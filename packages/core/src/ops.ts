import { z } from "zod";
import { ANIMATABLE, GRADE_ANIMATABLE, Ease, FontRole, MASK_PROPS, OVERLAY_TRANSFORM_ANIMATABLE, StickerProps, TextStyle, Theme, type Anchor, type AudioItem, type CaptionItem, type Ctx, type Item, type OverlayItem, type Project, type Track, type TrackKind, type VideoItem } from "./schema.ts";
import { keyAt, keyframeFrame, withKey } from "./keyframes.ts";
import { beatFrames, snap, snapPoints, snapSpan } from "./timing.ts";
import { badFont, isTheme, THEME_IDS } from "./themes.ts";
import { anchorOf, frameOf, itemSpan, secPerFrame, sourceAt, validate, videoItems } from "./validate.ts";

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

export type PreviewOpsResult =
  | {
      revision: number;
      summary: string;
      summaryTruncated: boolean;
      moved: Array<{ trackId: string; itemId: string; from: number; to: number; delta: number; kind: "direct" | "secondary" }>;
      movedTotal: number;
      secondaryTotal: number;
      truncated: boolean;
      limit: 500;
    }
  | { error: { code: string; message: string } };

export interface OpDef<S extends z.ZodType = z.ZodType> {
  doc: string;
  args: S;
  run: (p: Project, args: z.infer<S>, ctx: Ctx) => string;
}

const def = <S extends z.ZodType>(doc: string, args: S, run: OpDef<S>["run"]): OpDef<S> => ({ doc, args, run });

// Explicitly typed so TypeScript narrows after `if (...) fail(...)`.
const fail: (code: string, message: string) => never = (code, message) => {
  throw new OpError(code, message);
};

const Id = z.string().min(1);
const Frames = z.number().int();
const Near = z.object({
  near: Frames.min(0),
  snapTo: z.array(z.enum(["edge", "marker", "beat"])).optional(),
  within: Frames.min(0).optional(),
});
/** A frame arg that also takes { near } (§15.2). resolveNear() swaps the object for a frame before
 * parsing; the identity transform only narrows the type, because the MCP SDK parses the raw input too. */
const frameArg = (base: z.ZodNumber) =>
  z
    .union([base, Near])
    .transform((v) => v as number)
    .describe("Frame, or { near, snapTo?: (edge|marker|beat)[], within? } to snap to the closest target");
const Patch = z.record(z.string(), z.unknown()); // null value = unset the field
const KINDS = ["video", "audio", "caption", "overlay"] as const;

const EXT_KIND: Record<string, "video" | "audio" | "image" | "lut" | "font"> = {
  mp4: "video", mov: "video", m4v: "video", mkv: "video", webm: "video", avi: "video",
  mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", flac: "audio", ogg: "audio",
  jpg: "image", jpeg: "image", png: "image", webp: "image", gif: "image", cube: "lut",
  ttf: "font", otf: "font", woff: "font", woff2: "font",
};
/** Phone photos Chrome can't decode, so neither the editor nor the render can show them. */
export const HEIF = /\.hei[cf]$/i;

const ITEM_PROPS: Record<TrackKind, string[]> = {
  video: ["volume", "audioFx", "fit", "transform", "effects", "grade", "key", "crop", "mask", "blend", "keyframes", "fadeIn", "fadeOut", "transition", "speed", "reverse", "label", "note"],
  audio: ["volume", "audioFx", "fadeIn", "fadeOut", "label", "note"],
  caption: ["label", "note"],
  overlay: ["props", "mask", "blend", "label", "note"],
};

const TRACK_PROPS: Record<TrackKind, string[]> = {
  video: ["name", "muted", "hidden", "locked", "magnetic", "syncTo"],
  audio: ["name", "muted", "hidden", "locked", "magnetic", "syncTo", "volume"],
  caption: ["name", "muted", "hidden", "locked", "magnetic", "syncTo", "style", "textStyle", "highlight"],
  overlay: ["name", "muted", "hidden", "locked", "magnetic", "syncTo"],
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

const allItems = (p: Project): Item[] => p.tracks.flatMap((t): Item[] => t.items);

function audioItem(p: Project, itemId: string): AudioItem {
  const { track, item } = locate(p, itemId);
  return track.kind === "audio" ? (item as AudioItem) : fail("invalid", `${itemId} is not an audio item`);
}

const DENSITY = z
  .union([z.enum(["all", "strong", "downbeat"]), z.string().regex(/^every:[1-9]\d*$/)])
  .describe("all | strong (onset strength above the 60th percentile) | downbeat | every:N (every Nth beat from the first downbeat)");

/** Timeline frame → source seconds of the anchor's target. */
function toSource(p: Project, anchor: Anchor, frame: number): number {
  const target = videoItems(p).get(anchor.itemId) ?? fail("not_found", `anchor target ${anchor.itemId} not found`);
  return sourceAt(p, target, frame);
}

function spanText(p: Project, item: Item): string {
  const s = itemSpan(p, item);
  return s ? `[${s.start}, ${s.start + s.duration})` : "hidden (outside its anchor item)";
}

/** `<prefix>_<base36 counter>`, one past the highest id with that prefix ever handed out (§4.3). */
export function nextId(p: Project, prefix: string): string {
  const re = new RegExp(`^${prefix}_([0-9a-z]+)$`);
  const ids = [
    ...p.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)]),
    ...(p.markers ?? []).map((m) => m.id),
  ];
  let max = p.ids?.[prefix] ?? 0;
  for (const id of ids) {
    const m = re.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 36));
  }
  return `${prefix}_${(max + 1).toString(36)}`;
}

/** nextId, recorded in `p.ids` so the id stays taken after its item is deleted. */
function newId(p: Project, prefix: string): string {
  const id = nextId(p, prefix);
  (p.ids ??= {})[prefix] = parseInt(id.slice(prefix.length + 1), 36);
  return id;
}

/**
 * Track-level downstream sync: a clip moved out of/into a primary emits its usual ripple splice.
 * This is not per-clip audio attachment; source-relative keys and beats remain intrinsic to items.
 */
function shift(p: Project, t: Track, from: number, delta: number) {
  if (delta === 0) return;
  const dependents = t.kind === "video" && t.magnetic && !t.syncTo
    ? p.tracks.filter((candidate) => candidate.syncTo === t.id)
    : [];
  for (const dependent of dependents) {
    const moving = dependent.items.filter((item) => !anchorOf(item) && item.start >= from);
    const straddling = dependent.items.find((item) => !anchorOf(item) && item.start < from && end(item) > from);
    if (straddling)
      fail("conflict", `cannot ripple ${t.id} at ${from}: ${straddling.id} on synced track ${dependent.id} straddles the edit; split it or unlink the track first`);
    if (dependent.locked && moving.length)
      fail("conflict", `cannot ripple ${t.id} at ${from}: locked synced track ${dependent.id} has item ${moving[0].id} that would move; unlock or unlink it first`);
  }
  for (const i of t.items) if (i.start >= from) i.start += delta;
  for (const dependent of dependents) for (const item of dependent.items)
    if (!anchorOf(item) && item.start >= from) item.start += delta;
}

/** After items `ids` are gone: drop captions anchored to them, and detach overlays in place (those are hand-authored). */
function dropAnchored(p: Project, ids: string[]) {
  let orphans = 0;
  let detached = 0;
  for (const t of p.tracks) {
    if (t.kind === "caption") {
      const keep = t.items.filter((c) => !(c.mode === "anchored" && ids.includes(c.itemId)));
      orphans += t.items.length - keep.length;
      t.items = keep;
    }
    if (t.kind === "overlay")
      for (const o of t.items)
        if (o.anchor && ids.includes(o.anchor.itemId)) {
          delete o.anchor;
          detached++;
        }
  }
  return (orphans ? `; removed ${orphans} anchored captions` : "") + (detached ? `; detached ${detached} overlays in place` : "");
}

