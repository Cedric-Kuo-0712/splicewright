import React, { useMemo, useState } from "react";
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useRemotionEnvironment, createEffect, type EffectsProp, type EffectDefinition } from "remotion";
import { Video as CanvasVideo } from "@remotion/media";
import { colorKey } from "@remotion/effects/color-key";
import { exposure } from "@remotion/effects/exposure";
import { whiteBalance } from "@remotion/effects/white-balance";
import { vibrance } from "@remotion/effects/vibrance";
import { levels } from "@remotion/effects/levels";
import { shadowsHighlights } from "@remotion/effects/shadows-highlights";
import { gradeEffect, type GradeLut } from "./grade-effect.ts";
import { lumaKey } from "./luma-key.ts";
import "./fonts.ts";
import { animate, itemSpan, sourceAt, textCss, transitionOf, valueAt, type AudioItem, type Item, type OverlayItem, type Project, type Track, type VideoItem, type Word, type FontRole, type TextStyle } from "@splicewright/core";
import type { Config } from "./config.ts";
import { duckGain, type Ranges } from "./duck.ts";

// Spec §9: one composition renders any project.json, tracks bottom (index 0) to top.

export interface Props extends Record<string, unknown> {
  project: Project;
  /** From duckRanges(); speech ranges per ducked audio item. */
  duck?: Record<string, Ranges>;
  /** Coded [width, height] per asset, from sizesOf(); crop needs them to find the picture inside its box. */
  sizes?: Record<string, [number, number]>;
  /** From captionWords(); transcript words per anchored caption on a highlight: "word" track. */
  words?: Record<string, Word[]>;
  luts?: Record<string, GradeLut>;
  sampleItemId?: string;
  /** Carried through so the Node side can read config presets via selectComposition(). */
  presets?: Config["presets"];
}

const center = { justifyContent: "center", alignItems: "center", overflow: "hidden" } as const;

// Base styles, scoped so the M4 UI page isn't touched. They mirror the Tailwind preflight rules that
// video-cut's components were written against (sans-serif, line-height 1.5, box/margin reset).
const BASE = ".swr *, .swr ::before, .swr ::after { box-sizing: border-box; margin: 0; padding: 0; border: 0 solid; }";
const FONT = 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';

export const Text: React.FC<{ text: string; style?: React.CSSProperties }> = ({ text, style }) => (
  <AbsoluteFill style={center}>
    <div style={{ color: "#fff", fontSize: 64, fontWeight: 700, textAlign: "center", ...style }}>{text}</div>
  </AbsoluteFill>
);

export const Image: React.FC<{ src: string; fit?: "contain" | "cover"; style?: React.CSSProperties }> = ({ src, fit = "contain", style }) => (
  <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: fit, ...style }} />
);

/** Default caption look, ported from video-cut's CaptionOverlay. Captions sharing a frame stack. */
export interface CaptionProps {
  texts: string[];
  /** Theme subtitle + track textStyle, over the default look. */
  css?: React.CSSProperties;
  /** Per text: its words with the spoken one marked, drawn in `hiCss`. */
  words?: ({ text: string; on: boolean }[] | undefined)[];
  hiCss?: React.CSSProperties;
}

export const CaptionLayer: React.FC<CaptionProps> = ({ texts, css, words, hiCss }) => (
  <div style={{ position: "absolute", bottom: 60, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, zIndex: 40 }}>
    {texts.map((text, i) => (
      <div
        key={i}
        style={{
          background: "rgba(0, 0, 0, 0.55)",
          backdropFilter: "blur(4px)",
          color: "#ffffff",
          fontSize: 24,
          fontWeight: 600,
          padding: "6px 18px",
          borderRadius: 8,
          letterSpacing: "0.02em",
          textShadow: "0 1px 2px rgba(0,0,0,0.8)",
          maxWidth: "85%",
          textAlign: "center",
          lineHeight: 1.3,
          ...css,
        }}
      >
        {words?.[i]?.map((w, k) => (
          <span key={k} style={w.on ? hiCss : undefined}>{w.text}</span>
        )) ?? text}
      </div>
    ))}
  </div>
);

