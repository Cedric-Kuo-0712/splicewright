import React, { useCallback, useEffect, useMemo } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import config from "virtual:swr-config";
import { anchorOf, beatFrames, durationFrames, formatFrame, itemSpan, snapPoints, type AudioItem, type Item, type Project, type Track } from "@splicewright/core";
import { SplicewrightProject, type Props } from "@splicewright/render";
import { app, dnd, history, op, player, playhead, seek } from "./store.ts";
import { fitZoom, Timeline, zoom } from "./Timeline.tsx";

// Spec §7.3 panels: media bin, player, inspector, timeline.

const Composition: React.FC<Props> = (props) => <SplicewrightProject {...props} components={config.components} />;

export function App() {
  const p = app.use((s) => s.project);
  const message = app.use((s) => s.message);
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!p) return <div className="loading">loading project…</div>;
  return (
    <div className="app">
      <Toolbar p={p} />
      <MediaBin p={p} />
      <Preview p={p} />
      <Inspector p={p} />
      <Timeline />
      <div className={`status ${message?.error ? "error" : ""}`}>{message?.text ?? ""}</div>
    </div>
  );
}

function Toolbar({ p }: { p: Project }) {
  const snapping = app.use((s) => s.snapping);
  const useProxies = app.use((s) => s.useProxies);
  const proxies = app.use((s) => s.proxies);
  const selection = app.use((s) => s.selection);
  const gap = app.use((s) => s.gap);
  return (
    <div className="toolbar">
      <strong>{p.meta.title}</strong>
      <span className="dim">
        rev {p.revision} · {p.meta.width}×{p.meta.height} · {p.meta.fps} fps
      </span>
      <Timecode fps={p.meta.fps} />
      <span className="spacer" />
      <button onClick={() => split(p, app.get().selection, playhead.get().frame)} title="Split selection at the playhead; all items under it if nothing is selected (S / Cmd+B)">Split</button>
      <button disabled={!selection.length && !gap} onClick={() => rippleDelete(true)} title="Delete the selection and close its gap, or close a clicked gap (Shift+Delete)">Ripple delete</button>
      <button onClick={() => history("undo")} title="Cmd+Z">Undo</button>
      <button onClick={() => history("redo")} title="Cmd+Shift+Z">Redo</button>
      <button className={snapping ? "on" : ""} onClick={() => app.set({ snapping: !snapping })} title="Snapping (N); hold Alt to bypass">
        Snap
      </button>
      <button className={useProxies && proxies.length ? "on" : ""} disabled={!proxies.length} onClick={() => app.set({ useProxies: !useProxies })} title={proxies.length ? "Use edit proxies" : "No edit proxies yet; run splicewright ingest"}>
        Proxy
      </button>
      <button onClick={() => zoom(1 / 1.5)} title="-">−</button>
      <button onClick={() => zoom(1.5)} title="+">+</button>
      <button onClick={() => app.set({ pxPerFrame: fitZoom(p) })} title="Shift+Z">Fit</button>
    </div>
  );
}

function Timecode({ fps }: { fps: number }) {
  const frame = playhead.use((s) => s.frame);
  return (
    <span className="timecode">
      {formatFrame(frame, fps, 1)} <span className="dim">f{frame}</span>
    </span>
  );
}

