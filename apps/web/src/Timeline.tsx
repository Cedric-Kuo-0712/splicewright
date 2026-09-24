import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { beatFrames, durationFrames, formatFrame, itemSpan, rulerTicks, snap, snapPoints, snapSpan, type AudioItem, type Item, type Project, type SnapPoint, type Track } from "@splicewright/core";
import { app, op, playhead, seek } from "./store.ts";

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
  mode: "move" | "start" | "end";
  /** Pointer frame at pointer down, and the span then. */
  grab: number;
  span: { start: number; duration: number };
  /** Live result. */
  start: number;
  duration: number;
  trackId: string;
  guide: SnapPoint | null;
}

/** Frame under a client x, given the lanes element (which scrolls with the content). */
const frameAt = (lanes: HTMLElement, clientX: number, ppf: number) => Math.max(0, Math.round((clientX - lanes.getBoundingClientRect().left) / ppf));

export function Timeline() {
  const p = app.use((s) => s.project)!;
  const ppf = app.use((s) => s.pxPerFrame);
  const selection = app.use((s) => s.selection);
  const scroller = useRef<HTMLDivElement>(null);
  const lanes = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 1000 });
  const [drag, setDrag] = useState<Drag | null>(null);
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
    app.set({ selection: e.shiftKey || e.metaKey ? (sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]) : sel.includes(id) ? sel : [id] });
    if (track.locked) return;
    const span = itemSpan(p, item)!;
    const x = e.clientX - (e.currentTarget as HTMLElement).getBoundingClientRect().left;
    const w = span.duration * ppf;
    const mode = x < 6 && w > 18 ? "start" : x > w - 6 && w > 18 ? "end" : "move";
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ item, track, mode, grab: frameAt(lanes.current!, e.clientX, ppf), span, start: span.start, duration: span.duration, trackId: track.id, guide: null });
  }

  function move(e: React.PointerEvent) {
    if (!drag) return;
    const d = frameAt(lanes.current!, e.clientX, ppf) - drag.grab;
    const s = app.get();
    const id = drag.item.id;
    const moving = drag.mode === "move";
    // Own edges never count; own beats count for trims, and travel with the item on a move (§15.2).
    const points = s.snapping && !e.altKey ? snapPoints(p, [0, Infinity], { playhead: playhead.get().frame }).filter((pt) => pt.ref !== id || (pt.kind === "beat" && !moving)) : [];
    const threshold = Math.max(1, SNAP_PX / ppf);
    const ex: string[] = [];
    const { start, duration } = drag.span;
    let next: Pick<Drag, "start" | "duration" | "guide" | "trackId">;
    if (moving) {
      const beats = drag.track.kind === "audio" ? beatFrames(p, drag.item as AudioItem).map((f) => f - drag.item.start) : [];
      const r = snapSpan(points, Math.max(0, start + d), duration, threshold, ex, beats);
      // Another row of the same kind under the pointer?
      const row = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-track]");
      const over = p.tracks.find((t) => t.id === row?.dataset.track);
      next = { start: Math.max(0, r.frame), duration, guide: r.target, trackId: over && over.kind === drag.track.kind && !over.locked ? over.id : drag.trackId };
    } else if (drag.mode === "start") {
      const r = snap(points, Math.min(start + duration - 1, Math.max(0, start + d)), threshold, ex);
      const f = Math.min(start + duration - 1, r.frame);
      next = { start: f, duration: start + duration - f, guide: r.target, trackId: drag.trackId };
    } else {
      const r = snap(points, Math.max(start + 1, start + duration + d), threshold, ex);
      next = { start, duration: Math.max(1, r.frame - start), guide: r.target, trackId: drag.trackId };
    }
    setDrag({ ...drag, ...next });
  }

  async function up() {
    if (!drag) return;
    setDrag(null);
    const { item, mode, span } = drag;
    if (mode === "move" && (drag.start !== span.start || drag.trackId !== drag.track.id))
      await op("move", { itemId: item.id, to: drag.start, ...(drag.trackId !== drag.track.id && { trackId: drag.trackId }) });
    if (mode === "start" && drag.start !== span.start) await op("trim", { itemId: item.id, edge: "start", to: drag.start });
    if (mode === "end" && drag.duration !== span.duration) await op("trim", { itemId: item.id, edge: "end", to: drag.start + drag.duration });
  }

  async function drop(e: React.DragEvent, track: Track) {
    const assetId = e.dataTransfer.getData("application/x-splicewright-asset");
    const asset = p.assets[assetId];
    if (!asset) return;
    e.preventDefault();
    let at = frameAt(lanes.current!, e.clientX, ppf);
    if (app.get().snapping && !e.altKey) at = snap(snapPoints(p, [0, Infinity], { playhead: playhead.get().frame }), at, Math.max(1, SNAP_PX / ppf)).frame;
    const kind = asset.kind === "audio" ? "audio" : "video";
    // Probed assets let the core default the duration; otherwise read it from the media here.
    const probed = asset.kind !== "image" && app.get().durations[assetId] !== undefined;
    await op("insertItem", { assetId, at, ...(!probed && { duration: await assetFrames(asset.path, asset.kind, fps) }), ...(track.kind === kind && { trackId: track.id }) });
  }

  return (
    <div className="timeline" ref={scroller} onScroll={onScroll}>
      <div style={{ width: HEADER + width }}>
        <div className="row ruler" style={{ height: RULER }}>
          <div className="corner" style={{ width: HEADER }}>{formatFrame(from, fps, 1)}</div>
          <div
            className="lane"
            style={{ width }}
            onPointerDown={(e) => {
              const lane = e.currentTarget;
              const at = (ev: { clientX: number }) => seek(frameAt(lane, ev.clientX, ppf));
              at(e);
              lane.setPointerCapture(e.pointerId);
              lane.onpointermove = (ev) => ev.buttons && at(ev);
            }}
          >
            {ticks.minor.map((f) => <div key={f} className="tick minor" style={{ left: f * ppf }} />)}
            {ticks.labels.map((l) => (
              <div key={l.frame} className="tick major" style={{ left: l.frame * ppf }}>
                <span>{l.text}</span>
              </div>
            ))}
            {(p.markers ?? []).map((m) => (
              <div key={m.id} className="marker" title={`${m.label} (${m.id})`} style={{ left: m.start * ppf, width: m.duration ? m.duration * ppf : undefined, background: m.color }}>
                {m.label}
              </div>
            ))}
          </div>
        </div>
        <div className="tracks" onPointerMove={move} onPointerUp={up}>
          {tracks.map((t) => (
            <div key={t.id} className="row" style={{ height: ROW }}>
              <TrackHeader t={t} />
              <div
                data-track={t.id}
                className={`lane ${t.kind} ${drag && drag.trackId === t.id && drag.trackId !== drag.track.id ? "target" : ""}`}
                style={{ width }}
                onPointerDown={() => app.set({ selection: [] })}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => drop(e, t)}
              >
                {t.items.map((item) => {
                  const span = itemSpan(p, item);
                  if (!span) return null;
                  const live = drag?.item.id === item.id ? drag : null;
                  const [start, duration] = live ? [live.start, live.duration] : [span.start, span.duration];
                  return (
                    <div
                      key={item.id}
                      className={`item ${selection.includes(item.id) ? "selected" : ""} ${live ? "dragging" : ""}`}
                      style={{ left: start * ppf, width: Math.max(2, duration * ppf), ...(live && live.trackId !== t.id && { opacity: 0.35 }) }}
                      onPointerDown={(e) => down(e, t, item)}
                      title={item.id}
                    >
                      {"assetId" in item && t.kind === "video" && <Thumbs p={p} item={item} width={duration * ppf} viewLeft={view.left - start * ppf} viewWidth={view.width} />}
                      {"assetId" in item && t.kind === "audio" && <Wave assetId={item.assetId} sourceIn={item.sourceIn} fps={fps} ppf={ppf} duration={duration} />}
                      {t.kind === "audio" && !(live && live.mode !== "move") && beatFrames(p, item as AudioItem).map((f) => <div key={f} className="beat" style={{ left: (f - item.start) * ppf }} />)}
                      <span className="name">{"text" in item ? item.text : "component" in item ? item.component : (item.label ?? p.assets[item.assetId]?.path)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {/* Frame 0 of the lanes; also hosts the playhead and snap guide. */}
          <div ref={lanes} className="origin" style={{ left: HEADER, width }}>
            {drag?.guide && (
              <div className="guide" style={{ left: drag.guide.frame * ppf }}>
                <span>{GUIDE[drag.guide.kind]}</span>
              </div>
            )}
            <BeatGuides p={p} selection={selection} ppf={ppf} />
            <Playhead ppf={ppf} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The only timeline part that re-renders per frame. */
function Playhead({ ppf }: { ppf: number }) {
  const frame = playhead.use((s) => s.frame);
  return <div className="playhead" style={{ left: frame * ppf }} />;
}

function TrackHeader({ t }: { t: Track }) {
  const flag = (key: "muted" | "hidden" | "locked", label: string) => (
    <button className={t[key] ? "on" : ""} title={key} onPointerDown={(e) => e.stopPropagation()} onClick={() => op("setTrack", { trackId: t.id, patch: { [key]: t[key] ? null : true } })}>
      {label}
    </button>
  );
  return (
    <div className="track-header" style={{ width: HEADER }}>
      <span>{t.name}</span>
      {t.kind !== "caption" && t.kind !== "overlay" && flag("muted", "M")}
      {flag("hidden", "H")}
      {flag("locked", "L")}
    </div>
  );
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
    const t = Math.floor(item.sourceIn + x / ppf / fps);
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
