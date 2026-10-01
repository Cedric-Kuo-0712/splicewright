import { useSyncExternalStore } from "react";
import type { PlayerRef } from "@remotion/player";
import { durationFrames, gapAt, type Project, type VideoItem, type Word } from "@splicewright/core";
import type { Props as RenderProps, Ranges } from "@splicewright/render";

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
  /** The server's folder has no project.json yet: show the New project form. */
  empty: boolean;
  /** Projects the server will switch to (~/.splicewright/recent.json), minus the open one. */
  recent: { path: string; title: string }[];
  duck: Record<string, Ranges>;
  /** Transcript words per caption on a word-highlight track. */
  words: Record<string, Word[]>;
  /** Asset ids with an edit proxy in .splicewright/proxies/edit/. */
  proxies: string[];
  /** Probed durations in seconds, from .splicewright/assets.json. */
  durations: Record<string, number>;
  /** Coded pixel sizes per asset, for crop and the transform box. */
  sizes: Record<string, [number, number]>;
  /** Probe-marked animated images for frame-accurate Player playback. */
  animated: Record<string, boolean>;
  fontVersions: Record<string, string>;
  luts: NonNullable<RenderProps["luts"]>;
  /** Integrated LUFS per asset from the `loudness` ingest step; silent or unmeasured assets are absent. */
  loudness: Record<string, number>;
  /** Baked audioFx sources by timeline item id; preview URLs are served through /media. */
  audioFx: Record<string, string>;
  audioFxProcessing: string[];
  audioFxErrors: Record<string, string>;
  audioFxLoudness: Record<string, number>;
  useProxies: boolean;
  selection: string[];
  sampling: string | null;
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
  /** Live drag on the preview or an inspector slider: this patch shows before the op commits. */
  live: { itemId: string; patch: Partial<VideoItem> } | null;
  /** Crop handles instead of transform handles on the preview (Shift+C). */
  cropping: boolean;
  /** Mask box handles instead of transform handles on the preview (Shift+K); never on with `cropping`. */
  masking: boolean;
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
  project: null, empty: false, recent: [], duck: {}, words: {}, proxies: [], durations: {}, sizes: {}, animated: {}, fontVersions: {}, loudness: {}, audioFx: {}, audioFxProcessing: [], audioFxErrors: {}, audioFxLoudness: {}, luts: {}, useProxies: true, selection: [], sampling: null, gap: null, snapping: true, pxPerFrame: 2, message: null, rate: 1,
  io: { in: num(hash.get("in")), out: num(hash.get("out")) }, looping: false, menu: null, editing: null, slip: null, live: null, cropping: false, masking: false, ingesting: {}, uploads: [], reveal: null,
});
export const playhead = store({ frame: 0 });

type Snapshot = Pick<State, "project" | "duck" | "words" | "proxies" | "durations" | "sizes" | "animated" | "fontVersions" | "loudness" | "audioFx" | "audioFxProcessing" | "audioFxErrors" | "audioFxLoudness"> & { lutVersions: Record<string, string> };
const lutCache = new Map<string, { version: string; lut: State["luts"][string] }>();
let latest = 0;

/** The server sends each LUT's version, not its table (a 65³ one is ~4 MB of JSON). Only a LUT this page
 * lacks or has an older version of is fetched, so an unchanged one keeps its object, and so its GPU upload. */
const take = (s: Snapshot) => {
  const n = ++latest;
  const apply = () => {
    for (const id of lutCache.keys()) if (!(id in s.lutVersions)) lutCache.delete(id);
    const luts = Object.fromEntries([...lutCache].filter(([id]) => id in s.lutVersions).map(([id, e]) => [id, e.lut]));
    app.set(({ gap }) => {
      // Drop a gap selection that an undo, redo, or another writer filled.
      const t = gap && s.project?.tracks.find((t) => t.id === gap.trackId);
      return { project: s.project, duck: s.duck, words: s.words, proxies: s.proxies, durations: s.durations, sizes: s.sizes, animated: s.animated, fontVersions: s.fontVersions, loudness: s.loudness, audioFx: s.audioFx, audioFxProcessing: s.audioFxProcessing, audioFxErrors: s.audioFxErrors, audioFxLoudness: s.audioFxLoudness, luts, gap: t && gapAt(t, gap.at) ? gap : null };
    });
  };
  const stale = Object.entries(s.lutVersions).filter(([id, version]) => lutCache.get(id)?.version !== version);
  if (!stale.length) return apply();
  return Promise.all(stale.map(async ([id, version]) => {
    try {
      const res = await fetch(`/api/lut?asset=${encodeURIComponent(id)}&v=${encodeURIComponent(version)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      lutCache.set(id, { version, lut: await res.json() });
    } catch (e) {
      lutCache.delete(id); // never keep an older table under the new version; the preview names the missing LUT
      if (n === latest) fail(`LUT ${id}: ${(e as Error).message}`);
    }
  })).then(() => { if (n === latest) apply(); }); // a newer snapshot supersedes this one
};

async function call(path: string, body?: unknown) {
  const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

export async function refresh() {
  const { data } = await call("/api/project");
  app.set({ empty: !!data.empty, recent: data.recent ?? [] });
  if (!data.empty) await take(data);
}

const fail = (text: string) => app.set({ message: { text, error: true } });

export async function newProject(form: { title: string; preset: string; fps: number }) {
  const { data } = await call("/api/init", form);
  if (data.error) return fail(data.error.message);
  location.reload();
}

/** The server restarts on the chosen folder; wait until it answers from there, then reload. */
export async function switchProject(path: string) {
  const { data } = await call("/api/switch", { path });
  if (data.error) return fail(data.error.message);
  for (let k = 0; k < 50; k++) {
    await new Promise((ok) => setTimeout(ok, 200));
    const now = await fetch("/api/project").then((r) => r.json(), () => null);
    if (now?.dir === data.dir) return location.reload();
  }
  fail("the server did not come back");
}

/** Runs a core op against the revision on screen. A conflict means someone else (an agent) wrote first. */
export async function op(name: string, args: unknown) {
  const base = app.get().project?.revision;
  const { status, data } = await call("/api/op", { op: name, args, baseRevision: base });
  if (status === 409) await refresh();
  if (data.error) return app.set({ message: { text: `${name}: ${data.error.message}`, error: true } }), false;
  await take(data);
  app.set({ message: { text: data.summary } });
  return true;
}

export async function applyLutPreset(itemId: string, presetId: string) {
  const baseRevision = app.get().project?.revision;
  const { status, data } = await call("/api/lut-presets/apply", { itemId, presetId, baseRevision });
  if (status === 409) await refresh();
  if (data.error) return app.set({ message: { text: `apply LUT preset: ${data.error.message}`, error: true } }), false;
  await take(data);
  app.set({ message: { text: data.summary } });
  return true;
}

/** Undo/redo from the revision on screen, so an agent step that landed unseen is never the one undone. */
export async function history(which: "undo" | "redo", steps = 1) {
  const { status, data } = await call(`/api/${which}`, { steps, baseRevision: app.get().project?.revision });
  if (status === 409) await refresh();
  if (data.error) return app.set({ message: { text: data.error.message, error: true } });
  await take(data);
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
