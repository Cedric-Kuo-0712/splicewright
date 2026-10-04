import { useSyncExternalStore } from "react";
import type { PlayerRef } from "@remotion/player";
import { durationFrames, gapAt, type Project, type VideoItem, type Word } from "@splicewright/core";
import type { Props as RenderProps, Ranges } from "@splicewright/render";
import type { ExportPreset } from "../export-options.ts";

// Two stores (§7.3): project state changes per op; the frame ticks at playback rate and only the
// playhead and timecode subscribe to it.

function store<T>(initial: T, display: (state: T) => T = (state) => state) {
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
        () => select(display(value)),
      );
    },
  };
}

export interface State {
  project: Project | null;
  review: { id: string; label: string; summary: string; beforeRevision: number; afterRevision: number; status: "pending" | "kept" | "dismissed" | "reverted" } | null;
  reviewProject: Project | null;
  reviewMedia: (Omit<Snapshot, "project" | "lutVersions"> & { luts: State["luts"] }) | null;
  reviewView: "before" | "after" | null;
  /** The server's folder has no project.json yet: show the New project form. */
  empty: boolean;
  /** Projects the server will switch to (~/.splicewright/recent.json), minus the open one. */
  recent: { path: string; title: string }[];
  duck: Record<string, Ranges>;
  /** Transcript words per caption on a word-highlight track. */
  words: Record<string, Word[]>;
  /** Asset ids with an edit proxy in .splicewright/proxies/edit/. */
  proxies: string[];
  /** Asset ids with a reverse proxy in .splicewright/proxies/reverse/. */
  reverseProxies: string[];
  /** Probed durations in seconds, from .splicewright/assets.json. */
  durations: Record<string, number>;
  /** Probed source frame rates, used to seek reverse proxies in source frames. */
  frameRates: Record<string, number>;
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
  reverseAudioFx: Record<string, string>;
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
  exports: ExportJob[];
  audioMeter: { status: "unmeasured" | "measuring" | "unavailable"; peakDb: number | null; clipping: boolean };
}

export interface ExportJob {
  id: string;
  status: "running" | "done" | "error" | "cancelled";
  progress: number;
  output: string;
  preset: ExportPreset | "master";
  finalMix?: { status: "measuring" } | {
    status: "measured"; measuredAt: string; decoded: true;
    audio: { status: "none" } | {
      status: "measured"; integratedLufs: number | null;
      samplePeak: { dbfs: number | null; atSeconds: number | null };
      truePeak: { dbfs: number | null; atSeconds: number | null };
    };
  };
  error?: string;
}

export type MenuEntry = { label: string; hint?: string; run: () => unknown; disabled?: boolean } | "-";

const hash = new URLSearchParams(location.hash.slice(1));
const num = (v: string | null) => (v === null || v === "" || isNaN(Number(v)) ? null : Number(v));

export const app = store<State>({
  project: null, review: null, reviewProject: null, reviewMedia: null, reviewView: null, empty: false, recent: [], duck: {}, words: {}, proxies: [], reverseProxies: [], durations: {}, frameRates: {}, sizes: {}, animated: {}, fontVersions: {}, loudness: {}, audioFx: {}, reverseAudioFx: {}, audioFxProcessing: [], audioFxErrors: {}, audioFxLoudness: {}, luts: {}, useProxies: true, selection: [], sampling: null, gap: null, snapping: true, pxPerFrame: 2, message: null, rate: 1,
  io: { in: num(hash.get("in")), out: num(hash.get("out")) }, looping: false, menu: null, editing: null, slip: null, live: null, cropping: false, masking: false, ingesting: {}, uploads: [], reveal: null, exports: [], audioMeter: { status: "unmeasured", peakDb: null, clipping: false },
}, (state) => state.reviewMedia ? { ...state, ...state.reviewMedia } : state);
export const playhead = store({ frame: 0 });

type Snapshot = Pick<State, "project" | "duck" | "words" | "proxies" | "reverseProxies" | "durations" | "frameRates" | "sizes" | "animated" | "fontVersions" | "loudness" | "audioFx" | "reverseAudioFx" | "audioFxProcessing" | "audioFxErrors" | "audioFxLoudness"> & { lutVersions: Record<string, string> };
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
      return { project: s.project, duck: s.duck, words: s.words, proxies: s.proxies, reverseProxies: s.reverseProxies, durations: s.durations, frameRates: s.frameRates, sizes: s.sizes, animated: s.animated, fontVersions: s.fontVersions, loudness: s.loudness, audioFx: s.audioFx, reverseAudioFx: s.reverseAudioFx, audioFxProcessing: s.audioFxProcessing, audioFxErrors: s.audioFxErrors, audioFxLoudness: s.audioFxLoudness, luts, gap: t && gapAt(t, gap.at) ? gap : null };
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

export async function prepareReverse(assetId: string) {
  const { status, data } = await call("/api/reverse-proxy", { assetId });
  if (status >= 400) return fail(data.error?.message ?? "could not prepare reverse proxy");
  app.set({ message: { text: data.queued ? "Preparing reverse proxy…" : "Reverse proxy ready" } });
}

