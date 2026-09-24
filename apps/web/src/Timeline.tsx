import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { anchorOf, beatFrames, durationFrames, formatFrame, gapAt, itemSpan, rulerTicks, secPerFrame, snap, snapPoints, snapSpan, transitionOf, type AudioItem, type CaptionItem, type Item, type Project, type SnapPoint, type Track, type VideoItem } from "@splicewright/core";
import { app, dnd, ioRange, op, playhead, say, seek } from "./store.ts";
import { dropFiles, findItem, insertOnNewTrack, laneMenu, markerMenu, openMenu, itemMenu, rulerMenu, trackMenu, videoUnder } from "./edit.ts";

// Spec §7.3 timeline and §15.1–15.2 ruler and snapping.

export const HEADER = 120;
const RULER = 28;
const ROW = 48;
const SNAP_PX = 8;
export const MAX_PX_PER_FRAME = 24;

const GUIDE: Record<SnapPoint["kind"], string> = { playhead: "playhead", edge: "clip edge", marker: "marker", beat: "beat", caption: "caption", tick: "tick" };

interface Drag {
  item: Item;
  track: Track;
  mode: "move" | "start" | "end" | "slip";
  /** Pointer frame at pointer down, and the span then. */
  grab: number;
  span: { start: number; duration: number };
  /** Live result. */
  start: number;
  duration: number;
  trackId: string;
  guide: SnapPoint | null;
  /** Other selected items riding along on a move, with their start at pointer down. */
  group: Map<string, number>;
  /** The group would overlap something. */
  bad: boolean;
  /** Alt-drag of a caption/overlay: re-attach to the video under its new start. */
  attach: boolean;
  attachTo?: string;
  /** Playhead to restore after a slip. */
  from: number;
  sourceIn?: number;
  slipTo?: number;
  /** Slip hit the source edge. */
  limit?: boolean;
}

/** Frame under a client x, given the lanes element (which scrolls with the content). */
const frameAt = (lanes: HTMLElement, clientX: number, ppf: number) => Math.max(0, Math.round((clientX - lanes.getBoundingClientRect().left) / ppf));

let scrubbing = false;

/** Seeks to the pointer and follows it while the button is held. `lanes` is any element whose left edge is frame 0. */
function scrub(e: React.PointerEvent<HTMLElement>, lanes: HTMLElement, ppf: number) {
  if (e.button !== 0) return;
  e.stopPropagation();
  const el = e.currentTarget;
  const at = (ev: { clientX: number }) => seek(frameAt(lanes, ev.clientX, ppf));
  at(e);
  scrubbing = true;
  el.setPointerCapture(e.pointerId);
  el.onpointermove = (ev) => ev.buttons && at(ev);
  el.onlostpointercapture = () => (scrubbing = false);
}

