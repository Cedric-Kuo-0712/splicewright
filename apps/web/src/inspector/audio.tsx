import React from "react";
import { beatFrames, valueAt, withKey, type AudioFx, type AudioItem, type Project, type VideoItem } from "@splicewright/core";
import { app, ioRange, op, playhead } from "../store.ts";
import { Field, KeyButton, Slider } from "./fields.tsx";


/** Asset LUFS, 統一響度至 −14 LUFS (disabled on the same grounds normalizeLoudness refuses), and the project-wide render limiter. */
export function LoudnessFields({ p, item }: { p: Project; item: AudioItem | VideoItem }) {
  const lufs = app.use((s) => item.audioFx ? s.audioFxLoudness[item.id] : s.loudness[item.assetId]);
  const why = lufs === undefined ? (item.audioFx ? "處理後的響度尚未就緒；請等待聲音處理完成" : "尚無響度資料；請先準備素材（無聲素材不會有響度資料）") : item.keyframes?.volume ? "已有音量關鍵影格；請先移除後再統一響度" : null;
  return (
    <>
      <h4>響度</h4>
      <p className="dim">{lufs === undefined ? "響度尚未測量" : `響度 ${lufs.toFixed(1)} LUFS`}</p>
      <div className="buttons" data-ui-control="normalize">
        <button disabled={!!why} title={why ?? "Set volume so the asset plays at −14 LUFS (one undo step)"} onClick={() => op("normalizeLoudness", { itemIds: [item.id], target: -14 })}>
          統一響度至 −14 LUFS
        </button>
      </div>
      {why && <p className="dim">{why}</p>}
      <div data-ui-control="audio-fx"><AudioFxFields item={item} /></div>
      <label className="field" title="Render-only −1 dBFS master limiter for the whole project; the preview has no limiter">
        <span>輸出峰值限制（僅輸出時生效）</span>
        <input type="checkbox" checked={!!p.meta.limiter} onChange={(e) => op("setMeta", { limiter: e.target.checked })} />
      </label>
    </>
  );
}

function AudioFxFields({ item }: { item: AudioItem | VideoItem }) {
  const fx = item.audioFx ?? {};
  const processing = app.use((s) => s.audioFxProcessing.includes(item.id));
  const error = app.use((s) => s.audioFxErrors[item.id]);
  const setFx = (next: AudioFx | null) => op("setProps", { itemId: item.id, patch: { audioFx: next } });
  const change = (patch: Partial<AudioFx>) => {
    const next = { ...fx, ...patch };
    if (!next.eq?.length && next.pan === undefined && !next.denoise) setFx(null);
    else setFx(next);
  };
  return (
    <div className="audio-fx">
      <h4>聲音處理</h4>
      <Field control="pan" label="pan (−1 left, +1 right)" type="number" value={fx.pan} onCommit={(v) => change({ pan: v === null ? undefined : Number(v) })} />
      <div data-ui-control="eq">{(fx.eq ?? []).map((band, index) => (
        <div className="audio-fx-band" key={index}>
          <Field label={`EQ ${index + 1} Hz`} type="number" value={band.hz} onCommit={(v) => change({ eq: fx.eq!.map((b, i) => i === index ? { ...b, hz: Number(v) } : b) })} />
          <Field label="gain (dB)" type="number" value={band.gain} onCommit={(v) => change({ eq: fx.eq!.map((b, i) => i === index ? { ...b, gain: Number(v) } : b) })} />
          <button type="button" onClick={() => change({ eq: fx.eq!.filter((_, i) => i !== index) })}>移除等化器</button>
        </div>
      ))}
      <div className="buttons"><button type="button" disabled={(fx.eq?.length ?? 0) >= 16} onClick={() => change({ eq: [...(fx.eq ?? []), { hz: 1000, gain: -3, q: 1 }] })}>新增等化器頻段</button></div></div>
      <label className="field" data-ui-control="denoise">
        <span>降噪</span>
        <select value={fx.denoise?.kind ?? ""} onChange={(e) => change({ denoise: e.target.value ? { kind: e.target.value as "fft" | "rnnoise", mix: fx.denoise?.mix ?? 1, ...(fx.denoise?.model ? { model: fx.denoise.model } : {}) } : undefined })}>
          <option value="">off</option><option value="fft">FFT</option><option value="rnnoise">RNNoise</option>
        </select>
      </label>
      {fx.denoise && <Field label="denoise mix (0–1)" type="number" value={fx.denoise.mix ?? 1} onCommit={(v) => change({ denoise: { ...fx.denoise!, mix: v === null ? 1 : Number(v) } })} />}
      {fx.denoise?.kind === "rnnoise" && <Field label="RNNoise model (raw/*.rnnn)" value={fx.denoise.model} onCommit={(v) => change({ denoise: { ...fx.denoise!, model: v === null ? undefined : String(v) } })} />}
      {(fx.eq?.length || fx.pan !== undefined || fx.denoise) && <button type="button" onClick={() => setFx(null)}>重設聲音處理</button>}
      {processing && <p className="dim" role="status">processing audio…</p>}
      {error && <p className="error" role="alert">audio processing failed: {error}</p>}
    </div>
  );
}

/** §15.4: detect, clear, and fit a magnetic video track to this item's beats. B taps a beat at the playhead. */
export function BeatFields({ p, item }: { p: Project; item: AudioItem }) {
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
        <span>節拍密度</span>
        <select value={density} onChange={(e) => setDensity(e.target.value)}>
          {["all", "strong", "downbeat", "every:2", "every:4"].map((d) => <option key={d}>{d}</option>)}
        </select>
      </label>
      <div className="buttons">
        <button onClick={() => op("detectBeats", { itemId: item.id, density })}>偵測節拍</button>
        <button disabled={!item.beats?.length} onClick={() => op("clearBeats", { itemId: item.id })}>清除</button>
      </div>
      <label className="field">
        <span>要對齊節拍的軌道</span>
        <select value={trackId} onChange={(e) => setTrackId(e.target.value)}>
          {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <label className="field">
        <span>每隔幾拍切換</span>
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
export function AudioVolume({ p, item }: { p: Project; item: AudioItem | VideoItem }) {
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