/** A caption track's captions visible at the current frame, drawn by one layer component. */
const Captions: React.FC<{ p: Project; t: Track; Layer: React.ComponentType<CaptionProps>; words: Record<string, Word[]> }> = ({ p, t, Layer, words }) => {
  const frame = useCurrentFrame();
  const spans = useMemo(() => t.items.flatMap((i) => ("mode" in i && i.text ? [{ item: i, text: i.text, span: itemSpan(p, i) }] : [])), [p, t]);
  const shown = spans.filter(({ span }) => span && frame >= span.start && frame < span.start + span.duration);
  if (!shown.length) return null;
  const textStyle = t.kind === "caption" ? t.textStyle : undefined;
  const all = shown.map((c) => c.text).join("");
  const css = textCss(p, "subtitle", textStyle, all);
  // The emphasis look for the spoken word: font, weight, color, stroke and shadow only, so the line doesn't reflow.
  const { fontFamily, fontWeight, color, textTransform, WebkitTextStroke, paintOrder, textShadow } = textCss(p, "emphasis", undefined, all);
  const hiCss = { fontFamily, fontWeight, color: color ?? "#ffd60a", textTransform, WebkitTextStroke, paintOrder, textShadow } as React.CSSProperties;
  const marked = shown.map(({ item, text }) => {
    const ws = words[item.id];
    const vi = "itemId" in item ? p.tracks.flatMap((x) => (x.kind === "video" ? x.items : [])).find((v) => v.id === item.itemId) : undefined;
    // Words are spliced from the transcript; if the caption was edited they no longer match, so draw it plain.
    if (!ws || !vi || ws.map((w) => w.text).join("").replace(/\s/g, "") !== text.replace(/\s/g, "")) return undefined;
    const now = sourceAt(p, vi, frame);
    const lit = ws.findLastIndex((w) => w.start <= now);
    // A space between words unless the transcript already has one or the word is CJK.
    return ws.map((w, k) => ({ text: (k && !/^\s/.test(w.text) && !/[\u3400-\u9fff]/.test(w.text) ? " " : "") + w.text.trimEnd(), on: k === lit }));
  });
  return <Layer texts={shown.map((c) => c.text)} css={css} words={marked} hiCss={hiCss} />;
};

type Transition = NonNullable<ReturnType<typeof transitionOf>>;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Unit vector from the frame centre toward the side a transition's incoming picture enters from. */
const ENTRY = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] } as const;
/** CSS inset() order (top right bottom left) → the side a wipe shrinks: opposite the entry side. */
const WIPE_SIDE = { left: 1, right: 3, up: 2, down: 0 } as const;

/** How a video item looks and sounds at timeline frame `f`: its fades, plus the transition into it
 * (`inc`, from the item before) and out of it. Every kind but dip lays the incoming item over the
 * outgoing one across the cut: dissolve fades it in, wipe reveals it from the entry side, slide moves it
 * in (`dx`, `dy` are frame fractions), push also moves the outgoing one out, zoom fades it in while
 * `zoom` (a scale multiplier) settles; dip darkens to black before the cut and back after it. */
