import React, { useEffect, useRef, useState } from "react";
import { searchActions, type SearchAction, type SearchContext } from "./workspace-search.ts";
import { shortcutHint } from "./workspace-navigation.ts";

export function OperationSearch({ context, onLocate, onClose }: { context: SearchContext; onLocate: (action: SearchAction) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const results = searchActions(query, context);
  const current = Math.min(index, Math.max(0, results.length - 1));
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { dialog.current?.querySelector(`[data-search-index="${current}"]`)?.scrollIntoView({ block: "nearest" }); }, [current, query]);
  const locate = (i: number) => { const result = results[i]; if (result?.available) onLocate(result.action); };
  const onKey = (e: React.KeyboardEvent) => {
    // Transport shortcuts must never see keystrokes inside the search dialog.
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(results.length ? (current + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length : 0);
      input.current?.focus();
    }
    if (e.key === "Enter" && e.target === input.current) { e.preventDefault(); locate(current); }
    if (e.key === "Tab" && dialog.current) {
      const fields = [...dialog.current.querySelectorAll<HTMLElement>("input, button:not(:disabled)")];
      const first = fields[0], last = fields.at(-1);
      if (e.shiftKey && e.target === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && e.target === last) { e.preventDefault(); first?.focus(); }
    }
  };
  return <div className="search-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={dialog} className="operation-search" role="dialog" aria-modal="true" aria-labelledby="operation-search-title" onKeyDown={onKey}>
      <div className="search-heading"><h3 id="operation-search-title">搜尋操作</h3><button onClick={onClose} aria-label="關閉操作搜尋">關閉 · Esc</button></div>
      <p className="dim">輸入用途或技術名稱；選取結果會定位控制，不會直接修改內容。</p>
      <input ref={input} aria-label="搜尋用途或操作名稱" placeholder="例如：綠幕、放大、卡點、LUT" value={query} onChange={(e) => { setQuery(e.target.value); setIndex(0); }} onKeyDown={(e) => { if (e.key === "Enter" && e.nativeEvent.isComposing) e.stopPropagation(); }} />
      <p className="dim" role="status">{results.length} 項結果 · ↑↓ 選擇，Enter 定位</p>
      <div className="search-results">
        {results.map(({ action, available, reason }, i) => <div key={action.id} className={`search-result ${i === current ? "active" : ""}`} data-search-index={i}>
          <button disabled={!available} onFocus={() => setIndex(i)} onClick={() => locate(i)}>
            <span>{action.label}<small>{action.category}</small></span>
            {shortcutHint(action, /Mac/.test(navigator.platform), context) && <kbd>{shortcutHint(action, /Mac/.test(navigator.platform), context)}</kbd>}
          </button>
          {!available && <small className="unavailable">{reason}</small>}
        </div>)}
        {!results.length && <p className="dim">找不到符合的操作。試試「去背」「音量」或英文名稱。</p>}
      </div>
    </div>
  </div>;
}