function Preview({ p }: { p: Project }) {
  const duck = app.use((s) => s.duck);
  const proxies = app.use((s) => s.proxies);
  const useProxies = app.use((s) => s.useProxies);
  const rate = app.use((s) => s.rate);
  const shown = useMemo(() => {
    if (!useProxies || !proxies.length) return p;
    const assets = { ...p.assets };
    for (const id of proxies) assets[id] = { ...assets[id], path: `.splicewright/proxies/edit/${id}.mp4` };
    return { ...p, assets };
  }, [p, proxies, useProxies]);
  const ref = useCallback((r: PlayerRef | null) => {
    player.ref = r;
    r?.addEventListener("frameupdate", (e) => playhead.set({ frame: e.detail.frame }));
    r?.addEventListener("seeked", (e) => playhead.set({ frame: e.detail.frame }));
  }, []);
  return (
    <div className="preview">
      <Player
        ref={ref}
        component={Composition}
        inputProps={{ project: shown, duck }}
        durationInFrames={Math.max(1, durationFrames(p))}
        compositionWidth={p.meta.width}
        compositionHeight={p.meta.height}
        fps={p.meta.fps}
        playbackRate={rate}
        controls
        clickToPlay={false}
        spaceKeyToPlayOrPause={false}
        acknowledgeRemotionLicense
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}

function MediaBin({ p }: { p: Project }) {
  return (
    <div className="bin">
      <h3>Media</h3>
      {Object.values(p.assets).map((a) => (
        <div key={a.id} className="asset" draggable onDragStart={(e) => (e.dataTransfer.setData("application/x-splicewright-asset", a.id), (dnd.assetId = a.id))} onDragEnd={() => (dnd.assetId = null)} title={`${a.id} — drag onto the timeline`}>
          {a.kind === "audio" ? <div className="thumb audio">♪</div> : <img className="thumb" src={`/api/thumb?asset=${a.id}&t=0`} alt="" draggable={false} />}
          <span>{a.path.split("/").pop()}</span>
        </div>
      ))}
      {!Object.keys(p.assets).length && <p className="dim">No assets. Run `splicewright import &lt;files&gt;`.</p>}
    </div>
  );
}

/** Text or number input that commits on Enter or blur; empty clears the field. */
function Field({ label, value, onCommit, type = "text" }: { label: string; value: unknown; onCommit: (v: string | number | null) => void; type?: "text" | "number" }) {
  const initial = value === undefined || value === null ? "" : String(value);
  const commit = (raw: string) => raw !== initial && onCommit(raw === "" ? null : type === "number" ? Number(raw) : raw);
  return (
    <label className="field">
      <span>{label}</span>
      <input
        key={initial}
        type={type}
        step="any"
        defaultValue={initial}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
    </label>
  );
}

function Inspector({ p }: { p: Project }) {
  const selection = app.use((s) => s.selection);
  const found = selection.length === 1 ? findItem(p, selection[0]) : null;
  if (!found) return <div className="inspector dim">{selection.length ? `${selection.length} items selected` : "Select an item"}</div>;
  const { track: t, item } = found;
  const set = (patch: Record<string, unknown>) => op("setProps", { itemId: item.id, patch });
  const span = itemSpan(p, item);
  const fps = p.meta.fps;
  return (
    <div className="inspector">
      <h3>
        {item.id} <span className="dim">{t.kind} on {t.name}</span>
      </h3>
      {span && (
        <p className="dim">
          {formatFrame(span.start, fps)} → {formatFrame(span.start + span.duration, fps)} ({span.duration}f)
          {anchorOf(item) ? " · anchored" : ""}
        </p>
      )}
      {span && !t.locked && (
        <>
          {/* Same ops as dragging: move keeps the duration, trim end keeps the start. */}
          <Field label="start (f)" type="number" value={span.start} onCommit={(v) => v !== null && op("move", { itemId: item.id, to: Math.round(Number(v)) })} />
          <Field label="duration (f)" type="number" value={span.duration} onCommit={(v) => v !== null && op("trim", { itemId: item.id, edge: "end", to: span.start + Math.round(Number(v)) })} />
        </>
      )}
      {"mode" in item ? (
        <Field label="text" value={item.text} onCommit={(v) => op("editCaption", { captionId: item.id, text: v ?? "" })} />
      ) : (
        <>
          <Field label="label" value={item.label} onCommit={(v) => set({ label: v })} />
          <Field label="note" value={item.note} onCommit={(v) => set({ note: v })} />
        </>
      )}
      {"sourceIn" in item && <Field label="volume" type="number" value={item.volume} onCommit={(v) => set({ volume: v })} />}
      {t.kind === "audio" && (
        <>
          <Field label="fade in (f)" type="number" value={(item as { fadeIn?: number }).fadeIn} onCommit={(v) => set({ fadeIn: v })} />
          <Field label="fade out (f)" type="number" value={(item as { fadeOut?: number }).fadeOut} onCommit={(v) => set({ fadeOut: v })} />
          <BeatFields p={p} item={item as AudioItem} />
        </>
      )}
      {t.kind === "video" && "assetId" in item && <VideoFields item={item as Item & { fit?: string; transform?: Record<string, number> }} set={set} />}
      {"component" in item && <PropsField value={item.props} onCommit={(props) => set({ props })} />}
    </div>
  );
}

/** §15.4: detect, clear, and fit a magnetic video track to this item's beats. B taps a beat at the playhead. */
function BeatFields({ p, item }: { p: Project; item: AudioItem }) {
  const [density, setDensity] = React.useState("all");
  const [every, setEvery] = React.useState(1);
  const targets = p.tracks.filter((t) => t.kind === "video" && t.magnetic);
  const [trackId, setTrackId] = React.useState(targets[0]?.id ?? "");
  const n = beatFrames(p, item).length;
  return (
    <div className="beats">
      <p className="dim">
        {n} beats visible · B taps one at the playhead
      </p>
      <label className="field">
        <span>density</span>
        <select value={density} onChange={(e) => setDensity(e.target.value)}>
          {["all", "strong", "downbeat", "every:2", "every:4"].map((d) => <option key={d}>{d}</option>)}
        </select>
      </label>
      <div className="buttons">
        <button onClick={() => op("detectBeats", { itemId: item.id, density })}>Detect beats</button>
        <button disabled={!item.beats?.length} onClick={() => op("clearBeats", { itemId: item.id })}>Clear</button>
      </div>
      <label className="field">
        <span>fit track</span>
        <select value={trackId} onChange={(e) => setTrackId(e.target.value)}>
          {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <label className="field">
        <span>every N beats</span>
        <input type="number" min={1} value={every} onChange={(e) => setEvery(Math.max(1, Number(e.target.value) || 1))} />
      </label>
      <div className="buttons">
        <button disabled={!n || !trackId} onClick={() => op("fitToBeats", { trackId, audioItemId: item.id, every })} title="Beat sync (卡點): one undo step">
          Fit to beats
        </button>
      </div>
    </div>
  );
}

function VideoFields({ item, set }: { item: { fit?: string; transform?: Record<string, number> }; set: (patch: Record<string, unknown>) => void }) {
  const tf = item.transform ?? {};
  const setTf = (k: string, v: string | number | null) => {
    const next = { ...tf, [k]: v ?? undefined };
    if (v === null) delete next[k];
    set({ transform: Object.keys(next).length ? next : null });
  };
  return (
    <>
      <label className="field">
        <span>fit</span>
        <select value={item.fit ?? ""} onChange={(e) => set({ fit: e.target.value || null })}>
          <option value="">contain (default)</option>
          <option value="cover">cover</option>
        </select>
      </label>
      {["x", "y", "scale", "rotation", "opacity"].map((k) => (
        <Field key={k} label={k} type="number" value={tf[k]} onCommit={(v) => setTf(k, v)} />
      ))}
    </>
  );
}

function PropsField({ value, onCommit }: { value: unknown; onCommit: (v: unknown) => void }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <label className="field column">
      <span>props (JSON)</span>
      <textarea
        key={text}
        defaultValue={text}
        rows={6}
        onBlur={(e) => {
          if (e.currentTarget.value === text) return;
          try {
            onCommit(JSON.parse(e.currentTarget.value));
          } catch (err) {
            app.set({ message: { text: `props: ${(err as Error).message}`, error: true } });
          }
        }}
      />
    </label>
  );
}

function findItem(p: Project, id: string): { track: Track; item: Item } | null {
  for (const track of p.tracks) for (const item of track.items) if (item.id === id) return { track, item };
  return null;
}

// ---- keyboard (§7.3, §15.2) ----

const SHUTTLE = [1, 2, 4, 8];

function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  if (el.closest("input, textarea, select")) return;
  const s = app.get();
  const p = s.project;
  if (!p) return;
  const frame = playhead.get().frame;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  const handled = () => e.preventDefault();

  if (key === " ") return handled(), app.set({ rate: 1 }), player.ref?.toggle();
  if (key === "arrowleft" || key === "arrowright") return handled(), player.ref?.pause(), seek(frame + (key === "arrowleft" ? -1 : 1) * (e.shiftKey ? 10 : 1));
  if (key === "arrowup" || key === "arrowdown") {
    handled();
    const edges = [...new Set(snapPoints(p, [0, Infinity], { kinds: ["edge"] }).map((pt) => pt.frame))].sort((a, b) => a - b);
    const to = key === "arrowup" ? edges.filter((f) => f < frame).at(-1) : edges.find((f) => f > frame);
    return to !== undefined && seek(to);
  }
  if (!mod && (key === "j" || key === "k" || key === "l")) {
    handled();
    if (key === "k") return player.ref?.pause(), app.set({ rate: 1 });
    const dir = key === "l" ? 1 : -1;
    const playing = player.ref?.isPlaying();
    const cur = s.rate;
    // Same direction speeds up; the other direction starts over at 1×.
    const next = playing && Math.sign(cur) === dir ? dir * SHUTTLE[Math.min(SHUTTLE.length - 1, SHUTTLE.indexOf(Math.abs(cur)) + 1)] : dir;
    app.set({ rate: next });
    return player.ref?.play();
  }
  if (mod && key === "z") return handled(), history(e.shiftKey ? "redo" : "undo");
  if ((!mod && key === "s") || (mod && key === "b")) return handled(), split(p, s.selection, frame);
  if (key === "delete" || key === "backspace") {
    if (!s.selection.length && !s.gap) return;
    handled();
    return rippleDelete(e.shiftKey);
  }
  if (!mod && key === "b") return handled(), tapBeat(p, s.selection, frame);
  if (!mod && key === "n") return app.set({ snapping: !s.snapping, message: { text: `snapping ${s.snapping ? "off" : "on"}` } });
  if (!mod && (e.key === "," || e.key === "." || e.key === "<" || e.key === ">")) return handled(), nudge(p, s.selection, (e.key === "," || e.key === "<" ? -1 : 1) * (e.shiftKey ? 10 : 1));
  if (!mod && (e.key === "+" || e.key === "=")) return zoom(1.5);
  if (!mod && (e.key === "-" || e.key === "_")) return zoom(1 / 1.5);
  if (!mod && e.shiftKey && key === "z") return app.set({ pxPerFrame: fitZoom(p) });
}

