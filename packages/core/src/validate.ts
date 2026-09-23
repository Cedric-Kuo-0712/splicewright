import { Project as ProjectSchema } from "./schema.ts";
import type { CaptionItem, Ctx, Project, Track, VideoItem } from "./schema.ts";

/**
 * Timeline span of an anchored caption (§4.1): the intersection of its source range with the
 * referenced item's visible source range, mapped to timeline frames. null = hidden.
 */
export function captionSpan(project: Project, cap: CaptionItem): { start: number; duration: number } | null {
  if (cap.mode === "free") return { start: cap.start, duration: cap.duration };
  const item = videoItems(project).get(cap.itemId);
  if (!item) return null;
  const fps = project.meta.fps;
  const lo = Math.max(cap.sourceStart, item.sourceIn);
  const hi = Math.min(cap.sourceEnd, item.sourceIn + item.duration / fps);
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
      if ("mode" in i && i.mode === "anchored" && !vids.has(i.itemId))
        errs.push(`${i.id}: anchored to missing video item ${i.itemId}`);
    }
    if (t.kind !== "caption") {
      const sorted = [...t.items].sort((a, b) => a.start - b.start);
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

// Locking freezes items only; track settings (mute, name, ...) stay editable. Anchored caption
// timing is derived, so it may follow edits on other tracks even when locked.
function lockKey(t: Track): string {
  return JSON.stringify(t.items.map((i) => ("mode" in i && i.mode === "anchored" ? { ...i, start: 0, duration: 1 } : i)));
}
