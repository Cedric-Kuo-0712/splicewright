import { anchorOf, durationFrames, frameOf, itemSpan, nextId, secPerFrame, type Item, type Project, type Track, type TrackKind, type VideoItem } from "@splicewright/core";
import { pip, type PipPreset } from "@splicewright/render";
import { app, history, ioRange, op, player, playhead, refresh, say, seek, type MenuEntry } from "./store.ts";

// Editing commands shared by the keyboard, the toolbar, and the context menus. Multi-op edits go out
// as one batch, so each is one undo step.

type Op = { op: string; args: Record<string, unknown> };

export function findItem(p: Project, id: string): { track: Track; item: Item } | null {
  for (const track of p.tracks) for (const item of track.items) if (item.id === id) return { track, item };
  return null;
}

const send = (ops: Op[]) => (ops.length === 1 ? op(ops[0].op, ops[0].args) : op("batch", { ops }));

/** Ids the ops in one batch will create, in order: core numbers each prefix `<prefix>_<max+1>`. */
function idMaker(p: Project) {
  const next: Record<string, number> = {};
  return (prefix: string) => {
    next[prefix] ??= parseInt(nextId(p, prefix).split("_")[1], 36);
    return `${prefix}_${(next[prefix]++).toString(36)}`;
  };
}

const prefixOf = (t: Track) => (t.kind === "caption" ? "c" : "i");
const end = (s: { start: number; duration: number }) => s.start + s.duration;

const MOD = /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";
/** Labels of the M8.5 keys, shown in menus and tooltips; App.tsx's onKey handles the same keys. */
export const KEYS = { cut: `${MOD}X`, import: `${MOD}I`, detach: "⌥S", prevKey: "⌥←", nextKey: "⌥→", range: "X", fullscreen: "F" };

// ---- cut, lift, extract ----

type Piece = { id: string; track: Track; start: number; end: number };

/** Split ops cutting the chosen items at each frame, plus the pieces they leave (ids predicted). */
function cuts(p: Project, frames: number[], pick: (t: Track, i: Item) => boolean) {
  const id = idMaker(p);
  const ops: Op[] = [];
  const pieces: Piece[] = [];
  for (const t of p.tracks) {
    if (t.locked) continue;
    for (const i of t.items) {
      if (anchorOf(i) || !pick(t, i)) continue;
      let cur: Piece = { id: i.id, track: t, start: i.start, end: end(i) };
      for (const f of [...frames].sort((a, b) => a - b)) {
        if (f <= cur.start || f >= cur.end) continue;
        ops.push({ op: "split", args: { itemId: cur.id, at: f } });
        pieces.push({ ...cur, end: f });
        cur = { id: id(prefixOf(t)), track: t, start: f, end: cur.end };
      }
      pieces.push(cur);
    }
  }
  return { ops, pieces };
}

/** Split the selection, or every unlocked unanchored item, at the given frames (the playhead, or I and O). */
export function split(frames: number[]) {
  const { project: p, selection } = app.get();
  const { ops } = cuts(p!, frames, (_, i) => !selection.length || selection.includes(i.id));
  if (!ops.length) return say(`nothing to split at ${frames.join(" and ")}`, true);
  return send(ops);
}

/** Lift removes what is inside [a, b) on unlocked tracks; extract also pulls everything after it left. */
export function cutRange([a, b]: [number, number], extract: boolean) {
  const p = app.get().project!;
  const { ops, pieces } = cuts(p, [a, b], () => true);
  const inside = pieces.filter((x) => x.start >= a && x.end <= b);
  if (inside.length) ops.push({ op: "delete", args: { itemIds: inside.map((x) => x.id), ripple: false } });
  if (extract) for (const x of pieces) if (x.start >= b) ops.push({ op: "move", args: { itemId: x.id, to: x.start - (b - a), ripple: false } });
  if (!ops.length) return say(`nothing in [${a}, ${b})`, true);
  return send(ops).then((ok) => ok && app.set({ selection: [], gap: null }));
}

/** Delete key and the Ripple delete button: the selection, else a clicked gap, else the I/O range. */
export function rippleDelete(ripple: boolean) {
  const { selection, gap } = app.get();
  if (selection.length) return op("delete", { itemIds: selection, ...(ripple && { ripple: true }) }).then((ok) => ok && app.set({ selection: [] }));
  if (gap) return op("closeGap", gap).then((ok) => ok && app.set({ gap: null }));
  const r = ioRange();
  if (r) return cutRange(r, ripple);
}