/** Deletes the selection (ripple: close its gap), or closes the clicked gap. */
function rippleDelete(ripple: boolean) {
  const { selection, gap } = app.get();
  if (selection.length) return op("delete", { itemIds: selection, ...(ripple && { ripple: true }) }).then((ok) => ok && app.set({ selection: [] }));
  if (gap) return op("closeGap", gap).then((ok) => ok && app.set({ gap: null }));
}

/** Split the selection at the playhead, or every unlocked item under it when nothing is selected
 *  (anchored items are left out then; they follow the half they start in). */
function split(p: Project, selection: string[], frame: number) {
  const ids = p.tracks.flatMap((t) =>
    t.locked
      ? []
      : t.items.filter((i) => {
          const span = itemSpan(p, i);
          return span && frame > span.start && frame < span.start + span.duration && (selection.length ? selection.includes(i.id) : !anchorOf(i));
        }),
  );
  if (!ids.length) return app.set({ message: { text: "nothing to split under the playhead", error: true } });
  const ops = ids.map((i) => ({ op: "split", args: { itemId: i.id, at: frame } }));
  return ops.length === 1 ? op("split", ops[0].args) : op("batch", { ops });
}

/** Tap-along (§15.4): a beat at the playhead on the selected audio item, else the audio item under the playhead. */
function tapBeat(p: Project, selection: string[], frame: number) {
  const items = p.tracks.flatMap((t) => (t.kind === "audio" ? t.items : [])).filter((i) => frame >= i.start && frame < i.start + i.duration);
  const target = items.find((i) => selection.includes(i.id)) ?? items[0];
  if (!target) return app.set({ message: { text: "no audio item under the playhead", error: true } });
  return op("addBeat", { itemId: target.id, at: frame });
}

/** Keyboard nudge: ignores snapping (§15.2). */
function nudge(p: Project, selection: string[], delta: number) {
  const ops = selection.flatMap((id) => {
    const found = findItem(p, id);
    const span = found && itemSpan(p, found.item);
    return span && !found.track.locked ? [{ op: "move", args: { itemId: id, to: Math.max(0, span.start + delta) } }] : [];
  });
  if (ops.length) return ops.length === 1 ? op("move", ops[0].args) : op("batch", { ops });
}
