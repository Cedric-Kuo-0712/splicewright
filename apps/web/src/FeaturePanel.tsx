import React, { useEffect, useRef, useState } from "react";
import type { Project } from "@splicewright/core";
import { addSticker, addText } from "./edit.ts";
import { app, playhead } from "./store.ts";
import { MediaBin } from "./MediaBin.tsx";
import { Narration } from "./Narration.tsx";
import { OperationSearch } from "./OperationSearch.tsx";
import { actionAvailability, SEARCH_ACTIONS, WORKSPACE_CATEGORIES, type SearchAction, type WorkspaceCategory } from "./workspace-search.ts";
import { focusControl, searchContext, shortcutHint, type ControlLocation } from "./workspace-navigation.ts";

export function FeaturePanel({ p, category, location, onCategory, onLocate, readOnly = false }: { p: Project; category: WorkspaceCategory; location?: ControlLocation; onCategory: (category: WorkspaceCategory) => void; onLocate: (action: SearchAction) => void; readOnly?: boolean }) {
  const selection = app.use((s) => s.selection);
  const context = searchContext(p, selection);
  const [searchOpen, setSearchOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (location && root.current) focusControl(root.current, location.control); }, [location]);
  const images = Object.values(p.assets).filter((a) => a.kind === "image");
  const controls = SEARCH_ACTIONS.filter((a) => a.category === category && !a.destination);
  const closeSearch = () => { setSearchOpen(false); searchButton.current?.focus(); };
  return <aside inert={readOnly} className="feature-panel" ref={root} aria-label="功能分類">
    <nav className="feature-categories" aria-label="剪輯功能">
      {WORKSPACE_CATEGORIES.map((c) => <button key={c} className={category === c ? "on" : ""} aria-pressed={category === c} onClick={() => onCategory(c)}>{c}</button>)}
    </nav>
    <button ref={searchButton} className="operation-search-entry" onClick={() => setSearchOpen(true)}>搜尋操作…</button>
    <div className="feature-content">
      {category === "音訊" && <Narration p={p} readOnly={readOnly} />}
      <div hidden={category !== "素材" && category !== "音訊"}><MediaBin p={p} assetKind={category === "音訊" ? "audio" : undefined} /></div>
      {category === "文字" && <div className="feature-create"><h3>文字</h3><button data-ui-control="create-text" onClick={() => addText(playhead.get().frame)}>新增文字圖層 <kbd>T</kbd></button><p className="dim">在播放頭加入文字。選取現有文字或字幕後，可調整內容與樣式。</p></div>}
      {category === "貼紙" && <div className="feature-create" data-ui-control="create-sticker"><h3>圖片貼紙</h3><p className="dim">使用已匯入的圖片，加入可調整位置的貼紙圖層。</p>{images.map((a) => <button key={a.id} onClick={() => addSticker(a.id, playhead.get().frame)}>{a.path.split("/").pop()}</button>)}{!images.length && <p>請先到「素材」匯入圖片。</p>}</div>}
      {controls.length > 0 && <div className="feature-controls"><h3>{category === "音訊" ? "片段音訊調整" : `${category}控制`}</h3><p className="dim">選擇用途，直接定位右側控制。</p>{controls.map((a) => {
        const { available, reason } = actionAvailability(a, context);
        return <div className="feature-control" key={a.id}><button disabled={!available} onClick={() => onLocate(a)}>{a.label}{shortcutHint(a, /Mac/.test(navigator.platform), context) && <kbd>{shortcutHint(a, /Mac/.test(navigator.platform), context)}</kbd>}</button>{!available && <small>{reason}</small>}</div>;
      })}</div>}
    </div>
    {searchOpen && <OperationSearch context={context} onClose={closeSearch} onLocate={(a) => { setSearchOpen(false); onLocate(a); }} />}
  </aside>;
}
