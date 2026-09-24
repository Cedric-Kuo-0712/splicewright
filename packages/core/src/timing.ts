import type { AudioItem, Project } from "./schema.ts";
import { itemSpan } from "./validate.ts";

// Spec §15.1–15.2: adaptive ruler and snapping. Pure; shared by the UI and by op args ({ near }).

// ---- ruler ----

const SUB_SECOND = [1, 2, 5, 10, 15];
const SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

/** Candidate tick steps in frames, ascending. Seconds past 10 min extend the spec's list so long
 * projects still reach an 80 px major step. */
export function tickSteps(fps: number): number[] {
  return [...SUB_SECOND.filter((f) => f < fps), ...SECONDS.map((s) => Math.round(s * fps))];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Timecode for a frame, in the format the major step calls for (§15.1). */
export function formatFrame(frame: number, fps: number, step = 1): string {
  const secs = Math.floor(frame / fps);
  const [h, m, s] = [Math.floor(secs / 3600), Math.floor(secs / 60) % 60, secs % 60];
  if (step < fps) return `${pad(Math.floor(secs / 60))}:${pad(s)}:${pad(Math.round(frame - secs * fps))}`;
  if (step < 3600 * fps) return `${pad(Math.floor(secs / 60))}:${pad(s)}`;
  return `${h}:${pad(m)}:${pad(s)}`;
}

export interface Ticks {
  majorStep: number;
  minorStep: number | null;
  major: number[];
  minor: number[];
  labels: { frame: number; text: string }[];
}

/** Ruler ticks for frames [from, to) at `pxPerFrame` zoom. Major ≥ 80 px apart and labelled; minor ≥ 8 px. */
export function rulerTicks(fps: number, pxPerFrame: number, [from, to]: [number, number]): Ticks {
  const steps = tickSteps(fps);
  const majorStep = steps.find((s) => s * pxPerFrame >= 80) ?? steps.at(-1)!;
  const minorStep = steps.filter((s) => s < majorStep && majorStep % s === 0 && s * pxPerFrame >= 8).at(-1) ?? null;
  const every = (step: number) => {
    const out: number[] = [];
    for (let f = Math.max(0, Math.ceil(from / step) * step); f < to; f += step) out.push(f);
    return out;
  };
  const major = every(majorStep);
  return {
    majorStep,
    minorStep,
    major,
    minor: minorStep ? every(minorStep).filter((f) => f % majorStep !== 0) : [],
    labels: major.map((frame) => ({ frame, text: formatFrame(frame, fps, majorStep) })),
  };
}

// ---- snapping ----

/** Highest priority first; ties in distance go to the earlier kind (§15.2). */
export const SNAP_KINDS = ["playhead", "edge", "marker", "beat", "caption", "tick"] as const;
export type SnapKind = (typeof SNAP_KINDS)[number];

export interface SnapPoint {
  frame: number;
  kind: SnapKind;
  /** Item, marker, or caption id the point belongs to; absent for playhead and ticks. */
  ref?: string;
}

export interface SnapOptions {
  kinds?: readonly SnapKind[];
  playhead?: number;
  /** Frame step for "tick" points; the UI passes its current majorStep. */
  tickStep?: number;
}

/** An audio item's beats as timeline frames, inside its visible range, sorted and unique (§15.3). */
export function beatFrames(p: Project, item: AudioItem, times = item.beats): number[] {
  const out: number[] = [];
  for (const t of times ?? []) {
    const f = item.start + Math.round((t - item.sourceIn) * p.meta.fps);
    if (f >= item.start && f < item.start + item.duration && f !== out.at(-1)) out.push(f);
  }
  return out;
}

const cache = new WeakMap<Project, SnapPoint[]>();

/** Item edges, markers, and caption boundaries; computed once per project object (i.e. per revision). */
function projectPoints(p: Project): SnapPoint[] {
  let pts = cache.get(p);
  if (pts) return pts;
  pts = [];
  for (const t of p.tracks)
    for (const item of t.items) {
      if ("mode" in item && !item.text) continue;
      const span = itemSpan(p, item);
      if (!span) continue;
      const kind = t.kind === "caption" ? "caption" : "edge";
      pts.push({ frame: span.start, kind, ref: item.id }, { frame: span.start + span.duration, kind, ref: item.id });
    }
  for (const m of p.markers ?? []) {
    pts.push({ frame: m.start, kind: "marker", ref: m.id });
    if (m.duration) pts.push({ frame: m.start + m.duration, kind: "marker", ref: m.id });
  }
  for (const t of p.tracks) if (t.kind === "audio") for (const item of t.items) for (const frame of beatFrames(p, item)) pts.push({ frame, kind: "beat", ref: item.id });
  cache.set(p, pts);
  return pts;
}

/** Snap targets within frames [from, to). */
export function snapPoints(p: Project, [from, to]: [number, number], opts: SnapOptions = {}): SnapPoint[] {
  const kinds = new Set(opts.kinds ?? SNAP_KINDS.filter((k) => k !== "tick"));
  const inRange = (f: number) => f >= from && f < to;
  const pts = projectPoints(p).filter((pt) => kinds.has(pt.kind) && inRange(pt.frame));
  if (kinds.has("playhead") && opts.playhead !== undefined && inRange(opts.playhead)) pts.push({ frame: opts.playhead, kind: "playhead" });
  if (kinds.has("tick") && opts.tickStep)
    for (let f = Math.ceil(from / opts.tickStep) * opts.tickStep; f < to; f += opts.tickStep) pts.push({ frame: f, kind: "tick" });
  return pts;
}

export interface Snapped {
  frame: number;
  target: SnapPoint | null;
}

/** Nearest point within `thresholdFrames` of `frame`, skipping points whose ref is in `exclude`. */
export function snap(points: SnapPoint[], frame: number, thresholdFrames: number, exclude: readonly string[] = []): Snapped {
  let best: SnapPoint | null = null;
  let bestD = Infinity;
  for (const pt of points) {
    if (pt.ref && exclude.includes(pt.ref)) continue;
    const d = Math.abs(pt.frame - frame);
    if (d > thresholdFrames) continue;
    if (d < bestD || (d === bestD && SNAP_KINDS.indexOf(pt.kind) < SNAP_KINDS.indexOf(best!.kind))) [best, bestD] = [pt, d];
  }
  return { frame: best ? best.frame : frame, target: best };
}

/** Snap a span being moved: tests both edges, plus `offsets` from its start (a moving audio item's own
 * beats), and keeps the closest hit; ties go to the edges. Returns the new start. */
export function snapSpan(points: SnapPoint[], start: number, duration: number, thresholdFrames: number, exclude: readonly string[] = [], offsets: readonly number[] = []): Snapped {
  let best: Snapped = { frame: start, target: null };
  let bestD = Infinity;
  for (const off of [0, duration, ...offsets]) {
    const r = snap(points, start + off, thresholdFrames, exclude);
    const d = Math.abs(r.frame - start - off);
    if (r.target && d < bestD) [best, bestD] = [{ frame: r.frame - off, target: r.target }, d];
  }
  return best;
}
