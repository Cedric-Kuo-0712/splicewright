import React from "react";
import { animate, BLENDS, lutAssetAt, LUT_PRESETS, MASK_SHAPES, withKey, type OverlayItem, type Project, type VideoItem } from "@splicewright/core";
import { gradeWith, lookEntries, openMenu, pipEntries } from "../edit.ts";
import { app, applyLutPreset, op, player, playhead, prepareReverse } from "../store.ts";
import { Field, KeyButton, KeyGroupButton, EFFECTS, EFFECT_ZERO, prune, Slider } from "./fields.tsx";


const TRANSITIONS = ["dissolve", "dip", "wipe", "slide", "push", "zoom"] as const;

export function VideoFields({ p, item, fps, still, set }: { p: Project; item: VideoItem; fps: number; still: boolean; set: (patch: Record<string, unknown>) => void }) {
  const cropping = app.use((s) => s.cropping);
  const reverseProxies = app.use((s) => s.reverseProxies);
  const ingesting = app.use((s) => s.ingesting);
  const frame = playhead.use((s) => s.frame);
  const canKey = frame >= item.start && frame < item.start + item.duration;
  const tf: Record<string, number> = item.transform ?? {};
  const tr = item.transition;
  // Values at the playhead; a prop with keys edits its key there instead of its plain value.
  const now = animate(p, item, frame);
  const keyed = (k: string) => !!(item.keyframes as Record<string, unknown[]> | undefined)?.[k];
  const mark = (k: string, v: number) => <KeyButton p={p} item={item} prop={k} frame={frame} value={v} />;
  const keyPatch = (k: string, v: number) => ({ keyframes: withKey(p, item, k, frame, v) ?? null });
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
  const presetCategories = [...new Set(LUT_PRESETS.map((preset) => preset.category))];
  const lutLabel = (path: string) => LUT_PRESETS.find((preset) => path.startsWith(`raw/luts/${preset.id}-`))?.name ?? path;
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
      {!still && <>
        <label className="field"><span>reverse</span><input type="checkbox" checked={item.reverse ?? false} onChange={(e) => {
          const reverse = e.currentTarget.checked;
          set({ reverse: reverse || null });
          if (reverse && !reverseProxies.includes(item.assetId)) void prepareReverse(item.assetId);
        }} /></label>
        {item.reverse && !reverseProxies.includes(item.assetId) && <small className="hint">
          {ingesting[item.assetId] === "reverse" ? "Preparing reverse proxy…" : <button onClick={() => void prepareReverse(item.assetId)}>Prepare reverse proxy</button>}
        </small>}
      </>}
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
        return <Slider key={k} itemId={item.id} label={k} min={min} max={max} step={step} zero={0} value={now.grade?.[k] ?? 0} mark={mark(k, now.grade?.[k] ?? 0)} patch={(v) => (keyed(k) ? keyPatch(k, v) : { grade: gradeWith(item.grade, k, v) })} />;
      })}
      {(["inBlack", "inWhite", "gamma", "outBlack", "outWhite"] as const).map((k) => {
        const levels = { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1, ...item.grade?.levels };
        const range = k === "gamma" ? { min: 0.01, max: 10, step: 0.01, zero: 1 } : { min: 0, max: 1, step: 0.005, zero: k === "inWhite" || k === "outWhite" ? 1 : 0 };
        if (k === "inBlack") range.max = Math.min(1, levels.inWhite - 0.01);
        if (k === "inWhite") range.min = Math.max(0, levels.inBlack + 0.01);
        return <Slider key={k} itemId={item.id} label={`levels ${k}`} {...range} value={levels[k]} patch={(v) => ({ grade: { ...item.grade, levels: { ...levels, [k]: v } } })} />;
      })}
      <CurveEditor key={item.id} itemId={item.id} grade={item.grade} onCommit={(curves) => setGrade("curves", curves)} />
      <label className="field"><span>LUT <button className={`kf-btn ${item.lutKeyframes?.length ? "keyed" : ""}`} title="Add a discrete LUT switch at the playhead" disabled={!canKey || !item.grade?.lut} onClick={() => op("setLutKeyframe", { itemId: item.id, at: frame, assetId: lutAssetAt(p, item, frame) ?? item.grade?.lut?.assetId })}>◇</button></span><select value={lutAssetAt(p, item, frame) ?? ""} onChange={(e) => { const value = e.target.value; if (value.startsWith("preset:")) void applyLutPreset(item.id, value.slice(7), item.grade?.lut && canKey ? frame : undefined); else if (item.grade?.lut && canKey && value) void op("setLutKeyframe", { itemId: item.id, at: frame, assetId: value }); else setGrade("lut", value ? { assetId: value, strength: item.grade?.lut?.strength ?? 1 } : null); }}><option value="">None</option>{presetCategories.map((category) => <optgroup key={category} label={category}>{LUT_PRESETS.filter((preset) => preset.category === category).map((preset) => <option key={preset.id} value={`preset:${preset.id}`}>{preset.name}</option>)}</optgroup>)}<optgroup label="Project LUT assets">{Object.values(p.assets).filter((a) => a.kind === "lut").map((a) => <option key={a.id} value={a.id}>{lutLabel(a.path)}</option>)}</optgroup></select></label>
      <small className="muted">Creative SDR look · input profile unspecified</small>
      {item.grade?.lut && <Slider itemId={item.id} label="LUT strength" min={0} max={1} step={0.01} zero={1} value={now.grade?.lut?.strength ?? 1} mark={mark("lutStrength", now.grade?.lut?.strength ?? 1)} patch={(v) => (keyed("lutStrength") ? keyPatch("lutStrength", v) : { grade: { ...item.grade, lut: { ...item.grade!.lut!, strength: v } } })} />}
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
export type CurveMap = NonNullable<VideoItem["grade"]>["curves"];

export function CurveEditor({ itemId, grade, onCommit }: { itemId: string; grade: VideoItem["grade"]; onCommit: (curves: CurveMap) => Promise<unknown> | void }) {
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
        onPointerUp={() => { if (dragging !== null) { setDragging(null); commit(points); } }} onPointerCancel={() => { setDragging(null); setDraft(null); app.set({ live: null }); }}>
        <rect x="20" y="20" width="200" height="200" className="curve-grid" />
        <line x1="20" y1="220" x2="220" y2="20" className="curve-reference" />
        <polyline points={points.map(coords).join(" ")} className="curve-line" />
        {points.map((point, i) => <circle key={i} cx={20 + point[0] * 200} cy={220 - point[1] * 200} r="5" className="curve-point" onPointerDown={(e) => { e.stopPropagation(); (e.currentTarget as SVGCircleElement).setPointerCapture(e.pointerId); setDragging(i); }} onDoubleClick={(e) => { e.stopPropagation(); if (points.length > 2 && i > 0 && i < points.length - 1) commit(points.filter((_, j) => i !== j)); }} />)}
      </svg>
    </div>
  );
}

export const TF_KEYS = ["x", "y", "scale", "rotation", "opacity"] as const;
export type MaskT = NonNullable<VideoItem["mask"]>;
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
export function MaskFields({ p, item, set }: { p: Project; item: VideoItem | OverlayItem; set: (patch: Record<string, unknown>) => void }) {
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