export function Timeline() {
  const p = app.use((s) => s.project)!;
  const ppf = app.use((s) => s.pxPerFrame);
  const selection = app.use((s) => s.selection);
  const gap = app.use((s) => s.gap);
  const editing = app.use((s) => s.editing);
  app.use((s) => s.io);
  const range = ioRange();
  const scroller = useRef<HTMLDivElement>(null);
  const lanes = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 1000 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [ghost, setGhost] = useState<{ trackId: string; at: number; duration?: number; bad: boolean } | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [reorder, setReorder] = useState<{ from: string; to: string } | null>(null);
  const zoomAnchor = useRef<{ frame: number; x: number } | null>(null);

  const total = durationFrames(p);
  const fps = p.meta.fps;
  const width = (total + 10 * fps) * ppf;
  const from = Math.floor(view.left / ppf);
  const ticks = rulerTicks(fps, ppf, [from, Math.ceil((view.left + view.width) / ppf) + 1]);
  const tracks = [...p.tracks].reverse(); // top layer first, as in every NLE

  const onScroll = () => setView({ left: scroller.current!.scrollLeft, width: scroller.current!.clientWidth - HEADER });
  useEffect(() => {
    onScroll();
    const ro = new ResizeObserver(onScroll);
    ro.observe(scroller.current!);
    return () => ro.disconnect();
  }, []);

  // Keep the frame under the pointer (or the playhead) in place when zoom changes.
  useLayoutEffect(() => {
    const a = zoomAnchor.current ?? { frame: playhead.get().frame, x: view.width / 2 };
    zoomAnchor.current = null;
    scroller.current!.scrollLeft = a.frame * ppf - a.x;
  }, [ppf]);

  useEffect(() => {
    const el = scroller.current!;
    const wheel = (e: WheelEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      const ppf = app.get().pxPerFrame;
      const frame = (e.clientX - lanes.current!.getBoundingClientRect().left) / ppf;
      zoomAnchor.current = { frame, x: frame * ppf - el.scrollLeft };
      zoom(Math.exp(-e.deltaY / 200));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  function down(e: React.PointerEvent, track: Track, item: Item) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const id = item.id;
    const sel = app.get().selection;
    const next = e.shiftKey || e.metaKey ? (sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]) : sel.includes(id) ? sel : [id];
    app.set({ gap: null, selection: next });
    if (track.locked) return;
    const span = itemSpan(p, item)!;
    const x = e.clientX - (e.currentTarget as HTMLElement).getBoundingClientRect().left;
    const w = span.duration * ppf;
    let mode: Drag["mode"] = x < 6 && w > 18 ? "start" : x > w - 6 && w > 18 ? "end" : "move";
    const slippable = "sourceIn" in item && p.assets[item.assetId]?.kind !== "image";
    if (e.altKey && mode === "move" && slippable) mode = "slip";
    const attach = e.altKey && mode === "move" && (track.kind === "caption" || track.kind === "overlay");
    // The other selected items ride along on a plain move, as a rigid block.
    const group = new Map<string, number>();
    if (mode === "move" && !attach && next.includes(id))
      for (const other of next) {
        const f = other !== id && findItem(p, other);
        const s = f && !f.track.locked && itemSpan(p, f.item);
        if (s) group.set(other, s.start);
      }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const from = playhead.get().frame;
    if (mode === "slip") seek(span.start); // show the new first frame while slipping
    setDrag({ item, track, mode, grab: frameAt(lanes.current!, e.clientX, ppf), span, start: span.start, duration: span.duration, trackId: track.id, guide: null, group, bad: false, attach, from, ...("sourceIn" in item && { sourceIn: item.sourceIn, slipTo: item.sourceIn }) });
  }

  function move(e: React.PointerEvent) {
    if (!drag) return;
    const d = frameAt(lanes.current!, e.clientX, ppf) - drag.grab;
    const s = app.get();
    const id = drag.item.id;
    if (drag.mode === "slip") {
      // Dragging right moves the film strip right: earlier source shows.
      const len = s.durations[(drag.item as { assetId: string }).assetId];
      const spf = secPerFrame(p, drag.item as VideoItem);
      const max = len === undefined ? Infinity : len - drag.span.duration * spf;
      const want = drag.sourceIn! - d * spf;
      const to = Math.min(max, Math.max(0, want));
      app.set({ slip: { itemId: id, sourceIn: to } });
      return setDrag({ ...drag, slipTo: to, limit: to !== want });
    }
    const moving = drag.mode === "move";
    // Own edges never count; own beats count for trims, and travel with the item on a move (§15.2).
    const moved = new Set([id, ...drag.group.keys()]);
    const points = s.snapping && !e.altKey ? snapPoints(p, [0, Infinity], { playhead: playhead.get().frame }).filter((pt) => !(pt.ref && moved.has(pt.ref)) || (pt.ref === id && pt.kind === "beat" && !moving)) : [];
    const threshold = Math.max(1, SNAP_PX / ppf);
    const ex: string[] = [];
    const { start, duration } = drag.span;
    let next: Pick<Drag, "start" | "duration" | "guide" | "trackId">;
    let bad = false;
    let attachTo: string | undefined;
    if (moving) {
      const beats = drag.track.kind === "audio" ? beatFrames(p, drag.item as AudioItem).map((f) => f - drag.item.start) : [];
      const r = snapSpan(points, Math.max(0, start + d), duration, threshold, ex, beats);
      // Another row of the same kind under the pointer? (single items only; a group keeps its tracks)
      const row = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-track]");
      const over = p.tracks.find((t) => t.id === row?.dataset.track);
      next = { start: Math.max(0, r.frame), duration, guide: r.target, trackId: !drag.group.size && over && over.kind === drag.track.kind && !over.locked ? over.id : drag.trackId };
      if (drag.group.size) {
        const delta = Math.max(next.start - start, -Math.min(start, ...drag.group.values()));
        next.start = start + delta;
        bad = [[id, start] as const, ...drag.group].some(([mid, s0]) => {
          const f = findItem(p, mid)!;
          if (f.track.kind === "caption" || anchorOf(f.item)) return false;
          const a = s0 + delta;
          const b = a + itemSpan(p, f.item)!.duration;
          return f.track.items.some((o) => !moved.has(o.id) && !anchorOf(o) && o.start < b && a < o.start + o.duration);
        });
      }
      if (drag.attach) attachTo = videoUnder(p, next.start)?.id;
    } else if (drag.mode === "start") {
      const r = snap(points, Math.min(start + duration - 1, Math.max(0, start + d)), threshold, ex);
      const f = Math.min(start + duration - 1, r.frame);
      next = { start: f, duration: start + duration - f, guide: r.target, trackId: drag.trackId };
    } else {
      const r = snap(points, Math.max(start + 1, start + duration + d), threshold, ex);
      next = { start, duration: Math.max(1, r.frame - start), guide: r.target, trackId: drag.trackId };
    }
    setDrag({ ...drag, ...next, bad, attachTo });
  }

  async function up() {
    if (!drag) return;
    setDrag(null);
    const { item, mode, span } = drag;
    if (mode === "slip") {
      app.set({ slip: null });
      seek(drag.from);
      if (drag.slipTo !== drag.sourceIn) await op("slip", { itemId: item.id, deltaSec: +(drag.slipTo! - drag.sourceIn!).toFixed(6) });
      return;
    }
    const delta = drag.start - span.start;
    if (mode === "move" && drag.group.size) {
      if (!delta) return;
      if (drag.bad) return say("the selection would overlap other items there", true);
      const all = [[item.id, span.start] as const, ...drag.group];
      const ids = new Set(all.map(([id]) => id));
      // Items anchored to a moving item follow it; moving them too would move them twice.
      const ops = all
        .filter(([id]) => !ids.has(anchorOf(findItem(p, id)!.item)?.itemId ?? ""))
        .map(([id, s0]) => ({ op: "move", args: { itemId: id, to: s0 + delta, ripple: false } }));
      return op("batch", { ops });
    }
    if (mode === "move" && drag.attach) {
      const anchored = anchorOf(item);
      const to = drag.attachTo;
      if (!to) return delta ? op("move", { itemId: item.id, to: drag.start }) : say("no video item under it to attach to", true);
      return op("batch", {
        ops: [...(anchored ? [{ op: "attach", args: { itemId: item.id, to: null } }] : []), ...(delta ? [{ op: "move", args: { itemId: item.id, to: drag.start } }] : []), { op: "attach", args: { itemId: item.id, to } }],
      });
    }
    if (mode === "move" && (delta || drag.trackId !== drag.track.id)) await op("move", { itemId: item.id, to: drag.start, ...(drag.trackId !== drag.track.id && { trackId: drag.trackId }) });
    if (mode === "start" && drag.start !== span.start) await op("trim", { itemId: item.id, edge: "start", to: drag.start });
    if (mode === "end" && drag.duration !== span.duration) await op("trim", { itemId: item.id, edge: "end", to: drag.start + drag.duration });
  }

  /** Empty lane: a click seeks (and picks a gap); a drag draws a selection box. Shift adds, Cmd toggles. */
  function laneDown(e: React.PointerEvent<HTMLElement>, t: Track) {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const at = frameAt(el, e.clientX, ppf);
    const [x0, y0] = [e.clientX, e.clientY];
    const toggle = e.metaKey || e.ctrlKey;
    const base = e.shiftKey || toggle ? app.get().selection : [];
    let boxing = false;
    el.setPointerCapture(e.pointerId);
    el.onpointermove = (ev) => {
      if (!ev.buttons || (!boxing && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4)) return;
      boxing = true;
      const r = { left: Math.min(x0, ev.clientX), top: Math.min(y0, ev.clientY), right: Math.max(x0, ev.clientX), bottom: Math.max(y0, ev.clientY) };
      setBox({ left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top });
      const hits = [...document.querySelectorAll<HTMLElement>(".tracks .item[data-id]")]
        .filter((n) => {
          const b = n.getBoundingClientRect();
          return b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
        })
        .map((n) => n.dataset.id!);
      const selection = toggle ? [...base.filter((id) => !hits.includes(id)), ...hits.filter((id) => !base.includes(id))] : [...new Set([...base, ...hits])];
      app.set({ gap: null, selection });
    };
    el.onpointerup = () => {
      el.onpointermove = el.onpointerup = null;
      setBox(null);
      if (boxing) return;
      app.set({ selection: base, gap: !t.locked && gapAt(t, at) ? { trackId: t.id, at } : null });
      seek(at);
    };
  }

  /** Drag a track header up or down to change its layer. */
  function headerDown(e: React.PointerEvent<HTMLElement>, t: Track) {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const y0 = e.clientY;
    let to: string | undefined;
    el.onpointermove = (ev) => {
      if (!ev.buttons || Math.abs(ev.clientY - y0) < 4) return;
      // Capture only once it is a drag: capturing on down would steal the name's double-click.
      if (!el.hasPointerCapture(ev.pointerId)) el.setPointerCapture(ev.pointerId);
      const row = [...document.querySelectorAll<HTMLElement>("[data-row]")].find((r) => {
        const b = r.getBoundingClientRect();
        return ev.clientY >= b.top && ev.clientY < b.bottom;
      });
      to = row?.dataset.row;
      setReorder(to ? { from: t.id, to } : null);
    };
    el.onpointerup = () => {
      el.onpointermove = el.onpointerup = null;
      setReorder(null);
      const target = p.tracks.findIndex((x) => x.id === to);
      if (to && to !== t.id && target !== -1) op("moveTrack", { trackId: t.id, to: target });
    };
  }

  function ioDown(e: React.PointerEvent<HTMLElement>, which: "in" | "out") {
    e.stopPropagation();
    const el = e.currentTarget;
    const lane = el.closest<HTMLElement>(".lane")!;
    el.setPointerCapture(e.pointerId);
    el.onpointermove = (ev) => {
      if (!ev.buttons) return;
      const f = frameAt(lane, ev.clientX, ppf);
      app.set(({ io }) => {
        const [a, b] = ioRange()!;
        return { io: { ...io, [which]: which === "in" ? Math.min(f, b - 1) : Math.max(f, a + 1) } };
      });
    };
    el.onpointerup = () => (el.onpointermove = el.onpointerup = null);
  }

  function dropAt(e: React.DragEvent) {
    const at = frameAt(lanes.current!, e.clientX, ppf);
    return app.get().snapping && !e.altKey ? snap(snapPoints(p, [0, Infinity], { playhead: playhead.get().frame }), at, Math.max(1, SNAP_PX / ppf)).frame : at;
  }

  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

  /** Where and how long the dragged asset would land; red when it would overlap on a non-magnetic track. */
  function dragOver(e: React.DragEvent, track: Track | null) {
    e.preventDefault();
    const id = track?.id ?? "new";
    if (hasFiles(e)) return ghost?.trackId !== id || ghost.at !== dropAt(e) ? setGhost({ trackId: id, at: dropAt(e), bad: false }) : undefined;
    const asset = p.assets[dnd.assetId ?? ""];
    if (!asset || (track && (asset.kind === "audio" ? "audio" : "video") !== track.kind)) return ghost && setGhost(null);
    const at = dropAt(e);
    const secs = app.get().durations[asset.id];
    const duration = asset.kind === "image" ? 5 * fps : secs !== undefined ? Math.floor(secs * fps) : undefined;
    const bad = !!track && !track.magnetic && track.items.some((i) => !anchorOf(i) && i.start < at + (duration ?? 1) && at < i.start + i.duration);
    if (ghost?.trackId !== id || ghost.at !== at || ghost.duration !== duration || ghost.bad !== bad) setGhost({ trackId: id, at, duration, bad });
  }

  /** Drop from the media bin or from the file system; `track` null is the new-track row. */
  async function drop(e: React.DragEvent, track: Track | null) {
    setGhost(null);
    const at = dropAt(e);
    if (hasFiles(e)) return e.preventDefault(), dropFiles([...e.dataTransfer.files], at, track?.id);
    const assetId = e.dataTransfer.getData("application/x-splicewright-asset");
    const asset = p.assets[assetId];
    if (!asset) return;
    e.preventDefault();
    const kind = asset.kind === "audio" ? "audio" : "video";
    // Probed assets let the core default the duration; otherwise read it from the media here.
    const probed = asset.kind !== "image" && app.get().durations[assetId] !== undefined;
    const duration = probed ? undefined : await assetFrames(asset.path, asset.kind, fps);
    if (!track) return insertOnNewTrack(kind, assetId, at, duration);
    await op("insertItem", { assetId, at, ...(duration && { duration }), ...(track.kind === kind && { trackId: track.id }) });
  }

  const Ghost = ({ id, magnetic }: { id: string; magnetic?: boolean }) =>
    ghost?.trackId === id ? (
      <div className={`ghost ${ghost.bad ? "bad" : ""}`} style={{ left: ghost.at * ppf, width: ghost.duration ? ghost.duration * ppf : 2 }}>
        <span>{ghost.duration ? `${formatFrame(ghost.duration, fps)}${magnetic ? " · ripple" : ""}` : "?"}</span>
      </div>
    ) : null;

  return (
    <div className="timeline" ref={scroller} onScroll={onScroll}>
      <div style={{ width: HEADER + width }}>
        <div className="row ruler" style={{ height: RULER }}>
          <div className="corner" style={{ width: HEADER }}>{formatFrame(from, fps, 1)}</div>
          <div className="lane" style={{ width }} onPointerDown={(e) => scrub(e, e.currentTarget, ppf)} onContextMenu={(e) => openMenu(e, rulerMenu(frameAt(e.currentTarget, e.clientX, ppf)))}>
            {range && (
              <div className="io" style={{ left: range[0] * ppf, width: (range[1] - range[0]) * ppf }} title="I/O range: drag the ends; Alt+X clears">
                <div className="io-h in" onPointerDown={(e) => ioDown(e, "in")} />
                <div className="io-h out" onPointerDown={(e) => ioDown(e, "out")} />
              </div>
            )}
            <PlayheadHead ppf={ppf} />
            {ticks.minor.map((f) => <div key={f} className="tick minor" style={{ left: f * ppf }} />)}
            {ticks.labels.map((l) => (
              <div key={l.frame} className="tick major" style={{ left: l.frame * ppf }}>
                <span>{l.text}</span>
              </div>
            ))}
            {(p.markers ?? []).map((m) =>
              editing?.kind === "marker" && editing.id === m.id ? (
                <InlineInput key={m.id} className="marker-edit" style={{ left: m.start * ppf }} value={m.label} onDone={(v) => v !== m.label && op("setMarker", { markerId: m.id, patch: { label: v } })} />
              ) : (
                <div
                  key={m.id}
                  className="marker"
                  title={`${m.label} (${m.id}) — double-click to rename, right-click for more`}
                  style={{ left: m.start * ppf, width: m.duration ? m.duration * ppf : undefined, background: m.color }}
                  onPointerDown={(e) => e.button === 0 && (e.stopPropagation(), seek(m.start))}
                  onDoubleClick={() => app.set({ editing: { kind: "marker", id: m.id } })}
                  onContextMenu={(e) => openMenu(e, markerMenu(m.id))}
                >
                  {m.label}
                </div>
              ),
            )}
          </div>
        </div>
        <div className="tracks" onPointerMove={move} onPointerUp={up}>
          {tracks.map((t) => (
            <div key={t.id} className={`row ${reorder?.to === t.id && reorder.from !== t.id ? "drop-row" : ""}`} data-row={t.id} style={{ height: ROW }}>
              <TrackHeader p={p} t={t} onPointerDown={(e) => headerDown(e, t)} />
              <div
                data-track={t.id}
                className={`lane ${t.kind} ${drag && drag.trackId === t.id && drag.trackId !== drag.track.id ? "target" : ""}`}
                style={{ width }}
                onPointerDown={(e) => laneDown(e, t)}
                onContextMenu={(e) => {
                  const at = frameAt(e.currentTarget, e.clientX, ppf);
                  const g = !t.locked && !!gapAt(t, at);
                  app.set({ selection: [], gap: g ? { trackId: t.id, at } : null });
                  openMenu(e, laneMenu(t, at, g));
                }}
                onDragOver={(e) => dragOver(e, t)}
                onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setGhost(null)}
                onDrop={(e) => drop(e, t)}
              >
                {gap?.trackId === t.id && <Gap span={gapAt(t, gap.at)} ppf={ppf} />}
                <Ghost id={t.id} magnetic={t.magnetic} />
                {t.items.map((item) => {
                  const span = itemSpan(p, item);
                  if (!span) return null;
                  const live = drag?.item.id === item.id ? drag : null;
                  const rider = drag?.group.get(item.id);
                  const [start, duration] = live ? [live.start, live.duration] : rider !== undefined ? [rider + drag!.start - drag!.span.start, span.duration] : [span.start, span.duration];
                  const shown = live?.mode === "slip" ? ({ ...item, sourceIn: live.slipTo } as typeof item) : item;
                  const cls = ["item", selection.includes(item.id) && "selected", (live || rider !== undefined) && "dragging", (live || rider !== undefined) && drag!.bad && "bad", live?.limit && "limit"].filter(Boolean).join(" ");
                  return (
                    <React.Fragment key={item.id}>
                      <div
                        data-id={item.id}
                        className={cls}
                        style={{ left: start * ppf, width: Math.max(2, duration * ppf), ...(live && live.trackId !== t.id && { opacity: 0.35 }) }}
                        onPointerDown={(e) => down(e, t, item)}
                        onContextMenu={(e) => {
                          if (!selection.includes(item.id)) app.set({ selection: [item.id], gap: null });
                          openMenu(e, itemMenu(p, t, item, frameAt(lanes.current!, e.clientX, ppf)));
                        }}
                        onDoubleClick={() => t.kind === "caption" && !t.locked && app.set({ editing: { kind: "caption", id: item.id } })}
                        title={`${item.id}${t.kind === "caption" ? " — double-click to edit" : ""}${"sourceIn" in item && t.kind === "video" ? " — Alt+drag to slip" : ""}${t.kind === "caption" || t.kind === "overlay" ? " — Alt+drag to attach to the video under it" : ""}`}
                      >
                        {"assetId" in shown && t.kind === "video" && <Thumbs p={p} item={shown} width={duration * ppf} viewLeft={view.left - start * ppf} viewWidth={view.width} />}
                        {"assetId" in shown && t.kind === "audio" && <Wave assetId={shown.assetId} sourceIn={shown.sourceIn} fps={fps} ppf={ppf} duration={duration} />}
                        {t.kind === "audio" && !(live && live.mode !== "move") && <BeatTicks p={p} item={item as AudioItem} ppf={ppf} />}
                        {live?.mode === "slip" && <SlipEnds p={p} item={shown as Item & { assetId: string; sourceIn: number }} />}
                        {"sourceIn" in item && !t.locked && !live && <FadeHandles item={item} ppf={ppf} />}
                        <span className="name">
                          {"text" in item ? item.text : "component" in item ? item.component : (item.label ?? p.assets[item.assetId]?.path)}
                          {"speed" in item && item.speed ? ` · ${item.speed}×` : ""}
                        </span>
                      </div>
                      <TransitionMark t={t} item={item} ppf={ppf} />
                      {editing?.kind === "caption" && editing.id === item.id && <CaptionEditor p={p} t={t} item={item as CaptionItem} left={start * ppf} width={Math.max(240, duration * ppf)} />}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="row add-row" style={{ height: 30 }}>
            <div className="track-header" style={{ width: HEADER }} title="Add a track">
              {(["video", "audio", "caption", "overlay"] as const).map((k) => (
                <button key={k} onClick={() => op("addTrack", { kind: k })} title={`Add ${k} track`}>
                  +{k[0].toUpperCase()}
                </button>
              ))}
            </div>
            <div className="lane new" style={{ width }} onDragOver={(e) => dragOver(e, null)} onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setGhost(null)} onDrop={(e) => drop(e, null)}>
              <span className="dim">drop media here for a new track</span>
              <Ghost id="new" />
            </div>
          </div>
          {/* Frame 0 of the lanes; also hosts the playhead and snap guide. */}
          <div ref={lanes} className="origin" style={{ left: HEADER, width }}>
            {range && <div className="io-shade" style={{ left: range[0] * ppf, width: (range[1] - range[0]) * ppf }} />}
            {drag?.guide && (
              <div className="guide" style={{ left: drag.guide.frame * ppf }}>
                <span>{GUIDE[drag.guide.kind]}</span>
              </div>
            )}
            {drag?.attach && (
              <div className="guide attach" style={{ left: drag.start * ppf }}>
                <span>{drag.attachTo ? `attach → ${drag.attachTo}` : "no video here"}</span>
              </div>
            )}
            <BeatGuides p={p} selection={selection} ppf={ppf} />
            <Playhead ppf={ppf} scroller={scroller} />
          </div>
        </div>
      </div>
      {box && <div className="marquee" style={box} />}
    </div>
  );
}


/** The only timeline part that re-renders per frame. */
function Playhead({ ppf, scroller }: { ppf: number; scroller: React.RefObject<HTMLDivElement | null> }) {
  const frame = playhead.use((s) => s.frame);
  // Page the view when the playhead leaves it (playback, keyboard jumps), but not under a scrubbing pointer.
  useEffect(() => {
    const el = scroller.current;
    if (!el || scrubbing) return;
    const x = frame * ppf;
    const w = el.clientWidth - HEADER;
    if (x > el.scrollLeft + w) el.scrollLeft = x - 0.1 * w;
    else if (x < el.scrollLeft) el.scrollLeft = x - 0.9 * w;
  }, [frame]);
  return <div className="playhead" style={{ left: frame * ppf }} />;
}

function Gap({ span, ppf }: { span?: [number, number]; ppf: number }) {
  return span ? <div className="gap" style={{ left: span[0] * ppf, width: (span[1] - span[0]) * ppf }} title="gap: Delete closes it" /> : null;
}

/** Grab handle in the ruler; the ruler itself does the scrubbing. */
function PlayheadHead({ ppf }: { ppf: number }) {
  const frame = playhead.use((s) => s.frame);
  return <div className="playhead-head" style={{ left: frame * ppf }} />;
}

function TrackHeader({ p, t, onPointerDown }: { p: Project; t: Track; onPointerDown: (e: React.PointerEvent<HTMLElement>) => void }) {
  const editing = app.use((s) => s.editing);
  const flag = (key: "muted" | "hidden" | "locked" | "magnetic", label: string, title: string) => (
    <button className={t[key] ? "on" : ""} title={title} onPointerDown={(e) => e.stopPropagation()} onClick={() => op("setTrack", { trackId: t.id, patch: { [key]: t[key] ? null : true } })}>
      {label}
    </button>
  );
  return (
    <div className="track-header" style={{ width: HEADER }} onPointerDown={onPointerDown} onContextMenu={(e) => openMenu(e, trackMenu(p, t))} title="Drag to reorder; right-click for more">
      {editing?.kind === "track" && editing.id === t.id ? (
        <InlineInput value={t.name} onDone={(v) => v && v !== t.name && op("setTrack", { trackId: t.id, patch: { name: v } })} />
      ) : (
        <span onDoubleClick={() => app.set({ editing: { kind: "track", id: t.id } })}>{t.name}</span>
      )}
      {flag("magnetic", "⧉", "magnetic: edits ripple, inserts push later items")}
      {t.kind !== "caption" && t.kind !== "overlay" && flag("muted", "M", "muted")}
      {flag("hidden", "H", "hidden")}
      {flag("locked", "L", "locked")}
    </div>
  );
}

/** Text input that commits on Enter or blur and cancels on Escape; closes the `editing` state. */
function InlineInput({ value, onDone, className, style }: { value: string; onDone: (v: string) => unknown; className?: string; style?: React.CSSProperties }) {
  const done = (v: string | null) => {
    if (!app.get().editing) return; // already closed (Enter, then the blur of unmounting)
    app.set({ editing: null });
    if (v !== null) onDone(v.trim());
  };
  return (
    <input
      className={`inline-edit ${className ?? ""}`}
      style={style}
      autoFocus
      defaultValue={value}
      onFocus={(e) => e.currentTarget.select()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => (e.key === "Enter" ? done(e.currentTarget.value) : e.key === "Escape" && done(null))}
      onBlur={(e) => done(e.currentTarget.value)}
    />
  );
}

/** In-place caption text: Enter saves, Shift+Enter breaks the line, Escape cancels, Tab saves and edits the next caption. */
function CaptionEditor({ p, t, item, left, width }: { p: Project; t: Track; item: CaptionItem; left: number; width: number }) {
  const done = (text: string | null, next = false) => {
    if (app.get().editing?.id !== item.id) return;
    app.set({ editing: null });
    if (text !== null && text !== item.text) op("editCaption", { captionId: item.id, text });
    if (!next) return;
    const later = t.items
      .map((i) => ({ i, s: itemSpan(p, i) }))
      .filter((x) => x.s && x.s.start > (itemSpan(p, item)?.start ?? item.start))
      .sort((a, b) => a.s!.start - b.s!.start)[0];
    if (later) app.set({ editing: { kind: "caption", id: later.i.id }, selection: [later.i.id] }), seek(later.s!.start);
  };
  return (
    <textarea
      className="caption-edit"
      style={{ left, width }}
      autoFocus
      defaultValue={item.text}
      onFocus={(e) => e.currentTarget.select()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) e.preventDefault(), done(e.currentTarget.value);
        else if (e.key === "Escape") done(null);
        else if (e.key === "Tab") e.preventDefault(), done(e.currentTarget.value, true);
      }}
      onBlur={(e) => done(e.currentTarget.value)}
    />
  );
}

/** Slip preview: the new first and last source frames at the item's ends. */
function SlipEnds({ p, item }: { p: Project; item: Item & { assetId: string; sourceIn: number } }) {
  const last = item.sourceIn + (item.duration - 1) * secPerFrame(p, item);
  return (
    <>
      <img className="slip-end in" src={`/api/thumb?asset=${item.assetId}&t=${Math.floor(item.sourceIn)}`} alt="" draggable={false} />
      <img className="slip-end out" src={`/api/thumb?asset=${item.assetId}&t=${Math.floor(last)}`} alt="" draggable={false} />
      <span className="slip-label">
        {formatFrame(Math.round(item.sourceIn * p.meta.fps), p.meta.fps)} → {formatFrame(Math.round(last * p.meta.fps), p.meta.fps)}
      </span>
    </>
  );
}

/** The span a transition covers across the cut after `item`. */
function TransitionMark({ t, item, ppf }: { t: Track; item: Item; ppf: number }) {
  const tr = transitionOf(t, item);
  if (!tr) return null;
  const cut = item.start + item.duration;
  return <div className={`xfade ${tr.kind}`} style={{ left: (cut - tr.before) * ppf, width: (tr.before + tr.after) * ppf }} title={`${tr.kind} ${tr.before + tr.after}f into ${tr.next.id}`} />;
}

/** Fade wedges with corner handles, and a volume line to drag up and down (shown on hover or selection). */
function FadeHandles({ item, ppf }: { item: AudioItem | VideoItem; ppf: number }) {
  const [live, setLive] = useState<{ fadeIn?: number; fadeOut?: number; volume?: number } | null>(null);
  const fadeIn = live?.fadeIn ?? item.fadeIn ?? 0;
  const fadeOut = live?.fadeOut ?? item.fadeOut ?? 0;
  const volume = live?.volume ?? item.volume ?? 1;
  const grab = (e: React.PointerEvent<HTMLElement>, key: "fadeIn" | "fadeOut" | "volume") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const el = e.currentTarget;
    const box = el.parentElement!.getBoundingClientRect();
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    let value: number | undefined;
    el.setPointerCapture(e.pointerId);
    el.onpointermove = (ev) => {
      if (!ev.buttons) return;
      value =
        key === "volume"
          ? +clamp(2 * (1 - (ev.clientY - box.top) / box.height), 0, 2).toFixed(2)
          : key === "fadeIn"
            ? clamp(Math.round((ev.clientX - box.left) / ppf), 0, item.duration - fadeOut)
            : clamp(Math.round((box.right - ev.clientX) / ppf), 0, item.duration - fadeIn);
      setLive({ [key]: value });
    };
    el.onpointerup = () => {
      el.onpointermove = el.onpointerup = null;
      const before = item[key] ?? (key === "volume" ? 1 : 0);
      if (value === undefined || value === before) return setLive(null);
      // 0 fades and unity volume unset the field.
      op("setProps", { itemId: item.id, patch: { [key]: value === (key === "volume" ? 1 : 0) ? null : value } }).then(() => setLive(null));
    };
  };
  const db = volume ? `${(20 * Math.log10(volume)).toFixed(1)} dB` : "−∞ dB";
  return (
    <>
      {fadeIn > 0 && <div className="fade in" style={{ width: fadeIn * ppf }} />}
      {fadeOut > 0 && <div className="fade out" style={{ width: fadeOut * ppf }} />}
      <div className="fade-h in" style={{ left: fadeIn * ppf }} onPointerDown={(e) => grab(e, "fadeIn")} title={`fade in ${fadeIn}f — drag`} />
      <div className="fade-h out" style={{ right: fadeOut * ppf }} onPointerDown={(e) => grab(e, "fadeOut")} title={`fade out ${fadeOut}f — drag`} />
      <div className={`vol ${live?.volume !== undefined ? "live" : ""}`} style={{ top: `${(1 - volume / 2) * 100}%` }} onPointerDown={(e) => grab(e, "volume")} title={`volume ${volume} (${db}) — drag`}>
        <span>{db}</span>
      </div>
    </>
  );
}

function BeatTicks({ p, item, ppf }: { p: Project; item: AudioItem; ppf: number }) {
  const down = new Set(beatFrames(p, item, item.downbeats));
  return beatFrames(p, item).map((f) => <div key={f} className={`beat ${down.has(f) ? "down" : ""}`} style={{ left: (f - item.start) * ppf }} />);
}

/** Faint full-height lines at the selected audio items' beats (§15.3). */
function BeatGuides({ p, selection, ppf }: { p: Project; selection: string[]; ppf: number }) {
  const frames = p.tracks.flatMap((t) => (t.kind === "audio" ? t.items.filter((i) => selection.includes(i.id)).flatMap((i) => beatFrames(p, i)) : []));
  return frames.map((f) => <div key={f} className="beat-guide" style={{ left: f * ppf }} />);
}

/** Video thumbnails at whole source seconds, only across the visible part of the item. */
function Thumbs({ p, item, width, viewLeft, viewWidth }: { p: Project; item: Item & { assetId: string; sourceIn: number }; width: number; viewLeft: number; viewWidth: number }) {
  const W = 96;
  const fps = p.meta.fps;
  const ppf = width / item.duration;
  const out: React.ReactNode[] = [];
  for (let x = Math.max(0, Math.floor(viewLeft / W) * W); x < Math.min(width, viewLeft + viewWidth); x += W) {
    const t = Math.floor(item.sourceIn + (x / ppf) * secPerFrame(p, item));
    out.push(<img key={x} src={`/api/thumb?asset=${item.assetId}&t=${t}`} style={{ left: x, width: W }} draggable={false} alt="" />);
  }
  return <div className="thumbs">{out}</div>;
}

const waves = new Map<string, Promise<{ rate: number; peaks: number[] }>>();

function Wave({ assetId, sourceIn, fps, ppf, duration }: { assetId: string; sourceIn: number; fps: number; ppf: number; duration: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // ponytail: one canvas per item capped at 8000 px; tile it if zoomed-in long music looks blurry.
  const w = Math.min(8000, Math.ceil(duration * ppf));
  useEffect(() => {
    if (!waves.has(assetId)) waves.set(assetId, fetch(`/api/waveform?asset=${assetId}`).then((r) => r.json()));
    let live = true;
    waves.get(assetId)!.then(({ rate, peaks }) => {
      const c = ref.current;
      if (!live || !c || !peaks) return;
      const g = c.getContext("2d")!;
      g.clearRect(0, 0, c.width, c.height);
      g.fillStyle = "rgba(160, 230, 180, 0.8)";
      const h = c.height / 2;
      for (let x = 0; x < c.width; x++) {
        const a = Math.floor((sourceIn + (x / c.width) * (duration / fps)) * rate);
        const b = Math.max(a + 1, Math.floor((sourceIn + ((x + 1) / c.width) * (duration / fps)) * rate));
        let m = 0;
        for (let i = a; i < b && i < peaks.length; i++) m = Math.max(m, peaks[i]);
        const y = Math.sqrt(m / 255) * h; // sqrt so speech at -18 dBFS is still visible
        g.fillRect(x, h - y, 1, y * 2 || 1);
      }
    });
    return () => void (live = false);
  }, [assetId, sourceIn, fps, duration, w]);
  return <canvas ref={ref} className="wave" width={w} height={ROW - 8} style={{ width: duration * ppf }} />;
}

/** Fallback for assets not yet probed by `splicewright ingest`. */
async function assetFrames(path: string, kind: string, fps: number): Promise<number> {
  if (kind === "image") return 5 * fps;
  const el = document.createElement(kind === "audio" ? "audio" : "video");
  el.preload = "metadata";
  el.src = `/media/${path.split("/").map(encodeURIComponent).join("/")}`;
  await new Promise((ok, fail) => ((el.onloadedmetadata = ok), (el.onerror = () => fail(new Error(`cannot read ${path}`)))));
  return Math.max(1, Math.floor(el.duration * fps));
}

/** Zoom by a factor, clamped to [fit whole project, 24 px/frame] (§15.1). */
export function zoom(factor: number) {
  app.set((s) => ({ pxPerFrame: Math.min(MAX_PX_PER_FRAME, Math.max(fitZoom(s.project!) / 2, s.pxPerFrame * factor)) }));
}

export function fitZoom(p: Project) {
  const lanes = document.querySelector(".timeline")?.clientWidth ?? 1200;
  return (lanes - HEADER - 40) / Math.max(1, durationFrames(p));
}
