import React, { useCallback, useEffect, useMemo } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import config from "virtual:swr-config";
import { anchorOf, beatFrames, durationFrames, formatFrame, itemSpan, snapPoints, type AudioItem, type Item, type Project } from "@splicewright/core";
import { SplicewrightProject, type Props } from "@splicewright/render";
import { addMarker, copy, duplicate, findItem, loopRange, markerNear, nudge, openMenu, paste, rippleDelete, setIO, slipBy, split, tapBeat, upload } from "./edit.ts";
import { app, dnd, history, ioRange, op, player, playhead, say, seek } from "./store.ts";
import { fitZoom, Timeline, zoom } from "./Timeline.tsx";

// Spec §7.3 panels: media bin, player, inspector, timeline.

const Composition: React.FC<Props> = (props) => <SplicewrightProject {...props} components={config.components} />;

export function App() {
  const p = app.use((s) => s.project);
  const message = app.use((s) => s.message);
  const io = app.use((s) => s.io);
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The I/O range lives in the URL, so a reload keeps it and it can be pasted to an agent.
  useEffect(() => {
    const h = new URLSearchParams(Object.entries(io).flatMap(([k, v]) => (v === null ? [] : [[k, String(v)]]))).toString();
    window.history.replaceState(null, "", h ? `#${h}` : location.pathname);
  }, [io]);
  if (!p) return <div className="loading">loading project…</div>;
  return (
    <div className="app">
      <Toolbar p={p} />
      <MediaBin p={p} />
      <Preview p={p} />
      <Inspector p={p} />
      <Timeline />
      <div className={`status ${message?.error ? "error" : ""}`}>{message?.text ?? ""}</div>
      <ContextMenu />
    </div>
  );
}

