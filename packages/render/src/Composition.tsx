import React, { useMemo } from "react";
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import { itemSpan, type AudioItem, type Item, type Project, type Track, type VideoItem } from "@splicewright/core";
import type { Config } from "./config.ts";
import { duckGain, type Ranges } from "./duck.ts";

// Spec §9: one composition renders any project.json, tracks bottom (index 0) to top.

export interface Props extends Record<string, unknown> {
  project: Project;
  /** From duckRanges(); speech ranges per ducked audio item. */
  duck?: Record<string, Ranges>;
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
export const CaptionLayer: React.FC<{ texts: string[] }> = ({ texts }) => (
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
        }}
      >
        {text}
      </div>
    ))}
  </div>
);

/** A caption track's captions visible at the current frame, drawn by one layer component. */
const Captions: React.FC<{ p: Project; t: Track; Layer: React.ComponentType<{ texts: string[] }> }> = ({ p, t, Layer }) => {
  const frame = useCurrentFrame();
  const spans = useMemo(() => t.items.flatMap((i) => ("mode" in i && i.text ? [{ text: i.text, span: itemSpan(p, i) }] : [])), [p, t]);
  const texts = spans.filter(({ span }) => span && frame >= span.start && frame < span.start + span.duration).map((c) => c.text);
  return texts.length ? <Layer texts={texts} /> : null;
};

const Video: React.FC<{ p: Project; item: VideoItem; muted?: boolean }> = ({ p, item, muted }) => {
  const asset = p.assets[item.assetId];
  const { x = 0, y = 0, scale = 1, rotation = 0, opacity } = item.transform ?? {};
  const rot = (asset.rotation ?? 0) + rotation;
  const swap = Math.abs(rot % 180) === 90;
  const style: React.CSSProperties = {
    width: swap ? "100vh" : "100%",
    height: swap ? "100vw" : "100%",
    objectFit: item.fit ?? "contain",
    transform: rot ? `rotate(${rot}deg)` : undefined,
  };
  return (
    <AbsoluteFill style={{ ...center, opacity, transform: x || y || scale !== 1 ? `translate(${x}px, ${y}px) scale(${scale})` : undefined }}>
      {asset.kind === "image" ? (
        <Img src={staticFile(asset.path)} style={style} />
      ) : (
        // ponytail: sourceIn is rounded to whole frames, as video-cut did; pass seconds if sub-frame seeks matter.
        <OffthreadVideo src={staticFile(asset.path)} trimBefore={Math.round(item.sourceIn * p.meta.fps)} volume={item.volume ?? 1} muted={muted} style={style} />
      )}
    </AbsoluteFill>
  );
};

const Sound: React.FC<{ p: Project; t: Track; item: AudioItem; ranges?: Ranges }> = ({ p, t, item, ranges }) => {
  const base = (item.volume ?? 1) * ("volume" in t ? (t.volume ?? 1) : 1);
  const { duration: d, fadeIn = 0, fadeOut = 0 } = item;
  const volume = (f: number) => {
    let v = base;
    if (fadeIn) v *= Math.min(1, f / fadeIn);
    if (fadeOut) v *= Math.min(1, (d - f) / fadeOut);
    if (item.duck && ranges) v *= duckGain(item.start + f, ranges, item.duck.level);
    return Math.max(0, v);
  };
  return <Audio src={staticFile(p.assets[item.assetId].path)} trimBefore={Math.round(item.sourceIn * p.meta.fps)} volume={volume} muted={t.muted} />;
};

export const SplicewrightProject: React.FC<Props & { components?: Config["components"] }> = ({ project: p, duck = {}, components }) => {
  const registry: Record<string, React.ComponentType<any>> = { Text, Image, CaptionLayer, ...components };
  const component = (name: string, where: string) => {
    const C = registry[name];
    if (!C) throw new Error(`unknown component "${name}" on ${where}; register it in splicewright.config.ts`);
    return C;
  };
  const body = (t: Track, item: Item) => {
    if ("assetId" in item) return t.kind === "audio" ? <Sound p={p} t={t} item={item as AudioItem} ranges={duck[item.id]} /> : <Video p={p} item={item as VideoItem} muted={t.muted} />;
    const C = component((item as { component: string }).component, item.id);
    return <C {...(item as { props: object }).props} />;
  };
  return (
    <AbsoluteFill className="swr" style={{ backgroundColor: p.meta.background ?? "#000", fontFamily: FONT, lineHeight: 1.5 }}>
      <style>{BASE}</style>
      {p.tracks.map((t) =>
        // ponytail: `hidden` drops the whole track, audio included; split visual/audio if a use appears.
        t.hidden ? null : t.kind === "caption" ? (
          <Captions key={t.id} p={p} t={t} Layer={component(t.style ?? "CaptionLayer", t.id)} />
        ) : (
          <React.Fragment key={t.id}>
            {t.items.map((item) => {
              const span = itemSpan(p, item);
              if (!span) return null;
              return (
                <Sequence key={item.id} from={span.start} durationInFrames={span.duration} name={item.label ?? item.id}>
                  {body(t, item)}
                </Sequence>
              );
            })}
          </React.Fragment>
        ),
      )}
    </AbsoluteFill>
  );
};
