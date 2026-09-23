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
  const fps = project.meta.fps;
  const lo = Math.max(anchor.sourceStart, item.sourceIn);
  const hi = Math.min(anchor.sourceEnd, item.sourceIn + item.duration / fps);
  const start = item.start + Math.round((lo - item.sourceIn) * fps);
  const end = item.start + Math.round((hi - item.sourceIn) * fps);
  return end - start >= 1 ? { start, duration: end - start } : null;
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
        const dur = ctx.assetDurations?.[i.assetId];
        if (dur !== undefined && i.sourceIn + i.duration / p.meta.fps > dur + 1e-6)
          errs.push(`${i.id}: source range ends past asset duration ${dur}s`);
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