export function look(item: VideoItem, f: number, inc?: Transition, out?: Transition) {
  const end = item.start + item.duration;
  let opacity = 1;
  let bright = 1;
  let gain = 1;
  let clip: string | undefined;
  let dx = 0;
  let dy = 0;
  let zoom = 1;
  if (item.fadeIn) gain *= clamp01((f - item.start) / item.fadeIn);
  if (item.fadeOut) gain *= clamp01((end - f) / item.fadeOut);
  opacity *= gain;
  if (inc) {
    const t = clamp01((f - item.start + inc.before) / (inc.before + inc.after));
    const d = clamp01((f - item.start) / inc.after);
    const dir = inc.direction ?? "left";
    const [vx, vy] = ENTRY[dir];
    if (inc.kind === "dip") (bright *= d), (gain *= d);
    else gain *= t;
    if (inc.kind === "dissolve") opacity *= t;
    else if (inc.kind === "wipe") clip = `inset(${(["0", "0", "0", "0"] as string[]).map((z, i) => (i === WIPE_SIDE[dir] ? `${(1 - t) * 100}%` : z)).join(" ")})`;
    else if (inc.kind === "slide" || inc.kind === "push") (dx += vx * (1 - t)), (dy += vy * (1 - t));
    else if (inc.kind === "zoom") (opacity *= t), (zoom *= 1.25 - 0.25 * t);
  }
  if (out) {
    const t = clamp01((f - end + out.before) / (out.before + out.after));
    const d = clamp01((end - f) / out.before);
    if (out.kind === "dip") (bright *= d), (gain *= d);
    else {
      gain *= 1 - t; // stays in view under the incoming item
      const [vx, vy] = ENTRY[out.direction ?? "left"];
      if (out.kind === "push") (dx -= vx * t), (dy -= vy * t);
      else if (out.kind === "zoom") zoom *= 1 + 0.25 * t;
    }
  }
  return { opacity, bright, gain, clip, dx, dy, zoom };
}

/**
 * Where a video item's picture sits at scale 1. The media element is `ew`×`eh` (the frame, swapped when
 * the total rotation is a quarter turn) and rotated by `rot`; the visible picture inside it is `vw`×`vh`,
 * centred. `display` is that picture upright as the asset plays (asset rotation applied, the item's not),
 * and `turn` is the asset rotation in quarter turns. Without a probed `size` the picture fills the element.
 */
export function mediaBox(p: Project, item: VideoItem, size?: [number, number]) {
  const { width: W, height: H } = p.meta;
  const a = p.assets[item.assetId]?.rotation ?? 0;
  const rot = a + (item.transform?.rotation ?? 0);
  const [ew, eh] = Math.abs(rot % 180) === 90 ? [H, W] : [W, H];
  const [w, h] = size ?? [ew, eh];
  const s = (item.fit === "cover" ? Math.max : Math.min)(ew / w, eh / h);
  const [vw, vh] = [Math.min(ew, w * s), Math.min(eh, h * s)];
  const turn = ((Math.round(a / 90) % 4) + 4) % 4;
  return { ew, eh, vw, vh, rot, turn, display: (turn % 2 ? [vh, vw] : [vw, vh]) as [number, number] };
}

export type PipPreset = "tl" | "tr" | "bl" | "br" | "left" | "right" | "circle";

/**
 * Picture-in-picture as a setProps patch (transform and/or mask only). Corners scale to 0.3 with a 4%
 * margin; left/right fill half the frame side by side. Placement targets the visible region (mask box,
 * else crop box, else the whole upright picture), so a masked or cropped item lands where it shows.
 * circle only adds a centred circular mask and keeps the transform. Transform x, y are the picture
 * centre's px offset from the frame centre, as in the web transform box.
 * ponytail: rotation is ignored (the visible box is measured upright); handle it if rotated PIPs matter.
 */
