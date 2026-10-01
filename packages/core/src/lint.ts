// Read-only checks run before a master render (SPEC §13.7). Never mutates; no revision, no undo step.

import { FONTS } from "./fonts.ts";
import type { Project } from "./schema.ts";
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

// ponytail: skipped checks. Peaks above -1 dBFS (the project only stores integrated LUFS, no sample/true peak;
// add a `peak` ingest step to Probe, then compare against meta.limiter) and undecodable canvas-path items
// (no probe records decode failures; ingest would need to store one).
export function lint(p: Project): LintIssue[] {
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
  }
  return out.sort((a, b) => a.at - b.at);
}
