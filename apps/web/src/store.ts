import { useSyncExternalStore } from "react";
import type { PlayerRef } from "@remotion/player";
import { durationFrames, gapAt, type Project } from "@splicewright/core";
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
}

export const app = store<State>({ project: null, duck: {}, proxies: [], durations: {}, useProxies: true, selection: [], gap: null, snapping: true, pxPerFrame: 2, message: null, rate: 1 });
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

export async function history(which: "undo" | "redo") {
  const { data } = await call(`/api/${which}`, {});
  if (data.error) return app.set({ message: { text: data.error.message, error: true } });
  take(data);
  app.set({ message: { text: data.summary } });
}

/** Agents edit project.json too; the server pushes each new revision. */
export function listen() {
  new EventSource("/api/events").onmessage = (e) => {
    if (JSON.parse(e.data).revision !== app.get().project?.revision) refresh();
  };
}

/** The media-bin asset being dragged; dragover can't read dataTransfer, so the preview reads this. */
export const dnd: { assetId: string | null } = { assetId: null };

/** Set by the Player on mount; the timeline and keyboard seek through it. */
export const player: { ref: PlayerRef | null } = { ref: null };

export function seek(frame: number) {
  const max = Math.max(0, durationFrames(app.get().project!) - 1);
  frame = Math.max(0, Math.min(max, Math.round(frame)));
  player.ref ? player.ref.seekTo(frame) : playhead.set({ frame });
}
