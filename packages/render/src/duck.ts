import { frameOf, type Ctx, type Project } from "@splicewright/core";

export type Ranges = [number, number][];

/**
 * Timeline frame ranges [start, end) where transcript speech is visible on each ducked audio
 * item's `duck.under` tracks, keyed by audio item id. Computed where transcripts are readable
 * (Node) and handed to the composition as a prop, so the composition stays pure.
 */
export function duckRanges(p: Project, ctx: Ctx): Record<string, Ranges> {
  const out: Record<string, Ranges> = {};
  for (const t of p.tracks)
    for (const a of t.items) {
      if (!("duck" in a) || !a.duck) continue;
      const under = new Set(a.duck.under);
      out[a.id] = p.tracks
        .filter((v) => under.has(v.id))
        .flatMap((v) => (v.kind === "video" ? v.items : []))
        .flatMap((v) => {
          const end = v.start + v.duration;
          return (ctx.transcript?.(v.assetId) ?? []).flatMap(({ start, end: e }): Ranges => {
            const lo = Math.max(v.start, Math.round(frameOf(p, v, start)));
            const hi = Math.min(end, Math.round(frameOf(p, v, e)));
            return hi > lo ? [[lo, hi]] : [];
          });
        })
        .sort((x, y) => x[0] - y[0]);
    }
  return out;
}

/** Volume multiplier at timeline frame `f`: `level` inside speech, ramping back to 1 over `ramp` frames. */
export function duckGain(f: number, ranges: Ranges, level: number, ramp = 6): number {
  let d = Infinity;
  for (const [lo, hi] of ranges) d = Math.min(d, f < lo ? lo - f : f >= hi ? f - hi + 1 : 0);
  return level + (1 - level) * Math.min(1, d / ramp);
}