export function pip(p: Project, item: VideoItem, size: [number, number] | undefined, preset: PipPreset) {
  const { width: W, height: H } = p.meta;
  const [vw, vh] = mediaBox(p, item, size).display;
  if (preset === "circle") {
    const d = Math.min(vw, vh);
    const [w, h] = [d / vw, d / vh];
    return { mask: { shape: "ellipse" as const, x: (1 - w) / 2, y: (1 - h) / 2, w, h } };
  }
  const { mask, crop = {} } = item;
  // An inverted mask shows what is outside its box, so place the crop box instead.
  const [rx, ry, rw, rh] = mask && !mask.invert
    ? [mask.x, mask.y, mask.w, mask.h]
    : [crop.left ?? 0, crop.top ?? 0, 1 - (crop.left ?? 0) - (crop.right ?? 0), 1 - (crop.top ?? 0) - (crop.bottom ?? 0)];
  const [bw, bh] = [rw * vw, rh * vh]; // visible box at scale 1
  const [ox, oy] = [(rx + rw / 2 - 0.5) * vw, (ry + rh / 2 - 0.5) * vh]; // its centre relative to the picture's
  const side = preset === "left" || preset === "right";
  const scale = side ? Math.min(W / 2 / bw, H / bh) : 0.3;
  const m = 0.04 * Math.min(W, H);
  // Where the visible box's centre goes, in px from the frame centre.
  const cx = side ? (preset === "left" ? -W / 4 : W / 4) : (preset.endsWith("l") ? -1 : 1) * (W / 2 - m - (scale * bw) / 2);
  const cy = side ? 0 : (preset.startsWith("t") ? -1 : 1) * (H / 2 - m - (scale * bh) / 2);
  const t = item.transform ?? {};
  return { transform: { ...t, x: +(cx - scale * ox).toFixed(2), y: +(cy - scale * oy).toFixed(2), scale: +scale.toFixed(4) } };
}

const SIDES = ["top", "right", "bottom", "left"] as const;

/** Crop as a clip-path on the (rotated) media element: crop sides are the upright picture's, so shift them by the asset's quarter turns. */
function cropPath(box: ReturnType<typeof mediaBox>, crop: VideoItem["crop"]) {
  if (!crop) return undefined;
  const c = SIDES.map((_, i) => crop[SIDES[(i + box.turn) % 4]] ?? 0);
  const [ox, oy] = [(box.ew - box.vw) / 2, (box.eh - box.vh) / 2];
  return `inset(${oy + c[0] * box.vh}px ${ox + c[1] * box.vw}px ${oy + c[2] * box.vh}px ${ox + c[3] * box.vw}px)`;
}

const DIAMOND: [number, number][] = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
const STAR: [number, number][] = Array.from({ length: 10 }, (_, i) => {
  const [a, r] = [(i * Math.PI) / 5 - Math.PI / 2, i % 2 ? 0.2 : 0.5];
  return [0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)];
});
const n2 = (v: number) => +v.toFixed(2);

/**
 * Mask as CSS on a wrapper that fills the `frame` (W×H px) and centres the media, so it clips after the
 * media's own crop. Mask fractions are of the `pic` box, centred in the frame. Plain shapes are a
 * clip-path; feather or invert switch to an SVG mask-image (the shape blurred, or cut from a full rect).
 * ponytail: the mask stays upright when the item is rotated; rotate the wrapper too if that matters.
 */