/** X: I/O becomes the outer span of the selection ([in, out), like the range everywhere else). */
export function rangeFromSelection() {
  const { project, selection } = app.get();
  const spans = selection.flatMap((id) => {
    const f = findItem(project!, id);
    const s = f && itemSpan(project!, f.item);
    return s ? [s] : [];
  });
  if (!spans.length) return say("select items to take the range from", true);
  app.set({ io: { in: Math.min(...spans.map((s) => s.start)), out: Math.max(...spans.map(end)) } });
}

/** Alt+S: detachAudio on every selected video clip, one undo step. */
export function detachAudio() {
  const { project: p, selection } = app.get();
  const ops = selection.filter((id) => findItem(p!, id)?.track.kind === "video").map((itemId) => ({ op: "detachAudio", args: { itemId } }));
  return ops.length ? send(ops) : say("select a video clip to detach its audio", true);
}

/** Alt+←/→: the playhead goes to the previous/next key of the selected clip, else the clip under it. */
export function stepKey(dir: -1 | 1) {
  const p = app.get().project!;
  const frame = playhead.get().frame;
  const sel = app.get().selection[0];
  const it = (sel ? findItem(p, sel)?.item : videoUnder(p, frame)) as VideoItem | undefined;
  // Keys outside the trimmed span are invisible (no ◆), so they don't count.
  const keyed = Object.values(it?.keyframes ?? {})
    .flatMap((ks) => ks.map((k) => Math.round(frameOf(p, it!, k.t))))
    .filter((f) => f >= it!.start && f < end(it!));
  const to = dir < 0 ? keyed.filter((f) => f < frame).sort((a, b) => b - a)[0] : keyed.filter((f) => f > frame).sort((a, b) => a - b)[0];
  return to !== undefined ? seek(to) : say(`no ${dir < 0 ? "previous" : "next"} keyframe`, true);
}

// ---- copy, paste, duplicate ----

interface Clip {
  item: Item;
  track: Track;
  start: number;
  duration: number;
}

let clipboard: Clip[] = [];

function clips(p: Project, ids: string[]): Clip[] {
  return ids
    .flatMap((id) => {
      const f = findItem(p, id);
      const span = f && itemSpan(p, f.item);
      return span ? [{ item: structuredClone(f.item), track: f.track, ...span }] : [];
    })
    .sort((a, b) => a.start - b.start);
}

export function copy() {
  const { project, selection } = app.get();
  clipboard = clips(project!, selection);
  say(`copied ${clipboard.length} item${clipboard.length === 1 ? "" : "s"}`);
}

/** Cmd+X: copy, then delete the selection (a single delete op, so one undo step). */
export function cut() {
  copy();
  return rippleDelete(false);
}

export const paste = (at = playhead.get().frame, insert = false) => place(clipboard, at, insert);

/** A copy right after the last selected item; the clipboard is left alone. */
export function duplicate() {
  const { project, selection } = app.get();
  const c = clips(project!, selection);
  if (c.length) return place(c, Math.max(...c.map(end)));
}

/** Nearest item edge when `f` falls inside an item on `t`, so inserts never land mid-clip. */
function edgeNear(t: Track, f: number) {
  const i = t.items.find((i) => !anchorOf(i) && i.start < f && f < end(i));
  return !i ? f : f - i.start < end(i) - f ? i.start : end(i);
}

// Fields insertItem doesn't take; setProps copies them.
// ponytail: beats, downbeats and duck aren't copied; add a pasteItems op if pasted songs need them.
const EXTRA = ["volume", "fit", "transform", "effects", "crop", "keyframes", "fadeIn", "fadeOut", "speed", "transition", "label", "note"];

/**
 * Paste clips with their relative timing at `at`. Each lands on its own track if it still exists and is
 * unlocked, else the first unlocked track of its kind. Magnetic tracks (all tracks with `insert`) take
 * the clips back to back and push later items; other tracks keep the gaps and reject overlaps.
 * Items anchored to a pasted video item are re-anchored to the copy.
 */
