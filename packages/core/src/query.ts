import type { AudioItem, Ctx, Item, Project } from "./schema.ts";
import { beatFrames } from "./timing.ts";
import { frameOf, itemSpan, secPerFrame } from "./validate.ts";

// Token-budget read views (§7.2). Pure; shared by `splicewright status` and the MCP read tools.

const end = (i: { start: number; duration: number }) => i.start + i.duration;

/** Item as shown on the timeline: anchored items get their derived span; hidden ones are null. */
function visible(p: Project, item: Item): Item | null {
  if ("mode" in item && !item.text) return null;
  const span = itemSpan(p, item);
  return span ? { ...item, ...span } : null;
}

export function durationFrames(p: Project): number {
  return Math.max(0, ...p.tracks.filter((t) => t.kind !== "caption").flatMap((t) => t.items.map(end)));
}

export function getSummary(p: Project) {
  const frames = durationFrames(p);
  return {
    title: p.meta.title,
    revision: p.revision,
    fps: p.meta.fps,
    size: `${p.meta.width}x${p.meta.height}`,
    durationFrames: frames,
    durationSec: +(frames / p.meta.fps).toFixed(2),
    assets: Object.keys(p.assets).length,
    tracks: p.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      items: t.items.length,
      ...(t.magnetic ? { magnetic: true } : {}),
      ...(t.locked ? { locked: true } : {}),
      ...(t.muted ? { muted: true } : {}),
      ...(t.hidden ? { hidden: true } : {}),
    })),
    markers: (p.markers ?? []).map((m) => ({ id: m.id, label: m.label, start: m.start, ...(m.duration ? { duration: m.duration } : {}) })),
  };
}

/** Visible items and captions intersecting timeline frames [from, to). Audio beats come as frames in range. */
export function getRange(p: Project, from: number, to: number) {
  return p.tracks.flatMap((t) =>
    t.items
      .map((i) => visible(p, i))
      .filter((i): i is Item => i !== null && i.start < to && end(i) > from)
      .map((i) => {
        if (!("beats" in i && i.beats)) return { track: t.id, ...i };
        const { beats, downbeats, ...rest } = i as AudioItem;
        const inRange = (times?: number[]) => beatFrames(p, i as AudioItem, times).filter((f) => f >= from && f < to);
        return { track: t.id, ...rest, beatFrames: inRange(beats), ...(downbeats && { downbeatFrames: inRange(downbeats) }) };
      }),
  );
}

/** Transcript text of `assetId` within source seconds [lo, hi). */
function transcriptText(ctx: Ctx, assetId: string, lo: number, hi: number): string | undefined {
  const segs = ctx.transcript?.(assetId);
  return segs?.filter((s) => s.start < hi && s.end > lo).map((s) => s.text.trim()).join(" ");
}

export function getItem(p: Project, itemId: string, ctx: Ctx = {}) {
  for (const t of p.tracks)
    for (const item of t.items) {
      if (item.id !== itemId) continue;
      if (!("assetId" in item)) return { track: t.id, item, visible: visible(p, item) !== null };
      const lo = item.sourceIn;
      const hi = item.sourceIn + item.duration * secPerFrame(p, item);
      return {
        track: t.id,
        item,
        asset: { ...p.assets[item.assetId], duration: ctx.assetDurations?.[item.assetId] },
        sourceRange: [+lo.toFixed(3), +hi.toFixed(3)],
        transcript: transcriptText(ctx, item.assetId, lo, hi),
      };
    }
  return undefined;
}

const trimWord = (s: string) => s.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "").toLowerCase();

/**
 * Source ranges (seconds, the unit of sourceIn) to cut for cutRanges: filler words, and silences between
 * consecutive words longer than `minSilence`. A word range grows by 2 frames each side (Whisper's stamps are
 * loose); a silence shrinks by 2 frames each side, so the cut never clips the neighbouring words. Ranges are
 * clamped to the item's visible source span and merged when they touch. Items whose asset has a transcript
 * without word timestamps come back in `hints` (re-run `ingest --only transcript`).
 */
