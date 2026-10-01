import { anchorOf, formatFrame, itemSpan, type AudioItem, type OverlayItem, type Project, type VideoItem } from "@splicewright/core";
import { findItem } from "../edit.ts";
import { app, op } from "../store.ts";
import { Field, PropsField } from "./fields.tsx";
import { TextFields, CaptionStyleFields, ThemeField } from "./text.tsx";
import { LoudnessFields, BeatFields, AudioVolume } from "./audio.tsx";
import { VideoFields, MaskFields } from "./video.tsx";


export function Inspector({ p }: { p: Project }) {
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