/** The empty span [from, to) containing frame `at` on `t`, if items follow it. Anchored items don't count. */
export function gapAt(t: Track, at: number): [number, number] | undefined {
  const free = t.items.filter((i) => !anchorOf(i));
  if (free.some((i) => i.start <= at && at < end(i))) return;
  const to = Math.min(...free.filter((i) => i.start > at).map((i) => i.start));
  return to === Infinity ? undefined : [Math.max(0, ...free.filter((i) => end(i) <= at).map(end)), to];
}

function fits(t: Track, start: number, duration: number): boolean {
  return t.kind === "caption" || t.items.every((i) => end(i) <= start || i.start >= start + duration);
}

function addTrack(p: Project, kind: TrackKind, name?: string, magnetic?: boolean): Track {
  const letter = { video: "V", audio: "A", caption: "C", overlay: "O" }[kind];
  const t = {
    id: newId(p, "t"),
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

/** A Text overlay's `props.role` / `props.textStyle`: valid shape, known font. */
function checkText(props: Record<string, unknown>, p: Project) {
  if (props.role !== undefined && !FontRole.safeParse(props.role).success) fail("invalid", `role "${props.role}" is not one of title, subtitle, emphasis, handwritten`);
  if (props.textStyle === undefined) return;
  const s = TextStyle.safeParse(props.textStyle);
  if (!s.success) fail("invalid", `textStyle: ${s.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const bad = badFont(s.data, p.assets);
  if (bad) fail("invalid", bad);
}

// ---------- ops ----------

function advanceOverlayKeys(item: OverlayItem, seconds: number) {
  if (!item.keyframes) return;
  const offset = (item.keyframeOffset ?? 0) + seconds;
  if (offset >= 0) item.keyframeOffset = offset;
  else {
    item.keyframes = Object.fromEntries(Object.entries(item.keyframes).map(([prop, keys]) => [prop, keys.map((key) => ({ ...key, t: key.t - offset }))]));
    item.keyframeOffset = 0;
  }
}

export const ops: Record<string, OpDef<any>> = {
  relinkAsset: def(
    "Explicitly replace a source while preserving asset ID and timeline references. Requires ingest preflight; changed content needs acceptChanged. Unsafe source ranges are refused. One undo step.",
    z.object({ assetId: Id, path: z.string().min(1), acceptChanged: z.boolean().optional() }), (p, a, ctx) => {
      const asset = p.assets[a.assetId];
      if (!asset) fail("not_found", `asset ${a.assetId} not found`);
      const candidate = ctx.relinkCandidate;
      if (!candidate || candidate.assetId !== a.assetId || candidate.path !== a.path) fail("invalid", "relink requires source preflight through ingest");
      if (candidate.kind !== asset.kind) fail("invalid", `replacement format kind ${candidate.kind} differs from ${asset.kind}`);
      if (!candidate.identical && !a.acceptChanged) fail("invalid", "replacement content differs or original identity is unknown; explicitly pass acceptChanged after reviewing it");
      const unsafe: string[] = [];
      for (const track of p.tracks) for (const item of track.items) {
        if (!("assetId" in item) || item.assetId !== asset.id || !("sourceIn" in item) || asset.kind === "image") continue;
        const end = Math.max(sourceAt(p, item, item.start), sourceAt(p, item, item.start + item.duration));
        if (candidate.duration === undefined || end > candidate.duration + 1e-6) unsafe.push(`${item.id}: source ${item.sourceIn.toFixed(3)}..${end.toFixed(3)}s`);
      }
      if (unsafe.length) fail("invalid", `replacement cannot safely preserve usage: ${unsafe.join("; ")}`);
      const from = asset.path;
      asset.path = candidate.path;
      for (const track of p.tracks) if (track.kind === "overlay") for (const item of track.items)
        if (item.component === "Sticker" && item.props.src === from) item.props.src = candidate.path;
      return `relinked ${asset.id}: ${from} → ${candidate.path}${candidate.identical ? " (identical content)" : " (changed content; analysis and proxy invalidated)"}`;
    },
  ),
  importAsset: def(
    "Register a media file (path relative to the project root). Idempotent by path and by content fingerprint; a probed asset whose file moved is re-pointed to the new path.",
    z.object({ path: z.string().min(1), kind: z.enum(["video", "audio", "image", "lut", "font"]).optional() }),
    (p, a, ctx) => {
      if (/^([/\\]|[a-zA-Z]:)/.test(a.path) || a.path.split(/[/\\]/).includes(".."))
        fail("invalid", `asset path must be relative to the project root and inside it: ${a.path}`);
      const existing = Object.values(p.assets).find((x) => x.path === a.path);
      if (existing) return `already imported as ${existing.id}`;
      const fp = ctx.fingerprint?.(a.path);
      const same = fp && Object.values(p.assets).find((x) => ctx.fingerprints?.[x.id] === fp);
      if (same) {
        if (ctx.fingerprint!(same.path)) return `already imported as ${same.id} (same content as ${same.path})`;
        const from = same.path;
        same.path = a.path;
        for (const t of p.tracks) if (t.kind === "overlay") for (const item of t.items)
          if (item.component === "Sticker" && item.props.src === from) item.props.src = a.path;
        return `re-pointed ${same.id} from ${from} (missing) to ${a.path}`;
      }
      const file = a.path.split(/[/\\]/).pop()!;
      const ext = file.includes(".") ? file.split(".").pop()!.toLowerCase() : "";
      if (HEIF.test(file)) fail("invalid", `browsers can't show .${ext}; import it with \`splicewright import\` or the editor, which convert it to JPEG`);
      const kind = a.kind ?? EXT_KIND[ext] ?? fail("invalid", `unknown media type ".${ext}"; pass kind`);
      if (ext === "cube" && kind !== "lut") fail("invalid", ".cube files must be imported as LUT assets");
      if (kind === "lut" && ext !== "cube") fail("invalid", "LUT assets must be .cube files");
      if (kind === "font" && !["ttf", "otf", "woff", "woff2"].includes(ext)) fail("invalid", "font assets must be .ttf, .otf, .woff, or .woff2 files");
      if (kind === "lut") {
        if (!ctx.validateLut) fail("invalid", "cannot validate .cube LUT without a project file reader");
        try { ctx.validateLut(a.path); } catch (e) { fail("invalid", `invalid .cube LUT ${a.path}: ${(e as Error).message}`); }
      }
      const base = "a_" + (file.replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9]/g, "") || "asset");
      let id = base;
      for (let n = 2; p.assets[id]; n++) id = `${base}_${n}`;
      p.assets[id] = { id, path: a.path, kind };
      return `imported ${id} (${kind})`;
    },
  ),

  removeAsset: def(
    "Remove an asset from the project's media list. The file stays on disk. Refused while any item or LUT grade uses it.",
    z.object({ assetId: Id }),
    (p, a) => {
      if (!p.assets[a.assetId]) fail("not_found", `no asset ${a.assetId}`);
      const users = p.tracks.flatMap((t): (VideoItem | AudioItem | CaptionItem | OverlayItem)[] => t.items).filter((i) => ("assetId" in i && i.assetId === a.assetId) || ("grade" in i && i.grade?.lut?.assetId === a.assetId) || ("component" in i && i.component === "Sticker" && i.props.src === p.assets[a.assetId].path));
      if (p.assets[a.assetId].kind === "font") {
        const styled = (s: TextStyle | undefined) => s?.font === a.assetId;
        const themeUsers = Object.entries(p.themes ?? {}).filter(([, theme]) => Object.values(theme.roles).some(styled)).map(([id]) => `theme ${id}`);
        const trackUsers = p.tracks.filter((t) => t.kind === "caption" && styled(t.textStyle)).map((t) => `track ${t.id}`);
        const itemUsers = p.tracks.flatMap((t) => t.kind === "overlay" ? t.items.filter((i) => i.component === "Text" && styled(i.props.textStyle as TextStyle | undefined)).map((i) => i.id) : []);
        const allUsers = [...themeUsers, ...trackUsers, ...itemUsers];
        if (allUsers.length) fail("invalid", `${a.assetId} is used by ${allUsers.join(", ")}; update those styles first`);
      }
      if (users.length) fail("invalid", `${a.assetId} is used by ${users.map((i) => i.id).join(", ")}; delete those first`);
      const { path } = p.assets[a.assetId];
      delete p.assets[a.assetId];
      return `removed ${a.assetId} from the project (${path} kept on disk)`;
    },
  ),

  insertItem: def(
    "Insert one item at frame `at`: pass assetId (video/audio/image), component (overlay), or text (free caption). Omitted trackId picks the first track of the right kind with room, else creates one. Ripple defaults to the track's magnetic flag.",
    z
      .object({
        trackId: Id.optional(),
        assetId: Id.optional(),
        component: z.string().min(1).optional(),
        props: Patch.optional(),
        text: z.string().optional(),
        at: frameArg(Frames.min(0)),
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
        if (asset.kind === "lut" || asset.kind === "font") fail("invalid", `${asset.kind.toUpperCase()} assets cannot be inserted on a track`);
        kind = asset.kind === "audio" ? "audio" : "video";
        const sourceIn = a.sourceIn ?? 0;
        const len = asset.kind === "image" ? undefined : ctx.assetDurations?.[asset.id];
        const duration =
          a.duration ??
          (len !== undefined ? Math.floor((len - sourceIn) * p.meta.fps) : fail("invalid", "duration required (asset duration unknown; run splicewright ingest)"));
        item = { id: newId(p, "i"), start: a.at, duration, assetId: asset.id, sourceIn };
      } else if (a.component !== undefined) {
        kind = "overlay";
        const duration = a.duration ?? fail("invalid", "duration required");
        if (a.component === "Text") checkText(a.props ?? {}, p);
        if (a.component === "Sticker") {
          const sticker = StickerProps.safeParse(a.props ?? {});
          if (!sticker.success || !Object.values(p.assets).some((asset) => asset.kind === "image" && asset.path === sticker.data.src))
            fail("invalid", "Sticker src must reference an imported image; fit must be contain or cover");
        }
        item = { id: newId(p, "i"), start: a.at, duration, component: a.component, props: a.props ?? {} };
      } else {
        kind = "caption";
        const duration = a.duration ?? fail("invalid", "duration required");
        item = { id: newId(p, "c"), start: a.at, duration, mode: "free", text: a.text! };
      }
      const t = a.trackId
        ? findTrack(p, a.trackId)
        : (p.tracks.find((t) => t.kind === kind && ((a.ripple ?? t.magnetic) || fits(t, a.at, item.duration))) ??
          addTrack(p, kind));
      if (t.kind !== kind) fail("invalid", `${t.id} is a ${t.kind} track; this item needs ${kind}`);
      if (a.ripple ?? t.magnetic) shift(p, t, a.at, item.duration);
      (t.items as Item[]).push(item);
      return `inserted ${item.id} on ${t.id} at ${a.at} (${item.duration}f)`;
    },
  ),

  split: def(
    "Split an item at timeline frame `at`. The second half gets a new id; items anchored to it follow whichever half holds their first frame.",
    z.object({ itemId: Id, at: frameArg(Frames) }),
    (p, a) => {
      const { track: t, item } = locate(p, a.itemId);
      if (anchorOf(item)) fail("invalid", `${item.id} is anchored; detach it first (attach with to: null)`);
      if (a.at <= item.start || a.at >= end(item))
        fail("invalid", `split point ${a.at} is not inside ${item.id} [${item.start}, ${end(item)})`);
      const offset = a.at - item.start;
      const second = structuredClone(item);
      second.id = newId(p, t.kind === "caption" ? "c" : "i");
      second.start = a.at;
      second.duration = item.duration - offset;
      item.duration = offset;
      if ("sourceIn" in second) {
        if (t.kind === "video" && (item as VideoItem).reverse) (item as VideoItem).sourceIn += second.duration * secPerFrame(p, item as VideoItem);
        else (second as VideoItem | AudioItem).sourceIn += offset * secPerFrame(p, item as VideoItem);
      }
      if (t.kind === "overlay") advanceOverlayKeys(second as OverlayItem, offset / p.meta.fps);
      delete (second as { fadeIn?: number }).fadeIn;
      delete (item as { fadeOut?: number }).fadeOut;
      delete (item as VideoItem).transition; // it leads out of the second half now
      (t.items as Item[]).splice(t.items.indexOf(item as never) + 1, 0, second);

      let moved = 0;
      if ("sourceIn" in second && t.kind === "video")
        // ponytail: an anchored item spanning the cut stays with the first half and is clipped at
        // the cut; duplicate it into both halves if that proves visible.
        for (const other of allItems(p)) {
          const anchor = anchorOf(other);
          if (
            anchor?.itemId === item.id &&
            ((item as VideoItem).reverse
              ? anchor.sourceStart < (second as VideoItem).sourceIn + second.duration * secPerFrame(p, item as VideoItem) - 1e-9
              : anchor.sourceStart >= (second as VideoItem).sourceIn - 1e-9)
          ) {
            anchor.itemId = second.id;
            moved++;
          }
        }
      return `split ${item.id} at ${a.at} → ${item.id}, ${second.id}` + (moved ? `; ${moved} anchored items re-pointed` : "");
    },
  ),

  trim: def(
    "Move an item's start or end edge to frame `to`. Trimming start moves start and sourceIn together; with ripple the later items follow instead. On an anchored item this fine-tunes its anchor, and it stays anchored.",
    z.object({ itemId: Id, edge: z.enum(["start", "end"]), to: frameArg(Frames.min(0)), ripple: z.boolean().optional() }),
    (p, a) => {
      const { track: t, item } = locate(p, a.itemId);
      const anchor = anchorOf(item);
      if (anchor) {
        if (a.edge === "start" ? a.to >= end(item) : a.to <= item.start) fail("invalid", `trim leaves ${item.id} with no duration`);
        const origin = t.kind === "overlay" ? keyframeFrame(p, item as OverlayItem, (item as OverlayItem).keyframeOffset ?? 0) : 0;
        anchor[a.edge === "start" ? "sourceStart" : "sourceEnd"] = toSource(p, anchor, a.to);
        if (t.kind === "overlay") advanceOverlayKeys(item as OverlayItem, (keyframeFrame(p, item as OverlayItem, (item as OverlayItem).keyframeOffset ?? 0) - origin) / p.meta.fps);
        return `re-anchored ${item.id} ${a.edge} → ${spanText(p, item)}`;
      }
      const oldEnd = end(item);
      const ripple = a.ripple ?? t.magnetic ?? false;
      if (a.edge === "end") {
        const delta = a.to - oldEnd;
        item.duration += delta;
        if ("sourceIn" in item && t.kind === "video" && (item as VideoItem).reverse) {
          item.sourceIn -= delta * secPerFrame(p, item as VideoItem);
          if (item.sourceIn < 0) fail("invalid", `reverse trim moves ${item.id} before source time 0`);
        }
        if (ripple) shift(p, t, oldEnd, delta);
      } else {
        // The right edge stays put (or, with ripple, the left edge stays and later items follow).
        const delta = a.to - item.start;
        item.duration -= delta;
        if ("sourceIn" in item && !(t.kind === "video" && (item as VideoItem).reverse)) item.sourceIn += delta * secPerFrame(p, item as VideoItem);
        if (t.kind === "overlay") advanceOverlayKeys(item as OverlayItem, delta / p.meta.fps);
        if (ripple) shift(p, t, oldEnd, -delta);
        else {
          item.start = a.to;
        }
      }
      if (item.duration < 1) fail("invalid", `trim leaves ${item.id} with no duration`);
      return `trimmed ${item.id} ${a.edge} → [${item.start}, ${end(item)})` + (ripple ? " (ripple)" : "");
    },
  ),

  move: def(
    "Move an item to frame `to`, optionally onto another track of the same kind. Overlap is rejected unless ripple (then `to` is read after the source gap closes). On an anchored item this shifts its anchor, and it stays anchored.",
    z.object({ itemId: Id, to: frameArg(Frames.min(0)), trackId: Id.optional(), ripple: z.boolean().optional() }),
    (p, a) => {
      const { track: src, item } = locate(p, a.itemId);
      const dst = a.trackId ? findTrack(p, a.trackId) : src;
      if (dst.kind !== src.kind) fail("invalid", `cannot move a ${src.kind} item to ${dst.kind} track ${dst.id}`);
      if (src === dst && !anchorOf(item) && a.to === item.start)
        return `moved ${item.id} to ${dst.id} at ${a.to}`;
      src.items.splice(src.items.indexOf(item as never), 1);
      (dst.items as Item[]).push(item);
      const anchor = anchorOf(item);
      if (anchor) {
        const delta = toSource(p, anchor, a.to) - toSource(p, anchor, item.start);
        anchor.sourceStart += delta;
        anchor.sourceEnd += delta;
        return `re-anchored ${item.id} on ${dst.id} → ${spanText(p, item)}`;
      }
      // With ripple, `to` is read after the source gap has closed.
      if (a.ripple ?? src.magnetic) shift(p, src, end(item), -item.duration);
      if (a.ripple ?? dst.magnetic) shift(p, dst, a.to, item.duration);
      item.start = a.to;
      return `moved ${item.id} to ${dst.id} at ${a.to}`;
    },
  ),

  delete: def(
    "Delete items. Ripple (default on magnetic tracks) closes the gap. Captions anchored to a deleted item go too; overlays attached to it are detached in place.",
    z.object({ itemIds: z.array(Id).min(1), ripple: z.boolean().optional() }),
    (p, a) => {
      const ids = [...new Set<string>(a.itemIds)];
      // Latest first, so a ripple never shifts an item that is still to be deleted.
      const targets = ids.map((id) => locate(p, id)).sort((x, y) => y.item.start - x.item.start);
      for (const { track: t, item } of targets) {
        t.items.splice(t.items.indexOf(item as never), 1);
        if (a.ripple ?? t.magnetic) shift(p, t, end(item), -item.duration);
      }
      return `deleted ${ids.join(", ")}` + dropAnchored(p, ids);
    },
  ),

  cutRanges: def(
    "Remove source ranges [sourceStart, sourceEnd] (asset seconds, as findFillers returns them) from an item: splits at each range and deletes the piece, latest first, in one undo step. Ripple (default on) closes the gaps; false leaves them. Ranges outside the item's visible source are clamped or ignored. Anchored captions follow as for split and delete.",
    z.object({ itemId: Id, ranges: z.array(z.tuple([z.number().min(0), z.number().min(0)])).min(1), ripple: z.boolean().optional() }),
    (p, a, ctx) => {
      const { track: t, item } = locate(p, a.itemId);
      if (!("sourceIn" in item)) fail("invalid", `${item.id} has no source to cut`);
      const media = item as VideoItem | AudioItem;
      const whole = [media.start, end(media)];
      const reverse = "reverse" in media && media.reverse;
      // Source seconds → timeline frames, clamped to the item as it is now; later cuts leave earlier frames untouched.
      const cuts = a.ranges
        .map(([s, e]) => [
          Math.max(whole[0], Math.round(frameOf(p, media, reverse ? e - secPerFrame(p, media) : s))),
          Math.min(whole[1], Math.round(frameOf(p, media, reverse ? s : e)) + (reverse ? 1 : 0)),
        ])
        .filter(([from, to]) => to > from)
        .sort((x, y) => x[0] - y[0]);
      const merged: number[][] = [];
      for (const c of cuts) {
        const last = merged.at(-1);
        if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]);
        else merged.push([...c]);
      }
      let removed = 0;
      for (const [from, to] of merged.reverse()) {
        // The item keeps the earliest piece, so each cut splits it again.
        if (to < end(media)) ops.split.run(p, { itemId: media.id, at: to }, ctx);
        let mid: Item = media;
        if (from > media.start) {
          ops.split.run(p, { itemId: media.id, at: from }, ctx);
          mid = t.items.find((i) => i !== media && i.start === from)!;
        }
        ops.delete.run(p, { itemIds: [mid.id], ripple: a.ripple ?? true }, ctx);
        removed += to - from;
      }
      return removed ? `cut ${merged.length} ranges from ${a.itemId} (${removed}f)` : `no range inside ${a.itemId}; nothing cut`;
    },
  ),

  closeGap: def(
    "Close the empty span containing frame `at` on a track: every later item shifts left to meet the item before it (or frame 0). Anchored items are skipped; they follow their anchor item.",
    z.object({ trackId: Id, at: Frames.min(0) }),
    (p, a) => {
      const t = findTrack(p, a.trackId);
      const gap = gapAt(t, a.at);
      if (!gap) fail("invalid", `frame ${a.at} on ${t.id} is not in a gap with items after it`);
      const [from, to] = gap;
      for (const i of t.items) if (!anchorOf(i) && i.start >= to) i.start -= to - from;
      return `closed gap [${from}, ${to}) on ${t.id} (${to - from}f)`;
    },
  ),

  attach: def(
    "Anchor an overlay or caption to a video item's source time at its current position, so it follows that item through trims, ripples and moves. to: null detaches it, freezing it at its current timeline position.",
    z.object({ itemId: Id, to: Id.nullable() }),
    (p, a) => {
      const { track: t, item } = locate(p, a.itemId);
      if (t.kind !== "overlay" && t.kind !== "caption") fail("invalid", `only overlay and caption items can be anchored`);
      const { start, duration } = item; // current span (last known, if hidden)
      const it = item as Record<string, unknown>;
      if (t.kind === "caption") {
        it.mode = "free";
        delete it.itemId;
        delete it.sourceStart;
        delete it.sourceEnd;
      } else delete it.anchor;
      if (a.to === null) return `detached ${item.id} at [${start}, ${start + duration})`;

      const target = videoItems(p).get(a.to) ?? fail("not_found", `video item ${a.to} not found`);
      const anchor = { itemId: target.id, sourceStart: 0, sourceEnd: 0 };
      anchor.sourceStart = toSource(p, anchor, start);
      anchor.sourceEnd = toSource(p, anchor, start + duration);
      if (t.kind === "caption") Object.assign(it, { mode: "anchored", ...anchor });
      else it.anchor = anchor;
      return `attached ${item.id} to ${target.id} → ${spanText(p, item)}`;
    },
  ),

  setProps: def(
    'Patch item fields: volume, fit, transform, effects {brightness, contrast, saturation, hue, blur, grayscale, sepia, invert}, grade {exposure, temperature, tint, vibrance, shadows, highlights, levels, curves, lut}, key {kind: chroma|luma, color, similarity, smoothness, spill, low, high, invert}, crop {top, right, bottom, left} (fractions), mask {shape: rect|ellipse|diamond|star|polygon, x, y, w, h (fractions of the fitted picture box, x,y = top-left, w,h > 0), radius (rect only, 0..0.5 of min(w,h)), points [[x,y],...] (polygon only, >= 3, fractions of the mask box), feather (px, 0..200), invert} (video and overlay; drawn after crop), blend (video and overlay: normal|multiply|screen|overlay|darken|lighten|difference), keyframes (whole map; use setKeyframe to key one value), fadeIn, fadeOut, transition {kind: dissolve|dip|wipe|slide|push|zoom, duration, direction (left|right|up|down: side the incoming picture enters from, default left; wipe/slide/push)}, speed (video; speed here keeps duration, so the source range scales; setSpeed keeps the source range); volume, fadeIn, fadeOut (audio); audioFx (video/audio: eq [{hz,gain,q?}], pan -1..1, denoise {kind: fft|rnnoise,mix?}; RNNoise requires model path raw/<name>.rnnn, supplied by the user); props (overlay; a Text overlay takes text, role title|subtitle|emphasis|handwritten (default title), textStyle {font (a built-in font name), weight, size px, color, tracking em, lineHeight, upper, align, stroke {color,width}, shadow {color,blur,y}, box {color,radius,pad}} over the theme role, style raw CSS); label, note (all). null unsets.',z.object({ itemId: Id, patch: Patch }), (p, a) => {
    const { track: t, item } = locate(p, a.itemId);
    patch(item as Record<string, unknown>, a.patch, ITEM_PROPS[t.kind], `${t.kind} item ${item.id}`);
    if (a.patch.audioFx !== undefined && a.patch.audioFx !== null && "assetId" in item && p.assets[item.assetId]?.kind === "image")
      fail("invalid", `${item.id} uses an image asset and cannot have audio processing`);
    const v = item as VideoItem;
    if (v.grade?.lut && p.assets[v.grade.lut.assetId]?.kind !== "lut") fail("invalid", `grade LUT ${v.grade.lut.assetId} must reference an imported .cube LUT asset`);
    if (a.patch.mask === null && v.keyframes) {
      // keys of a removed mask would override the geometry of the next one
      for (const k of Object.keys(MASK_PROPS)) delete v.keyframes[k as keyof typeof MASK_PROPS];
      if (!Object.keys(v.keyframes).length) delete v.keyframes;
    }
    if ("grade" in a.patch && !(a.patch.grade as VideoItem["grade"] | null)?.lut) {
      delete v.lutKeyframes;
      if (v.keyframes?.lutStrength) {
        delete v.keyframes.lutStrength;
        if (!Object.keys(v.keyframes).length) delete v.keyframes;
      }
    }
    if (t.kind === "overlay" && (item as OverlayItem).component === "Text") checkText((item as OverlayItem).props, p);
    if (t.kind === "overlay" && (item as OverlayItem).component === "Sticker") {
      const sticker = StickerProps.safeParse((item as OverlayItem).props);
      if (!sticker.success || !Object.values(p.assets).some((asset) => asset.kind === "image" && asset.path === sticker.data.src))
        fail("invalid", "Sticker src must reference an imported image; fit must be contain or cover");
    }
    return `updated ${item.id}: ${Object.keys(a.patch).join(", ")}`;
  }),

  setSpeed: def(
    "Play a video item at `speed` (0.1–10, 1 = normal) over the same source range: its duration scales to fit. With ripple (default on magnetic tracks) later items follow its new end.",
    z.object({ itemId: Id, speed: z.number().min(0.1).max(10), ripple: z.boolean().optional() }),
    (p, a) => {
      const { track: t, item } = locate(p, a.itemId);
      const v = item as VideoItem;
      if (t.kind !== "video" || !("assetId" in v) || p.assets[v.assetId]?.kind === "image") fail("invalid", `${item.id} is not a video clip`);
      const oldEnd = end(v);
      v.duration = Math.max(1, Math.round((v.duration * (v.speed ?? 1)) / a.speed));
      if (a.speed === 1) delete v.speed;
      else v.speed = a.speed;
      if (a.ripple ?? t.magnetic) shift(p, t, oldEnd, end(v) - oldEnd);
      return `${item.id} at ${a.speed}× → ${v.duration}f`;
    },
  ),

  setKeyframe: def(
    `Key video transform/effects/mask/volume and Color values (${[...ANIMATABLE, ...GRADE_ANIMATABLE].join(", ")}), an audio item's volume, or an overlay transform (${OVERLAY_TRANSFORM_ANIMATABLE.join(", ")}) to numeric value at timeline frame at. Overlays may also key an existing numeric component prop using props.<name>. Overlay keys use item-local seconds; media keys use source seconds. LUT strength is numeric; use setLutKeyframe to switch LUT assets discretely.`,
    z.object({ itemId: Id, prop: z.string().min(1), at: z.number().int(), value: z.number().nullable(), ease: Ease.optional() }),
    (p, a) => {
      const { track: t, item } = locate(p, a.itemId);
      const span = itemSpan(p, item);
      if (!span || a.at < span.start || a.at >= span.start + span.duration) fail("invalid", `frame ${a.at} is outside ${item.id}'s visible span`);
      if (t.kind === "overlay") {
        const v = item as OverlayItem;
        const customPath = a.prop.startsWith("props.") ? a.prop.slice(6).split(".") : [];
        const customRoot = customPath.length === 2 ? v.props[customPath[0]] : undefined;
        const customValue = customPath.length === 1 ? v.props[customPath[0]] : customPath.length === 2 && customRoot && typeof customRoot === "object" ? (customRoot as Record<string, unknown>)[customPath[1]] : undefined;
        const custom = customPath.length > 0 && typeof customValue === "number";
        if (!(OVERLAY_TRANSFORM_ANIMATABLE as readonly string[]).includes(a.prop) && !custom) fail("invalid", `${v.id} can key overlay transform props or existing numeric component props via props.<name>[.<nestedName>]; ${a.prop} is not numeric or absent`);
        if (a.value === null && !keyAt(p, v, a.prop, a.at)) fail("invalid", `${v.id} has no ${a.prop} key at frame ${a.at}`);
        const kf = withKey(p, v, a.prop, a.at, a.value, a.ease);
        if (kf) v.keyframes = kf as OverlayItem["keyframes"];
        else delete v.keyframes;
        return a.value === null ? `removed ${a.prop} key on ${v.id} at ${a.at}` : `keyed ${v.id} ${a.prop} = ${a.value} at ${a.at}`;
      }
      if (!["video", "audio"].includes(t.kind) || !("assetId" in item)) fail("invalid", `${item.id} is not a video or audio item`);
      const v = item as VideoItem;
      const supported = t.kind === "audio" ? a.prop === "volume" : [...ANIMATABLE, ...GRADE_ANIMATABLE].includes(a.prop as never);
      if (!supported) fail("invalid", `${v.id} does not support numeric key ${a.prop}`);
      if (a.prop in MASK_PROPS && !v.mask) fail("invalid", `${v.id} has no mask to key ${a.prop} on; set one with setProps first`);
      if (a.prop === "lutStrength" && !v.grade?.lut) fail("invalid", `${v.id} has no LUT to key strength on; set one with setProps first`);
      if (a.value === null && !keyAt(p, v, a.prop, a.at)) fail("invalid", `${v.id} has no ${a.prop} key at frame ${a.at}`);
      const kf = withKey(p, v, a.prop, a.at, a.value, a.ease);
      if (kf) v.keyframes = kf;
      else delete v.keyframes;
      return a.value === null ? `removed ${a.prop} key on ${v.id} at ${a.at}` : `keyed ${v.id} ${a.prop} = ${a.value} at ${a.at}`;
    },
  ),

  setLutKeyframe: def(
    "Switch a video item's LUT at timeline frame at. Asset selection is discrete and holds the most recent key; LUTs are never blended with each other. Strength is animated separately with setKeyframe prop lutStrength.",
    z.object({ itemId: Id, at: z.number().int(), assetId: Id.nullable() }),
    (p, a) => {
      const { track: t, item } = locate(p, a.itemId);
      if (t.kind !== "video" || !("assetId" in item)) fail("invalid", `${item.id} is not a video item`);
      const v = item as VideoItem;
      if (a.at < v.start || a.at >= end(v)) fail("invalid", `frame ${a.at} is outside ${v.id} [${v.start}, ${end(v)})`);
      if (!v.grade?.lut) fail("invalid", `${v.id} has no LUT to switch; set one with setProps first`);
      const at = sourceAt(p, v, a.at);
      const keys = (v.lutKeyframes ?? []).filter((key) => Math.abs(key.t - at) >= secPerFrame(p, v) / 2);
      if (a.assetId !== null) {
        if (p.assets[a.assetId]?.kind !== "lut") fail("invalid", `${a.assetId} is missing or is not a LUT asset`);
        keys.push({ t: +at.toFixed(4), assetId: a.assetId });
        keys.sort((x, y) => x.t - y.t);
      }
      if (keys.length) v.lutKeyframes = keys;
      else delete v.lutKeyframes;
      return a.assetId === null ? `removed LUT key on ${v.id} at ${a.at}` : `keyed LUT ${a.assetId} on ${v.id} at ${a.at}`;
    },
  ),

  detachAudio: def(
    "Split a video item's sound off onto an audio track: an audio item with the same asset, start, duration, sourceIn, volume, fadeIn and fadeOut goes on the first unlocked audio track with room (else a new one), and the video item's volume becomes 0. One undo step. The two items are not linked afterwards, so trimming, moving or splitting one leaves the other alone; that is what makes J/L-cuts: detach, then trim the audio separately. Transitions and fades on the video item keep affecting its picture only (a dissolve's audio crossfade is lost), so fade the audio item instead. Only unlocked, unmuted, visible audio tracks at volume 1 are reused. Refused when the video track is muted or hidden, and for images, for speed ≠ 1 (audio items have no speed). Volume keyframes move to the audio item as they are (they are in source time).",
    z.object({ itemId: Id }),
    (p, a) => {
      const { track: t, item } = locate(p, a.itemId);
      const v = item as VideoItem;
      if (t.kind !== "video" || !("assetId" in v) || p.assets[v.assetId]?.kind !== "video") fail("invalid", `${item.id} is not a video clip with sound`);
      if ((v.speed ?? 1) !== 1) fail("invalid", `${v.id} plays at ${v.speed}×; audio items have no speed yet, set it back to 1 first`);
      if (v.volume === 0) fail("invalid", `${v.id} is already silent; nothing to detach`);
      const audio: AudioItem = {
        id: newId(p, "i"),
        start: v.start,
        duration: v.duration,
        assetId: v.assetId,
        sourceIn: v.sourceIn,
        ...(v.volume !== undefined && { volume: v.volume }),
        ...(v.keyframes?.volume && { keyframes: { volume: v.keyframes.volume } }),
        ...(v.fadeIn && { fadeIn: v.fadeIn }),
        ...(v.fadeOut && { fadeOut: v.fadeOut }),
      };
      if (t.muted || t.hidden) fail("invalid", `track ${t.id} is ${t.muted ? "muted" : "hidden"}; unmute/show it first or delete the audio instead`);
      // Only plain tracks: a track volume, mute or hide would change how the dialogue sounds.
      const to = p.tracks.find((x) => x.kind === "audio" && !x.locked && !x.muted && !x.hidden && (x.volume ?? 1) === 1 && fits(x, v.start, v.duration)) ?? addTrack(p, "audio");
      (to.items as Item[]).push(audio);
      v.volume = 0;
      if (v.keyframes?.volume) {
        delete v.keyframes.volume;
        if (!Object.keys(v.keyframes).length) delete v.keyframes;
      }
      return `detached ${v.id} audio to ${audio.id} on ${to.id}`;
    },
  ),

  normalizeLoudness: def(
    "Set each audio or video item's `volume` so its asset plays at `target` LUFS (default -14): volume = 10^((target - L) / 20), where L is the asset's integrated loudness from the `loudness` ingest step, clamped to 0..2 (so a very quiet asset may stay below target). It measures whole assets, not the trimmed range, and ignores track volume, fades and ducking. Run it before mixing dialogue and music so their levels start comparable. Items at volume 0 (e.g. the video after detachAudio) are skipped and reported in the summary, so passing every item is safe. All or nothing, one undo step. Refused for items whose asset has no loudness yet (run `splicewright ingest --only loudness`; silent assets have none) and for items with volume keyframes (remove them first).",
    z.object({ itemIds: z.array(Id).min(1), target: z.number().min(-70).max(0).default(-14) }),
    (p, a, ctx) => {
      let silent = 0;
      for (const id of a.itemIds) {
        const { track: t, item } = locate(p, id);
        if (!["video", "audio"].includes(t.kind) || !("assetId" in item)) fail("invalid", `${id} is not an audio or video item`);
        if (item.volume === 0) {
          silent++; // deliberately silenced, e.g. the video after detachAudio; raising it would double the sound
          continue;
        }
        const l = item.audioFx ? ctx.audioFxLoudness?.[item.id] : ctx.loudness?.[item.assetId];
        if (l === undefined) fail("not_found", `no ${item.audioFx ? "processed " : ""}loudness for ${item.id}; run splicewright ingest --only loudness and wait for audio processing`);
        if (item.keyframes?.volume) fail("invalid", `${id} has volume keyframes; remove them before normalizing`);
        item.volume = Math.min(2, Math.max(0, 10 ** ((a.target - l) / 20)));
      }
      return `normalized ${a.itemIds.length - silent} items to ${a.target} LUFS` + (silent ? `; skipped ${silent} silent (volume 0)` : "");
    },
  ),

  slip: def(
    'Shift which source media an item shows by deltaSec; timeline position unchanged.',z.object({ itemId: Id, deltaSec: z.number() }), (p, a) => {
    const { item } = locate(p, a.itemId);
    if (!("sourceIn" in item)) fail("invalid", `${item.id} has no source media to slip`);
    item.sourceIn += a.deltaSec;
    return `slipped ${item.id} to sourceIn ${item.sourceIn.toFixed(3)}s`;
  }),

  addTrack: def(
    'Add an empty track of a kind.',z.object({ kind: z.enum(KINDS), name: z.string().optional(), magnetic: z.boolean().optional() }), (p, a) => {
    const t = addTrack(p, a.kind, a.name, a.magnetic);
    return `added ${a.kind} track ${t.id} (${t.name})`;
  }),

  removeTrack: def(
    'Remove a track and its items. Captions anchored to its items go too; overlays attached to them are detached in place.',z.object({ trackId: Id }), (p, a) => {
    const t = findTrack(p, a.trackId);
    p.tracks.splice(p.tracks.indexOf(t), 1);
    return `removed track ${t.id} with ${t.items.length} items` + dropAnchored(p, t.items.map((i) => i.id));
  }),

  setTrack: def(
    'Patch track fields: name, muted, hidden, locked, magnetic, volume (audio), style (caption), textStyle (caption; TextStyle over the theme subtitle role, see setProps), highlight (caption: none|word, per-word highlight in the emphasis style on anchored captions). null unsets.',z.object({ trackId: Id, patch: Patch }), (p, a) => {
    const t = findTrack(p, a.trackId);
    patch(t as Record<string, unknown>, a.patch, TRACK_PROPS[t.kind], `${t.kind} track ${t.id}`);
    if (t.kind === "caption") {
      const bad = badFont(t.textStyle, p.assets);
      if (bad) fail("invalid", bad);
    }
    return `updated track ${t.id}: ${Object.keys(a.patch).join(", ")}`;
  }),

  // fps and size are not settable: frame positions and normalized transforms/masks would need retiming or rescaling.
  setMeta: def(
    `Patch project meta: title, background, limiter (render-only −1 dBFS master limiter), theme (one op restyles every role-bound Text overlay and caption track; built-in: ${THEME_IDS.join(", ")}, or a key of themes), themes ({id: {name, roles: {title|subtitle|emphasis|handwritten: TextStyle}}}, project-defined themes; whole map). null unsets background/limiter/theme/themes. fps and size are fixed at init.`,
    z.object({ title: z.string().min(1).optional(), background: z.string().nullable().optional(), limiter: z.boolean().nullable().optional(), theme: z.string().nullable().optional(), themes: z.record(z.string().min(1), Theme).nullable().optional() }).strict(),
    (p, a) => {
      const { themes, ...meta } = a;
      patch(p.meta as Record<string, unknown>, meta, ["title", "background", "limiter", "theme"], "meta");
      if (themes !== undefined) {
        if (themes === null) delete p.themes;
        else p.themes = themes;
      }
      for (const t of Object.values(p.themes ?? {})) for (const s of Object.values(t.roles)) checkText({ textStyle: s }, p);
      if (p.meta.theme && !isTheme(p, p.meta.theme)) fail("invalid", `unknown theme "${p.meta.theme}"; one of: ${[...THEME_IDS, ...Object.keys(p.themes ?? {})].join(", ")}`);
      return `updated meta: ${Object.keys(a).join(", ")}`;
    },
  ),

  moveTrack: def(
    "Move a track to index `to` in the layer order (0 = bottom).",
    z.object({ trackId: Id, to: z.number().int().min(0) }),
    (p, a) => {
      const t = findTrack(p, a.trackId);
      p.tracks.splice(p.tracks.indexOf(t), 1);
      p.tracks.splice(Math.min(a.to, p.tracks.length), 0, t);
      return `moved track ${t.id} to layer ${p.tracks.indexOf(t)}`;
    },
  ),

  addCaptionsFromTranscript: def(
    "Create captions anchored to a video item's source time from its asset transcript (visible segments only).",z.object({ itemId: Id, trackId: Id.optional() }), (p, a, ctx) => {
    const { track: src, item } = locate(p, a.itemId);
    if (src.kind !== "video" || !("assetId" in item)) fail("invalid", `${a.itemId} is not a video item`);
    const assetId = (item as { assetId: string }).assetId;
    const segs = ctx.transcript?.(assetId) ?? fail("not_found", `no transcript for ${assetId}; run ingest`);
    const t = a.trackId ? findTrack(p, a.trackId) : (p.tracks.find((t) => t.kind === "caption") ?? addTrack(p, "caption"));
    if (t.kind !== "caption") fail("invalid", `${t.id} is not a caption track`);
    let n = 0;
    for (const s of segs) {
      const text = s.text.trim();
      const cap: CaptionItem = { id: "", start: 0, duration: 1, mode: "anchored", itemId: item.id, sourceStart: s.start, sourceEnd: s.end, text };
      // Only segments visible now; a later trim that extends the item won't pull in the others.
      if (!text || !itemSpan(p, cap)) continue;
      cap.id = newId(p, "c");
      (t.items as Item[]).push(cap);
      n++;
    }
    return `added ${n} captions for ${item.id} on ${t.id}`;
  }),

  editCaption: def(
    "Replace a caption's text. Empty text hides it.",z.object({ captionId: Id, text: z.string() }), (p, a) => {
    const { item } = locate(p, a.captionId);
    if (!("mode" in item)) fail("invalid", `${a.captionId} is not a caption`);
    (item as CaptionItem).text = a.text;
    return a.text ? `edited ${a.captionId}` : `hid ${a.captionId}`;
  }),

  addMarker: def(
    "Add a named marker (point or range) on the timeline.",
    z.object({ label: z.string(), start: Frames.min(0), duration: Frames.min(1).optional(), color: z.string().optional() }),
    (p, a) => {
      const id = newId(p, "m");
      (p.markers ??= []).push({ id, ...a });
      p.markers.sort((x, y) => x.start - y.start);
      return `added marker ${id} "${a.label}" at ${a.start}`;
    },
  ),

  removeMarker: def(
    'Remove a marker.',z.object({ markerId: Id }), (p, a) => {
    const i = (p.markers ?? []).findIndex((m) => m.id === a.markerId);
    if (i === -1) fail("not_found", `marker ${a.markerId} not found`);
    p.markers!.splice(i, 1);
    return `removed marker ${a.markerId}`;
  }),

  setMarker: def(
    "Patch marker fields: label, start, duration, color. null unsets duration or color.",
    z.object({ markerId: Id, patch: Patch }),
    (p, a) => {
      const m = (p.markers ?? []).find((m) => m.id === a.markerId) ?? fail("not_found", `marker ${a.markerId} not found`);
      patch(m as Record<string, unknown>, a.patch, ["label", "start", "duration", "color"], `marker ${m.id}`);
      p.markers!.sort((x, y) => x.start - y.start);
      return `updated marker ${m.id}: ${Object.keys(a.patch).join(", ")}`;
    },
  ),

  detectBeats: def(
    "Copy beats from the ingest cache (splicewright ingest --only beats) into an audio item, replacing its current beats.",
    z.object({ itemId: Id, density: DENSITY.default("all") }),
    (p, a, ctx) => {
      const item = audioItem(p, a.itemId);
      const r = ctx.beats?.(item.assetId) ?? fail("not_found", `no beat analysis for ${item.assetId}; run splicewright ingest --only beats`);
      let beats = r.beats.map((b) => b.t);
      if (a.density === "strong") {
        const s = r.beats.map((b) => b.strength).sort((x, y) => x - y);
        const cut = s[Math.floor(s.length * 0.6)] ?? 0;
        beats = r.beats.filter((b) => b.strength > cut).map((b) => b.t);
      } else if (a.density === "downbeat") beats = [...r.downbeats];
      else if (a.density.startsWith("every:")) {
        const n = Number(a.density.slice(6));
        const first = Math.max(0, beats.findIndex((t) => Math.abs(t - (r.downbeats[0] ?? beats[0])) < 1e-6));
        beats = beats.filter((_, i) => i >= first && (i - first) % n === 0);
      }
      beats.sort((x, y) => x - y);
      const down = r.downbeats.filter((t) => beats.includes(t));
      delete item.beats, delete item.downbeats;
      if (beats.length) item.beats = beats;
      if (down.length) item.downbeats = down;
      return `${item.id}: ${beats.length} beats (${a.density}, ${r.tempo.toFixed(1)} BPM); ${beatFrames(p, item).length} visible`;
    },
  ),

  addBeat: def(
    "Add a beat to an audio item at timeline frame `at` (manual correction, tap-along).",
    z.object({ itemId: Id, at: frameArg(Frames.min(0)) }),
    (p, a) => {
      const item = audioItem(p, a.itemId);
      if (a.at < item.start || a.at >= end(item)) fail("invalid", `frame ${a.at} is outside ${item.id} [${item.start}, ${end(item)})`);
      if (beatFrames(p, item).includes(a.at)) return `${item.id} already has a beat at ${a.at}`;
      item.beats = [...(item.beats ?? []), +(item.sourceIn + (a.at - item.start) / p.meta.fps).toFixed(4)].sort((x, y) => x - y);
      return `added beat to ${item.id} at ${a.at}`;
    },
  ),

  removeBeat: def(
    "Remove an audio item's beat at timeline frame `at`.",
    z.object({ itemId: Id, at: frameArg(Frames.min(0)) }),
    (p, a) => {
      const item = audioItem(p, a.itemId);
      const frame = (t: number) => item.start + Math.round((t - item.sourceIn) * p.meta.fps);
      const keep = (item.beats ?? []).filter((t) => frame(t) !== a.at);
      if (keep.length === (item.beats ?? []).length) fail("not_found", `${item.id} has no beat at ${a.at}`);
      const down = (item.downbeats ?? []).filter((t) => frame(t) !== a.at);
      delete item.beats, delete item.downbeats;
      if (keep.length) item.beats = keep;
      if (down.length) item.downbeats = down;
      return `removed beat from ${item.id} at ${a.at}`;
    },
  ),

  clearBeats: def("Remove all beats from an audio item.", z.object({ itemId: Id }), (p, a) => {
    const item = audioItem(p, a.itemId);
    const n = item.beats?.length ?? 0;
    delete item.beats, delete item.downbeats;
    return `cleared ${n} beats from ${item.id}`;
  }),

  fitToBeats: def(
    "Beat sync: walk consecutive items on a magnetic video track and put each cut on the next `every`-th beat of an audio item. Images get the duration directly; video is trimmed, never past its source (a clip too short for the next beat takes the nearest reachable one, or is skipped). range: [from, to) frames or a marker id/label with a duration picks the items by start; from: beats are counted from the last beat at or before this frame (default: the first item's start). One undo step.",
    z.object({
      trackId: Id,
      audioItemId: Id,
      every: z.number().int().min(1).default(1),
      range: z.union([z.tuple([Frames.min(0), Frames.min(1)]), z.string()]).optional(),
      from: Frames.min(0).optional(),
    }),
    (p, a, ctx) => {
      const t = findTrack(p, a.trackId);
      if (t.kind !== "video" || !t.magnetic) fail("invalid", `${t.id} is not a magnetic video track`);
      const beats = beatFrames(p, audioItem(p, a.audioItemId));
      if (!beats.length) fail("invalid", `${a.audioItemId} has no visible beats; run detectBeats first`);
      let [lo, hi] = [0, Infinity];
      if (typeof a.range === "string") {
        const m = (p.markers ?? []).find((m) => m.id === a.range || m.label === a.range) ?? fail("not_found", `marker ${a.range} not found`);
        if (!m.duration) fail("invalid", `marker ${m.id} is a point; range needs a marker with a duration`);
        [lo, hi] = [m.start, m.start + m.duration];
      } else if (a.range) [lo, hi] = a.range;
      const items = t.items.filter((i) => i.start >= lo && i.start < hi);
      if (!items.length) fail("not_found", `no items on ${t.id} start in [${lo}, ${hi})`);

      // Beat grid origin: the last beat at or before `from`; -1 makes the first beat after it beat 1.
      let k = beats.findLastIndex((b) => b <= (a.from ?? items[0].start));
      const changed: string[] = [];
      const notes: string[] = [];
      for (const item of items as (Item & { assetId: string; sourceIn: number })[]) {
        const want = k + a.every;
        if (want >= beats.length) {
          notes.push(`${item.id} skipped (no more beats)`);
          continue;
        }
        let j = want;
        if (p.assets[item.assetId]?.kind === "video") {
          const len = ctx.assetDurations?.[item.assetId];
          const max = len === undefined ? undefined : Math.floor((len - item.sourceIn) / secPerFrame(p, item));
          if (max === undefined) j = -1;
          else while (j >= 0 && beats[j] - item.start > max) j--;
          if (j === -1 || beats[j] <= item.start) {
            notes.push(`${item.id} skipped (${max === undefined ? "source duration unknown; run ingest" : "source too short to reach a beat"})`);
            k = beats.findLastIndex((b) => b <= end(item));
            continue;
          }
          if (j !== want) notes.push(`${item.id} cut at beat ${beats[j]} (source too short for ${beats[want]})`);
        }
        const oldEnd = end(item);
        const delta = beats[j] - oldEnd;
        if (delta) {
          item.duration += delta;
          shift(p, t, oldEnd, delta);
          changed.push(item.id);
        }
        k = j;
      }
      return `fitted ${changed.length} of ${items.length} items on ${t.id} to beats (every ${a.every})` + (changed.length ? `: ${changed.join(", ")}` : "") + (notes.length ? `; ${notes.join("; ")}` : "");
    },
  ),

  batch: def(
    'Apply several ops atomically: all or nothing, one revision, one undo step. ops: [{op, args}].',z.object({ ops: z.array(z.object({ op: z.string(), args: z.unknown() })).min(1) }), (p, a, ctx) => {
    // Intermediate states may be invalid (e.g. swapping two items); only the end result is validated.
    const summaries = a.ops.map(({ op, args }: { op: string; args: unknown }) => {
      const d = ops[op] ?? fail("unknown_op", `unknown op ${op}`);
      return d.run(p, parseArgs(d, resolveNear(p, args)), ctx);
    });
    return `batch of ${summaries.length}: ${summaries.join("; ")}`;
  }),
};