export async function startExport(preset: ExportPreset | "master") {
  try {
    const r = await fetch("/api/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preset }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message ?? `HTTP ${r.status}`);
    app.set(({ exports }) => ({ exports: [data as ExportJob, ...exports] }));
  } catch (e) { say(`Export: ${(e as Error).message}`, true); }
}

export async function refreshExports() {
  try {
    const r = await fetch("/api/export");
    if (r.ok) app.set({ exports: await r.json() as ExportJob[] });
  } catch { /* The regular project refresh reports connection failures. */ }
}

export async function refreshExport(id: string) {
  try {
    const r = await fetch(`/api/export/${encodeURIComponent(id)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message ?? `HTTP ${r.status}`);
    app.set(({ exports }) => ({ exports: exports.map((job) => job.id === id ? data as ExportJob : job) }));
  } catch (e) { say(`Export status: ${(e as Error).message}`, true); }
}

export async function cancelExport(id: string) {
  try {
    const r = await fetch(`/api/export/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message ?? `HTTP ${r.status}`);
    app.set(({ exports }) => ({ exports: exports.map((job) => job.id === id ? data as ExportJob : job) }));
  } catch (e) { say(`Cancel export: ${(e as Error).message}`, true); }
}

export async function revealExport(id: string) {
  try {
    const r = await fetch(`/api/export/${encodeURIComponent(id)}/reveal`, { method: "POST" });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message ?? `HTTP ${r.status}`);
  } catch (e) { say(`Open export: ${(e as Error).message}`, true); }
}

export async function refresh() {
  const { data } = await call("/api/project");
  app.set({ empty: !!data.empty, recent: data.recent ?? [] });
  if (!data.empty) await Promise.all([take(data), refreshExports()]);
  if (!data.empty) await refreshEditReview();
}

let reviewRequest = 0;
let reviewRefresh = 0;

export async function refreshEditReview() {
  const request = ++reviewRefresh;
  try {
    const res = await fetch("/api/edit-review");
    if (request !== reviewRefresh) return;
    if (!res.ok) { ++reviewRequest; return app.set({ review: null, reviewProject: null, reviewMedia: null, reviewView: null }); }
    const data = await res.json();
    if (request !== reviewRefresh) return;
    if (app.get().review?.id === data.id) return app.set({ review: data });
    ++reviewRequest;
    app.set({ review: data, reviewProject: null, reviewMedia: null, reviewView: null });
  } catch { /* Project load remains usable if no review endpoint is available. */ }
}

export async function showEditReview(view: "before" | "after" | null) {
  const request = ++reviewRequest;
  if (!view) return app.set({ reviewProject: null, reviewMedia: null, reviewView: null, selection: [], gap: null, editing: null, live: null, slip: null, sampling: null, cropping: false, masking: false });
  const id = app.get().review?.id;
  const { data } = await call(`/api/edit-review?view=${view}&id=${encodeURIComponent(id ?? "")}`);
  if (data.error) return fail(data.error.message);
  const luts: State["luts"] = {};
  try {
    await Promise.all(Object.entries(data.lutVersions as Record<string, string>).map(async ([asset, version]) => {
      const cached = lutCache.get(asset);
      if (cached?.version === version) { luts[asset] = cached.lut; return; }
      const response = await fetch(`/api/lut?asset=${encodeURIComponent(asset)}&view=${view}&id=${encodeURIComponent(id ?? "")}`);
      if (!response.ok) throw new Error(`Cannot load snapshot LUT ${asset}`);
      luts[asset] = await response.json();
    }));
  } catch (error) { return fail((error as Error).message); }
  if (request !== reviewRequest || app.get().review?.id !== id) return; // A newer agent round superseded this request.
  const { project: shown, lutVersions: _, review: __, ...media } = data;
  app.set({ reviewProject: shown, reviewMedia: { ...media, luts }, reviewView: view, selection: [], gap: null, editing: null, live: null, slip: null, sampling: null, cropping: false, masking: false });
  seek(playhead.get().frame);
}

export async function editReviewStatus(status: "kept" | "dismissed") {
  const id = app.get().review?.id;
  if (!id) return;
  const { data } = await call("/api/edit-review/status", { id, status });
  if (data.error) return fail(data.error.message);
  app.set(({ review }) => ({ review: review ? { ...review, status } : null }));
}

export async function revertEditReview() {
  const { review, project } = app.get();
  if (!review || !project) return;
  const { status, data } = await call("/api/edit-review/revert", { id: review.id, baseRevision: project.revision });
  if (status === 409) await refresh();
  if (data.error) return fail(data.error.message);
  await take(data);
  app.set({ reviewProject: null, reviewMedia: null, reviewView: null, review: { ...review, status: "reverted" }, message: { text: data.summary } });
}

const fail = (text: string) => app.set({ message: { text, error: true } });

const TIMING_OPS = new Set(["move", "trim", "slip", "delete", "cutRanges", "closeGap", "insertItem", "setSpeed", "attach", "fitToBeats"]);
let projectSession = 0;