export function findFillers(p: Project, ctx: Ctx = {}, { itemId, words = ["um", "uh", "嗯", "那個", "那个", "就是"], minSilence = 0.6 }: { itemId?: string; words?: string[]; minSilence?: number } = {}) {
  const fillers = new Set(words.map(trimWord));
  const pad = 2 / p.meta.fps;
  const items: { itemId: string; assetId: string; ranges: [number, number][]; what: string[] }[] = [];
  const hints: string[] = [];
  const r3 = (n: number) => +n.toFixed(3);
  for (const t of p.tracks)
    for (const item of t.items) {
      if (!("assetId" in item) || (itemId && item.id !== itemId)) continue;
      const segs = ctx.transcript?.(item.assetId);
      const ws = segs?.flatMap((s) => s.words ?? []).sort((a, b) => a.start - b.start);
      if (!ws?.length) {
        if (itemId || segs?.length) hints.push(`${item.id}: asset ${item.assetId} has no word timestamps; run ingest with --only transcript to re-transcribe`);
        continue;
      }
      const [lo, hi] = [item.sourceIn, item.sourceIn + item.duration * secPerFrame(p, item)];
      const cuts: { range: [number, number]; what: string }[] = [];
      ws.forEach((w, i) => {
        const text = trimWord(w.text);
        if (fillers.has(text)) cuts.push({ range: [w.start - pad, w.end + pad], what: text });
        const next = ws[i + 1];
        if (next && next.start - w.end > minSilence && next.start - w.end > 2 * pad) cuts.push({ range: [w.end + pad, next.start - pad], what: `silence ${(next.start - w.end).toFixed(2)}s` });
      });
      const merged: typeof cuts = [];
      for (const c of cuts.sort((a, b) => a.range[0] - b.range[0])) {
        const range: [number, number] = [Math.max(lo, c.range[0]), Math.min(hi, c.range[1])];
        if (range[1] <= range[0]) continue;
        const last = merged.at(-1);
        if (last && range[0] <= last.range[1]) (last.range[1] = Math.max(last.range[1], range[1])), (last.what += `, ${c.what}`);
        else merged.push({ range, what: c.what });
      }
      if (merged.length) items.push({ itemId: item.id, assetId: item.assetId, ranges: merged.map((m) => [r3(m.range[0]), r3(m.range[1])]), what: merged.map((m) => m.what) });
    }
  return { items, ...(hints.length && { hints }) };
}

/** Case-insensitive search over labels, notes, caption text, overlay props, and visible transcript. */
export function find(p: Project, query: string, ctx: Ctx = {}, limit = 50) {
  const q = query.toLowerCase();
  const hits: { track: string; itemId: string; start: number; field: string; text: string }[] = [];
  const has = (s: unknown) => typeof s === "string" && s.toLowerCase().includes(q);
  for (const t of p.tracks)
    for (const item of t.items) {
      const add = (field: string, text: string, start = item.start) => hits.push({ track: t.id, itemId: item.id, start, field, text });
      if (has(item.label)) add("label", item.label!);
      if (has(item.note)) add("note", item.note!);
      if ("text" in item && has(item.text)) add("text", item.text, visible(p, item)?.start ?? item.start);
      if ("props" in item && has(JSON.stringify(item.props))) add("props", JSON.stringify(item.props));
      if (t.kind === "video" && "assetId" in item) {
        const hi = item.sourceIn + item.duration * secPerFrame(p, item);
        for (const s of ctx.transcript?.(item.assetId) ?? [])
          if (s.start < hi && s.end > item.sourceIn && has(s.text))
            add("transcript", s.text.trim(), Math.max(item.start, Math.round(frameOf(p, item, s.start))));
      }
    }
  return hits.sort((a, b) => a.start - b.start).slice(0, limit);
}
