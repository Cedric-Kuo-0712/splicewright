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
  volume: z.number().min(0).max(2).optional(),
  fit: z.enum(["contain", "cover"]).optional(),
  transform: Transform.optional(),
  role: z.string().optional(),
});

export const AudioItem = z.object({
  ...itemBase,
  assetId: Id,
  sourceIn: Seconds.min(0),
  volume: z.number().min(0).optional(),
  fadeIn: Frames.min(0).optional(),
  fadeOut: Frames.min(0).optional(),
  duck: z.object({ under: z.array(Id), level: z.number().min(0).max(1) }).optional(),
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

export const OverlayItem = z.object({
  ...itemBase,
  component: z.string().min(1),
  props: z.record(z.string(), z.unknown()),
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
  }),
  assets: z.record(Id, Asset),
  tracks: z.array(Track),
  markers: z.array(Marker).optional(),
});

export type Asset = z.infer<typeof Asset>;
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
  /** Transcript segments in asset time, from .splicewright/transcripts/. */
  transcript?: (assetId: string) => { start: number; end: number; text: string }[] | undefined;
}