function previewOperations(name: string, args: unknown) {
  const operations = name === "batch" && args && typeof args === "object" && Array.isArray((args as { ops?: unknown }).ops)
    ? (args as { ops: unknown[] }).ops
    : [{ op: name, args }];
  const hasTiming = (operations: unknown[]): boolean => operations.some((operation) => {
    if (!operation || typeof operation !== "object") return false;
    const opName = (operation as { op?: unknown }).op;
    const args = (operation as { args?: unknown }).args;
    if (opName === "batch" && args && typeof args === "object" && Array.isArray((args as { ops?: unknown }).ops))
      return hasTiming((args as { ops: unknown[] }).ops);
    return typeof opName === "string" && TIMING_OPS.has(opName);
  });
  return operations.length > 0 && hasTiming(operations) ? operations : null;
}

async function confirmSyncMovements(ops: unknown[], baseRevision: number) {
  const { status, data } = await call("/api/op/preview", { ops, baseRevision });
  if (status === 409) { await refresh(); fail(`Preview: ${data.error?.message ?? "Project changed; preview again."}`); return false; }
  if (data.error) { fail(`Preview: ${data.error.message}`); return false; }
  if (!data.moved?.length || (data.secondaryTotal === 0 || (data.secondaryTotal === undefined && !data.truncated && !data.moved.some((m: { kind: string }) => m.kind === "secondary")))) return true;
  const project = app.get().project;
  const lines = data.moved.map((m: { trackId: string; itemId: string; from: number; to: number; kind: "direct" | "secondary" }) => {
    const track = project?.tracks.find((t) => t.id === m.trackId);
    return `${m.kind === "direct" ? "直接" : "連動"}${track ? ` ${track.name}` : ` ${m.trackId}`} / ${m.itemId}：${m.from} → ${m.to}`;
  });
  const omitted = data.truncated ? "\n…（另有未列出的項目）" : "";
  const detail = lines.join("\n");
  return confirm(`此操作會移動 ${data.movedTotal ?? data.moved.length} 個同步項目：\n${detail}${omitted}\n\n確定後套用？`);
}

export async function newProject(form: { title: string; preset: string; fps: number }) {
  projectSession++;
  const { data } = await call("/api/init", form);
  if (data.error) return fail(data.error.message);
  location.reload();
}

/** The server restarts on the chosen folder; wait until it answers from there, then reload. */
export async function switchProject(path: string) {
  projectSession++;
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
  if (app.get().reviewProject) { fail("Snapshot preview is read-only. Switch to Current to edit."); return false; }
  const base = app.get().project?.revision;
  const session = projectSession;
  const project = app.get().project;
  const configuredSync = project?.tracks.some((track) => "syncTo" in track && track.syncTo);
  const ops = configuredSync ? previewOperations(name, args) : null;
  if (ops && typeof base === "number" && !(await confirmSyncMovements(ops, base))) return false;
  if (ops && (session !== projectSession || app.get().reviewProject || app.get().project?.revision !== base)) {
    fail("Project or revision changed during preview; preview again.");
    return false;
  }
  const { status, data } = await call("/api/op", { op: name, args, baseRevision: base });
  if (status === 409) await refresh();
  if (data.error) return app.set({ message: { text: `${name}: ${data.error.message}`, error: true } }), false;
  await take(data);
  app.set({ message: { text: data.summary } });
  return true;
}

export async function applyLutPreset(itemId: string, presetId: string, at?: number) {
  if (app.get().reviewProject) { fail("Snapshot preview is read-only. Switch to Current to edit."); return false; }
  const baseRevision = app.get().project?.revision;
  const { status, data } = await call("/api/lut-presets/apply", { itemId, presetId, baseRevision, at });
  if (status === 409) await refresh();
  if (data.error) return app.set({ message: { text: `apply LUT preset: ${data.error.message}`, error: true } }), false;
  await take(data);
  app.set({ message: { text: data.summary } });
  return true;
}

/** Undo/redo from the revision on screen, so an agent step that landed unseen is never the one undone. */
export async function history(which: "undo" | "redo", steps = 1) {
  if (app.get().reviewProject) return fail("Snapshot preview is read-only. Switch to Current to edit.");
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
      const { id, step, error } = m.ingest as { id: string; step: string | null; error?: string };
      app.set(({ ingesting }) => {
        const next: Record<string, string> = { ...ingesting, [id]: step ?? "" };
        if (!step) delete next[id];
        return { ingesting: next };
      });
      if (error) app.set({ message: { text: `Ingest ${id} failed: ${error}`, error: true } });
      // Editing milestones are sent after cache publication; analysis may still be queued.
      if (!step || ["probe", "proxy", "thumbs", "waveform"].includes(step)) refresh();
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
  const state = app.get();
  const max = Math.max(0, durationFrames(state.reviewProject ?? state.project!) - 1);
  frame = Math.max(0, Math.min(max, Math.round(frame)));
  player.ref ? player.ref.seekTo(frame) : playhead.set({ frame });
}
