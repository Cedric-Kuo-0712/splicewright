import { z } from "zod";
import type { CaptionItem, Ctx, Item, Project, Track, TrackKind } from "./schema.ts";
import { captionSpan, validate } from "./validate.ts";

// Spec §5. Every op mutates a private clone; `apply` bumps the revision and validates.

export class OpError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type OpResult =
  | { project: Project; changes: { summary: string } }
  | { error: { code: string; message: string } };

interface OpDef<S extends z.ZodType = z.ZodType> {
  args: S;
  run: (p: Project, args: z.infer<S>, ctx: Ctx) => string;
}

const def = <S extends z.ZodType>(args: S, run: OpDef<S>["run"]): OpDef<S> => ({ args, run });

// Explicitly typed so TypeScript narrows after `if (...) fail(...)`.
const fail: (code: string, message: string) => never = (code, message) => {
  throw new OpError(code, message);
};

const Id = z.string().min(1);
const Frames = z.number().int();
const Patch = z.record(z.string(), z.unknown()); // null value = unset the field
const KINDS = ["video", "audio", "caption", "overlay"] as const;

const EXT_KIND: Record<string, "video" | "audio" | "image"> = {
  mp4: "video", mov: "video", m4v: "video", mkv: "video", webm: "video", avi: "video",
  mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", flac: "audio", ogg: "audio",
  jpg: "image", jpeg: "image", png: "image", webp: "image", gif: "image", heic: "image",
};

const ITEM_PROPS: Record<TrackKind, string[]> = {
  video: ["volume", "fit", "transform", "label", "note"],
  audio: ["volume", "fadeIn", "fadeOut", "label", "note"],
  caption: ["label", "note"],
  overlay: ["props", "label", "note"],
};

const TRACK_PROPS: Record<TrackKind, string[]> = {
  video: ["name", "muted", "hidden", "locked", "magnetic"],
  audio: ["name", "muted", "hidden", "locked", "magnetic", "volume"],
  caption: ["name", "muted", "hidden", "locked", "magnetic", "style"],
  overlay: ["name", "muted", "hidden", "locked", "magnetic"],
};

// ---------- helpers ----------

const end = (i: Item) => i.start + i.duration;

function findTrack(p: Project, id: string): Track {
  return p.tracks.find((t) => t.id === id) ?? fail("not_found", `track ${id} not found`);
}

function locate(p: Project, itemId: string): { track: Track; item: Item } {
  for (const track of p.tracks) {
    const item = track.items.find((i) => i.id === itemId);
    if (item) return { track, item };
  }
  return fail("not_found", `item ${itemId} not found`);
}

function assertAuthored(item: Item) {
  if ("mode" in item && item.mode === "anchored")
    fail("invalid", `${item.id} is an anchored caption; its timing follows ${item.itemId}`);
}

/** `<prefix>_<base36 counter>`, one past the highest existing id with that prefix (§4.3). */
export function nextId(p: Project, prefix: string): string {
  const re = new RegExp(`^${prefix}_([0-9a-z]+)$`);
  const ids = [
    ...p.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)]),
    ...(p.markers ?? []).map((m) => m.id),
  ];
  let max = 0;
  for (const id of ids) {
    const m = re.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 36));
  }
  return `${prefix}_${(max + 1).toString(36)}`;
}

/** Ripple: shift every item on `t` starting at or after `from`. */
function shift(t: Track, from: number, delta: number) {
  for (const i of t.items) if (i.start >= from) i.start += delta;
}

function fits(t: Track, start: number, duration: number): boolean {
  return t.kind === "caption" || t.items.every((i) => end(i) <= start || i.start >= start + duration);
}

function addTrack(p: Project, kind: TrackKind, name?: string, magnetic?: boolean): Track {
  const letter = { video: "V", audio: "A", caption: "C", overlay: "O" }[kind];
  const t = {
    id: nextId(p, "t"),
    name: name ?? `${letter}${p.tracks.filter((x) => x.kind === kind).length + 1}`,
    kind,
    ...(magnetic ? { magnetic } : {}),
    items: [],
  } as Track;
  // Place it above the last track of the same kind, else on top.
  const last = p.tracks.findLastIndex((x) => x.kind === kind);
  p.tracks.splice(last === -1 ? p.tracks.length : last + 1, 0, t);
  return t;
}

function patch(target: Record<string, unknown>, changes: Record<string, unknown>, allowed: string[], what: string) {
  for (const [k, v] of Object.entries(changes)) {
    if (!allowed.includes(k)) fail("invalid", `${what} does not accept "${k}"; allowed: ${allowed.join(", ")}`);
    if (v === null) delete target[k];
    else target[k] = v;
  }
}

// ---------- ops ----------

