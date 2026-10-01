import React, { useCallback, useEffect, useMemo } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import config from "virtual:swr-config";
import { anchorOf, animate, ASPECTS, BLENDS, FONT_ROLES, FONTS, FPS_CHOICES, THEME_IDS, MASK_PROPS, MASK_SHAPES, beatFrames, durationFrames, formatFrame, itemSpan, keyAt, snapPoints, valueAt, withKey, type Animatable, type AudioItem, type FontRole, type Item, type OverlayItem, type Project, type SnapPoint, type TextStyle, type Track, type VideoItem } from "@splicewright/core";
import { mediaBox, SplicewrightProject, type Props } from "@splicewright/render";
import { addMarker, addText, copy, cut, detachAudio, duplicate, findItem, freezeFrame, historyMenu, itemsAfter, KEYS, lookEntries, loopRange, markerAroundSelection, markerNear, nudge, openMenu, paste, pipEntries, rangeFromSelection, replaceWith, rippleDelete, selectItems, setIO, slipBy, split, stepKey, tapBeat, upload, videoUnder } from "./edit.ts";
import { app, dnd, history, ioRange, newProject, op, player, playhead, say, seek, switchProject } from "./store.ts";
import { mapSamplePoint, multiplyMatrix, sampledRgb } from "./sample-coordinates.ts";
import { fitZoom, Timeline, zoom } from "./Timeline.tsx";

// Spec §7.3 panels: media bin, player, inspector, timeline.

const Composition: React.FC<Props> = (props) => <SplicewrightProject {...props} components={config.components} />;

