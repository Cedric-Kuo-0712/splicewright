import React, { useEffect } from "react";
import { ASPECTS, FPS_CHOICES, durationFrames, formatFrame, itemSpan, snapPoints, type Project, type SnapPoint } from "@splicewright/core";
import { addMarker, addText, copy, cut, detachAudio, duplicate, findItem, freezeFrame, historyMenu, itemsAfter, loopRange, markerAroundSelection, markerNear, nudge, paste, rangeFromSelection, rippleDelete, selectItems, setIO, slipBy, split, stepKey, tapBeat, videoUnder } from "./edit.ts";
import { app, cancelExport, editReviewStatus, history, ioRange, newProject, op, player, playhead, refreshExport, revertEditReview, revealExport, say, seek, showEditReview, startExport, switchProject } from "./store.ts";
import { fitZoom, Timeline, zoom } from "./Timeline.tsx";
import { constrainLayout, DEFAULT_LAYOUT, type PanelLayout } from "./layout.ts";
import { PanelSeparator } from "./PanelSeparator.tsx";
import { Inspector } from "./inspector/Inspector.tsx";
import { FeaturePanel } from "./FeaturePanel.tsx";
import { type SearchAction, type WorkspaceCategory } from "./workspace-search.ts";
import { focusControl, type ControlLocation } from "./workspace-navigation.ts";
import { Preview } from "./Preview.tsx";
import { ExportControls } from "./ExportControls.tsx";
import { exportLabel, type ExportPreset } from "../export-options.ts";

// Spec §7.3 panels: media bin, player, inspector, timeline.