export const ops: Record<string, OpDef<any>> = {
  importAsset: def(
    z.object({ path: z.string().min(1), kind: z.enum(["video", "audio", "image"]).optional() }),
    (p, a) => {
      if (/^([/\\]|[a-zA-Z]:)/.test(a.path)) fail("invalid", `asset path must be relative to the project root: ${a.path}`);
      const existing = Object.values(p.assets).find((x) => x.path === a.path);
      if (existing) return `already imported as ${existing.id}`;
      const file = a.path.split(/[/\\]/).pop()!;
      const ext = file.includes(".") ? file.split(".").pop()!.toLowerCase() : "";
      const kind = a.kind ?? EXT_KIND[ext] ?? fail("invalid", `unknown media type ".${ext}"; pass kind`);
      const base = "a_" + (file.replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9]/g, "") || "asset");
      let id = base;
      for (let n = 2; p.assets[id]; n++) id = `${base}_${n}`;
      p.assets[id] = { id, path: a.path, kind };
      return `imported ${id} (${kind})`;
    },
  ),

  insertItem: def(
    z
      .object({
        trackId: Id.optional(),
        assetId: Id.optional(),
        component: z.string().min(1).optional(),
        props: Patch.optional(),
        text: z.string().optional(),
        at: Frames.min(0),
        duration: Frames.min(1).optional(),
        sourceIn: z.number().min(0).optional(),
        ripple: z.boolean().optional(),
      })
      .refine((a) => [a.assetId, a.component, a.text].filter((x) => x !== undefined).length === 1, {
        message: "pass exactly one of assetId, component, text",
      }),
    (p, a, ctx) => {
      let kind: TrackKind;
      let item: Item;
      if (a.assetId !== undefined) {
        const asset = p.assets[a.assetId] ?? fail("not_found", `asset ${a.assetId} not found`);
        kind = asset.kind === "audio" ? "audio" : "video";
        const sourceIn = a.sourceIn ?? 0;
        const len = asset.kind === "image" ? undefined : ctx.assetDurations?.[asset.id];
        const duration =
          a.duration ??
          (len !== undefined ? Math.floor((len - sourceIn) * p.meta.fps) : fail("invalid", "duration required (asset duration unknown)"));
        item = { id: nextId(p, "i"), start: a.at, duration, assetId: asset.id, sourceIn };
      } else if (a.component !== undefined) {
        kind = "overlay";
        const duration = a.duration ?? fail("invalid", "duration required");
        item = { id: nextId(p, "i"), start: a.at, duration, component: a.component, props: a.props ?? {} };
      } else {
        kind = "caption";
        const duration = a.duration ?? fail("invalid", "duration required");
        item = { id: nextId(p, "c"), start: a.at, duration, mode: "free", text: a.text! };
      }
      const t = a.trackId
        ? findTrack(p, a.trackId)
        : (p.tracks.find((t) => t.kind === kind && ((a.ripple ?? t.magnetic) || fits(t, a.at, item.duration))) ??
          addTrack(p, kind));
      if (t.kind !== kind) fail("invalid", `${t.id} is a ${t.kind} track; this item needs ${kind}`);
      if (a.ripple ?? t.magnetic) shift(t, a.at, item.duration);
      (t.items as Item[]).push(item);
      return `inserted ${item.id} on ${t.id} at ${a.at} (${item.duration}f)`;
    },
  ),

  split: def(z.object({ itemId: Id, at: Frames }), (p, a) => {
    const { track: t, item } = locate(p, a.itemId);
    assertAuthored(item);
    if (a.at <= item.start || a.at >= end(item))
      fail("invalid", `split point ${a.at} is not inside ${item.id} [${item.start}, ${end(item)})`);
    const offset = a.at - item.start;
    const second = structuredClone(item);
    second.id = nextId(p, t.kind === "caption" ? "c" : "i");
    second.start = a.at;
    second.duration = item.duration - offset;
    item.duration = offset;
    if ("sourceIn" in second) second.sourceIn += offset / p.meta.fps;
    delete (second as { fadeIn?: number }).fadeIn;
    delete (item as { fadeOut?: number }).fadeOut;
    (t.items as Item[]).splice(t.items.indexOf(item as never) + 1, 0, second);

    let moved = 0;
    if ("sourceIn" in second && t.kind === "video") {
      // ponytail: a caption spanning the cut goes wholly to the half holding its midpoint and is
      // clipped at the cut; duplicate it into both halves if that proves visible.
      for (const ct of p.tracks)
        if (ct.kind === "caption")
          for (const c of ct.items)
            if (c.mode === "anchored" && c.itemId === item.id && (c.sourceStart + c.sourceEnd) / 2 >= second.sourceIn) {
              c.itemId = second.id;
              moved++;
            }
    }
    return `split ${item.id} at ${a.at} → ${item.id}, ${second.id}` + (moved ? `; ${moved} captions re-pointed` : "");
  }),

  trim: def(
    z.object({ itemId: Id, edge: z.enum(["start", "end"]), to: Frames.min(0), ripple: z.boolean().optional() }),
    (p, a) => {
      const { track: t, item } = locate(p, a.itemId);
      assertAuthored(item);
      const oldEnd = end(item);
      const ripple = a.ripple ?? t.magnetic ?? false;
      if (a.edge === "end") {
        const delta = a.to - oldEnd;
        item.duration += delta;
        if (ripple) shift(t, oldEnd, delta);
      } else {
        // The right edge stays put (or, with ripple, the left edge stays and later items follow).
        const delta = a.to - item.start;
        item.duration -= delta;
        if ("sourceIn" in item) item.sourceIn += delta / p.meta.fps;
        if (ripple) shift(t, oldEnd, -delta);
        else item.start = a.to;
      }
      if (item.duration < 1) fail("invalid", `trim leaves ${item.id} with no duration`);
      return `trimmed ${item.id} ${a.edge} → [${item.start}, ${end(item)})` + (ripple ? " (ripple)" : "");
    },
  ),

  move: def(
    z.object({ itemId: Id, to: Frames.min(0), trackId: Id.optional(), ripple: z.boolean().optional() }),
    (p, a) => {
      const { track: src, item } = locate(p, a.itemId);
      assertAuthored(item);
      const dst = a.trackId ? findTrack(p, a.trackId) : src;
      if (dst.kind !== src.kind) fail("invalid", `cannot move a ${src.kind} item to ${dst.kind} track ${dst.id}`);
      src.items.splice(src.items.indexOf(item as never), 1);
      // With ripple, `to` is read after the source gap has closed.
      if (a.ripple ?? src.magnetic) shift(src, end(item), -item.duration);
      if (a.ripple ?? dst.magnetic) shift(dst, a.to, item.duration);
      item.start = a.to;
      (dst.items as Item[]).push(item);
      return `moved ${item.id} to ${dst.id} at ${a.to}`;
    },
  ),

  delete: def(z.object({ itemIds: z.array(Id).min(1), ripple: z.boolean().optional() }), (p, a) => {
    const ids = [...new Set<string>(a.itemIds)];
    // Latest first, so a ripple never shifts an item that is still to be deleted.
    const targets = ids.map((id) => locate(p, id)).sort((x, y) => y.item.start - x.item.start);
    for (const { track: t, item } of targets) {
      t.items.splice(t.items.indexOf(item as never), 1);
      if (a.ripple ?? t.magnetic) shift(t, end(item), -item.duration);
    }
    let orphans = 0;
    for (const t of p.tracks)
      if (t.kind === "caption") {
        const keep = t.items.filter((c) => !(c.mode === "anchored" && ids.includes(c.itemId)));
        orphans += t.items.length - keep.length;
        t.items = keep;
      }
    return `deleted ${ids.join(", ")}` + (orphans ? ` and ${orphans} anchored captions` : "");
  }),

  setProps: def(z.object({ itemId: Id, patch: Patch }), (p, a) => {
    const { track: t, item } = locate(p, a.itemId);
    patch(item as Record<string, unknown>, a.patch, ITEM_PROPS[t.kind], `${t.kind} item ${item.id}`);
    return `updated ${item.id}: ${Object.keys(a.patch).join(", ")}`;
  }),

  slip: def(z.object({ itemId: Id, deltaSec: z.number() }), (p, a) => {
    const { item } = locate(p, a.itemId);
    if (!("sourceIn" in item)) fail("invalid", `${item.id} has no source media to slip`);
    item.sourceIn += a.deltaSec;
    return `slipped ${item.id} to sourceIn ${item.sourceIn.toFixed(3)}s`;
  }),

  addTrack: def(z.object({ kind: z.enum(KINDS), name: z.string().optional(), magnetic: z.boolean().optional() }), (p, a) => {
    const t = addTrack(p, a.kind, a.name, a.magnetic);
    return `added ${a.kind} track ${t.id} (${t.name})`;
  }),

  removeTrack: def(z.object({ trackId: Id }), (p, a) => {
    const t = findTrack(p, a.trackId);
    p.tracks.splice(p.tracks.indexOf(t), 1);
    return `removed track ${t.id} with ${t.items.length} items`;
  }),

  setTrack: def(z.object({ trackId: Id, patch: Patch }), (p, a) => {
    const t = findTrack(p, a.trackId);
    patch(t as Record<string, unknown>, a.patch, TRACK_PROPS[t.kind], `${t.kind} track ${t.id}`);
    return `updated track ${t.id}: ${Object.keys(a.patch).join(", ")}`;
  }),

  addCaptionsFromTranscript: def(z.object({ itemId: Id, trackId: Id.optional() }), (p, a, ctx) => {
    const { track: src, item } = locate(p, a.itemId);
    if (src.kind !== "video" || !("assetId" in item)) fail("invalid", `${a.itemId} is not a video item`);
    const assetId = (item as { assetId: string }).assetId;
    const segs = ctx.transcript?.(assetId) ?? fail("not_found", `no transcript for ${assetId}; run ingest`);
    const t = a.trackId ? findTrack(p, a.trackId) : (p.tracks.find((t) => t.kind === "caption") ?? addTrack(p, "caption"));
    if (t.kind !== "caption") fail("invalid", `${t.id} is not a caption track`);
    let n = 0;
    for (const s of segs) {
      const text = s.text.trim();
      const cap: CaptionItem = { id: nextId(p, "c"), start: 0, duration: 1, mode: "anchored", itemId: item.id, sourceStart: s.start, sourceEnd: s.end, text };
      // Only segments visible now; a later trim that extends the item won't pull in the others.
      if (!text || !captionSpan(p, cap)) continue;
      (t.items as Item[]).push(cap);
      n++;
    }
    return `added ${n} captions for ${item.id} on ${t.id}`;
  }),

  editCaption: def(z.object({ captionId: Id, text: z.string() }), (p, a) => {
    const { item } = locate(p, a.captionId);
    if (!("mode" in item)) fail("invalid", `${a.captionId} is not a caption`);
    (item as CaptionItem).text = a.text;
    return a.text ? `edited ${a.captionId}` : `hid ${a.captionId}`;
  }),

  addMarker: def(
    z.object({ label: z.string(), start: Frames.min(0), duration: Frames.min(1).optional(), color: z.string().optional() }),
    (p, a) => {
      const id = nextId(p, "m");
      (p.markers ??= []).push({ id, ...a });
      p.markers.sort((x, y) => x.start - y.start);
      return `added marker ${id} "${a.label}" at ${a.start}`;
    },
  ),

  removeMarker: def(z.object({ markerId: Id }), (p, a) => {
    const i = (p.markers ?? []).findIndex((m) => m.id === a.markerId);
    if (i === -1) fail("not_found", `marker ${a.markerId} not found`);
    p.markers!.splice(i, 1);
    return `removed marker ${a.markerId}`;
  }),

  batch: def(z.object({ ops: z.array(z.object({ op: z.string(), args: z.unknown() })).min(1) }), (p, a, ctx) => {
    // Intermediate states may be invalid (e.g. swapping two items); only the end result is validated.
    const summaries = a.ops.map(({ op, args }: { op: string; args: unknown }) => {
      const d = ops[op] ?? fail("unknown_op", `unknown op ${op}`);
      return d.run(p, parseArgs(d, args), ctx);
    });
    return `batch of ${summaries.length}: ${summaries.join("; ")}`;
  }),
};