export function App() {
  const p = app.use((s) => s.project);
  const empty = app.use((s) => s.empty);
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
  if (empty) return <NewProject />;
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
  const snapping = app.use((s) => s.snapping);
  const useProxies = app.use((s) => s.useProxies);
  const proxies = app.use((s) => s.proxies);
  const selection = app.use((s) => s.selection);
  const gap = app.use((s) => s.gap);
  const recent = app.use((s) => s.recent);
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
      {recent.length > 0 && (
        <select value="" onChange={(e) => switchProject(e.target.value)} title="Switch to a recent project">
          <option value="" disabled>Recent…</option>
          {recent.map((r) => (
            <option key={r.path} value={r.path}>{r.title}</option>
          ))}
        </select>
      )}
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
      <button onClick={() => addText(playhead.get().frame)} title="Add a text overlay at the playhead (T)">+ Text</button>
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
  const words = app.use((s) => s.words);
  const proxies = app.use((s) => s.proxies);
  const useProxies = app.use((s) => s.useProxies);
  const rate = app.use((s) => s.rate);
  const slip = app.use((s) => s.slip);
  const looping = app.use((s) => s.looping);
  const live = app.use((s) => s.live);
  const sizes = app.use((s) => s.sizes);
  const luts = app.use((s) => s.luts);
  const sampling = app.use((s) => s.sampling);
  const shown = useMemo(() => {
    let out = p;
    if (useProxies && proxies.length) {
      const assets = { ...p.assets };
      for (const id of proxies) assets[id] = { ...assets[id], path: `.splicewright/proxies/edit/${id}.mp4` };
      out = { ...p, assets };
    }
    // A slip drag previews its new source range before the op commits.
    if (slip) out = { ...out, tracks: out.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.id === slip.itemId ? { ...i, sourceIn: slip.sourceIn } : i)) })) as Project["tracks"] };
    if (live) out = { ...out, tracks: out.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.id === live.itemId ? { ...i, ...live.patch } : i)) })) as Project["tracks"] };
    return out;
  }, [p, proxies, useProxies, slip, live]);
  const total = Math.max(1, durationFrames(p));
  const range = looping ? (ioRange() ?? [0, total]) : null;
  const ref = useCallback((r: PlayerRef | null) => {
    player.ref = r;
    r?.addEventListener("frameupdate", (e) => playhead.set({ frame: e.detail.frame }));
    r?.addEventListener("seeked", (e) => playhead.set({ frame: e.detail.frame }));
    r?.addEventListener("pause", () => app.get().looping && app.set({ looping: false }));
  }, []);
  const sampleLookColor = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!sampling || !p) return;
    const wrapper = e.currentTarget.querySelector<HTMLElement>(`[data-look-item-id="${CSS.escape(sampling)}"]`);
    const canvas = wrapper?.matches("canvas") ? wrapper as HTMLCanvasElement : wrapper?.querySelector("canvas");
    if (!wrapper || !canvas || !canvas.width || !canvas.height) return say("Wait for the selected media frame, then click its visible picture.");
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    if (!hit || !wrapper.contains(hit)) return say("Click a visible part of the selected picture.");
    let transform = { a: 1, b: 0, c: 0, d: 1 };
    for (let el: HTMLElement | null = canvas; el && el !== e.currentTarget; el = el.parentElement) {
      const css = getComputedStyle(el);
      if (css.transform !== "none") { const m = new DOMMatrix(css.transform); transform = multiplyMatrix({ a: m.a, b: m.b, c: m.c, d: m.d }, transform); }
    }
    const computed = getComputedStyle(canvas), rect = canvas.getBoundingClientRect();
    const pixel = mapSamplePoint({ point: { x: e.clientX, y: e.clientY }, rect, canvas: { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight }, fit: computed.objectFit === "cover" ? "cover" : "contain", transform });
    if (!pixel) return;
    let rgba: Uint8Array | Uint8ClampedArray, rgb: [number, number, number] | null;
    const gl = canvas.getContext("webgl2");
    if (gl) { rgba = new Uint8Array(4); gl.readPixels(pixel.x, canvas.height - pixel.y - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba); rgb = sampledRgb(rgba, true); }
    else { const ctx = canvas.getContext("2d"); if (!ctx) return say("The selected media canvas cannot be sampled."); rgba = ctx.getImageData(pixel.x, pixel.y, 1, 1).data; rgb = sampledRgb(rgba, false); }
    if (!rgb) return say("That source pixel is fully transparent; choose a visible source pixel.");
    const color = `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    const found = findItem(p, sampling);
    if (found && "key" in found.item && found.item.key?.kind === "chroma") op("setProps", { itemId: sampling, patch: { key: { ...found.item.key, color } } });
    app.set({ sampling: null });
  };
  return (
    <div className={`preview ${sampling ? "sampling" : ""}`} onClick={sampleLookColor}>
      {sampling && <div className="badge" style={{ position: "absolute", zIndex: 50, left: 8, top: 8 }}>Click the selected picture to sample its graded color (key and mask bypassed) · Esc to cancel</div>}
      <Player
        ref={ref}
        component={Composition}
        inputProps={{ project: shown, duck, sizes, words, luts, sampleItemId: sampling ?? undefined }}
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
      <TransformBox p={p} />
    </div>
  );
}

type Tf = NonNullable<VideoItem["transform"]>;

/** Drop identity values, so a reset transform unsets the field. */
const cleanTf = ({ x, y, scale, rotation, opacity }: Tf): Tf | null => {
  const out: Tf = { ...(x && { x }), ...(y && { y }), ...(scale !== undefined && scale !== 1 && { scale }), ...(rotation && { rotation }), ...(opacity !== undefined && { opacity }) };
  return Object.keys(out).length ? out : null;
};

type Crop = NonNullable<VideoItem["crop"]>;
const SIDES = ["top", "right", "bottom", "left"] as const;

/** Drop zero sides, so an uncropped picture unsets the field. */
const cleanCrop = (c: Crop): Crop | null => {
  const out = Object.fromEntries(SIDES.flatMap((k) => (c[k] ? [[k, c[k]]] : [])));
  return Object.keys(out).length ? out : null;
};

/**
 * Move, scale and rotate the selected video item on the preview: drag the box, a corner, or the top knob.
 * Snaps to the frame centre (Alt bypasses), Shift snaps rotation to 15°, double-click resets.
 * In crop mode (Shift+C) the box's edges crop the picture instead; double-click uncrops.
 * In mask mode (Shift+K) the mask's box moves (drag inside) and resizes (corners).
 */
function TransformBox({ p }: { p: Project }) {
  const selection = app.use((s) => s.selection);
  const live = app.use((s) => s.live);
  const sizes = app.use((s) => s.sizes);
  const cropping = app.use((s) => s.cropping);
  const masking = app.use((s) => s.masking);
  const frame = playhead.use((s) => s.frame);
  const box = React.useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState<[number, number] | null>(null);
  useEffect(() => {
    const el = box.current!.parentElement!;
    const ro = new ResizeObserver(() => setSize([el.clientWidth, el.clientHeight]));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const found = selection.length === 1 ? findItem(p, selection[0]) : null;
  const item = found && found.track.kind === "video" && !found.track.locked && "assetId" in found.item ? (found.item as VideoItem) : null;
  const span = item && itemSpan(p, item);
  const visible = !!(item && span && size && frame >= span.start && frame < span.start + span.duration);
  const { width: cw, height: ch } = p.meta;
  const k = size ? Math.min(size[0] / cw, size[1] / ch) : 1;
  const shown = item && live?.itemId === item.id ? { ...item, ...live.patch } : item;
  const now = shown ? animate(p, shown, frame) : null;
  const tf: Tf = now?.transform || {};
  const mask = now?.mask;
  const crop: Crop = shown?.crop ?? {};
  const { x = 0, y = 0, scale = 1, rotation = 0 } = tf;
  // The picture as displayed, at scale 1, in composition px.
  const [dw, dh] = shown ? mediaBox(p, shown, sizes[shown.assetId]).display : [cw, ch];
  // Screen position of the composition's top-left and of the item's centre.
  const ox = size ? (size[0] - cw * k) / 2 : 0;
  const oy = size ? (size[1] - ch * k) / 2 : 0;
  const cx = ox + (cw / 2 + x) * k;
  const cy = oy + (ch / 2 + y) * k;

  const grabEdge = (e: React.PointerEvent<HTMLElement>, side: (typeof SIDES)[number]) => {
    if (e.button !== 0 || !item) return;
    e.stopPropagation();
    const el = e.currentTarget;
    const start = { ...crop };
    const [a, b] = [Math.cos((rotation * Math.PI) / 180), Math.sin((rotation * Math.PI) / 180)];
    let next: Crop | undefined;
    el.setPointerCapture(e.pointerId);
    el.onpointermove = (ev) => {
      if (!ev.buttons) return;
      // Pointer travel along the box's own axes, as a fraction of the picture.
      const [dx, dy] = [ev.clientX - e.clientX, ev.clientY - e.clientY];
      const u = (dx * a + dy * b) / (dw * scale * k);
      const v = (-dx * b + dy * a) / (dh * scale * k);
      const d = { top: v, bottom: -v, left: u, right: -u }[side];
      const other = start[SIDES[(SIDES.indexOf(side) + 2) % 4]] ?? 0;
      next = { ...start, [side]: +Math.min(0.95 - other, Math.max(0, (start[side] ?? 0) + d)).toFixed(3) };
      app.set({ live: { itemId: item.id, patch: { crop: next } } });
    };
    el.onpointerup = () => {
      el.onpointermove = el.onpointerup = null;
      if (!next) return app.set({ live: null });
      op("setProps", { itemId: item.id, patch: { crop: cleanCrop(next) } }).finally(() => app.set({ live: null }));
    };
  };

  // Keyed props take a key at the playhead; the rest change the plain transform. One setProps either way.
  const patchFor = (next: Tf) => {
    let kf = item!.keyframes;
    const plain: Tf = { ...item!.transform };
    for (const k of ["x", "y", "scale", "rotation"] as const)
      if (next[k] !== tf[k]) kf?.[k] ? (kf = withKey(p, { ...item!, keyframes: kf }, k, frame, next[k]!)) : (plain[k] = next[k]);
    return { transform: cleanTf(plain), keyframes: kf ?? null };
  };

  // Same split for the mask box: keyed maskX/Y/W/H take a key at the playhead, the rest change the plain mask.
  const maskPatch = (next: MaskT) => {
    let kf = item!.keyframes;
    const plain: MaskT = { ...item!.mask! };
    for (const [prop, f] of Object.entries(MASK_PROPS) as [Animatable, "x" | "y" | "w" | "h" | "feather"][])
      if (f !== "feather" && next[f] !== mask![f]) kf?.[prop] ? (kf = withKey(p, { ...item!, keyframes: kf }, prop, frame, next[f])) : (plain[f] = next[f]);
    return { mask: plain, keyframes: kf ?? null };
  };

  const grabMask = (e: React.PointerEvent<HTMLElement>, handle: "move" | "nw" | "ne" | "sw" | "se") => {
    if (e.button !== 0 || !item || !mask) return;
    e.stopPropagation();
    const el = e.currentTarget;
    const start = { ...mask };
    const [a, b] = [Math.cos((rotation * Math.PI) / 180), Math.sin((rotation * Math.PI) / 180)];
    const r3 = (n: number) => +n.toFixed(3);
    let next: MaskT | undefined;
    el.setPointerCapture(e.pointerId);
    el.onpointermove = (ev) => {
      if (!ev.buttons) return;
      // Pointer travel along the box's own axes, as a fraction of the picture (the box the mask is measured in).
      const [dx, dy] = [ev.clientX - e.clientX, ev.clientY - e.clientY];
      const u = (dx * a + dy * b) / (dw * scale * k);
      const v = (-dx * b + dy * a) / (dh * scale * k);
      if (handle === "move") next = { ...start, x: r3(start.x + u), y: r3(start.y + v) };
      else {
        // The opposite corner stays put; the box never gets thinner than 2%.
        let [x0, y0, x1, y1] = [start.x, start.y, start.x + start.w, start.y + start.h];
        if (handle.includes("w")) x0 = Math.min(x1 - 0.02, x0 + u);
        else x1 = Math.max(x0 + 0.02, x1 + u);
        if (handle.includes("n")) y0 = Math.min(y1 - 0.02, y0 + v);
        else y1 = Math.max(y0 + 0.02, y1 + v);
        next = { ...start, x: r3(x0), y: r3(y0), w: r3(x1 - x0), h: r3(y1 - y0) };
      }
      app.set({ live: { itemId: item.id, patch: maskPatch(next) as Partial<VideoItem> } });
    };
    el.onpointerup = () => {
      el.onpointermove = el.onpointerup = null;
      if (!next) return app.set({ live: null });
      op("setProps", { itemId: item.id, patch: maskPatch(next) }).finally(() => app.set({ live: null }));
    };
  };

  const grab = (e: React.PointerEvent<HTMLElement>, mode: "move" | "scale" | "rotate") => {
    if (e.button !== 0 || !item) return;
    e.stopPropagation();
    const el = e.currentTarget;
    const r = box.current!.parentElement!.getBoundingClientRect();
    const [px, py] = [e.clientX - r.left, e.clientY - r.top];
    const start = { x, y, scale, rotation };
    const d0 = Math.hypot(px - cx, py - cy) || 1;
    const a0 = Math.atan2(py - cy, px - cx);
    let next: Tf | undefined;
    el.setPointerCapture(e.pointerId);
    el.onpointermove = (ev) => {
      if (!ev.buttons) return;
      const [qx, qy] = [ev.clientX - r.left, ev.clientY - r.top];
      if (mode === "move") {
        let nx = Math.round(start.x + (qx - px) / k);
        let ny = Math.round(start.y + (qy - py) / k);
        if (!ev.altKey && Math.abs(nx * k) < 6) nx = 0;
        if (!ev.altKey && Math.abs(ny * k) < 6) ny = 0;
        next = { ...tf, x: nx, y: ny };
      } else if (mode === "scale") {
        const f = Math.hypot(qx - cx, qy - cy) / d0;
        next = { ...tf, scale: Math.max(0.05, +(start.scale * f).toFixed(3)) };
      } else {
        let deg = start.rotation + ((Math.atan2(qy - cy, qx - cx) - a0) * 180) / Math.PI;
        deg = ((deg + 540) % 360) - 180;
        next = { ...tf, rotation: ev.shiftKey ? Math.round(deg / 15) * 15 : +deg.toFixed(1) };
      }
      app.set({ live: { itemId: item.id, patch: patchFor(next) as Partial<VideoItem> } });
    };
    el.onpointerup = () => {
      el.onpointermove = el.onpointerup = null;
      if (!next) return app.set({ live: null });
      op("setProps", { itemId: item.id, patch: patchFor(next) }).finally(() => app.set({ live: null }));
    };
  };

  return (
    <div ref={box} className="stage">
      {visible && (
        <div
          className={`tf-box ${cropping ? "cropping" : ""} ${masking ? "masking" : ""}`}
          style={{ left: cx, top: cy, width: dw * scale * k, height: dh * scale * k, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }}
          onPointerDown={(e) => grab(e, "move")}
          onDoubleClick={() => !masking && op("setProps", { itemId: item!.id, patch: cropping ? { crop: null } : { transform: cleanTf({ opacity: tf.opacity }) } })}
          title={
            cropping
              ? `${item!.id}: drag an edge to crop, double-click uncrops, Shift+C leaves crop mode`
              : masking
                ? `${item!.id}: drag inside the mask to move it, corners resize, Shift+K leaves mask mode`
                : `${item!.id}: drag to move, corners scale, top knob rotates (Shift: 15°), double-click resets, Shift+C crops, Shift+K edits the mask`
          }
        >
          {cropping ? (
            <div className="crop-rect" style={{ inset: SIDES.map((s) => `${(crop[s] ?? 0) * 100}%`).join(" ") }}>
              {SIDES.map((s) => <div key={s} className={`crop-h ${s}`} onPointerDown={(e) => grabEdge(e, s)} />)}
            </div>
          ) : masking ? (
            mask && (
              // Only the mask's box: rect and ellipse draw their outline, other shapes show the box they fill.
              <div
                className={`mask-rect ${mask.shape === "ellipse" ? "ellipse" : ""}`}
                style={{ left: `${mask.x * 100}%`, top: `${mask.y * 100}%`, width: `${mask.w * 100}%`, height: `${mask.h * 100}%` }}
                onPointerDown={(e) => grabMask(e, "move")}
              >
                {(["nw", "ne", "sw", "se"] as const).map((c) => <div key={c} className={`tf-h ${c}`} onPointerDown={(e) => grabMask(e, c)} />)}
              </div>
            )
          ) : (
            <>
              {["nw", "ne", "sw", "se"].map((c) => <div key={c} className={`tf-h ${c}`} onPointerDown={(e) => grab(e, "scale")} />)}
              <div className="tf-rot" onPointerDown={(e) => grab(e, "rotate")} />
            </>
          )}
          <span className="tf-label">
            {cropping
              ? SIDES.map((s) => `${Math.round((crop[s] ?? 0) * 100)}`).join(" / ") + " % crop"
              : masking
                ? mask
                  ? `mask ${[mask.x, mask.y, mask.w, mask.h].map((n) => Math.round(n * 100)).join(" / ")} %`
                  : "no mask: pick a shape in the inspector"
                : `${Math.round(x)}, ${Math.round(y)} · ${Math.round(scale * 100)}%${rotation ? ` · ${rotation}°` : ""}`}
          </span>
        </div>
      )}
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
        <button onClick={() => input.current!.click()} title={`Import files into raw/ (or drop them here or on the timeline) (${KEYS.import})`}>
          Import…
        </button>
        <input ref={input} type="file" multiple hidden accept="video/*,audio/*,image/*,.cube" onChange={(e) => (upload([...e.currentTarget.files!]), (e.currentTarget.value = ""))} />
      </h3>
      {Object.values(p.assets).map((a) => (
        <div
          key={a.id}
          data-asset={a.id}
          className={`asset ${reveal === a.id ? "reveal" : ""}`}
          draggable={a.kind !== "lut"}
          onDragStart={(e) => { if (a.kind === "lut") return; e.dataTransfer.setData("application/x-splicewright-asset", a.id); dnd.assetId = a.id; }}
          onDragEnd={() => (dnd.assetId = null)}
          onContextMenu={(e) =>
            openMenu(e, [
              ...(a.kind === "lut" ? [] : [{ label: "Insert at playhead", run: () => op("insertItem", { assetId: a.id, at: playhead.get().frame }) }]),
              { label: "Replace selected clip", run: () => replaceWith(a.id), disabled: app.get().selection.length !== 1 },
            ])
          }
          title={a.kind === "lut" ? `${a.id} — choose this LUT in the Color inspector` : `${a.id} — drag onto the timeline`}
        >
          {a.kind === "lut" ? <div className="thumb audio">LUT</div> : a.kind === "audio" ? <div className="thumb audio">♪</div> : <img className="thumb" src={`/api/thumb?asset=${a.id}&t=0`} alt="" draggable={false} />}
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
const TRANSITIONS = ["dissolve", "dip", "wipe", "slide", "push", "zoom"] as const;

function Field({ label, value, onCommit, type = "text", mark }: { label: string; value: unknown; onCommit: (v: string | number | null) => void; type?: "text" | "number"; mark?: React.ReactNode }) {
  const initial = value === undefined || value === null ? "" : String(value);
  const commit = (raw: string) => raw !== initial && onCommit(raw === "" ? null : type === "number" ? Number(raw) : raw);
  const id = React.useId();
  return (
    <label className="field" htmlFor={id}>
      <span>
        {label}
        {mark}
      </span>
      <input
        id={id}
        name={label}
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
  const live = app.use((s) => s.live);
  const found = selection.length === 1 ? findItem(p, selection[0]) : null;
  if (!found)
    return (
      <div className="inspector">
        <p className="dim">{selection.length ? `${selection.length} items selected` : "Select an item"}</p>
        <ThemeField p={p} />
      </div>
    );
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
        <>
          <Field label="text" value={item.text} onCommit={(v) => op("editCaption", { captionId: item.id, text: v ?? "" })} />
          {t.kind === "caption" && <CaptionStyleFields t={t} text={item.text} />}
        </>
      ) : (
        <>
          <Field label="label" value={item.label} onCommit={(v) => set({ label: v })} />
          <Field label="note" value={item.note} onCommit={(v) => set({ note: v })} />
        </>
      )}
      {t.kind === "audio" && "assetId" in item && <AudioVolume p={p} item={(live?.itemId === item.id ? { ...item, ...live.patch } : item) as AudioItem} />}
      {"sourceIn" in item && (
        <>
          <Field label="fade in (f)" type="number" value={item.fadeIn} onCommit={(v) => set({ fadeIn: v })} />
          <Field label="fade out (f)" type="number" value={item.fadeOut} onCommit={(v) => set({ fadeOut: v })} />
        </>
      )}
      {(t.kind === "audio" || t.kind === "video") && "assetId" in item && p.assets[item.assetId]?.kind !== "image" && <LoudnessFields p={p} item={item as AudioItem | VideoItem} />}
      {t.kind === "audio" && <BeatFields p={p} item={item as AudioItem} />}
      {t.kind === "video" && "assetId" in item && <VideoFields p={p} item={(live?.itemId === item.id ? { ...item, ...live.patch } : item) as VideoItem} fps={fps} still={p.assets[item.assetId]?.kind === "image"} set={set} />}
      {"component" in item && <MaskFields p={p} item={(live?.itemId === item.id ? { ...item, ...live.patch } : item) as OverlayItem} set={set} />}
      {"component" in item && item.component === "Text" && <TextFields item={item} set={set} />}
      {"component" in item && <PropsField value={item.props} onCommit={(props) => set({ props })} />}
    </div>
  );
}

/** Text overlay: the string, its role (theme slot) and style fields. Each edit rewrites props (one undo step); anything else stays in the JSON field below. */
function TextFields({ item, set }: { item: OverlayItem; set: (patch: Record<string, unknown>) => void }) {
  const props = item.props as { text?: string; role?: FontRole; textStyle?: TextStyle; style?: Record<string, unknown> };
  const put = (next: Record<string, unknown>) => set({ props: { ...props, ...next } });
  return (
    <>
      <Field label="text" value={props.text} onCommit={(v) => put({ text: v ?? "" })} />
      <label className="field">
        <span>role</span>
        <select value={props.role ?? "title"} onChange={(e) => put({ role: e.target.value })}>
          {FONT_ROLES.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <StyleFields
        style={props.textStyle}
        text={props.text ?? ""}
        onChange={(textStyle, key) => {
          // the raw CSS escape hatch would override the field just edited
          const { [RAW[key]]: _, ...style } = props.style ?? {};
          put({ textStyle, style });
        }}
      />
    </>
  );
}

const RAW = { font: "fontFamily", weight: "fontWeight", size: "fontSize", color: "color" } as const;
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

/** Font (★ first, each in its own face, 中 = has Chinese glyphs), weight, size, color. null clears a field back to the theme. */
function StyleFields({ style = {}, text, onChange }: { style?: TextStyle; text: string; onChange: (next: TextStyle, key: keyof typeof RAW) => void }) {
  const put = (key: keyof typeof RAW, v: unknown) => {
    const { [key]: _, ...rest } = style;
    onChange(v === null ? rest : { ...rest, [key]: v }, key);
  };
  const face = (f: (typeof FONTS)[number]) => (
    <option key={f.name} value={f.name} style={{ fontFamily: `"${f.family}"` }}>
      {f.name}
      {f.cjk ? " 中" : ""}
    </option>
  );
  const chosen = FONTS.find((f) => f.name === style.font);
  return (
    <>
      <label className="field">
        <span>font</span>
        <select value={style.font ?? ""} onChange={(e) => put("font", e.target.value || null)}>
          <option value="">(theme)</option>
          <optgroup label="★ recommended">{FONTS.filter((f) => f.core).map(face)}</optgroup>
          <optgroup label="more">{FONTS.filter((f) => !f.core).map(face)}</optgroup>
        </select>
      </label>
      {chosen && !chosen.cjk && CJK.test(text) && <p className="dim">⚠ {chosen.name} has no Chinese glyphs; this text falls back to Noto Sans TC. Pick a 中 font for Chinese.</p>}
      <Field label="weight" type="number" value={style.weight} onCommit={(v) => put("weight", v === null ? null : Number(v))} />
      <Field label="size (px)" type="number" value={style.size} onCommit={(v) => put("size", v === null ? null : Number(v))} />
      <Field label="color" value={style.color} onCommit={(v) => put("color", v)} />
    </>
  );
}

/** A caption track's look: textStyle over the theme's subtitle role, and per-word highlight (anchored captions with transcript words). */
function CaptionStyleFields({ t, text }: { t: Extract<Track, { kind: "caption" }>; text: string }) {
  return (
    <>
      <h4>caption track {t.name}</h4>
      <StyleFields style={t.textStyle} text={text} onChange={(textStyle) => op("setTrack", { trackId: t.id, patch: { textStyle: Object.keys(textStyle).length ? textStyle : null } })} />
      <label className="field" title="Highlight the spoken word in the emphasis style (anchored captions only)">
        <span>highlight</span>
        <select value={t.highlight ?? "none"} onChange={(e) => op("setTrack", { trackId: t.id, patch: { highlight: e.target.value === "none" ? null : e.target.value } })}>
          <option>none</option>
          <option>word</option>
        </select>
      </label>
    </>
  );
}

/** Project theme: one op restyles every role-bound text. */
function ThemeField({ p }: { p: Project }) {
  return (
    <label className="field" title="Restyles every Text overlay and caption track that uses a role (one undo step)">
      <span>theme</span>
      <select value={p.meta.theme ?? ""} onChange={(e) => op("setMeta", { theme: e.target.value || null })}>
        <option value="">(none)</option>
        {[...THEME_IDS, ...Object.keys(p.themes ?? {})].map((id) => (
          <option key={id}>{id}</option>
        ))}
      </select>
    </label>
  );
}

/** Asset LUFS, Normalize to −14 (disabled on the same grounds normalizeLoudness refuses), and the project-wide render limiter. */
function LoudnessFields({ p, item }: { p: Project; item: AudioItem | VideoItem }) {
  const lufs = app.use((s) => s.loudness[item.assetId]);
  const why = lufs === undefined ? "no loudness yet: run splicewright ingest --only loudness (silent assets have none)" : item.keyframes?.volume ? "has volume keyframes: remove them first" : null;
  return (
    <>
      <h4>audio</h4>
      <p className="dim">{lufs === undefined ? "loudness —" : `loudness ${lufs.toFixed(1)} LUFS`}</p>
      <div className="buttons">
        <button disabled={!!why} title={why ?? "Set volume so the asset plays at −14 LUFS (one undo step)"} onClick={() => op("normalizeLoudness", { itemIds: [item.id], target: -14 })}>
          Normalize to −14
        </button>
      </div>
      {why && <p className="dim">{why}</p>}
      <label className="field" title="Render-only −1 dBFS master limiter for the whole project; the preview has no limiter">
        <span>limiter (render)</span>
        <input type="checkbox" checked={!!p.meta.limiter} onChange={(e) => op("setMeta", { limiter: e.target.checked })} />
      </label>
    </>
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

/** Volume slider with a ◇ key button; once keyed, dragging edits the key on the playhead. */
function AudioVolume({ p, item }: { p: Project; item: AudioItem }) {
  const frame = playhead.use((s) => s.frame);
  const now = valueAt(p, item, "volume", frame) ?? item.volume ?? 1;
  return (
    <Slider
      itemId={item.id}
      label="volume"
      min={0}
      max={2}
      step={0.01}
      zero={1}
      value={now}
      mark={<KeyButton p={p} item={item} prop="volume" frame={frame} value={now} />}
      patch={(v) => (item.keyframes?.volume ? { keyframes: withKey(p, item, "volume", frame, v) ?? null } : { volume: v === 1 ? null : v })}
    />
  );
}

function VideoFields({ p, item, fps, still, set }: { p: Project; item: VideoItem; fps: number; still: boolean; set: (patch: Record<string, unknown>) => void }) {
  const cropping = app.use((s) => s.cropping);
  const frame = playhead.use((s) => s.frame);
  const tf: Record<string, number> = item.transform ?? {};
  const tr = item.transition;
  // Values at the playhead; a prop with keys edits its key there instead of its plain value.
  const now = animate(p, item, frame);
  const keyed = (k: Animatable) => !!item.keyframes?.[k];
  const mark = (k: Animatable, v: number) => <KeyButton p={p} item={item} prop={k} frame={frame} value={v} />;
  const keyPatch = (k: Animatable, v: number) => ({ keyframes: withKey(p, item, k, frame, v) ?? null });
  const setTf = (k: string, v: string | number | null) => {
    const next = { ...tf, [k]: v ?? undefined };
    if (v === null) delete next[k];
    set({ transform: Object.keys(next).length ? next : null });
  };
  const setGrade = (k: string, v: unknown) => {
    const next = { ...item.grade } as Record<string, unknown>;
    if (v === null) delete next[k]; else next[k] = v;
    return set({ grade: Object.keys(next).length ? next : null });
  };
  const lumaKey = item.key?.kind === "luma" ? item.key : null;
  return (
    <>
      <label className="field">
        <span>fit</span>
        <select value={item.fit ?? ""} onChange={(e) => set({ fit: e.target.value || null })}>
          <option value="">contain (default)</option>
          <option value="cover">cover</option>
        </select>
      </label>
      <Slider itemId={item.id} label="volume" min={0} max={2} step={0.01} zero={1} value={now.volume ?? 1} mark={mark("volume", now.volume ?? 1)} patch={(v) => (keyed("volume") ? keyPatch("volume", v) : { volume: v === 1 ? null : v })} />
      <h4>
        transform
        <KeyGroupButton p={p} item={item} frame={frame} props={TF_KEYS.map((k) => [k, (now.transform as Record<string, number> | undefined)?.[k] ?? (k === "scale" || k === "opacity" ? 1 : 0)])} />
        <button onClick={(e) => openMenu(e, pipEntries(p, item))}>PIP ▾</button>
      </h4>
      {TF_KEYS.map((k) => {
        const v = (now.transform as Record<string, number> | undefined)?.[k];
        const dflt = k === "scale" || k === "opacity" ? 1 : 0;
        return (
          <Field
            key={k}
            label={k}
            type="number"
            value={v === undefined ? v : +v.toFixed(3)}
            mark={mark(k, v ?? dflt)}
            onCommit={(n) => (keyed(k) ? n !== null && op("setKeyframe", { itemId: item.id, prop: k, at: frame, value: Number(n) }) : setTf(k, n))}
          />
        );
      })}
      {!still && <Field label="speed (×)" type="number" value={item.speed ?? 1} onCommit={(v) => Number(v) > 0 && op("setSpeed", { itemId: item.id, speed: Number(v) })} />}
      <label className="field">
        <span>transition out</span>
        <select value={tr?.kind ?? ""} onChange={(e) => set({ transition: e.target.value ? { kind: e.target.value, duration: tr?.duration ?? Math.round(fps) } : null })}>
          <option value="">none</option>
          {TRANSITIONS.map((k) => <option key={k}>{k}</option>)}
        </select>
      </label>
      {tr && <Field label="transition (f)" type="number" value={tr.duration} onCommit={(v) => Number(v) >= 2 && set({ transition: { ...tr, duration: Math.round(Number(v)) } })} />}
      {tr && (tr.kind === "wipe" || tr.kind === "slide" || tr.kind === "push") && (
        <label className="field">
          <span>direction</span>
          <select value={tr.direction ?? "left"} onChange={(e) => set({ transition: { ...tr, direction: e.target.value } })}>
            {["left", "right", "up", "down"].map((d) => <option key={d}>{d}</option>)}
          </select>
        </label>
      )}
      <h4>
        effects
        <KeyGroupButton p={p} item={item} frame={frame} props={EFFECTS.map(([k, , , , zero]) => [k, now.effects?.[k] ?? zero])} />
        <button onClick={(e) => openMenu(e, lookEntries(item))}>Look ▾</button>
      </h4>
      {EFFECTS.map(([k, min, max, step, zero]) => (
        <Slider
          key={k}
          itemId={item.id}
          label={k}
          min={min}
          max={max}
          step={step}
          zero={zero}
          value={now.effects?.[k] ?? zero}
          mark={mark(k, now.effects?.[k] ?? zero)}
          patch={(v) => (keyed(k) ? keyPatch(k, v) : { effects: prune({ ...item.effects, [k]: v }, EFFECT_ZERO) })}
        />
      ))}
      <h4>color</h4>
      {(["exposure", "temperature", "tint", "vibrance", "shadows", "highlights"] as const).map((k) => {
        const [min, max, step] = { exposure: [-5, 5, 0.05], temperature: [-1, 1, 0.01], tint: [-1, 1, 0.01], vibrance: [-1, 1, 0.01], shadows: [-1, 1, 0.01], highlights: [-1, 1, 0.01] }[k];
        return <Slider key={k} itemId={item.id} label={k} min={min} max={max} step={step} zero={0} value={item.grade?.[k] ?? 0} patch={(v) => ({ grade: { ...item.grade, [k]: v } })} />;
      })}
      {(["inBlack", "inWhite", "gamma", "outBlack", "outWhite"] as const).map((k) => {
        const levels = { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1, ...item.grade?.levels };
        const range = k === "gamma" ? { min: 0.01, max: 10, step: 0.01, zero: 1 } : { min: 0, max: 1, step: 0.005, zero: k === "inWhite" || k === "outWhite" ? 1 : 0 };
        if (k === "inBlack") range.max = Math.min(1, levels.inWhite - 0.01);
        if (k === "inWhite") range.min = Math.max(0, levels.inBlack + 0.01);
        return <Slider key={k} itemId={item.id} label={`levels ${k}`} {...range} value={levels[k]} patch={(v) => ({ grade: { ...item.grade, levels: { ...levels, [k]: v } } })} />;
      })}
      <CurveEditor key={item.id} itemId={item.id} grade={item.grade} onCommit={(curves) => setGrade("curves", curves)} />
      <label className="field"><span>LUT</span><select value={item.grade?.lut?.assetId ?? ""} onChange={(e) => setGrade("lut", e.target.value ? { assetId: e.target.value, strength: item.grade?.lut?.strength ?? 1 } : null)}><option value="">None</option>{Object.values(p.assets).filter((a) => a.kind === "lut").map((a) => <option key={a.id} value={a.id}>{a.path}</option>)}</select></label>
      {item.grade?.lut && <Slider itemId={item.id} label="LUT strength" min={0} max={1} step={0.01} zero={1} value={item.grade.lut.strength ?? 1} patch={(v) => ({ grade: { ...item.grade, lut: { ...item.grade!.lut!, strength: v } } })} />}
      <h4>key</h4>
      <label className="field"><span>type</span><select value={item.key?.kind ?? ""} onChange={(e) => set({ key: e.target.value === "chroma" ? { kind: "chroma", color: "#00ff00", similarity: 0.18, smoothness: 0.08 } : e.target.value === "luma" ? { kind: "luma", low: 0.1, high: 0.9 } : null })}><option value="">Off</option><option value="chroma">Chroma</option><option value="luma">Luma</option></select></label>
      {item.key?.kind === "chroma" && <><Field label="key color" value={item.key.color} onCommit={(v) => set({ key: { ...item.key!, color: v } })} /><button onClick={() => { player.ref?.pause(); app.set({ sampling: item.id }); }}>Eyedropper · click preview</button><Slider itemId={item.id} label="similarity" min={0} max={1} step={0.01} zero={0.45} value={item.key.similarity} patch={(v) => ({ key: { ...item.key!, similarity: v } })} /><Slider itemId={item.id} label="smoothness" min={0} max={1} step={0.01} zero={0.08} value={item.key.smoothness} patch={(v) => ({ key: { ...item.key!, smoothness: v } })} /><Slider itemId={item.id} label="spill" min={0} max={1} step={0.01} zero={0} value={item.key.spill ?? 0} patch={(v) => ({ key: { ...item.key!, spill: v } })} /></>}
      {lumaKey && <><Slider itemId={item.id} label="luma low" min={0} max={Math.max(0, lumaKey.high - 0.001)} step={0.001} zero={0} value={lumaKey.low} patch={(v) => ({ key: { ...lumaKey, low: Math.min(v, lumaKey.high - 0.001) } })} /><Slider itemId={item.id} label="luma high" min={Math.min(1, lumaKey.low + 0.001)} max={1} step={0.001} zero={1} value={lumaKey.high} patch={(v) => ({ key: { ...lumaKey, high: Math.max(v, lumaKey.low + 0.001) } })} /><label className="field"><span>invert</span><input type="checkbox" checked={lumaKey.invert ?? false} onChange={(e) => set({ key: { ...lumaKey, invert: e.target.checked } })} /></label></>}
      <h4>
        crop
        <button className={cropping ? "on" : ""} onClick={() => app.set({ cropping: !cropping, masking: false })} title="crop handles on the preview (Shift+C)">
          on preview
        </button>
      </h4>
      {(["top", "right", "bottom", "left"] as const).map((k) => (
        <Slider key={k} itemId={item.id} label={k} min={0} max={0.9} step={0.005} zero={0} value={item.crop?.[k] ?? 0} patch={(v) => ({ crop: prune({ ...item.crop, [k]: v }, {}) })} />
      ))}
      <MaskFields p={p} item={item} set={set} />
    </>
  );
}

const CURVE_IDENTITY: [number, number][] = [[0, 0], [1, 1]];
type CurveMap = NonNullable<VideoItem["grade"]>["curves"];

function CurveEditor({ itemId, grade, onCommit }: { itemId: string; grade: VideoItem["grade"]; onCommit: (curves: CurveMap) => Promise<unknown> | void }) {
  const [channel, setChannel] = React.useState<"all" | "r" | "g" | "b">("all");
  const [draft, setDraft] = React.useState<[number, number][] | null>(null);
  const [dragging, setDragging] = React.useState<number | null>(null);
  const curves = grade?.curves ?? {};
  const points = draft ?? curves[channel] ?? CURVE_IDENTITY;
  const encode = (next: [number, number][]) => ({ ...curves, [channel]: next });
  const preview = (next: [number, number][]) => {
    setDraft(next);
    app.set({ live: { itemId, patch: { grade: { ...grade, curves: encode(next) } } } });
  };
  const commit = (next: [number, number][]) => {
    setDraft(next);
    void Promise.resolve(onCommit(encode(next))).finally(() => { app.set({ live: null }); setDraft(null); });
  };
  const at = (e: React.PointerEvent<SVGSVGElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - rect.left - rect.width / 12) / (rect.width * 5 / 6))), Math.min(1, Math.max(0, 1 - (e.clientY - rect.top - rect.height / 12) / (rect.height * 5 / 6)))];
  };
  const move = (index: number, x: number, y: number) => points.map(([px, py], i) => {
    if (i !== index) return [px, py] as [number, number];
    const minX = i === 0 ? 0 : points[i - 1][0] + 0.01, maxX = i === points.length - 1 ? 1 : points[i + 1][0] - 0.01;
    return [i === 0 || i === points.length - 1 ? px : Math.min(maxX, Math.max(minX, x)), y] as [number, number];
  });
  const add = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.target instanceof SVGCircleElement || points.length >= 16) return;
    const [x, y] = at(e as unknown as React.PointerEvent<SVGSVGElement>);
    const next = [...points, [x, y] as [number, number]].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < next.length; i++) if (next[i][0] - next[i - 1][0] < 0.02) return;
    commit(next);
  };
  const coords = (p: [number, number]) => `${20 + p[0] * 200},${220 - p[1] * 200}`;
  return (
    <div className="curve-editor">
      <label className="field"><span>curve</span><select value={channel} onChange={(e) => { setChannel(e.target.value as typeof channel); setDraft(null); }}><option value="all">master</option><option value="r">red</option><option value="g">green</option><option value="b">blue</option></select></label>
      <div className="curve-tools"><span>click to add · drag to edit · double-click a point to remove</span><button onClick={() => commit(CURVE_IDENTITY)}>Reset</button></div>
      <svg className="curve-graph" viewBox="0 0 240 240" role="img" aria-label={`${channel} tone curve`} onClick={add}
        onPointerMove={(e) => { if (dragging !== null) { const [x, y] = at(e); preview(move(dragging, x, y)); } }}
        onPointerUp={() => { if (dragging !== null) { setDragging(null); commit(points); } }} onPointerCancel={() => setDragging(null)}>
        <rect x="20" y="20" width="200" height="200" className="curve-grid" />
        <line x1="20" y1="220" x2="220" y2="20" className="curve-reference" />
        <polyline points={points.map(coords).join(" ")} className="curve-line" />
        {points.map((point, i) => <circle key={i} cx={20 + point[0] * 200} cy={220 - point[1] * 200} r="5" className="curve-point" onPointerDown={(e) => { e.stopPropagation(); (e.currentTarget as SVGCircleElement).setPointerCapture(e.pointerId); setDragging(i); }} onDoubleClick={(e) => { e.stopPropagation(); if (points.length > 2 && i > 0 && i < points.length - 1) commit(points.filter((_, j) => i !== j)); }} />)}
      </svg>
    </div>
  );
}

const TF_KEYS = ["x", "y", "scale", "rotation", "opacity"] as const;
type MaskT = NonNullable<VideoItem["mask"]>;
const TRIANGLE: [number, number][] = [[0.5, 0], [1, 1], [0, 1]];
/** field, key prop (video only), min, max, step, default (double-click resets) */
const MASK_SLIDERS = [
  ["x", "maskX", -0.5, 1.5, 0.005, 0.2],
  ["y", "maskY", -0.5, 1.5, 0.005, 0.2],
  ["w", "maskW", 0.05, 2, 0.005, 0.6],
  ["h", "maskH", 0.05, 2, 0.005, 0.6],
  ["feather", "maskFeather", 0, 200, 1, 0],
] as const;

/** Mask and blend for a video or overlay item; only video items key the geometry. Same live-preview/commit/◇ pattern as effects. */
function MaskFields({ p, item, set }: { p: Project; item: VideoItem | OverlayItem; set: (patch: Record<string, unknown>) => void }) {
  const frame = playhead.use((s) => s.frame);
  const masking = app.use((s) => s.masking);
  const video = "assetId" in item ? item : undefined;
  const mask = item.mask;
  const now = (video ? animate(p, video, frame) : item).mask;
  const pick = (shape: string) => {
    if (!shape) return set({ mask: null });
    const { radius, points, ...rest }: MaskT = mask ?? { shape: "rect", x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
    set({ mask: { ...rest, shape, ...(shape === "rect" && radius && { radius }), ...(shape === "polygon" && { points: points ?? TRIANGLE }) } });
  };
  return (
    <>
      <h4>
        mask
        {video && mask && now && <KeyGroupButton p={p} item={video} frame={frame} props={MASK_SLIDERS.map(([k, prop, , , , dflt]) => [prop, now[k] ?? dflt])} />}
        {/* The preview box only follows video items; overlays have no picture box on the player. */}
        {video && mask && (
          <button className={masking ? "on" : ""} onClick={() => app.set({ masking: !masking, cropping: false })} title="mask box on the preview (Shift+K)">
            on preview
          </button>
        )}
      </h4>
      <label className="field">
        <span>shape</span>
        <select value={mask?.shape ?? ""} onChange={(e) => pick(e.target.value)}>
          <option value="">none</option>
          {MASK_SHAPES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </label>
      {mask && now && (
        <>
          {MASK_SLIDERS.map(([k, prop, min, max, step, dflt]) => (
            <Slider
              key={k}
              itemId={item.id}
              label={k}
              min={min}
              max={max}
              step={step}
              zero={dflt}
              value={now[k] ?? dflt}
              mark={video && <KeyButton p={p} item={video} prop={prop} frame={frame} value={now[k] ?? dflt} />}
              patch={(v) => (video?.keyframes?.[prop] ? { keyframes: withKey(p, video, prop, frame, v) ?? null } : { mask: { ...mask, [k]: k === "feather" && !v ? undefined : v } })}
            />
          ))}
          {mask.shape === "rect" && <Slider itemId={item.id} label="radius" min={0} max={0.5} step={0.005} zero={0} value={mask.radius ?? 0} patch={(v) => ({ mask: { ...mask, radius: v || undefined } })} />}
          <label className="field">
            <span>invert</span>
            <input type="checkbox" checked={!!mask.invert} onChange={(e) => set({ mask: { ...mask, invert: e.target.checked || undefined } })} />
          </label>
        </>
      )}
      <label className="field">
        <span>blend</span>
        <select value={item.blend ?? "normal"} onChange={(e) => set({ blend: e.target.value === "normal" ? null : e.target.value })}>
          {BLENDS.map((b) => <option key={b}>{b}</option>)}
        </select>
      </label>
    </>
  );
}

/** ◆ when a key sits on the playhead (click removes it), ◇ otherwise (click keys `value` there); lit once the prop has keys. */
function KeyButton({ p, item, prop, frame, value }: { p: Project; item: VideoItem | AudioItem; prop: Animatable; frame: number; value: number }) {
  const on = !!keyAt(p, item, prop, frame);
  const inside = frame >= item.start && frame < item.start + item.duration;
  return (
    <button
      className={`kf-btn ${item.keyframes?.[prop] ? "keyed" : ""}`}
      disabled={!inside}
      title={inside ? (on ? `remove the ${prop} key here` : `key ${prop} here`) : "move the playhead into the item to key it"}
      onClick={() => op("setKeyframe", { itemId: item.id, prop, at: frame, value: on ? null : +value.toFixed(4) })}
    >
      {on ? "◆" : "◇"}
    </button>
  );
}

/** ◇ for a whole section: keys every prop at the playhead (keeping keys already there), or, when all are keyed here, removes them all. One undo step. */
function KeyGroupButton({ p, item, frame, props }: { p: Project; item: VideoItem; frame: number; props: [Animatable, number][] }) {
  const here = props.filter(([k]) => keyAt(p, item, k, frame));
  const all = here.length === props.length;
  const inside = frame >= item.start && frame < item.start + item.duration;
  const ops = (all ? props.map(([prop]) => [prop, null] as const) : props.filter((kv) => !here.includes(kv)).map(([prop, v]) => [prop, +v.toFixed(4)] as const)).map(([prop, value]) => ({
    op: "setKeyframe",
    args: { itemId: item.id, prop, at: frame, value },
  }));
  return (
    <button
      className={`kf-btn ${props.some(([k]) => item.keyframes?.[k]) ? "keyed" : ""}`}
      disabled={!inside}
      title={inside ? (all ? "remove every key here in this section" : "key every field in this section here") : "move the playhead into the item to key it"}
      onClick={() => op("batch", { ops })}
    >
      {all ? "◆" : here.length ? "◈" : "◇"}
    </button>
  );
}

/** name, min, max, step, neutral */
const EFFECTS = [
  ["brightness", 0, 2, 0.01, 1],
  ["contrast", 0, 2, 0.01, 1],
  ["saturation", 0, 3, 0.01, 1],
  ["hue", -180, 180, 1, 0],
  ["blur", 0, 40, 0.5, 0],
  ["grayscale", 0, 1, 0.01, 0],
  ["sepia", 0, 1, 0.01, 0],
  ["invert", 0, 1, 0.01, 0],
] as const;
const EFFECT_ZERO: Record<string, number> = Object.fromEntries(EFFECTS.map(([k, , , , z]) => [k, z]));

/** Drop neutral values (`zero[k]`, else 0), so a fully reset group unsets the field. */
const prune = (o: Record<string, number | undefined>, zero: Record<string, number>) => {
  const out = Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && v !== (zero[k] ?? 0)));
  return Object.keys(out).length ? out : null;
};

/** Range slider: the preview follows the drag through `live`, release commits one setProps (one undo step); double-click resets. */
function Slider({ itemId, label, min, max, step, zero, value, patch, mark }: { itemId: string; label: string; min: number; max: number; step: number; zero: number; value: number; patch: (v: number) => Partial<VideoItem> | Record<string, unknown>; mark?: React.ReactNode }) {
  const commit = (v: number) => op("setProps", { itemId, patch: patch(v) }).finally(() => app.set({ live: null }));
  const release = (v: number) => app.get().live?.itemId === itemId && commit(v);
  const id = React.useId();
  return (
    <label className="field slider" htmlFor={id} title="drag; arrow keys step; double-click resets">
      <span>
        {label}
        {mark}
      </span>
      <input
        id={id}
        onDoubleClick={() => value !== zero && commit(zero)}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => app.set({ live: { itemId, patch: patch(+e.currentTarget.value) as Partial<VideoItem> } })}
        onPointerUp={(e) => release(+e.currentTarget.value)}
        onKeyUp={(e) => release(+e.currentTarget.value)}
      />
      <output>{+value.toFixed(3)}</output>
    </label>
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
  if (app.get().sampling && e.key === "Escape") { e.preventDefault(); app.set({ sampling: null }); return; }
  if (el.closest("input, textarea, select")) return;
  const s = app.get();
  const p = s.project;
  if (!p) return;
  const frame = playhead.get().frame;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  const handled = () => e.preventDefault();

  if (key === " ") return handled(), app.set({ rate: 1 }), player.ref?.toggle();
  if (e.altKey && !mod && (key === "arrowleft" || key === "arrowright")) return handled(), stepKey(key === "arrowleft" ? -1 : 1);
  if (key === "arrowleft" || key === "arrowright") return handled(), player.ref?.pause(), seek(frame + (key === "arrowleft" ? -1 : 1) * (e.shiftKey ? 10 : 1));
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