export function App() {
  const p = app.use((s) => s.project);
  const reviewProject = app.use((s) => s.reviewProject);
  const empty = app.use((s) => s.empty);
  const message = app.use((s) => s.message);
  const io = app.use((s) => s.io);
  const [category, setCategory] = React.useState<WorkspaceCategory>("素材");
  const [inspectorLocation, setInspectorLocation] = React.useState<ControlLocation>();
  const [panelLocation, setPanelLocation] = React.useState<ControlLocation>();
  const serial = React.useRef(0);
  const locate = (action: SearchAction) => {
    setCategory(action.category);
    const location = { section: action.section, control: action.control, serial: ++serial.current };
    if (action.destination === "panel") setPanelLocation(location);
    else if (action.destination === "toolbar") focusControl(document.querySelector<HTMLElement>(".toolbar")!, action.control);
    else setInspectorLocation(location);
  };
  const [layout, setLayout] = React.useState<PanelLayout>(() => {
    try { return constrainLayout({ ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem("swr.ui.layout") ?? "{}") }, innerWidth, innerHeight); }
    catch { return DEFAULT_LAYOUT; }
  });
  const resizeCleanup = React.useRef<(() => void) | null>(null);
  useEffect(() => {
    const resize = () => setLayout((current) => constrainLayout(current, innerWidth, innerHeight));
    window.addEventListener("resize", resize);
    return () => { window.removeEventListener("resize", resize); resizeCleanup.current?.(); };
  }, []);
  const saveLayout = (next: PanelLayout) => {
    const bounded = constrainLayout(next, innerWidth, innerHeight);
    setLayout(bounded);
    try { localStorage.setItem("swr.ui.layout", JSON.stringify(bounded)); } catch { /* Layout remains usable for this session. */ }
  };
  const resizeByKeyboard = (panel: keyof PanelLayout, delta: number) => (e: React.KeyboardEvent) => {
    const valid = panel === "timeline" ? e.key === "ArrowUp" || e.key === "ArrowDown" : e.key === "ArrowLeft" || e.key === "ArrowRight";
    if (!valid) return;
    e.preventDefault();
    e.stopPropagation();
    const direction = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 1;
    const sign = panel === "inspector" ? -direction : direction;
    saveLayout({ ...layout, [panel]: layout[panel] + sign * delta });
  };
  const beginResize = (panel: keyof PanelLayout, e: React.PointerEvent) => {
    e.preventDefault();
    resizeCleanup.current?.();
    const start = panel === "bin" ? e.clientX : panel === "inspector" ? -e.clientX : innerHeight - e.clientY;
    const initial = layout[panel];
    let latest = layout;
    const move = (event: PointerEvent) => {
      const current = panel === "bin" ? event.clientX : panel === "inspector" ? -event.clientX : innerHeight - event.clientY;
      latest = constrainLayout({ ...layout, [panel]: initial + current - start }, innerWidth, innerHeight);
      setLayout(latest);
    };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      window.removeEventListener("blur", done);
      try { localStorage.setItem("swr.ui.layout", JSON.stringify(latest)); } catch { /* Layout remains usable for this session. */ }
      resizeCleanup.current = null;
    };
    resizeCleanup.current = done;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
    window.addEventListener("blur", done);
  };
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The I/O range lives in the URL, so a reload keeps it and it can be pasted to an agent.
  useEffect(() => {
    const h = new URLSearchParams(Object.entries(io).flatMap(([k, v]) => (v === null ? [] : [[k, String(v)]]))).toString();
    window.history.replaceState(null, "", h ? `#${h}` : location.pathname);
  }, [io]);
  if (empty) return <NewProject />;
  if (!p) return <div className="loading">loading project…</div>;
  const displayProject = reviewProject ?? p;
  return (
    <div className={`app${reviewProject ? " review-reading" : ""}`} style={{ "--bin-size": `${layout.bin}px`, "--inspector-size": `${layout.inspector}px`, "--timeline-size": `${layout.timeline}px` } as React.CSSProperties}>
      <Toolbar p={p} />
      <FeaturePanel p={displayProject} category={category} onCategory={setCategory} onLocate={locate} location={panelLocation} readOnly={!!reviewProject} />
      <PanelSeparator className="bin-split" label="Resize media bin" orientation="vertical" value={layout.bin} min={Math.min(150, Math.round(innerWidth * 0.28))} max={Math.round(innerWidth * 0.28)} onPointerDown={(e) => beginResize("bin", e)} onKeyDown={resizeByKeyboard("bin", 10)} />
      <Preview p={displayProject} readOnly={!!reviewProject} />
      <PanelSeparator className="inspector-split" label="Resize inspector" orientation="vertical" value={layout.inspector} min={Math.min(200, Math.round(innerWidth * 0.34))} max={Math.round(innerWidth * 0.34)} onPointerDown={(e) => beginResize("inspector", e)} onKeyDown={resizeByKeyboard("inspector", 10)} />
      <Inspector p={displayProject} location={inspectorLocation} readOnly={!!reviewProject} />
      <PanelSeparator className="" label="Resize timeline" orientation="horizontal" value={layout.timeline} min={Math.min(140, Math.round(innerHeight * 0.48))} max={Math.round(innerHeight * 0.48)} onPointerDown={(e) => beginResize("timeline", e)} onKeyDown={resizeByKeyboard("timeline", 10)} />
      <Timeline project={displayProject} readOnly={!!reviewProject} />
      <div className={`status ${message?.error ? "error" : ""}`}>{message?.text ?? ""}</div>
      <ContextMenu />
    </div>
  );
}