function place(list: Clip[], at: number, insert = false) {
  const p = app.get().project!;
  if (!list.length) return say("clipboard is empty", true);
  const id = idMaker(p);
  const ops: Op[] = [];
  const made = new Map<string, { id: string; start: number }>();
  const cursor = new Map<string, number>();
  const copied = new Set(list.map((c) => c.item.id));
  const anchorIn = (c: Clip) => (anchorOf(c.item)?.itemId && copied.has(anchorOf(c.item)!.itemId) ? anchorOf(c.item)!.itemId : undefined);
  const origin = list[0].start;
  let skipped = 0;
  // Anchor targets first, so their copies' positions are known.
  for (const c of [...list.filter((c) => !anchorIn(c)), ...list.filter(anchorIn)]) {
    const own = p.tracks.find((t) => t.id === c.track.id);
    const t = own && !own.locked ? own : p.tracks.find((t) => t.kind === c.track.kind && !t.locked);
    if (!t) {
      skipped++;
      continue;
    }
    const parent = made.has(anchorIn(c) ?? "") ? anchorIn(c) : undefined; // its anchor may have been skipped
    const ripple = !parent && t.kind !== "caption" && (insert || !!t.magnetic);
    let start: number;
    if (parent) {
      const src = list.find((x) => x.item.id === parent)!;
      start = made.get(parent)!.start + c.start - src.start;
    } else if (ripple) {
      start = cursor.get(t.id) ?? edgeNear(t, at + c.start - origin);
      cursor.set(t.id, start + c.duration);
    } else start = at + c.start - origin;
    const it = c.item;
    const base = { trackId: t.id, at: start, duration: c.duration, ripple };
    ops.push({
      op: "insertItem",
      args: "assetId" in it ? { ...base, assetId: it.assetId, sourceIn: it.sourceIn } : "component" in it ? { ...base, component: it.component, props: it.props } : { ...base, text: it.text },
    });
    const nid = id(prefixOf(t));
    made.set(it.id, { id: nid, start });
    const extra = Object.fromEntries(EXTRA.filter((k) => k in it).map((k) => [k, (it as Record<string, unknown>)[k]]));
    if (Object.keys(extra).length) ops.push({ op: "setProps", args: { itemId: nid, patch: extra } });
    if (parent) ops.push({ op: "attach", args: { itemId: nid, to: made.get(parent)!.id } });
  }
  if (!ops.length) return say("no unlocked track to paste into", true);
  return send(ops).then((ok) => {
    if (ok) return app.set({ selection: [...made.values()].map((m) => m.id), gap: null, ...(skipped && { message: { text: `pasted ${made.size}; ${skipped} skipped (no unlocked track of their kind)` } }) });
    const m = app.get().message;
    if (!insert && m?.text.includes("overlaps")) say(`${m.text} — Cmd+Shift+V inserts and pushes later items`, true);
  });
}

// ---- small edits ----

/** Tap-along (§15.4): a beat at the playhead on the selected audio item, else the audio item under the playhead. */
export function tapBeat(frame: number) {
  const { project: p, selection } = app.get();
  const items = p!.tracks.flatMap((t) => (t.kind === "audio" ? t.items : [])).filter((i) => frame >= i.start && frame < end(i));
  const target = items.find((i) => selection.includes(i.id)) ?? items[0];
  if (!target) return say("no audio item under the playhead", true);
  return op("addBeat", { itemId: target.id, at: frame });
}

/** Keyboard nudge: ignores snapping (§15.2). */
export function nudge(delta: number) {
  const { project: p, selection } = app.get();
  const ops = selection.flatMap((id) => {
    const found = findItem(p!, id);
    const span = found && itemSpan(p!, found.item);
    return span && !found.track.locked ? [{ op: "move", args: { itemId: id, to: Math.max(0, span.start + delta) } }] : [];
  });
  if (ops.length) return send(ops);
}

/** Keyboard slip by whole frames. Positive shows earlier source, like dragging the film strip right. */
export function slipBy(frames: number) {
  const { project: p, selection } = app.get();
  const ops = selection.flatMap((id) => {
    const f = findItem(p!, id);
    return f && "sourceIn" in f.item && p!.assets[f.item.assetId]?.kind !== "image" ? [{ op: "slip", args: { itemId: id, deltaSec: -frames / p!.meta.fps } }] : [];
  });
  if (!ops.length) return say("select a video or audio item to slip", true);
  return send(ops);
}

export function addMarker(at: number) {
  const p = app.get().project!;
  return op("addMarker", { label: `M${(p.markers?.length ?? 0) + 1}`, start: at });
}

/** The marker nearest `at` within `within` frames. */
export function markerNear(at: number, within: number) {
  const m = [...(app.get().project!.markers ?? [])].sort((a, b) => Math.abs(a.start - at) - Math.abs(b.start - at))[0];
  return m && Math.abs(m.start - at) <= within ? m : undefined;
}

export function setIO(which: "in" | "out", at: number) {
  app.set(({ io }) => {
    const next = { ...io, [which]: at };
    // A new point that crosses the other one drops the other one.
    if (next.in !== null && next.out !== null && next.out <= next.in) next[which === "in" ? "out" : "in"] = null;
    return { io: next, selection: [], gap: null };
  });
}

/** `/`: play the I/O range in a loop (or the whole project); pausing ends it. */
export function loopRange() {
  const r = ioRange() ?? [0, durationFrames(app.get().project!)];
  app.set({ looping: true, rate: 1 });
  seek(r[0]);
  player.ref?.play();
}

