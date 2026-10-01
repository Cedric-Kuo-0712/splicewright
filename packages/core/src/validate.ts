import { Project as ProjectSchema } from "./schema.ts";
import type { Anchor, Ctx, Item, Project, Track, VideoItem } from "./schema.ts";

/** The anchor of an anchored caption (the caption itself) or of an attached overlay; else undefined. */
export function anchorOf(item: Item): Anchor | undefined {
  if ("mode" in item) return item.mode === "anchored" ? item : undefined;
  return "anchor" in item ? item.anchor : undefined;
}

/**
 * Timeline span of an item. Anchored items (§4.1) get the intersection of their source range with
 * the referenced item's visible source range, mapped to timeline frames; null = hidden.
 */
export function itemSpan(project: Project, it: Item): { start: number; duration: number } | null {
  const anchor = anchorOf(it);
  if (!anchor) return { start: it.start, duration: it.duration };
  const item = videoItems(project).get(anchor.itemId);
  if (!item) return null;
  const lo = Math.max(anchor.sourceStart, item.sourceIn);
  const hi = Math.min(anchor.sourceEnd, sourceAt(project, item, item.start + item.duration));
  const start = Math.round(frameOf(project, item, lo));
  const end = Math.round(frameOf(project, item, hi));
  return end - start >= 1 ? { start, duration: end - start } : null;
}

type Media = { start: number; sourceIn: number; speed?: number };

/** Source seconds per timeline frame (speed only exists on video items). */
export const secPerFrame = (p: Project, i: Media) => (i.speed ?? 1) / p.meta.fps;
/** Source seconds shown at timeline frame `f`. */
export const sourceAt = (p: Project, i: Media, f: number) => i.sourceIn + (f - i.start) * secPerFrame(p, i);
/** Timeline frame (unrounded) that shows source second `s`. */
export const frameOf = (p: Project, i: Media, s: number) => i.start + (s - i.sourceIn) / secPerFrame(p, i);

/** A video item's transition when the next item touches it: that item, plus the frames before and
 * after the cut the transition covers. */
export function transitionOf(t: Track, it: Item) {
  const tr = t.kind === "video" ? (it as VideoItem).transition : undefined;
  const next = tr && (t.items as VideoItem[]).find((i) => i.start === it.start + it.duration);
  if (!tr || !next) return undefined;
  const half = Math.floor(tr.duration / 2);
  return { kind: tr.kind, direction: tr.direction, next, before: Math.min(half, it.duration), after: Math.min(tr.duration - half, next.duration) };
}

export function videoItems(project: Project): Map<string, VideoItem> {
  const m = new Map<string, VideoItem>();
  for (const t of project.tracks) if (t.kind === "video") for (const i of t.items) m.set(i.id, i);
  return m;
}

/** §4.4 invariants. Returns a list of violations; empty means valid. */
export function validate(project: unknown, prev?: Project, ctx: Ctx = {}): string[] {
  const parsed = ProjectSchema.safeParse(project);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  const p = project as Project;
  const errs: string[] = [];

  for (const [key, a] of Object.entries(p.assets)) if (key !== a.id) errs.push(`asset key ${key} != id ${a.id}`);

  const ids = new Set<string>();
  const unique = (id: string) => {
    if (ids.has(id)) errs.push(`duplicate id ${id}`);
    ids.add(id);
  };
  const vids = videoItems(p);

  for (const t of p.tracks) {
    unique(t.id);
    for (const i of t.items) {
      unique(i.id);
      if ("assetId" in i) {
        if (!p.assets[i.assetId]) errs.push(`${i.id}: unknown asset ${i.assetId}`);
        else if (p.assets[i.assetId].kind === "lut") errs.push(`${i.id}: LUT assets cannot be placed on a track`);
        const dur = ctx.assetDurations?.[i.assetId];
        if ("grade" in i && i.grade?.lut && p.assets[i.grade.lut.assetId]?.kind !== "lut")
          errs.push(`${i.id}: grade LUT ${i.grade.lut.assetId} is missing or is not a LUT asset`);
        if (dur !== undefined && sourceAt(p, i, i.start + i.duration) > dur + 1e-6)
          errs.push(`${i.id}: source range ends past asset duration ${dur}s`);
        // dissolve and wipe play both sides past the cut; images have no source limits.
        const tr = transitionOf(t, i);
        if (tr && tr.kind !== "dip") {
          const still = (x: { assetId: string }) => p.assets[x.assetId]?.kind === "image";
          if (!still(i) && dur !== undefined && sourceAt(p, i, i.start + i.duration + tr.after) > dur + 1e-6)
            errs.push(`${i.id}: ${tr.kind} into ${tr.next.id} needs ${tr.after} frames of source after ${i.id}'s end; shorten it or use dip`);
          if (!still(tr.next) && sourceAt(p, tr.next, tr.next.start - tr.before) < -1e-6)
            errs.push(`${i.id}: ${tr.kind} into ${tr.next.id} needs ${tr.before} frames of source before ${tr.next.id}'s start; shorten it or use dip`);
        }
      }
      const anchor = anchorOf(i);
      if (anchor && !vids.has(anchor.itemId)) errs.push(`${i.id}: anchored to missing video item ${anchor.itemId}`);
    }
    if (t.kind !== "caption") {
      // Anchored items are exempt: their timing is derived and they only ever stack, like captions.
      const sorted = t.items.filter((i) => !anchorOf(i)).sort((a, b) => a.start - b.start);
      for (let k = 1; k < sorted.length; k++)
        if (sorted[k - 1].start + sorted[k - 1].duration > sorted[k].start)
          errs.push(`${t.id}: ${sorted[k - 1].id} overlaps ${sorted[k].id}`);
    }
  }

  if (prev) {
    for (const before of prev.tracks) {
      if (!before.locked) continue;
      const after = p.tracks.find((t) => t.id === before.id);
      if (!after) errs.push(`locked track ${before.id} removed`);
      else if (after.locked && lockKey(after) !== lockKey(before)) errs.push(`locked track ${before.id} changed`);
    }
  }
  return errs;
}

// Locking freezes items only; track settings (mute, name, ...) stay editable. Anchored item
// timing is derived, so it may follow edits on other tracks even when locked.
function lockKey(t: Track): string {
  return JSON.stringify(t.items.map((i) => (anchorOf(i) ? { ...i, start: 0, duration: 1 } : i)));
}
