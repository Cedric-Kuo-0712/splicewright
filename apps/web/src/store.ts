import { useSyncExternalStore } from "react";
import type { PlayerRef } from "@remotion/player";
import { durationFrames, gapAt, type Project, type VideoItem } from "@splicewright/core";
import type { Ranges } from "@splicewright/render";

// Two stores (§7.3): project state changes per op; the frame ticks at playback rate and only the
// playhead and timecode subscribe to it.

function store<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(next: Partial<T> | ((v: T) => Partial<T>)) {
      value = { ...value, ...(typeof next === "function" ? next(value) : next) };
      subs.forEach((f) => f());
    },
    use<S>(select: (v: T) => S): S {
      return useSyncExternalStore(
        (f) => (subs.add(f), () => subs.delete(f)),
        () => select(value),
      );
    },
  };
}

export interface State {
  project: Project | null;
  duck: Record<string, Ranges>;
  /** Asset ids with an edit proxy in .splicewright/proxies/edit/. */
  proxies: string[];
  /** Probed durations in seconds, from .splicewright/assets.json. */
  durations: Record<string, number>;
  useProxies: boolean;
  selection: string[];
  /** A clicked empty span on a track, closed by Delete; kept apart from `selection` (items only). */
  gap: { trackId: string; at: number } | null;
  snapping: boolean;
  /** Timeline zoom. */
  pxPerFrame: number;
  message: { text: string; error?: boolean } | null;
  /** Shuttle speed (J/K/L); negative plays backwards. */
  rate: number;
  /** I/O points; the range is [in, out) with a missing end meaning the project edge. Mirrored in the URL hash. */
  io: { in: number | null; out: number | null };
  /** `/` plays the I/O range in a loop until paused. */
  looping: boolean;
  menu: { x: number; y: number; entries: MenuEntry[] } | null;
  /** What is being renamed or retyped in place. */
  editing: { kind: "caption" | "marker" | "track"; id: string } | null;
  /** Live slip drag: the preview shows this sourceIn before the op commits. */
  slip: { itemId: string; sourceIn: number } | null;
  /** Live transform drag on the preview, shown before the op commits. */
  live: { itemId: string; transform: NonNullable<VideoItem["transform"]> } | null;
  /** Assets with ingest running on the server → the step last reported. */
  ingesting: Record<string, string>;
  /** File names being uploaded. */
  uploads: string[];
  /** Media-bin asset to scroll to and flash. */
  reveal: string | null;
}

export type MenuEntry = { label: string; hint?: string; run: () => unknown; disabled?: boolean } | "-";

const hash = new URLSearchParams(location.hash.slice(1));
const num = (v: string | null) => (v === null || v === "" || isNaN(Number(v)) ? null : Number(v));

export const app = store<State>({
  project: null, duck: {}, proxies: [], durations: {}, useProxies: true, selection: [], gap: null, snapping: true, pxPerFrame: 2, message: null, rate: 1,
  io: { in: num(hash.get("in")), out: num(hash.get("out")) }, looping: false, menu: null, editing: null, slip: null, live: null, ingesting: {}, uploads: [], reveal: null,
});
export const playhead = store({ frame: 0 });

type Snapshot = Pick<State, "project" | "duck" | "proxies" | "durations">;
const take = ({ project, duck, proxies, durations }: Snapshot) =>
  app.set(({ gap }) => {
    // Drop a gap selection that an undo, redo, or another writer filled.
    const t = gap && project?.tracks.find((t) => t.id === gap.trackId);
    return { project, duck, proxies, durations, gap: t && gapAt(t, gap.at) ? gap : null };
  });

async function call(path: string, body?: unknown) {
  const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

export async function refresh() {
  take((await call("/api/project")).data);
}

/** Runs a core op against the revision on screen. A conflict means someone else (an agent) wrote first. */
export async function op(name: string, args: unknown) {
  const base = app.get().project?.revision;
  const { status, data } = await call("/api/op", { op: name, args, baseRevision: base });
  if (status === 409) await refresh();
  if (data.error) return app.set({ message: { text: `${name}: ${data.error.message}`, error: true } }), false;
  take(data);
  app.set({ message: { text: data.summary } });
  return true;
}

export async function history(which: "undo" | "redo", steps = 1) {
  const { data } = await call(`/api/${which}`, { steps });
  if (data.error) return app.set({ message: { text: data.error.message, error: true } });
  take(data);
  app.set({ message: { text: data.summary } });
}

/** Agents edit project.json too; the server pushes each new revision, and ingest progress for UI imports. */
export function listen() {
  new EventSource("/api/events").onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.ingest) {
      const { id, step } = m.ingest as { id: string; step: string | null };
      app.set(({ ingesting }) => {
        const next: Record<string, string> = { ...ingesting, [id]: step ?? "" };
        if (!step) delete next[id];
        return { ingesting: next };
      });
      // Probe results bring durations; the end brings proxies.
      if (!step || step === "probe") refresh();
      return;
    }
    if (m.revision !== app.get().project?.revision) refresh();
  };
}

/** The I/O range, or null when neither point is set or it is empty. */
export function ioRange(): [number, number] | null {
  const { io, project } = app.get();
  if (io.in === null && io.out === null) return null;
  const r: [number, number] = [io.in ?? 0, io.out ?? durationFrames(project!)];
  return r[1] > r[0] ? r : null;
}

export const say = (text: string, error = false) => app.set({ message: { text, error } });

/** The media-bin asset being dragged; dragover can't read dataTransfer, so the preview reads this. */
export const dnd: { assetId: string | null } = { assetId: null };

/** Set by the Player on mount; the timeline and keyboard seek through it. */
export const player: { ref: PlayerRef | null } = { ref: null };

export function seek(frame: number) {
  const max = Math.max(0, durationFrames(app.get().project!) - 1);
  frame = Math.max(0, Math.min(max, Math.round(frame)));
  player.ref ? player.ref.seekTo(frame) : playhead.set({ frame });
}
