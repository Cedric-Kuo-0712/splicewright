import React, { useEffect, useRef, useState } from "react";
import { focusControl, type ControlLocation } from "../workspace-navigation.ts";
import { anchorOf, formatFrame, itemSpan, type AudioItem, type OverlayItem, type Project, type VideoItem } from "@splicewright/core";
import { findItem, copyStyle, pasteStyle } from "../edit.ts";
import { app, op } from "../store.ts";
import { Field, PropsField } from "./fields.tsx";
import { TextFields, CaptionStyleFields, ThemeField } from "./text.tsx";
import { LoudnessFields, BeatFields, AudioVolume } from "./audio.tsx";
import { VideoFields, MaskFields } from "./video.tsx";
import { StickerFields } from "./sticker.tsx";
import { OverlayFields } from "./overlay.tsx";

function StyleActions() {
  const selection = app.use((s) => s.selection);
  return (
    <div className="buttons style-actions">
      <button disabled={selection.length !== 1} onClick={copyStyle} title="複製視覺樣式；不包含內容、時間、來源與位置">複製樣式</button>
      <button onClick={pasteStyle} title="套用到相容且未鎖定的選取項目；一次復原">套用樣式</button>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return <section className="inspector-section" data-inspector-section={id} tabIndex={-1}><h4>{title}</h4>{children}</section>;
}

export function Inspector({ p, location }: { p: Project; location?: ControlLocation }) {
  const selection = app.use((s) => s.selection);
  const live = app.use((s) => s.live);
  const found = selection.length === 1 ? findItem(p, selection[0]) : null;
  const root = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"selection" | "project">(location?.section === "project" ? "project" : "selection");
  const processed = useRef<number | undefined>(undefined);
  const selectedIds = selection.join(",");
  const lastSelection = useRef(selectedIds);
  useEffect(() => {
    if (lastSelection.current !== selectedIds) { lastSelection.current = selectedIds; setMode("selection"); }
  }, [selectedIds]);
  useEffect(() => {
    if (!location || processed.current === location.serial) return;
    const next = location.section === "project" ? "project" : "selection";
    if (mode !== next) { setMode(next); return; }
    if (root.current && focusControl(root.current, location.control)) processed.current = location.serial;
  }, [location, mode, selectedIds]);
  const tabs = <div className="inspector-tabs">
    <button aria-pressed={mode === "selection"} className={mode === "selection" ? "on" : ""} onClick={() => setMode("selection")}>選取內容</button>
    <button aria-pressed={mode === "project"} className={mode === "project" ? "on" : ""} onClick={() => setMode("project")}>專案設定</button>
  </div>;
  if (mode === "project") return <div className="inspector" ref={root}>{tabs}<Section id="project" title="專案設定"><div data-ui-control="project"><ThemeField p={p} /></div></Section></div>;
  if (!found) return (
    <div className="inspector" ref={root}>{tabs}
      <h3>{selection.length ? "多重選取" : "專案設定"}</h3>
      {selection.length ? <>
        <p className="scope-label">已選取 {selection.length} 個項目</p>
        <p className="dim">只有相容的樣式操作可套用到多重選取。</p>
        <Section id="basic" title="基本"><StyleActions /></Section>
      </> : <>
        <p className="dim">目前沒有選取項目。選取時間軸上的片段後，可在右側調整對應內容。</p>
        <Section id="basic" title="基本"><div data-ui-control="project"><ThemeField p={p} /></div></Section>
      </>}
    </div>
  );

  const { track: t, item } = found;
  const set = (patch: Record<string, unknown>) => op("setProps", { itemId: item.id, patch });
  const span = itemSpan(p, item);
  const fps = p.meta.fps;
  const isOverlay = "component" in item;
  const isStill = t.kind === "video" && "assetId" in item && p.assets[item.assetId]?.kind === "image";
  const liveItem = live?.itemId === item.id ? { ...item, ...live.patch } : item;
  const hasScreen = t.kind === "video" || isOverlay;
  const hasAudio = t.kind === "audio" || t.kind === "video" && !isStill;
  const hasText = t.kind === "caption" || isOverlay && item.component === "Text";
  return (
    <div className="inspector" ref={root}>{tabs}
      <h3>{item.id} <span className="dim">{t.name}</span></h3>
      <p className="scope-label">{t.kind === "caption" ? "字幕軌道樣式與單句文字" : "正在編輯單一項目"}</p>
      {t.locked && <p className="dim">此軌道已鎖定，控制項目前停用。</p>}
      <StyleActions />
      <Section id="basic" title="基本">
        <fieldset className="inspector-fields" disabled={t.locked}>
          {span && <>
            <p className="dim">{formatFrame(span.start, fps)} → {formatFrame(span.start + span.duration, fps)}（{span.duration} 格）{anchorOf(item) ? " · 已錨定" : ""}</p>
            <Field control="start" label="開始位置（格）" type="number" value={span.start} onCommit={(v) => v !== null && op("move", { itemId: item.id, to: Math.round(Number(v)) })} />
            <Field control="duration" label="長度（格）" type="number" value={span.duration} onCommit={(v) => v !== null && op("trim", { itemId: item.id, edge: "end", to: span.start + Math.round(Number(v)) })} />
          </>}
          {"mode" in item ? <></> : <>
            <Field label="名稱" value={item.label} onCommit={(v) => set({ label: v })} />
            <Field label="備註" value={item.note} onCommit={(v) => set({ note: v })} />
          </>}
        </fieldset>
      </Section>
      {hasScreen && <Section id="screen" title="畫面">
        <fieldset className="inspector-fields" disabled={t.locked}>
          {t.kind === "video" && "assetId" in item && <VideoFields p={p} item={liveItem as VideoItem} fps={fps} still={isStill} set={set} />}
          {isOverlay && <>
            <MaskFields p={p} item={liveItem as OverlayItem} set={set} />
            {item.component === "Sticker" && <StickerFields p={p} item={item} set={set} />}
            <OverlayFields p={p} item={item} set={set} />
          </>}
        </fieldset>
      </Section>}
      {hasAudio && <Section id="audio" title="音訊">
        <fieldset className="inspector-fields" disabled={t.locked}>
          <AudioVolume p={p} item={liveItem as AudioItem | VideoItem} />

          {"sourceIn" in item && <>
            <Field control="fade-in" label="淡入（格）" type="number" value={item.fadeIn} onCommit={(v) => set({ fadeIn: v })} />
            <Field control="fade-out" label="淡出（格）" type="number" value={item.fadeOut} onCommit={(v) => set({ fadeOut: v })} />
          </>}
          {t.kind === "audio" && <div data-ui-control="beats"><BeatFields p={p} item={item as AudioItem} /></div>}
          {(t.kind === "audio" || t.kind === "video") && "assetId" in item && <LoudnessFields p={p} item={item as AudioItem | VideoItem} />}
        </fieldset>
      </Section>}
      {hasText && <Section id="text" title="文字與樣式">
        <fieldset className="inspector-fields" disabled={t.locked}>
          {"mode" in item ? <>
            <Field control="text" label="文字內容" value={item.text} onCommit={(v) => op("editCaption", { captionId: item.id, text: v ?? "" })} />
            {t.kind === "caption" && <CaptionStyleFields t={t} text={item.text} />}
          </> : "component" in item && item.component === "Text" && <TextFields p={p} item={item} set={set} />}
        </fieldset>
      </Section>}
      {isOverlay && <details className="advanced" data-ui-control="advanced" data-inspector-section="advanced" tabIndex={-1}>
        <summary>進階參數</summary>
        <fieldset className="inspector-fields" disabled={t.locked}>
          <p className="dim">原始元件屬性；一般調整請使用上方控制項。</p>
          <PropsField value={item.props} onCommit={(props) => set({ props })} />
        </fieldset>
      </details>}
    </div>
  );
}
