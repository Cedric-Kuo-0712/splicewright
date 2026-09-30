import { z } from "zod";

// Spec §4. The zod schema is the source of the TypeScript types.

const Frames = z.number().int();
const Seconds = z.number();
const Id = z.string().min(1);

const itemBase = {
  id: Id,
  start: Frames.min(0),
  duration: Frames.min(1),
  label: z.string().optional(),
  note: z.string().optional(),
};

const trackBase = {
  id: Id,
  name: z.string(),
  muted: z.boolean().optional(),
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
  magnetic: z.boolean().optional(),
};

export const Transform = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  scale: z.number().optional(),
  rotation: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
});

/** CSS-filter look; 1 (or 0 for hue, blur, grayscale, sepia, invert) is neutral. */
export const Effects = z.object({
  brightness: z.number().min(0).max(3).optional(),
  contrast: z.number().min(0).max(3).optional(),
  saturation: z.number().min(0).max(3).optional(),
  hue: z.number().min(-180).max(180).optional(),
  blur: z.number().min(0).max(100).optional(),
  grayscale: z.number().min(0).max(1).optional(),
  sepia: z.number().min(0).max(1).optional(),
  invert: z.number().min(0).max(1).optional(),
});

/** Fractions of the picture cut from each side, in the picture's own orientation. */
export const Crop = z
  .object({ top: z.number().min(0).optional(), right: z.number().min(0).optional(), bottom: z.number().min(0).optional(), left: z.number().min(0).optional() })
  .refine((c) => (c.left ?? 0) + (c.right ?? 0) < 1 && (c.top ?? 0) + (c.bottom ?? 0) < 1, { message: "crop leaves nothing visible" });

const Volume = z.number().min(0).max(2);

export const MASK_SHAPES = ["rect", "ellipse", "diamond", "star", "polygon"] as const;
export const BLENDS = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "difference"] as const;

/** x, y, w, h are fractions of the fitted picture box (the one crop is measured in), x,y = top-left; may reach outside 0..1. */
export const Mask = z
  .object({
    shape: z.enum(MASK_SHAPES),
    x: z.number(),
    y: z.number(),
    w: z.number().gt(0),
    h: z.number().gt(0),
    /** rect only: corner radius, fraction of min(w, h) */
    radius: z.number().min(0).max(0.5).optional(),
    /** polygon only: fractions of the mask box */
    points: z.array(z.tuple([z.number(), z.number()])).min(3).optional(),
    /** px at output resolution */
    feather: z.number().min(0).max(200).optional(),
    invert: z.boolean().optional(),
  })
  .refine((m) => (m.shape === "polygon") === !!m.points, { message: "points are required for polygon masks and only for them" })
  .refine((m) => m.shape === "rect" || m.radius === undefined, { message: "radius is for rect masks only" });

/** Keyframe prop → the mask field it drives. */
export const MASK_PROPS = { maskX: "x", maskY: "y", maskW: "w", maskH: "h", maskFeather: "feather" } as const;

const ANIMATED = {
  ...Transform.shape,
  ...Effects.shape,
  volume: Volume.optional(),
  maskX: Mask.shape.x.optional(),
  maskY: Mask.shape.y.optional(),
  maskW: Mask.shape.w.optional(),
  maskH: Mask.shape.h.optional(),
  maskFeather: Mask.shape.feather,
};
/** Video item fields that take keyframes: transform, effects, volume, mask geometry. */
export const ANIMATABLE = Object.keys(ANIMATED) as (keyof typeof ANIMATED)[];
export type Animatable = (typeof ANIMATABLE)[number];

/**
 * Per prop, keys sorted by `t` in source seconds, so split, trim, slip and speed keep them on the
 * same content. `ease` shapes the segment leaving a key (default linear); values hold past the ends.
 */
export const Keyframes = z
  .partialRecord(z.enum(ANIMATABLE), z.array(z.object({ t: Seconds.min(0), v: z.number(), ease: z.enum(["linear", "ease"]).optional() })).min(1))
  .superRefine((kf, ctx) => {
    for (const [k, keys] of Object.entries(kf) as [Animatable, { t: number; v: number }[]][])
      keys.forEach((key, i) => {
        if (i && key.t <= keys[i - 1].t) ctx.addIssue({ code: "custom", message: `${k} keys must increase in t` });
        if (!ANIMATED[k].safeParse(key.v).success) ctx.addIssue({ code: "custom", message: `${k} key ${key.v} out of range` });
      });
  });

export const Asset = z.object({
  id: Id,
  path: z.string().min(1),
  kind: z.enum(["video", "audio", "image"]),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
});

export const VideoItem = z.object({
  ...itemBase,
  assetId: Id,
  sourceIn: Seconds.min(0),
  volume: Volume.optional(),
  fit: z.enum(["contain", "cover"]).optional(),
  transform: Transform.optional(),
  effects: Effects.optional(),
  crop: Crop.optional(),
  mask: Mask.optional(),
  blend: z.enum(BLENDS).optional(),
  keyframes: Keyframes.optional(),
  role: z.string().optional(),
  /** Playback rate: source seconds per timeline second. Changes how much source `duration` covers. */
  speed: z.number().min(0.1).max(10).optional(),
  /** Opacity and volume ramps at the ends, in frames. */
  fadeIn: Frames.min(0).optional(),
  fadeOut: Frames.min(0).optional(),
  /** Into the next item on the track when they touch, centred on the cut. Every kind but dip needs
   * duration/2 frames of source past both sides of the cut; dip goes through black and needs none.
   * `direction` is the side the incoming picture enters from (default left); wipe, slide and push use it. */
  transition: z
    .object({
      kind: z.enum(["dissolve", "dip", "wipe", "slide", "push", "zoom"]),
      duration: Frames.min(2),
      direction: z.enum(["left", "right", "up", "down"]).optional(),
    })
    .optional(),
});

