// Read-only checks run before a master render (SPEC §13.7). Never mutates; no revision, no undo step.

import { FONTS } from "./fonts.ts";
import type { Ctx, Project } from "./schema.ts";
import type { AudioPeak, SourceHealth } from "./source-health.ts";
import { textCss, themeOf } from "./themes.ts";
import { anchorOf, itemSpan } from "./validate.ts";

export interface LintIssue {
  level: "error" | "warn";
  what: string;
  /** Timeline frame. */
  at: number;
  itemId?: string;
}

const CJK = /[㐀-鿿豈-﫿]/;
/** Title-safe: the inner 90% of the frame, so a 5% margin per side. */
const SAFE = 0.05;
/** CaptionLayer's fixed bottom offset in px (render/Composition.tsx). */
const CAPTION_BOTTOM = 60;

export type LintMetadata = Pick<Ctx, "fingerprints" | "fingerprint"> & { sourceHealth?: Record<string, SourceHealth> };

const peakText = (peak: AudioPeak) =>
  peak.dbfs === null ? "silent" : `${peak.dbfs.toFixed(1)} dBFS${peak.atSeconds === null ? "" : ` near source ${peak.atSeconds.toFixed(2)}s`}`;

/** Optional ingest metadata adds source integrity and peak checks without bringing Node or filesystem APIs into core. */
export function lint(p: Project, metadata?: LintMetadata): LintIssue[] {
  const out: LintIssue[] = [];
  const { width: W, height: H } = p.meta;

  for (const t of p.tracks) {
    if (t.magnetic) {
      const free = t.items.filter((i) => !anchorOf(i)).sort((a, b) => a.start - b.start);
      let end = 0;
      for (const i of free) {
        if (i.start > end) out.push({ level: "error", what: `${i.start - end}f gap on ${t.name} before ${i.id}; closeGap or move the item`, at: end, itemId: i.id });
        end = Math.max(end, i.start + i.duration);
      }
    }

    if (t.kind === "caption" && t.items.length) {
      const first = t.items.reduce((a, b) => (b.start < a.start ? b : a));
      // Only the default CaptionLayer has a known position; a custom `style` component is unknowable here.
      if (!t.style && CAPTION_BOTTOM < H * SAFE)
        out.push({ level: "warn", what: `captions on ${t.name} sit ${CAPTION_BOTTOM}px from the bottom, outside the title-safe area (${Math.round(H * SAFE)}px); use a custom caption component`, at: first.start, itemId: first.id });
      for (const c of t.items) {
        const text = "text" in c ? c.text : "";
        if (!CJK.test(text)) continue;
        const name = { ...themeOf(p)?.roles.subtitle, ...t.textStyle }.font;
        if (name && !FONTS.find((f) => f.name === name)?.cjk) {
          out.push({ level: "warn", what: `${t.name} has Chinese text but "${name}" has no CJK glyphs, so it falls back to another font; set textStyle.font to a CJK font (e.g. Noto Sans TC) for one look`, at: c.start, itemId: c.id });
          break;
        }
      }
    }

    if (t.kind === "overlay") {
      for (const o of t.items) {
        if (o.component !== "Text") continue;
        const props = o.props as { text?: unknown; role?: string; textStyle?: Parameters<typeof textCss>[2]; style?: Record<string, unknown> };
        const text = String(props.text ?? "");
        const css = textCss(p, (props.role ?? "title") as Parameters<typeof textCss>[1], props.textStyle, text);
        const name = props.textStyle?.font ?? themeOf(p)?.roles[(props.role ?? "title") as "title"]?.font;
        if (CJK.test(text) && name && !FONTS.find((f) => f.name === name)?.cjk)
          out.push({ level: "warn", what: `${o.id} has Chinese text but "${name}" has no CJK glyphs, so it falls back to another font; set textStyle.font to a CJK font (e.g. Noto Sans TC) for one look`, at: o.start, itemId: o.id });
        // ponytail: Text is centred by default and its box needs layout to measure, so only explicit px insets
        // in props.style are checked; add text measurement when a use appears.
        const inset = { ...css, ...props.style } as Record<string, unknown>;
        const sides: [string, number][] = [["left", W], ["right", W], ["top", H], ["bottom", H]];
        const bad = sides.filter(([k, size]) => typeof inset[k] === "number" && (inset[k] as number) < size * SAFE).map(([k]) => k);
        if (bad.length) out.push({ level: "warn", what: `${o.id} text is within the title-safe margin on ${bad.join("/")}; move it at least 5% in`, at: itemSpan(p, o)?.start ?? o.start, itemId: o.id });
      }
    }

    if (metadata && (t.kind === "video" || t.kind === "audio")) {
      for (const item of t.items) {
        const asset = p.assets[item.assetId];
        if (!asset || asset.kind === "lut" || asset.kind === "font") continue;
        const at = itemSpan(p, item)?.start ?? item.start;
        const health = metadata.sourceHealth?.[asset.id];
        const liveFingerprint = metadata.fingerprint?.(asset.path);
        const intervalStart = "sourceIn" in item ? item.sourceIn : 0;
        const intervalEnd = intervalStart + item.duration / p.meta.fps * ("speed" in item ? item.speed ?? 1 : 1);
        const interval = `[${intervalStart.toFixed(2)}, ${intervalEnd.toFixed(2)})s`;
        if (metadata.fingerprint && liveFingerprint === undefined) {
          out.push({ level: "error", what: `source file ${asset.path} for ${item.id} is missing; relink it before rendering`, at, itemId: item.id });
          continue;
        }
        if (!health) {
          out.push({ level: "warn", what: `${asset.path} used by ${item.id} has no current full-decode/peak measurement for source ${interval}; run ingest`, at, itemId: item.id });
          continue;
        }
        if (health.path !== asset.path || health.fingerprint !== liveFingerprint || (metadata.fingerprints?.[asset.id] !== undefined && metadata.fingerprints[asset.id] !== health.fingerprint)) {
          out.push({ level: "error", what: `${item.id} has stale source-health metadata for ${asset.path} source ${interval}; run ingest before rendering`, at, itemId: item.id });
          continue;
        }
        if (health.decode.status === "failed") {
          out.push({ level: "error", what: `${asset.path} cannot be fully decoded for ${item.id} source ${interval}: ${health.decode.error}`, at, itemId: item.id });
          continue;
        }
        if (health.audio.status === "failed") {
          out.push({ level: "error", what: `${asset.path} audio peaks could not be measured for ${item.id} source ${interval}: ${health.audio.error}`, at, itemId: item.id });
          continue;
        }
        if (health.audio.status === "unmeasured") {
          out.push({ level: "warn", what: `${asset.path} has unmeasured source audio peaks for ${item.id} source ${interval}; run ingest`, at, itemId: item.id });
          continue;
        }
        if (health.audio.status === "none") continue;
        const { samplePeak, truePeak } = health.audio;
        const inSourceRange = (peakAt: number | null) => peakAt !== null && peakAt >= intervalStart && peakAt < intervalEnd;
        const hotSample = (samplePeak.dbfs ?? -Infinity) > -1;
        const hotTruePeak = (truePeak.dbfs ?? -Infinity) > -1;
        if (hotSample || hotTruePeak) {
          const selected = (hotSample && inSourceRange(samplePeak.atSeconds)) || (hotTruePeak && inSourceRange(truePeak.atSeconds));
          out.push({ level: "warn", what: `${item.id} uses source ${interval} from ${asset.path}; whole-source peaks ${peakText(samplePeak)} sample / ${peakText(truePeak)} true peak${selected ? " in the selected source interval" : "; selected-range maximum is not separately measured"}. Source peaks are independent of the render limiter; check the final mix separately`, at, itemId: item.id });
        }
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