export function maskStyle(mask: NonNullable<VideoItem["mask"]>, [W, H]: [number, number], pic: [number, number]): React.CSSProperties {
  const [mw, mh] = [mask.w * pic[0], mask.h * pic[1]].map(n2);
  const [mx, my] = [(W - pic[0]) / 2 + mask.x * pic[0], (H - pic[1]) / 2 + mask.y * pic[1]].map(n2);
  const { shape, feather = 0, invert } = mask;
  const pts = (shape === "polygon" ? mask.points : shape === "star" ? STAR : shape === "diamond" ? DIAMOND : undefined)?.map(([u, v]) => [n2(mx + u * mw), n2(my + v * mh)]);
  const r = n2((mask.radius ?? 0) * Math.min(mw, mh));
  if (!feather && !invert) {
    if (pts) return { clipPath: `polygon(${pts.map(([a, b]) => `${a}px ${b}px`).join(", ")})` };
    if (shape === "ellipse") return { clipPath: `ellipse(${mw / 2}px ${mh / 2}px at ${n2(mx + mw / 2)}px ${n2(my + mh / 2)}px)` };
    return { clipPath: `inset(${my}px ${n2(W - mx - mw)}px ${n2(H - my - mh)}px ${mx}px${r ? ` round ${r}px` : ""})` };
  }
  const geom = pts ? `<polygon points="${pts.map((q) => q.join(",")).join(" ")}"/>` : shape === "ellipse" ? `<ellipse cx="${n2(mx + mw / 2)}" cy="${n2(my + mh / 2)}" rx="${mw / 2}" ry="${mh / 2}"/>` : `<rect x="${mx}" y="${my}" width="${mw}" height="${mh}" rx="${r}"/>`;
  const g = `<g fill="#000"${feather ? ' filter="url(#b)"' : ""}>${geom}</g>`;
  const full = `width="${W}" height="${H}"`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ${full}><defs>` +
    (feather ? `<filter id="b" filterUnits="userSpaceOnUse" x="${-3 * feather}" y="${-3 * feather}" width="${W + 6 * feather}" height="${H + 6 * feather}"><feGaussianBlur stdDeviation="${feather / 2}"/></filter>` : "") +
    (invert ? `<mask id="m"><rect ${full} fill="#fff"/>${g}</mask>` : "") +
    `</defs>${invert ? `<rect ${full} mask="url(#m)"/>` : g}</svg>`;
  const image = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  return { maskImage: image, WebkitMaskImage: image, maskSize: `${W}px ${H}px`, WebkitMaskSize: `${W}px ${H}px`, maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat" };
}

const blendOf = (item: { blend?: string }) => (item.blend && item.blend !== "normal" ? (item.blend as React.CSSProperties["mixBlendMode"]) : undefined);

/** effects field → CSS filter function, unit, neutral value. */
const FILTERS = [
  ["brightness", "brightness", "", 1],
  ["contrast", "contrast", "", 1],
  ["saturation", "saturate", "", 1],
  ["hue", "hue-rotate", "deg", 0],
  ["blur", "blur", "px", 0],
  ["grayscale", "grayscale", "", 0],
  ["sepia", "sepia", "", 0],
  ["invert", "invert", "", 0],
] as const;

export const filterOf = (e: VideoItem["effects"] | null = {}) =>
  FILTERS.flatMap(([k, fn, unit, zero]) => (e?.[k] !== undefined && e[k] !== zero ? [`${fn}(${e[k]}${unit})`] : [])).join(" ") || undefined;

export function canvasVideoErrorHandler(itemName: string, onFailure: (error: Error) => void) {
  return (error: Error): "fail" => {
    error.message = `Video look decode failed for item "${itemName}": ${error.message}`;
    onFailure(error);
    return "fail";
  };
}

/** The same ordered pixel pipeline is used by stills and video: built-in grading, curves/LUT, then key. */
const samplingCanvasEffect = createEffect<{}, null>({
  type: "splicewright-sampling-canvas", label: "Sampling canvas", documentationLink: null, backend: "2d", schema: {},
  calculateKey: () => "sampling-canvas", validateParams: () => {}, setup: () => null,
  apply: ({ source, target, width, height }) => {
    const ctx = target.getContext("2d");
    if (!ctx) throw new Error("2D canvas required for color sampling");
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);
  },
  cleanup: () => {},
} satisfies EffectDefinition<{}, null>);

export function lookEffects(itemId: string, grade: VideoItem["grade"], keyLook: VideoItem["key"], luts: Record<string, GradeLut>, sample: boolean): EffectsProp {
  if (grade?.lut && !luts[grade.lut.assetId]) throw new Error(`Look item ${itemId} references unavailable LUT asset ${grade.lut.assetId}`);
  const effects: EffectsProp = [
    ...(grade?.exposure !== undefined ? [exposure({ stops: grade.exposure })] : []),
    ...(grade?.temperature !== undefined || grade?.tint !== undefined ? [whiteBalance({ temperature: grade.temperature, tint: grade.tint })] : []),
    ...(grade?.vibrance !== undefined ? [vibrance({ amount: grade.vibrance })] : []),
    ...(grade?.shadows !== undefined || grade?.highlights !== undefined ? [shadowsHighlights({ shadows: grade.shadows, highlights: grade.highlights })] : []),
    ...(grade?.levels ? [levels({ blackPoint: grade.levels.inBlack, whitePoint: grade.levels.inWhite, gamma: grade.levels.gamma })] : []),
    // The shader only does curves, a LUT and the output levels; skip it (and its WebGL2 context) for the built-in effects alone.
    ...(grade && (Object.keys(grade.curves ?? {}).length || grade.lut || (grade.levels && (grade.levels.outBlack > 0 || grade.levels.outWhite < 1))) ? [gradeEffect({ curves: grade.curves ?? {}, lut: grade.lut ? luts[grade.lut.assetId] : undefined, strength: grade.lut?.strength ?? 1, outBlack: grade.levels?.outBlack, outWhite: grade.levels?.outWhite })] : []),
    ...(!sample && keyLook?.kind === "chroma" ? [colorKey({ keyColor: keyLook.color, similarity: keyLook.similarity, smoothness: keyLook.smoothness, spillSuppression: keyLook.spill })] : []),
    ...(!sample && keyLook?.kind === "luma" ? [lumaKey({ low: keyLook.low, high: keyLook.high, invert: keyLook.invert })] : []),
  ];
  // Remotion Img renders a native <img> for an empty effects list. Sampling still needs a canvas
  // even when a key-only item bypasses its key and has no persistent grading fields.
  return sample && effects.length === 0 ? [samplingCanvasEffect({})] : effects;
}

const lookOffStyle: React.CSSProperties = { position: "absolute", top: 8, right: 8, zIndex: 10, padding: "4px 8px", color: "#fff", background: "#9b1c1c", borderRadius: 4, font: "12px sans-serif" };

const CanvasVideoPath: React.FC<{
  itemName: string;
  src: string;
  trimBefore: number;
  speed: number;
  volume: (frame: number) => number;
  muted?: boolean;
  fit: VideoItem["fit"];
  style: React.CSSProperties;
  keyLook?: NonNullable<VideoItem["key"]>;
  grade?: VideoItem["grade"];
  luts: Record<string, GradeLut>;
  itemId: string;
  sample: boolean;
}> = ({ itemName, src, trimBefore, speed, volume, muted, fit, style, keyLook, grade, luts, itemId, sample }) => {
  const [decodeError, setDecodeError] = useState<Error | null>(null);
  return (
    <div data-look-item-id={itemId} style={{ display: "contents" }}>
      {decodeError ? (
        <div style={lookOffStyle}>look off: can&apos;t decode ({itemName})</div>
      ) : (
        <CanvasVideo
          src={src}
          trimBefore={trimBefore}
          playbackRate={speed}
          volume={volume}
          muted={muted || speed !== 1}
          objectFit={fit ?? "contain"}
          style={{ ...style, objectFit: undefined }}
          disallowFallbackToOffthreadVideo
          onError={canvasVideoErrorHandler(itemName, setDecodeError)}
          effects={lookEffects(itemId, grade, keyLook, luts, sample)}
        />
      )}
      {!decodeError && speed !== 1 && <Audio src={src} trimBefore={trimBefore} playbackRate={speed} volume={volume} muted={muted} />}
    </div>
  );
};

const Video: React.FC<{ p: Project; item: VideoItem; size?: [number, number]; muted?: boolean; from: number; inc?: Transition; out?: Transition; luts: Record<string, GradeLut>; sampleItemId?: string }> = ({ p, item: raw, size, muted, from, inc, out, luts, sampleItemId }) => {
  const asset = p.assets[raw.assetId];
  const f = from + useCurrentFrame();
  const item = animate(p, raw, f);
  const l = look(item, f, inc, out);
  const speed = item.speed ?? 1;
  const { x = 0, y = 0, scale = 1, opacity } = item.transform ?? {};
  // ponytail: an animated rotation crossing a quarter turn re-fits the picture (the element swaps W and H) and pops.
  const box = mediaBox(p, item, size);
  // Pixel sizes, not vw/vh: in the Player those are the browser window's.
  const style: React.CSSProperties = {
    width: box.ew,
    height: box.eh,
    flexShrink: 0,
    objectFit: item.fit ?? "contain",
    transform: box.rot ? `rotate(${box.rot}deg)` : undefined,
    filter: filterOf(item.effects),
    clipPath: cropPath(box, item.crop),
  };
  const trimBefore = Math.round((item.sourceIn - ((item.start - from) * speed) / p.meta.fps) * p.meta.fps);
  const volume = (v: number) => (valueAt(p, raw, "volume", from + v) ?? raw.volume ?? 1) * look(raw, from + v, inc, out).gain;
  // A missing .cube must not take the whole preview down, but a render keeps failing on it (lookEffects throws) rather than writing an ungraded clip.
  const { isRendering } = useRemotionEnvironment();
  const lutMissing = !!raw.grade?.lut && !luts[raw.grade.lut.assetId];
  const media = lutMissing && !isRendering ? (
    <div style={lookOffStyle}>look off: LUT {raw.grade!.lut!.assetId} unavailable ({raw.label ?? raw.id})</div>
  ) : asset.kind === "image" && (raw.grade || raw.key) ? (
    <div data-look-item-id={raw.id} style={{ display: "contents" }}><Img src={staticFile(asset.path)} style={style} effects={lookEffects(raw.id, raw.grade, raw.key, luts, sampleItemId === raw.id)} /></div>
  ) : asset.kind === "image" ? (
    <Img src={staticFile(asset.path)} style={style} />
  ) : raw.key || raw.grade ? (
    <CanvasVideoPath key={asset.path} itemName={raw.label ?? raw.id} itemId={raw.id} sample={sampleItemId === raw.id} src={staticFile(asset.path)} trimBefore={trimBefore} speed={speed} volume={volume} muted={muted} fit={item.fit} style={style} keyLook={raw.key} grade={raw.grade} luts={luts} />
  ) : (
    // Legacy items stay on OffthreadVideo; only pixel-look items opt into the canvas decoder.
    <OffthreadVideo
      src={staticFile(asset.path)}
      trimBefore={trimBefore}
      playbackRate={speed}
      volume={volume}
      muted={muted}
      style={style}
    />
  );
  return (
    <AbsoluteFill
      style={{
        ...center,
        mixBlendMode: blendOf(item),
        opacity: (opacity ?? 1) * l.opacity,
        filter: l.bright < 1 ? `brightness(${l.bright})` : undefined,
        clipPath: l.clip,
        transform: x || y || scale !== 1 || l.dx || l.dy || l.zoom !== 1 ? `translate(${x + l.dx * p.meta.width}px, ${y + l.dy * p.meta.height}px) scale(${scale * l.zoom})` : undefined,
      }}
    >
      {item.mask && sampleItemId !== raw.id ? (
        <div style={{ ...center, display: "flex", width: p.meta.width, height: p.meta.height, flexShrink: 0, ...maskStyle(item.mask, [p.meta.width, p.meta.height], box.display) }}>{media}</div>
      ) : (
        media
      )}
    </AbsoluteFill>
  );
};

const Sound: React.FC<{ p: Project; t: Track; item: AudioItem; ranges?: Ranges }> = ({ p, t, item, ranges }) => {
  const track = "volume" in t ? (t.volume ?? 1) : 1;
  const { duration: d, fadeIn = 0, fadeOut = 0 } = item;
  const volume = (f: number) => {
    let v = (valueAt(p, item, "volume", item.start + f) ?? item.volume ?? 1) * track;
    if (fadeIn) v *= Math.min(1, f / fadeIn);
    if (fadeOut) v *= Math.min(1, (d - f) / fadeOut);
    if (item.duck && ranges) v *= duckGain(item.start + f, ranges, item.duck.level);
    return Math.max(0, v);
  };
  return <Audio src={staticFile(p.assets[item.assetId].path)} trimBefore={Math.round(item.sourceIn * p.meta.fps)} volume={volume} muted={t.muted} />;
};

export const SplicewrightProject: React.FC<Props & { components?: Config["components"] }> = ({ project: p, duck = {}, sizes = {}, words = {}, luts = {}, sampleItemId, components }) => {
  const registry: Record<string, React.ComponentType<any>> = { Text, Image, CaptionLayer, ...components };
  const component = (name: string, where: string) => {
    const C = registry[name];
    if (!C) throw new Error(`unknown component "${name}" on ${where}; register it in splicewright.config.ts`);
    return C;
  };
  const body = (t: Track, item: Item, from: number, inc?: Transition, out?: Transition) => {
    if ("assetId" in item) return t.kind === "audio" ? <Sound p={p} t={t} item={item as AudioItem} ranges={duck[item.id]} /> : <Video p={p} item={item as VideoItem} size={sizes[(item as VideoItem).assetId]} muted={t.muted} from={from} inc={inc} out={out} luts={luts} sampleItemId={sampleItemId} />;
    const C = component((item as { component: string }).component, item.id);
    const { mask } = item as OverlayItem;
    let props = (item as { props: Record<string, unknown> }).props;
    // A Text overlay's look: theme role, then textStyle, then the raw `style` escape hatch.
    if ((item as OverlayItem).component === "Text")
      props = { ...props, style: { ...textCss(p, (props.role as FontRole) ?? "title", props.textStyle as TextStyle | undefined, String(props.text ?? "")), ...(props.style as object) } };
    const layer = <C {...props} />;
    const mixBlendMode = blendOf(item as OverlayItem);
    return mask || mixBlendMode ? <AbsoluteFill style={{ mixBlendMode, ...(mask && maskStyle(mask, [p.meta.width, p.meta.height], [p.meta.width, p.meta.height])) }}>{layer}</AbsoluteFill> : layer;
  };
  return (
    <AbsoluteFill className="swr" style={{ backgroundColor: p.meta.background ?? "#000", fontFamily: FONT, lineHeight: 1.5 }}>
      <style>{BASE}</style>
      {p.tracks.map((t) =>
        // ponytail: `hidden` drops the whole track, audio included; split visual/audio if a use appears.
        t.hidden ? null : t.kind === "caption" ? (
          <Captions key={t.id} p={p} t={t} Layer={component(t.style ?? "CaptionLayer", t.id)} words={words} />
        ) : (
          <React.Fragment key={t.id}>
            {/* Video items in time order, so an incoming item draws over the outgoing one. */}
            {(t.kind === "video" ? [...t.items].sort((a, b) => a.start - b.start) : t.items).map((item, k, list) => {
              const span = itemSpan(p, item);
              if (!span) return null;
              const inc = k > 0 ? transitionOf(t, list[k - 1]) : undefined;
              const out = transitionOf(t, item);
              // every kind but dip plays the handles: the incoming item starts early, the outgoing one runs late.
              const lead = inc && inc.next === item && inc.kind !== "dip" ? inc.before : 0;
              const tail = out && out.kind !== "dip" ? out.after : 0;
              return (
                <Sequence key={item.id} from={span.start - lead} durationInFrames={span.duration + lead + tail} name={item.label ?? item.id}>
                  {body(t, item, span.start - lead, inc?.next === item ? inc : undefined, out)}
                </Sequence>
              );
            })}
          </React.Fragment>
        ),
      )}
    </AbsoluteFill>
  );
};