export const AudioItem = z.object({
  ...itemBase,
  assetId: Id,
  sourceIn: Seconds.min(0),
  volume: z.number().min(0).optional(),
  /** `volume` only; source seconds like video keys. */
  keyframes: Keyframes.refine((k) => Object.keys(k).every((p) => p === "volume"), { message: "audio items can only key volume" }).optional(),
  fadeIn: Frames.min(0).optional(),
  fadeOut: Frames.min(0).optional(),
  duck: z.object({ under: z.array(Id), level: z.number().min(0).max(1) }).optional(),
  /** Chosen beats in asset seconds, sorted (§15.3); mapped to frames on the fly like anchored captions. */
  beats: z.array(Seconds.min(0)).optional(),
  /** The subset of `beats` that start a bar, from detectBeats; drawn taller. */
  downbeats: z.array(Seconds.min(0)).optional(),
});

export const CaptionItem = z.discriminatedUnion("mode", [
  z.object({
    ...itemBase,
    mode: z.literal("anchored"),
    itemId: Id,
    sourceStart: Seconds,
    sourceEnd: Seconds,
    text: z.string(),
  }),
  z.object({ ...itemBase, mode: z.literal("free"), text: z.string() }),
]);

/** Ties an item to a video item's source time; the item's start/duration are then derived. */
export const Anchor = z.object({ itemId: Id, sourceStart: Seconds, sourceEnd: Seconds });

export const OverlayItem = z.object({
  ...itemBase,
  component: z.string().min(1),
  props: z.record(z.string(), z.unknown()),
  mask: Mask.optional(),
  blend: z.enum(BLENDS).optional(),
  anchor: Anchor.optional(),
});

export const Track = z.discriminatedUnion("kind", [
  z.object({ ...trackBase, kind: z.literal("video"), items: z.array(VideoItem) }),
  z.object({ ...trackBase, kind: z.literal("audio"), volume: z.number().min(0).optional(), items: z.array(AudioItem) }),
  z.object({ ...trackBase, kind: z.literal("caption"), style: z.string().optional(), items: z.array(CaptionItem) }),
  z.object({ ...trackBase, kind: z.literal("overlay"), items: z.array(OverlayItem) }),
]);

export const Marker = z.object({
  id: Id,
  label: z.string(),
  start: Frames.min(0),
  duration: Frames.min(1).optional(),
  color: z.string().optional(),
});

export const Project = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().min(0),
  meta: z.object({
    title: z.string(),
    fps: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    background: z.string().optional(),
    /** Render-only master limiter at −1 dBFS; the preview is unlimited. */
    limiter: z.boolean().optional(),
  }),
  assets: z.record(Id, Asset),
  tracks: z.array(Track),
  markers: z.array(Marker).optional(),
  /** Highest counter handed out per id prefix, so a deleted id is never reused (§4.3). */
  ids: z.record(z.string(), z.number().int().min(0)).optional(),
});

export type Asset = z.infer<typeof Asset>;
export type Anchor = z.infer<typeof Anchor>;
export type VideoItem = z.infer<typeof VideoItem>;
export type AudioItem = z.infer<typeof AudioItem>;
export type CaptionItem = z.infer<typeof CaptionItem>;
export type OverlayItem = z.infer<typeof OverlayItem>;
export type Track = z.infer<typeof Track>;
export type TrackKind = Track["kind"];
export type Item = Track["items"][number];
export type Marker = z.infer<typeof Marker>;
export type Project = z.infer<typeof Project>;

/** Data the pure core can't read from project.json itself; supplied by the adapter. */
export interface Ctx {
  /** Probed durations in seconds, from .splicewright/assets.json. */
  assetDurations?: Record<string, number>;
  /** Transcript segments in asset time, from .splicewright/transcripts/. `words` (format 2+) is absent in older transcripts. */
  transcript?: (assetId: string) => { start: number; end: number; text: string; words?: { start: number; end: number; text: string }[] }[] | undefined;
  /** Beat analysis in asset seconds, from .splicewright/beats/ (§15.3). */
  beats?: (assetId: string) => BeatAnalysis | undefined;
  /** Content fingerprints recorded by the last probe, by asset id. */
  fingerprints?: Record<string, string>;
  /** Live fingerprint of a project-relative file; undefined if it doesn't exist. */
  fingerprint?: (path: string) => string | undefined;
  /** Integrated loudness in LUFS from the `loudness` ingest step, by asset id. */
  loudness?: Record<string, number>;
}

export interface BeatAnalysis {
  algo: string;
  version: string;
  tempo: number;
  beats: { t: number; strength: number }[];
  downbeats: number[];
}