/** No project.json in the served folder yet; importing happens afterwards through the normal Import/drop flow. */
function NewProject() {
  const recent = app.use((s) => s.recent);
  const message = app.use((s) => s.message);
  return (
    <div className="new-project">
      <h2>New project</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          newProject({ title: String(f.get("title")), preset: String(f.get("preset")), fps: Number(f.get("fps")) });
        }}
      >
        <input name="title" placeholder="Title" autoFocus />
        <select name="preset">
          {Object.entries(ASPECTS).map(([k, [w, h]]) => (
            <option key={k} value={k}>{k} ({w}×{h})</option>
          ))}
        </select>
        <select name="fps" defaultValue="30">
          {FPS_CHOICES.map((f) => (
            <option key={f} value={f}>{f} fps</option>
          ))}
        </select>
        <button>Create</button>
      </form>
      {recent.length > 0 && <h3>Recent</h3>}
      {recent.map((r) => (
        <button key={r.path} onClick={() => switchProject(r.path)} title={r.path}>{r.title}</button>
      ))}
      <div className={`status ${message?.error ? "error" : ""}`}>{message?.text ?? ""}</div>
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
  const review = app.use((s) => s.review);
  const reviewProject = app.use((s) => s.reviewProject);
  const snapping = app.use((s) => s.snapping);
  const useProxies = app.use((s) => s.useProxies);
  const proxies = app.use((s) => s.proxies);
  const selection = app.use((s) => s.selection);
  const gap = app.use((s) => s.gap);
  const recent = app.use((s) => s.recent);
  const exports = app.use((s) => s.exports);
  const [exportPreset, setExportPreset] = React.useState<ExportPreset>("auto");
  const runningExports = exports.filter((job) => job.status === "running").map((job) => job.id).join(",");
  useEffect(() => {
    const controls = document.querySelectorAll<HTMLElement>(".toolbar > :not(.agent-review):not(.timecode):not(.spacer)");
    controls.forEach((element) => { element.inert = !!reviewProject; });
    return () => controls.forEach((element) => { element.inert = false; });
  }, [reviewProject]);
  useEffect(() => {
    if (!runningExports) return;
    const ids = runningExports.split(",");
    const timer = window.setInterval(() => ids.forEach((id) => void refreshExport(id)), 800);
    return () => window.clearInterval(timer);
  }, [runningExports]);
  app.use((s) => s.io);
  const range = ioRange();
  return (
    <div className="toolbar" onKeyDownCapture={(e) => { if (reviewProject && !(e.target as HTMLElement).closest(".agent-review")) { e.preventDefault(); e.stopPropagation(); } }}>
      <strong>{p.meta.title}</strong>
      <span className="dim">
        rev {p.revision} · {p.meta.width}×{p.meta.height} · {p.meta.fps} fps
      </span>
      {review && <div className="agent-review" aria-label="Agent edit review">
        <strong>Agent 修改 · {review.label}</strong><span>{review.summary}</span>
        <button aria-pressed={!reviewProject} onClick={() => void showEditReview(null)}>目前版本</button>
        <button aria-pressed={!!reviewProject && reviewProject.revision === review.beforeRevision} onClick={() => void showEditReview("before")}>修改前</button>
        <button aria-pressed={!!reviewProject && reviewProject.revision === review.afterRevision} onClick={() => void showEditReview("after")}>Agent 修改後</button>
        {reviewProject && <span className="dim">快照預覽 · 唯讀</span>}
        {!reviewProject && review.status === "pending" && <><button onClick={() => void editReviewStatus("kept")}>保留修改</button></>}
        {review.status !== "reverted" && <button title={p.revision === review.afterRevision ? "Restore this complete agent round" : "A later project edit prevents whole-round restore"} disabled={p.revision !== review.afterRevision} onClick={() => void revertEditReview()}>還原整輪修改</button>}
      </div>}
      <Timecode fps={p.meta.fps} />
      <span className="spacer" />
      {recent.length > 0 && (
        <select value="" onChange={(e) => switchProject(e.target.value)} title="Switch to a recent project">
          <option value="" disabled>Recent…</option>
          {recent.map((r) => (
            <option key={r.path} value={r.path}>{r.title}</option>
          ))}
        </select>
      )}
      <details className="export-menu">
        <summary>Export{runningExports ? ` · ${runningExports.split(",").length}` : ""}</summary>
        <div className="export-panel">
          <ExportControls preset={exportPreset} onChange={setExportPreset} onRender={() => void startExport(exportPreset)} />
          {exports.length === 0 ? <span className="dim">No exports yet</span> : exports.map((job) => (
            <div className="export-job" key={job.id}>
              <div className="export-job-head"><b>{exportLabel(job.preset)}</b><span>{job.status === "running" ? `${Math.round(job.progress * 100)}%` : job.status}</span></div>
              {job.status === "running" && <progress max={1} value={job.progress} />}
              <small>{job.output}</small>
              {job.finalMix?.status === "measuring" && <small>Checking completed render audio…</small>}
              {job.finalMix?.status === "measured" && <small title={`Full decode and audio measurement at ${job.finalMix.measuredAt}`}>
                {job.finalMix.audio.status === "none" ? "Render audio · no audio stream · decode checked" : `Render audio · ${job.finalMix.audio.integratedLufs === null ? "LUFS unmeasured" : `${job.finalMix.audio.integratedLufs.toFixed(1)} LUFS`} · sample ${dbfs(job.finalMix.audio.samplePeak.dbfs)} dBFS · true peak ${dbfs(job.finalMix.audio.truePeak.dbfs)} dBTP`}
              </small>}
              {job.error && <small className="error-text">{job.error}</small>}
              <div className="export-job-actions">
                <button disabled={job.status !== "running"} onClick={() => void cancelExport(job.id)}>Cancel</button>
                <button disabled={job.status !== "done"} onClick={() => void revealExport(job.id)}>Reveal output</button>
              </div>
            </div>
          ))}
        </div>
      </details>
      {range && (
        <span className="io-label" title="I/O range: I and O set it, Alt+X clears it, / plays it in a loop">
          I/O {formatFrame(range[0], p.meta.fps)}–{formatFrame(range[1], p.meta.fps)}
          <button onClick={() => app.set({ io: { in: null, out: null } })} title="Clear (Alt+X)">×</button>
        </span>
      )}
      {range ? (
        <button data-ui-control="split" onClick={() => split(range)} title="Cut at I and O: the selection, or everything crossing them (S still splits at the playhead)">Split I/O</button>
      ) : (
        <button data-ui-control="split" onClick={() => split([playhead.get().frame])} title="Split selection at the playhead; all items under it if nothing is selected (S / Cmd+B)">分割</button>
      )}
      <button onClick={() => addText(playhead.get().frame)} title="Add a text overlay at the playhead (T)">＋文字</button>
      <button
        disabled={!selection.length && !gap && !range}
        onClick={() => rippleDelete(true)}
        title="Delete the selection and close its gap; or close a clicked gap; or, with nothing selected, extract the I/O range (Shift+Delete). Delete alone lifts the range."
      >
        {selection.length || gap || !range ? "Ripple delete" : "Extract I/O"}
      </button>
      <button onClick={() => history("undo")} title="Cmd+Z">Undo</button>
      <button onClick={() => history("redo")} title="Cmd+Shift+Z">Redo</button>
      <button onClick={(e) => historyMenu(e)} title="Undo history: pick a step to go back (or forward) to">History</button>
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

const dbfs = (value: number | null) => value === null ? "unmeasured" : value.toFixed(1);

export function Timecode({ fps }: { fps: number }) {
  const frame = playhead.use((s) => s.frame);
  return (
    <span className="timecode">
      {formatFrame(frame, fps, 1)} <span className="dim">f{frame}</span>
    </span>
  );
}


// ---- keyboard (§7.3, §15.2) ----

const SHUTTLE = [1, 2, 4, 8];

function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  if (app.get().sampling && e.key === "Escape") { e.preventDefault(); app.set({ sampling: null }); return; }
  if (el.closest("input, textarea, select")) return;
  const s = app.get();
  const p = s.reviewProject ?? s.project;
  if (!p) return;
  const frame = playhead.get().frame;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  const handled = () => e.preventDefault();

  if (key === " ") return handled(), app.set({ rate: 1 }), player.ref?.toggle();
  if (!s.reviewProject && e.altKey && !mod && (key === "arrowleft" || key === "arrowright")) return handled(), stepKey(key === "arrowleft" ? -1 : 1);
  if (key === "arrowleft" || key === "arrowright") return handled(), player.ref?.pause(), seek(frame + (key === "arrowleft" ? -1 : 1) * (e.shiftKey ? 10 : 1));
  if (s.reviewProject) return;
  if (key === "arrowup" || key === "arrowdown") {
    handled();
    // Shift adds beats and captions: every snap point.
    const kinds: SnapPoint["kind"][] = e.shiftKey ? ["edge", "marker", "beat", "caption"] : ["edge", "marker"];
    const edges = [...new Set(snapPoints(p, [0, Infinity], { kinds }).map((pt) => pt.frame))].sort((a, b) => a - b);
    const to = key === "arrowup" ? edges.filter((f) => f < frame).at(-1) : edges.find((f) => f > frame);
    return to !== undefined && seek(to);
  }
  if (!mod && e.shiftKey && key === "k") return app.set({ masking: !s.masking, cropping: false });
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
  if (key === "home" || key === "end") return handled(), seek(key === "home" ? 0 : durationFrames(p));
  if (!mod && (e.key === "[" || e.key === "]")) {
    // The selected clip's start or end, else the clip under the playhead on the top video track.
    const f = s.selection.length ? findItem(p, s.selection[0]) : null;
    const it = f?.item ?? videoUnder(p, frame);
    const span = it && itemSpan(p, it);
    return span ? seek(e.key === "[" ? span.start : span.start + span.duration - 1) : say("no clip selected or under the playhead", true);
  }
  if (mod && key === "a") return handled(), selectItems(itemsAfter(p, p.tracks));
  if (!mod && e.shiftKey && key === "m") return markerAroundSelection();
  if (!mod && e.shiftKey && key === "f") return freezeFrame(frame);
  if (!mod && e.shiftKey && key === "c") return app.set({ cropping: !s.cropping, masking: false });
  if (mod && key === "z") return handled(), history(e.shiftKey ? "redo" : "undo");
  if (mod && key === "c") return s.selection.length ? (handled(), copy()) : undefined;
  if (mod && key === "x") return s.selection.length ? (handled(), cut()) : undefined;
  if (mod && key === "i") return handled(), document.querySelector<HTMLInputElement>("input[type=file]")?.click();
  if (mod && key === "v") return handled(), paste(frame, e.shiftKey);
  if (mod && key === "d") return handled(), s.selection.length ? duplicate() : say("select items to duplicate", true);
  if ((!mod && key === "s") || (mod && key === "b")) return handled(), split([frame]);
  if (key === "delete" || key === "backspace") {
    if (!s.selection.length && !s.gap && !ioRange()) return;
    handled();
    return rippleDelete(e.shiftKey);
  }
  if (key === "escape") return app.set({ selection: [], gap: null, cropping: false, masking: false });
  // Alt letters: match the physical key, since macOS turns Alt+X into "≈".
  if (e.altKey && e.code === "KeyX") return handled(), app.set({ io: { in: null, out: null } });
  if (e.altKey && e.code === "KeyS") return handled(), detachAudio();
  if (e.altKey && e.code === "KeyM") {
    handled();
    const m = markerNear(frame, Math.max(1, Math.round(8 / s.pxPerFrame)));
    return m ? op("removeMarker", { markerId: m.id }) : say("no marker at the playhead", true);
  }
  if (e.altKey && (e.code === "Comma" || e.code === "Period")) return handled(), slipBy((e.code === "Comma" ? -1 : 1) * (e.shiftKey ? 10 : 1));
  if (!mod && !e.altKey && key === "x") return handled(), rangeFromSelection();
  if (!mod && !e.altKey && !e.shiftKey && key === "f") return handled(), player.ref?.requestFullscreen();
  if (!mod && key === "i") return setIO("in", frame);
  if (!mod && key === "o") return setIO("out", frame);
  if (!mod && key === "/") return handled(), s.looping ? player.ref?.pause() : loopRange();
  if (!mod && !e.altKey && !e.shiftKey && key === "t") return handled(), addText(frame);
  if (!mod && key === "m") return addMarker(frame);
  if (!mod && key === "b") return handled(), tapBeat(frame);
  if (!mod && key === "n") return app.set({ snapping: !s.snapping, message: { text: `snapping ${s.snapping ? "off" : "on"}` } });
  if (!mod && (e.key === "," || e.key === "." || e.key === "<" || e.key === ">")) return handled(), nudge((e.key === "," || e.key === "<" ? -1 : 1) * (e.shiftKey ? 10 : 1));
  if (!mod && (e.key === "+" || e.key === "=")) return zoom(1.5);
  if (!mod && (e.key === "-" || e.key === "_")) return zoom(1 / 1.5);
  if (!mod && e.shiftKey && key === "z") return app.set({ pxPerFrame: fitZoom(p) });
}