/** The video item on the topmost visible video track under `frame`: the target of attach. */
export function videoUnder(p: Project, frame: number) {
  for (const t of [...p.tracks].reverse()) {
    if (t.kind !== "video" || t.hidden) continue;
    const i = t.items.find((i) => i.start <= frame && frame < end(i));
    if (i) return i;
  }
}

// ---- space, freeze, replace ----

/** Close every gap on `t`, latest first so each closeGap sees positions the earlier ones didn't move. */
export function removeGaps(t: Track) {
  const at: number[] = [];
  let cur = 0;
  for (const i of t.items.filter((i) => !anchorOf(i)).sort((a, b) => a.start - b.start)) {
    if (i.start > cur) at.push(cur);
    cur = Math.max(cur, end(i));
  }
  if (!at.length) return say(`no gaps on ${t.name}`, true);
  return send(at.reverse().map((f) => ({ op: "closeGap", args: { trackId: t.id, at: f } })));
}

/** Push every unlocked item starting at or after `at` right by a prompted number of seconds. Items
 * crossing `at` stay put. */
export function insertSpace(at: number) {
  const p = app.get().project!;
  const sec = Number(prompt("Insert how many seconds of space?", "1"));
  if (!(sec > 0)) return;
  const d = Math.round(sec * p.meta.fps);
  const later = p.tracks.flatMap((t) => (t.locked ? [] : t.items.filter((i) => !anchorOf(i) && i.start >= at)));
  if (!later.length) return say(`nothing starts after ${at}`, true);
  // Latest first, so no move lands on an item that hasn't moved yet.
  return send(later.sort((a, b) => b.start - a.start).map((i) => ({ op: "move", args: { itemId: i.id, to: i.start + d, ripple: false } })));
}

/** The selected video item under `frame`, else the topmost one: freeze frame and replace act on it. */
function videoTarget(p: Project, frame: number) {
  const sel = app.get().selection.map((id) => findItem(p, id)).find((f) => f?.track.kind === "video" && f.item.start <= frame && frame < end(f.item));
  const i = sel?.item ?? videoUnder(p, frame);
  return i && findItem(p, i.id);
}

/** Holds the frame under the playhead for `sec` seconds: the server grabs it into raw/ as a still, then
 * the item is split there and the still goes in between, pushing the rest of the track right. */
