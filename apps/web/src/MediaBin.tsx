import React, { useEffect } from "react";
import { type Project } from "@splicewright/core";
import { addSticker, KEYS, openMenu, replaceWith, upload } from "./edit.ts";
import { app, dnd, op, playhead } from "./store.ts";


export function MediaBin({ p }: { p: Project }) {
  const uploads = app.use((s) => s.uploads);
  const ingesting = app.use((s) => s.ingesting);
  const reveal = app.use((s) => s.reveal);
  const [over, setOver] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!reveal) return;
    document.querySelector(`[data-asset="${reveal}"]`)?.scrollIntoView({ block: "nearest" });
    const t = setTimeout(() => app.set({ reveal: null }), 1500);
    return () => clearTimeout(t);
  }, [reveal]);
  const files = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
  return (
    <div
      className={`bin ${over ? "drop" : ""}`}
      onDragOver={(e) => files(e) && (e.preventDefault(), setOver(true))}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false)}
      onDrop={(e) => files(e) && (e.preventDefault(), setOver(false), upload([...e.dataTransfer.files]))}
    >
      <h3>
        Media{" "}
        <button onClick={() => input.current!.click()} title={`Import files into raw/ (or drop them here or on the timeline) (${KEYS.import})`}>
          Import…
        </button>
        <input ref={input} type="file" multiple hidden accept="video/*,audio/*,image/*,.cube" onChange={(e) => (upload([...e.currentTarget.files!]), (e.currentTarget.value = ""))} />
      </h3>
      {Object.values(p.assets).map((a) => (
        <div
          key={a.id}
          data-asset={a.id}
          className={`asset ${reveal === a.id ? "reveal" : ""}`}
          draggable={a.kind !== "lut"}
          onDragStart={(e) => { if (a.kind === "lut") return; e.dataTransfer.setData("application/x-splicewright-asset", a.id); dnd.assetId = a.id; }}
          onDragEnd={() => (dnd.assetId = null)}
          onContextMenu={(e) =>
            openMenu(e, [
              ...(a.kind === "lut"
                ? []
                : [
                    { label: "Insert at playhead", run: () => op("insertItem", { assetId: a.id, at: playhead.get().frame }) },
                    ...(a.kind === "image" ? [{ label: "Add as Sticker at playhead", run: () => addSticker(a.id, playhead.get().frame) }] : []),
                    { label: "Replace selected clip", run: () => replaceWith(a.id), disabled: app.get().selection.length !== 1 },
                    "-" as const,
                  ]),
              { label: "Remove from project (keeps file)", run: () => op("removeAsset", { assetId: a.id }) },
            ])
          }
          title={a.kind === "lut" ? `${a.id} — choose this LUT in the Color inspector` : `${a.id} — drag onto the timeline`}
        >
          {a.kind === "lut" ? <div className="thumb audio">LUT</div> : a.kind === "audio" ? <div className="thumb audio">♪</div> : <img className="thumb" src={`/api/thumb?asset=${a.id}&t=0`} alt="" draggable={false} />}
          <span>{a.path.split("/").pop()}</span>
          {ingesting[a.id] && <em className="badge">{ingesting[a.id]}…</em>}
        </div>
      ))}
      {uploads.map((name) => (
        <div key={name} className="asset pending">
          <div className="thumb">⇪</div>
          <span>{name}</span>
          <em className="badge">uploading…</em>
        </div>
      ))}
      {!Object.keys(p.assets).length && !uploads.length && <p className="dim">No assets yet. Drop files here or use Import….</p>}
    </div>
  );
}
