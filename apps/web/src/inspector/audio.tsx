import React from "react";
import { beatFrames, valueAt, withKey, type AudioItem, type Project, type VideoItem } from "@splicewright/core";
import { app, ioRange, op, playhead } from "../store.ts";
import { KeyButton, Slider } from "./fields.tsx";


/** Asset LUFS, Normalize to −14 (disabled on the same grounds normalizeLoudness refuses), and the project-wide render limiter. */
export function LoudnessFields({ p, item }: { p: Project; item: AudioItem | VideoItem }) {
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
export function AudioVolume({ p, item }: { p: Project; item: AudioItem }) {
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