export async function freezeFrame(frame: number, sec = 2) {
  const p = app.get().project!;
  const f = videoTarget(p, frame);
  if (!f || !("assetId" in f.item) || p.assets[f.item.assetId]?.kind !== "video") return say("no video clip under the playhead", true);
  if (f.track.locked) return say(`${f.track.name} is locked`, true);
  const res = await fetch("/api/freeze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: f.item.id, frame }) });
  const data = await res.json();
  if (data.error) return say(`freeze: ${data.error.message ?? data.error}`, true);
  await refresh();
  const q = app.get().project!;
  const { ops } = cuts(q, [frame], (_, i) => i.id === f.item.id);
  ops.push({ op: "insertItem", args: { trackId: f.track.id, assetId: data.assetId, at: frame, duration: Math.round(sec * q.meta.fps), ripple: true } });
  return send(ops);
}

/** Swap the selected video or audio clip's media for `assetId`, keeping its place, length (as far as
 * the new media reaches), props, and anything anchored to it. */
export function replaceWith(assetId: string) {
  const { project: p, selection, durations } = app.get();
  const f = selection.length === 1 ? findItem(p!, selection[0]) : null;
  const a = p!.assets[assetId];
  if (!f || !("assetId" in f.item)) return say("select one video or audio clip to replace", true);
  if ((a.kind === "audio") !== (f.track.kind === "audio")) return say(`${a.id} is ${a.kind}; ${f.item.id} is on a ${f.track.kind} track`, true);
  if (f.track.locked) return say(`${f.track.name} is locked`, true);
  const it = f.item;
  const len = a.kind === "image" ? Infinity : Math.floor((durations[assetId] ?? 0) / secPerFrame(p!, it));
  if (!len) return say(`${a.id} has no known duration yet; wait for ingest`, true);
  const children = p!.tracks.flatMap((t) => t.items.filter((c) => anchorOf(c)?.itemId === it.id));
  const nid = idMaker(p!)("i");
  const extra = Object.fromEntries(EXTRA.filter((k) => k in it).map((k) => [k, (it as Record<string, unknown>)[k]]));
  const ops: Op[] = [
    ...children.map((c) => ({ op: "attach", args: { itemId: c.id, to: null } })),
    { op: "delete", args: { itemIds: [it.id], ripple: false } },
    // ponytail: a shorter replacement leaves a gap; no retime-to-fit.
    { op: "insertItem", args: { trackId: f.track.id, assetId, at: it.start, duration: Math.min(it.duration, len), ripple: false } },
    ...(Object.keys(extra).length ? [{ op: "setProps", args: { itemId: nid, patch: extra } }] : []),
    ...children.map((c) => ({ op: "attach", args: { itemId: c.id, to: nid } })),
  ];
  return send(ops).then((ok) => ok && app.set({ selection: [nid] }));
}

// ---- speed, transitions ----

function setSpeed(item: VideoItem) {
  const v = Number(prompt("Speed (0.1–10×; the clip's length scales)", String(item.speed ?? 1)));
  if (v >= 0.1 && v <= 10) return op("setSpeed", { itemId: item.id, speed: v });
}

const TRANSITION_NAME = { dissolve: "Dissolve", dip: "Dip to black", wipe: "Wipe", slide: "Slide", push: "Push", zoom: "Zoom" } as const;

function transitionEntries(p: Project, t: Track, item: VideoItem): MenuEntry[] {
  const next = t.items.some((i) => i.start === end(item));
  const cur = item.transition;
  const set = (kind: keyof typeof TRANSITION_NAME | null) =>
    op("setProps", { itemId: item.id, patch: { transition: kind && { kind, duration: cur?.duration ?? Math.round(p.meta.fps) } } });
  return [
    ...(Object.keys(TRANSITION_NAME) as (keyof typeof TRANSITION_NAME)[]).map((k) => ({
      label: `${cur?.kind === k ? "✓ " : ""}${TRANSITION_NAME[k]} into next`,
      run: () => set(k),
      disabled: !next || t.locked,
    })),
    ...(cur ? [{ label: "Remove transition", run: () => set(null), disabled: t.locked }] : []),
  ];
}

/** Look presets: each replaces the item's effects. */
export const LOOKS: Record<string, VideoItem["effects"]> = {
  "B&W": { grayscale: 1, contrast: 1.1 },
  Noir: { grayscale: 1, contrast: 1.4, brightness: 0.9 },
  Warm: { sepia: 0.25, saturation: 1.15, hue: -8 },
  Cool: { hue: 12, saturation: 0.9, brightness: 1.03 },
  Vintage: { sepia: 0.45, contrast: 0.9, saturation: 0.8, brightness: 1.05 },
  Vivid: { saturation: 1.4, contrast: 1.15 },
  Faded: { contrast: 0.8, saturation: 0.7, brightness: 1.1 },
  Cinematic: { contrast: 1.2, saturation: 0.85, brightness: 0.95, hue: -6 },
  Sepia: { sepia: 1 },
  Fresh: { saturation: 1.2, brightness: 1.08, contrast: 1.05, hue: 4 },
};

const PIP_NAME: Record<PipPreset, string> = { tl: "Top left", tr: "Top right", bl: "Bottom left", br: "Bottom right", left: "Left half", right: "Right half", circle: "Circle" };

/** Picture-in-picture presets: one setProps with pip()'s transform/mask patch. Keyed x/y/scale would override it. */
export const pipEntries = (p: Project, item: VideoItem): MenuEntry[] =>
  (Object.keys(PIP_NAME) as PipPreset[]).map((k) => ({
    label: `PIP: ${PIP_NAME[k]}`,
    run: () => op("setProps", { itemId: item.id, patch: pip(p, item, app.get().sizes[item.assetId], k) }),
    disabled: k !== "circle" && !!(item.keyframes?.x || item.keyframes?.y || item.keyframes?.scale),
  }));

export const lookEntries = (item: VideoItem): MenuEntry[] => [
  ...Object.entries(LOOKS).map(([label, effects]) => ({ label, run: () => op("setProps", { itemId: item.id, patch: { effects } }) })),
  "-",
  { label: "Reset effects", run: () => op("setProps", { itemId: item.id, patch: { effects: null } }), disabled: !item.effects },
];

// ---- selection ----

const spanOf = (p: Project, i: Item) => itemSpan(p, i) ?? i;

export const selectItems = (ids: string[]) => app.set({ selection: ids, gap: null, message: { text: `selected ${ids.length}` } });

/** A 3 s Text overlay at the playhead (first overlay track with room, else a new one), selected with its text field ready to type. */
export async function addText(frame: number) {
  const p = app.get().project!;
  const id = idMaker(p)("i");
  if (!(await op("insertItem", { component: "Text", props: { text: "Text" }, at: frame, duration: 3 * p.meta.fps, ripple: false }))) return;
  selectItems([id]);
  requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.inspector input[name="text"]')?.select());
}

/** Items on `tracks` that start at or after `from` (anchored ones by their current span). */
export function itemsAfter(p: Project, tracks: Track[], from = 0) {
  return tracks.flatMap((t) => t.items.filter((i) => spanOf(p, i).start >= from).map((i) => i.id));
}

export function itemsUnder(p: Project, frame: number) {
  return p.tracks.flatMap((t) => t.items.filter((i) => spanOf(p, i).start <= frame && frame < end(spanOf(p, i))).map((i) => i.id));
}

// ---- markers, captions, history ----

/** A range marker covering the selection. */
export function markerAroundSelection() {
  const { project: p, selection } = app.get();
  const spans = selection.flatMap((id) => {
    const f = findItem(p!, id);
    return f ? [spanOf(p!, f.item)] : [];
  });
  if (!spans.length) return say("select items to mark", true);
  const start = Math.min(...spans.map((s) => s.start));
  return op("addMarker", { label: `M${(p!.markers?.length ?? 0) + 1}`, start, duration: Math.max(...spans.map(end)) - start });
}

const COLORS: [string, string][] = [["Orange", ""], ["Red", "#e5534b"], ["Green", "#57ab5a"], ["Blue", "#539bf5"], ["Purple", "#b083f0"], ["Yellow", "#e0c341"]];

function srtTime(frame: number, fps: number) {
  const ms = Math.round((frame / fps) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/** The caption track as SubRip text; hidden captions (anchor trimmed away) and empty ones are left out. */
export function toSrt(p: Project, t: Track) {
  const cues = t.items
    .flatMap((c) => {
      const s = itemSpan(p, c);
      return s && "text" in c && c.text.trim() ? [{ ...s, text: c.text.trim() }] : [];
    })
    .sort((a, b) => a.start - b.start);
  return cues.map((c, k) => `${k + 1}\n${srtTime(c.start, p.meta.fps)} --> ${srtTime(end(c), p.meta.fps)}\n${c.text}\n`).join("\n");
}

function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Toolbar History: the undo and redo stacks as a menu; picking an entry steps back (or forward) to it. */
export async function historyMenu(e: { clientX: number; clientY: number }) {
  const { clientX: x, clientY: y } = e;
  const res = await fetch("/api/history");
  const h: Record<"undo" | "redo", { summary: string; revision: number }[]> = await res.json();
  const entries: MenuEntry[] = [
    // Farthest redo on top, so the menu reads oldest (bottom) to newest (top) like a timeline of edits.
    ...h.redo.map((r, k) => ({ label: `↷ ${r.summary}`, run: () => history("redo", k + 1) })).reverse(),
    { label: "● now", run: () => {}, disabled: true },
    ...h.undo.map((u, k) => ({ label: `↶ ${u.summary}`, run: () => history("undo", k + 1) })),
  ];
  app.set({ menu: { x, y, entries } });
}

// ---- context menus ----

export function openMenu(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, entries: MenuEntry[]) {
  e.preventDefault();
  e.stopPropagation();
  app.set({ menu: { x: e.clientX, y: e.clientY, entries } });
}

export function itemMenu(p: Project, t: Track, item: Item, frame: number): MenuEntry[] {
  const span = itemSpan(p, item);
  const inside = !!span && frame > span.start && frame < end(span);
  const anchor = anchorOf(item);
  const out: MenuEntry[] = [
    { label: "Split here", hint: "S", run: () => split([frame]), disabled: !inside || !!anchor || t.locked },
    { label: "Cut", hint: KEYS.cut, run: cut, disabled: t.locked },
    { label: "Copy", hint: `${MOD}C`, run: copy },
    { label: "Duplicate", hint: `${MOD}D`, run: duplicate },
    { label: "Delete", hint: "⌫", run: () => rippleDelete(false), disabled: t.locked },
    { label: "Ripple delete", hint: "⇧⌫", run: () => rippleDelete(true), disabled: t.locked },
    { label: "Add marker around selection", hint: "⇧M", run: markerAroundSelection },
    { label: "Range from selection", hint: KEYS.range, run: rangeFromSelection },
  ];
  if (t.kind === "video" && "assetId" in item) {
    out.push("-", { label: "Captions from transcript", run: () => op("addCaptionsFromTranscript", { itemId: item.id }) });
    out.push({ label: "Show in media bin", run: () => app.set({ reveal: item.assetId }) });
    if (p.assets[item.assetId]?.kind === "video") {
      out.push({ label: "Freeze frame here (2 s)", hint: "⇧F", run: () => freezeFrame(frame), disabled: !inside || t.locked });
      out.push({ label: `Speed… (${(item as VideoItem).speed ?? 1}×)`, run: () => setSpeed(item as VideoItem), disabled: t.locked });
      out.push({ label: "Detach audio", hint: KEYS.detach, run: detachAudio, disabled: t.locked });
    }
    if ("keyframes" in item && item.keyframes) out.push({ label: "Previous keyframe", hint: KEYS.prevKey, run: () => stepKey(-1) }, { label: "Next keyframe", hint: KEYS.nextKey, run: () => stepKey(1) });
    out.push("-", ...transitionEntries(p, t, item as VideoItem));
    out.push("-", ...pipEntries(p, item as VideoItem).map((e) => (e === "-" ? e : { ...e, disabled: e.disabled || t.locked })));
    if (p.assets[item.assetId]?.kind !== "image") out.push({ label: "Slip…", hint: "⌥drag, ⌥, ⌥.", run: () => say("hold Alt and drag the item, or press Alt+, / Alt+. to slip a frame") });
  }
  if (t.kind === "audio") {
    const fit = p.tracks.find((x) => x.kind === "video" && x.magnetic && !x.locked);
    out.push(
      "-",
      { label: "Detect beats", run: () => op("detectBeats", { itemId: item.id }) },
      { label: "Clear beats", run: () => op("clearBeats", { itemId: item.id }), disabled: !(item as { beats?: number[] }).beats?.length },
      { label: `Fit ${fit?.name ?? "video track"} to beats`, run: () => op("fitToBeats", { trackId: fit!.id, audioItemId: item.id, ...(ioRange() && { range: ioRange() }) }), disabled: !fit || !(item as { beats?: number[] }).beats?.length },
    );
  }
  if (t.kind === "caption" || t.kind === "overlay") {
    const under = span && videoUnder(p, span.start);
    out.push(
      "-",
      anchor
        ? { label: `Detach from ${anchor.itemId} (freeze in place)`, run: () => op("attach", { itemId: item.id, to: null }), disabled: t.locked }
        : { label: under ? `Attach to ${under.id}` : "Attach (no video under its start)", run: () => op("attach", { itemId: item.id, to: under!.id }), disabled: !under || t.locked },
    );
    if (t.kind === "caption") out.push({ label: "Edit text", hint: "double-click", run: () => app.set({ editing: { kind: "caption", id: item.id } }), disabled: t.locked });
  }
  return out;
}

export function laneMenu(t: Track, frame: number, gap: boolean): MenuEntry[] {
  return [
    { label: "Fullscreen preview", hint: KEYS.fullscreen, run: () => player.ref?.requestFullscreen() },
    { label: "Paste here", hint: `${MOD}V`, run: () => paste(frame), disabled: !clipboard.length },
    { label: "Close gap", hint: "⌫", run: () => op("closeGap", { trackId: t.id, at: frame }), disabled: !gap },
    { label: "Remove all gaps on track", run: () => removeGaps(t), disabled: t.locked },
    { label: "Insert space here…", run: () => insertSpace(frame) },
    "-",
    { label: "Select all after here on track", run: () => selectItems(itemsAfter(app.get().project!, [t], frame)) },
    { label: "Select all after here", run: () => selectItems(itemsAfter(app.get().project!, app.get().project!.tracks, frame)) },
    "-",
    ...rulerMenu(frame),
  ];
}

export function rulerMenu(frame: number): MenuEntry[] {
  const m = markerNear(frame, 0);
  return [
    { label: "Add marker here", hint: "M", run: () => addMarker(frame) },
    ...(m ? [{ label: `Rename marker ${m.label}`, run: () => app.set({ editing: { kind: "marker", id: m.id } }) }, { label: `Delete marker ${m.label}`, hint: "⌥M", run: () => op("removeMarker", { markerId: m.id }) }] : []),
    { label: "Set In here", hint: "I", run: () => setIO("in", frame) },
    { label: "Set Out here", hint: "O", run: () => setIO("out", frame) },
    { label: "Select items here", run: () => selectItems(itemsUnder(app.get().project!, frame)) },
    { label: "Clear In/Out", hint: "⌥X", run: () => app.set({ io: { in: null, out: null } }), disabled: !ioRange() },
  ];
}

export function markerMenu(markerId: string): MenuEntry[] {
  const m = app.get().project!.markers?.find((x) => x.id === markerId);
  if (!m) return [];
  return [
    { label: "Rename", hint: "double-click", run: () => app.set({ editing: { kind: "marker", id: m.id } }) },
    { label: "Delete", hint: "⌥M", run: () => op("removeMarker", { markerId: m.id }) },
    { label: "Set In/Out to this range", run: () => app.set({ io: { in: m.start, out: m.start + m.duration! } }), disabled: !m.duration },
    "-",
    ...COLORS.map(([name, c]) => ({ label: `${(m.color ?? "") === c ? "✓ " : ""}${name}`, run: () => op("setMarker", { markerId: m.id, patch: { color: c || null } }) })),
  ];
}

const KIND_NAME: Record<TrackKind, string> = { video: "video", audio: "audio", caption: "caption", overlay: "overlay" };

export function trackMenu(p: Project, t: Track): MenuEntry[] {
  const i = p.tracks.indexOf(t);
  const flag = (key: "muted" | "hidden" | "locked" | "magnetic", label: string) => ({ label: `${t[key] ? "✓ " : ""}${label}`, run: () => op("setTrack", { trackId: t.id, patch: { [key]: t[key] ? null : true } }) });
  return [
    { label: "Rename", hint: "double-click", run: () => app.set({ editing: { kind: "track", id: t.id } }) },
    ...(t.kind === "caption" || t.kind === "overlay" ? [] : [flag("muted", "Mute")]),
    flag("hidden", "Hide"),
    flag("locked", "Lock"),
    flag("magnetic", "Magnetic (ripple edits)"),
    "-",
    { label: "Select all on track", run: () => selectItems(itemsAfter(p, [t])) },
    { label: "Remove all gaps", run: () => removeGaps(t), disabled: t.locked },
    ...(t.kind === "caption" ? [{ label: "Export SRT…", run: () => download(`${t.name}.srt`, toSrt(p, t)), disabled: !t.items.length }] : []),
    "-",
    { label: "Move up", run: () => op("moveTrack", { trackId: t.id, to: i + 1 }), disabled: i === p.tracks.length - 1 },
    { label: "Move down", run: () => op("moveTrack", { trackId: t.id, to: i - 1 }), disabled: i === 0 },
    { label: `Add ${KIND_NAME[t.kind]} track`, run: () => op("addTrack", { kind: t.kind }) },
    "-",
    { label: "Delete track", run: () => removeTrack(t), disabled: t.locked },
  ];
}

export function removeTrack(t: Track) {
  if (t.items.length && !confirm(`Delete track ${t.name} and its ${t.items.length} items?`)) return;
  return op("removeTrack", { trackId: t.id });
}

/** New track of `kind` holding one asset: addTrack and insertItem as one step. */
export function insertOnNewTrack(kind: TrackKind, assetId: string, at: number, duration?: number) {
  const p = app.get().project!;
  const trackId = idMaker(p)("t");
  return send([
    { op: "addTrack", args: { kind } },
    { op: "insertItem", args: { trackId, assetId, at, ...(duration && { duration }) } },
  ]);
}

// ---- import from the UI ----

/** Uploads files into raw/ and imports them; the server probes before answering, then ingests in the
 * background. Resolves to the asset ids, in order, of the files that imported. */
export async function upload(files: File[]): Promise<string[]> {
  const ids: string[] = [];
  for (const f of files) {
    app.set(({ uploads }) => ({ uploads: [...uploads, f.name] }));
    try {
      const res = await fetch(`/api/import?name=${encodeURIComponent(f.name)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f });
      const data = await res.json();
      if (data.error) say(`import ${f.name}: ${data.error.message ?? data.error}`, true);
      else ids.push(data.assetId), say(data.summary);
    } catch (e) {
      say(`import ${f.name}: ${(e as Error).message}`, true);
    } finally {
      app.set(({ uploads }) => ({ uploads: uploads.filter((n) => n !== f.name) }));
    }
  }
  await refresh();
  return ids;
}

/** Files dropped on the timeline: import, then place them one after another from `at`. No `trackId`
 * means a new track per kind (the drop row under the tracks). */
export async function dropFiles(files: File[], at: number, trackId?: string) {
  const ids = await upload(files);
  const { project: p, durations } = app.get();
  if (!ids.length || !p) return;
  const fps = p.meta.fps;
  const target = p.tracks.find((t) => t.id === trackId);
  const id = idMaker(p);
  const ops: Op[] = [];
  const fresh: Record<string, string> = {};
  for (const assetId of ids) {
    const a = p.assets[assetId];
    const kind = a.kind === "audio" ? "audio" : "video";
    const duration = a.kind === "image" ? 5 * fps : Math.floor((durations[assetId] ?? 5) * fps);
    let tid = target?.kind === kind ? target.id : undefined;
    if (!target) {
      if (!fresh[kind]) ops.push({ op: "addTrack", args: { kind } }), (fresh[kind] = id("t"));
      tid = fresh[kind];
    }
    ops.push({ op: "insertItem", args: { assetId, at, duration, ...(tid && { trackId: tid }) } });
    at += duration;
  }
  return send(ops);
}