function parseArgs(d: OpDef, args: unknown) {
  const r = d.args.safeParse(args ?? {});
  return r.success ? r.data : fail("invalid_args", z.prettifyError(r.error));
}

/**
 * Replaces { near } in `at` / `to` with the snapped frame. `within` defaults to 1 s. A move snaps
 * either edge of the item; the item's own edges never count. No target in reach is an error, so an
 * agent asking for "the beat near 12 s" never silently gets 12 s.
 */
function resolveNear(p: Project, args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const a = { ...(args as Record<string, unknown>) };
  for (const key of ["at", "to"]) {
    const n = Near.safeParse(a[key]);
    if (!n.success) continue; // plain frames, and malformed objects that parseArgs will report
    const { near, snapTo = ["edge", "marker", "beat"], within = Math.round(p.meta.fps) } = n.data;
    const own = typeof a.itemId === "string" ? a.itemId : undefined;
    const moving = key === "to" && !("edge" in a) && own ? locate(p, own).item : undefined;
    // The item's own edges never count; its own beats do (trim to, or add/remove, a beat), unless it moves with them.
    const points = snapPoints(p, [0, Infinity], { kinds: snapTo }).filter((pt) => pt.ref !== own || (pt.kind === "beat" && !moving));
    const offsets = moving && "beats" in moving ? beatFrames(p, moving as AudioItem).map((f) => f - moving.start) : [];
    const r = moving ? snapSpan(points, near, moving.duration, within, [], offsets) : snap(points, near, within);
    if (!r.target) fail("no_snap_target", `no ${snapTo.join("/")} within ${within} frames of ${near}`);
    a[key] = r.frame;
  }
  return a;
}

