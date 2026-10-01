import React, { useCallback, useEffect, useMemo } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import config from "virtual:swr-config";
import { animate, MASK_PROPS, durationFrames, itemSpan, withKey, type Animatable, type Project, type VideoItem } from "@splicewright/core";
import type { MaskT } from "./inspector/video.tsx";
import { mediaBox, SplicewrightProject, type Props } from "@splicewright/render";
import { findItem, split } from "./edit.ts";
import { app, ioRange, op, player, playhead, say } from "./store.ts";
import { mapSamplePoint, multiplyMatrix, sampledRgb } from "./sample-coordinates.ts";

const Composition: React.FC<Props> = (props) => <SplicewrightProject {...props} components={config.components} />;


export function Preview({ p }: { p: Project }) {
  const duck = app.use((s) => s.duck);
  const words = app.use((s) => s.words);
  const proxies = app.use((s) => s.proxies);
  const useProxies = app.use((s) => s.useProxies);
  const rate = app.use((s) => s.rate);
  const slip = app.use((s) => s.slip);
  const looping = app.use((s) => s.looping);
  const live = app.use((s) => s.live);
  const sizes = app.use((s) => s.sizes);
  const animated = app.use((s) => s.animated);
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
  // The eyedropper belongs to one item; a different selection (or none) ends it.
  const selected = app.use((s) => s.selection);
  useEffect(() => {
    if (sampling && !(selected.length === 1 && selected[0] === sampling)) app.set({ sampling: null });
  }, [sampling, selected]);
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
        inputProps={{ project: shown, duck, sizes, animated, words, luts, sampleItemId: sampling ?? undefined }}
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
export function TransformBox({ p }: { p: Project }) {
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