function parseArgs(d: OpDef, args: unknown) {
  const r = d.args.safeParse(args ?? {});
  return r.success ? r.data : fail("invalid_args", z.prettifyError(r.error));
}

/** Recompute derived anchored-caption timing and keep items ordered by start. */
function refresh(p: Project) {
  for (const t of p.tracks) {
    if (t.kind === "caption")
      for (const c of t.items) {
        const span = c.mode === "anchored" ? captionSpan(p, c) : null;
        if (span) Object.assign(c, span); // hidden captions keep their last timing
      }
    (t.items as Item[]).sort((x, y) => x.start - y.start);
  }
}

/** Run one op: `(project, args) → { project, changes } | { error }`. Never mutates `project`. */
export function apply(project: Project, name: string, args: unknown, ctx: Ctx = {}): OpResult {
  try {
    const d = ops[name] ?? fail("unknown_op", `unknown op ${name}; one of: ${Object.keys(ops).join(", ")}`);
    const parsed = parseArgs(d, args);
    const next = structuredClone(project);
    const summary = d.run(next, parsed, ctx);
    refresh(next);
    next.revision = project.revision + 1;
    const errs = validate(next, project, ctx);
    if (errs.length) fail("invalid", errs.join("; "));
    return { project: next, changes: { summary } };
  } catch (e) {
    if (e instanceof OpError) return { error: { code: e.code, message: e.message } };
    throw e;
  }
}

export function createProject(meta: Project["meta"]): Project {
  return {
    schemaVersion: 1,
    revision: 0,
    meta,
    assets: {},
    tracks: [
      { id: "t_1", name: "V1", kind: "video", magnetic: true, items: [] },
      { id: "t_2", name: "A1", kind: "audio", items: [] },
      { id: "t_3", name: "C1", kind: "caption", items: [] },
    ],
  };
}