/** Recompute derived anchored-item timing and keep items ordered by start. */
function refresh(p: Project) {
  for (const t of p.tracks) {
    for (const i of t.items) {
      const span = anchorOf(i) ? itemSpan(p, i) : null;
      if (span) Object.assign(i, span); // hidden items keep their last timing
    }
    (t.items as Item[]).sort((x, y) => x.start - y.start);
  }
}

/** Run one op: `(project, args) → { project, changes } | { error }`. Never mutates `project`. */
export function apply(project: Project, name: string, args: unknown, ctx: Ctx = {}): OpResult {
  try {
    const d = ops[name] ?? fail("unknown_op", `unknown op ${name}; one of: ${Object.keys(ops).join(", ")}`);
    const parsed = parseArgs(d, resolveNear(project, args));
    const next = structuredClone(project);
    const summary = d.run(next, parsed, ctx);
    // A track this op emptied goes with it (magnetic main tracks stay); tracks created or left empty on purpose are kept.
    const hadItems = new Set(project.tracks.filter((t) => t.items.length).map((t) => t.id));
    next.tracks = next.tracks.filter((t) => t.items.length || t.magnetic || !hadItems.has(t.id));
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

/** Dry-run an atomic operation batch and report timeline starts that would move. */
export function previewOps(project: Project, operations: Array<{ op: string; args: unknown }>, ctx: Ctx = {}): PreviewOpsResult {
  const result = apply(project, "batch", { ops: operations }, ctx);
  if ("error" in result) return result;

  const directTracks = new Set<string>();
  const directItems = new Set<string>();
  const collectTargets = (ops: Array<{ op: string; args: unknown }>) => {
    for (const { op, args } of ops) {
      if (!args || typeof args !== "object") continue;
      const a = args as Record<string, unknown>;
      if (op === "batch" && Array.isArray(a.ops)) {
        collectTargets(a.ops as Array<{ op: string; args: unknown }>);
        continue;
      }
      if (typeof a.trackId === "string") directTracks.add(a.trackId);
      if (typeof a.itemId === "string") directItems.add(a.itemId);
      if (Array.isArray(a.itemIds)) for (const id of a.itemIds) if (typeof id === "string") directItems.add(id);
    }
  };
  collectTargets(operations);
  const oldItems = new Map(project.tracks.flatMap((track) => track.items.map((item) => [item.id, { track, item }] as const)));
  for (const id of directItems) {
    const before = oldItems.get(id);
    if (before) directTracks.add(before.track.id);
  }
  const moved: NonNullable<Extract<PreviewOpsResult, { moved: unknown }>["moved"]> = [];
  for (const track of result.project.tracks) for (const item of track.items) {
    const before = oldItems.get(item.id);
    if (!before || before.item.start === item.start) continue;
    const direct = directItems.has(item.id) || directTracks.has(before.track.id) || directTracks.has(track.id);
    moved.push({ trackId: track.id, itemId: item.id, from: before.item.start, to: item.start, delta: item.start - before.item.start, kind: direct ? "direct" : "secondary" });
  }
  moved.sort((a, b) => a.from - b.from || a.trackId.localeCompare(b.trackId) || a.itemId.localeCompare(b.itemId));
  return {
    revision: project.revision,
    summary: result.changes.summary.slice(0, 2000),
    summaryTruncated: result.changes.summary.length > 2000,
    moved: moved.slice(0, 500),
    movedTotal: moved.length,
    secondaryTotal: moved.filter((item) => item.kind === "secondary").length,
    truncated: moved.length > 500,
    limit: 500,
  };
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