function ContextMenu() {
  const menu = app.use((s) => s.menu);
  useEffect(() => {
    if (!menu) return;
    const close = () => app.set({ menu: null });
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", close);
    window.addEventListener("wheel", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", close);
      window.removeEventListener("wheel", close);
    };
  }, [menu]);
  if (!menu) return null;
  // Keep it on screen: open upwards / leftwards near the bottom and right edges.
  const style = { left: Math.min(menu.x, innerWidth - 240), top: menu.y, ...(menu.y > innerHeight - 320 && { top: undefined, bottom: innerHeight - menu.y }) };
  return (
    <div className="menu" style={style} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {menu.entries.map((e, k) =>
        e === "-" ? (
          <hr key={k} />
        ) : (
          <button key={k} disabled={e.disabled} onClick={() => (app.set({ menu: null }), e.run())}>
            <span>{e.label}</span>
            {e.hint && <kbd>{e.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

function Toolbar({ p }: { p: Project }) {
  const snapping = app.use((s) => s.snapping);
  const useProxies = app.use((s) => s.useProxies);
  const proxies = app.use((s) => s.proxies);
  const selection = app.use((s) => s.selection);
  const gap = app.use((s) => s.gap);
  app.use((s) => s.io);
  const range = ioRange();
  return (
    <div className="toolbar">
      <strong>{p.meta.title}</strong>
      <span className="dim">
        rev {p.revision} · {p.meta.width}×{p.meta.height} · {p.meta.fps} fps
      </span>
      <Timecode fps={p.meta.fps} />
      <span className="spacer" />
      {range && (
        <span className="io-label" title="I/O range: I and O set it, Alt+X clears it, / plays it in a loop">
          I/O {formatFrame(range[0], p.meta.fps)}–{formatFrame(range[1], p.meta.fps)}
          <button onClick={() => app.set({ io: { in: null, out: null } })} title="Clear (Alt+X)">×</button>
        </span>
      )}
      {range ? (
        <button onClick={() => split(range)} title="Cut at I and O: the selection, or everything crossing them (S still splits at the playhead)">Split I/O</button>
      ) : (
        <button onClick={() => split([playhead.get().frame])} title="Split selection at the playhead; all items under it if nothing is selected (S / Cmd+B)">Split</button>
      )}
      <button
        disabled={!selection.length && !gap && !range}
        onClick={() => rippleDelete(true)}
        title="Delete the selection and close its gap; or close a clicked gap; or, with nothing selected, extract the I/O range (Shift+Delete). Delete alone lifts the range."
      >
        {selection.length || gap || !range ? "Ripple delete" : "Extract I/O"}
      </button>
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
  const slip = app.use((s) => s.slip);
  const looping = app.use((s) => s.looping);
  const shown = useMemo(() => {
    let out = p;
    if (useProxies && proxies.length) {
      const assets = { ...p.assets };
      for (const id of proxies) assets[id] = { ...assets[id], path: `.splicewright/proxies/edit/${id}.mp4` };
      out = { ...p, assets };
    }
    // A slip drag previews its new source range before the op commits.
    if (slip) out = { ...out, tracks: out.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.id === slip.itemId ? { ...i, sourceIn: slip.sourceIn } : i)) })) as Project["tracks"] };
    return out;
  }, [p, proxies, useProxies, slip]);
  const total = Math.max(1, durationFrames(p));
  const range = looping ? (ioRange() ?? [0, total]) : null;
  const ref = useCallback((r: PlayerRef | null) => {
    player.ref = r;
    r?.addEventListener("frameupdate", (e) => playhead.set({ frame: e.detail.frame }));
    r?.addEventListener("seeked", (e) => playhead.set({ frame: e.detail.frame }));
    r?.addEventListener("pause", () => app.get().looping && app.set({ looping: false }));
  }, []);
  return (
    <div className="preview">
      <Player
        ref={ref}
        component={Composition}
        inputProps={{ project: shown, duck }}
        durationInFrames={total}
        inFrame={range?.[0]}
        outFrame={range ? Math.min(total - 1, range[1] - 1) : undefined}
        loop={looping}
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
  const uploads = app.use((s) => s.uploads);
  const ingesting = app.use((s) => s.ingesting);
  const reveal = app.use((s) => s.reveal);
  const [over, setOver] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!reveal) return;
    document.querySelector(`[data-asset="${reveal}"]`)?.scrollIntoView({ block: "nearest" });
    const t = setTimeout(() => app.set({ reveal: null }), 1500);
    return () => clearTimeout(t);
  }, [reveal]);
  const files = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
  return (
    <div
      className={`bin ${over ? "drop" : ""}`}
      onDragOver={(e) => files(e) && (e.preventDefault(), setOver(true))}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false)}
      onDrop={(e) => files(e) && (e.preventDefault(), setOver(false), upload([...e.dataTransfer.files]))}
    >
      <h3>
        Media{" "}
        <button onClick={() => input.current!.click()} title="Import files into raw/ (or drop them here or on the timeline)">
          Import…
        </button>
        <input ref={input} type="file" multiple hidden accept="video/*,audio/*,image/*" onChange={(e) => (upload([...e.currentTarget.files!]), (e.currentTarget.value = ""))} />
      </h3>
      {Object.values(p.assets).map((a) => (
        <div
          key={a.id}
          data-asset={a.id}
          className={`asset ${reveal === a.id ? "reveal" : ""}`}
          draggable
          onDragStart={(e) => (e.dataTransfer.setData("application/x-splicewright-asset", a.id), (dnd.assetId = a.id))}
          onDragEnd={() => (dnd.assetId = null)}
          onContextMenu={(e) => openMenu(e, [{ label: "Insert at playhead", run: () => op("insertItem", { assetId: a.id, at: playhead.get().frame }) }])}
          title={`${a.id} — drag onto the timeline`}
        >
          {a.kind === "audio" ? <div className="thumb audio">♪</div> : <img className="thumb" src={`/api/thumb?asset=${a.id}&t=0`} alt="" draggable={false} />}
          <span>{a.path.split("/").pop()}</span>
          {ingesting[a.id] && <em className="badge">{ingesting[a.id]}…</em>}
        </div>
      ))}
      {uploads.map((name) => (
        <div key={name} className="asset pending">
          <div className="thumb">⇪</div>
          <span>{name}</span>
          <em className="badge">uploading…</em>
        </div>
      ))}
      {!Object.keys(p.assets).length && !uploads.length && <p className="dim">No assets yet. Drop files here or use Import….</p>}
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
  app.use((s) => s.io);
  const range = ioRange();
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
        <button disabled={!n || !trackId} onClick={() => op("fitToBeats", { trackId, audioItemId: item.id, every, ...(range && { range }) })} title="Beat sync (卡點): one undo step; limited to items starting in the I/O range when one is set">
          Fit to beats{range ? " (I/O)" : ""}
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
    const edges = [...new Set(snapPoints(p, [0, Infinity], { kinds: ["edge", "marker"] }).map((pt) => pt.frame))].sort((a, b) => a - b);
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
  if (mod && key === "c") return s.selection.length ? (handled(), copy()) : undefined;
  if (mod && key === "v") return handled(), paste(frame, e.shiftKey);
  if (mod && key === "d") return handled(), s.selection.length ? duplicate() : say("select items to duplicate", true);
  if ((!mod && key === "s") || (mod && key === "b")) return handled(), split([frame]);
  if (key === "delete" || key === "backspace") {
    if (!s.selection.length && !s.gap && !ioRange()) return;
    handled();
    return rippleDelete(e.shiftKey);
  }
  if (key === "escape") return app.set({ selection: [], gap: null });
  // Alt letters: match the physical key, since macOS turns Alt+X into "≈".
  if (e.altKey && e.code === "KeyX") return handled(), app.set({ io: { in: null, out: null } });
  if (e.altKey && e.code === "KeyM") {
    handled();
    const m = markerNear(frame, Math.max(1, Math.round(8 / s.pxPerFrame)));
    return m ? op("removeMarker", { markerId: m.id }) : say("no marker at the playhead", true);
  }
  if (e.altKey && (e.code === "Comma" || e.code === "Period")) return handled(), slipBy((e.code === "Comma" ? -1 : 1) * (e.shiftKey ? 10 : 1));
  if (!mod && key === "i") return setIO("in", frame);
  if (!mod && key === "o") return setIO("out", frame);
  if (!mod && key === "/") return handled(), s.looping ? player.ref?.pause() : loopRange();
  if (!mod && key === "m") return addMarker(frame);
  if (!mod && key === "b") return handled(), tapBeat(frame);
  if (!mod && key === "n") return app.set({ snapping: !s.snapping, message: { text: `snapping ${s.snapping ? "off" : "on"}` } });
  if (!mod && (e.key === "," || e.key === "." || e.key === "<" || e.key === ">")) return handled(), nudge((e.key === "," || e.key === "<" ? -1 : 1) * (e.shiftKey ? 10 : 1));
  if (!mod && (e.key === "+" || e.key === "=")) return zoom(1.5);
  if (!mod && (e.key === "-" || e.key === "_")) return zoom(1 / 1.5);
  if (!mod && e.shiftKey && key === "z") return app.set({ pxPerFrame: fitZoom(p) });
}
