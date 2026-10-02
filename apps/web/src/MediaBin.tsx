import React, { useEffect } from "react";
import { type Project } from "@splicewright/core";
import { addSticker, KEYS, openMenu, replaceWith, upload } from "./edit.ts";
import { app, dnd, op, playhead, refresh } from "./store.ts";

type Material = { path: string; assetId?: string; health: string; errors?: string[]; measurement?: { decode: { status: string }; audio: { status: string; samplePeak?: { dbfs: number | null }; truePeak?: { dbfs: number | null } } } };


export function MediaBin({ p }: { p: Project }) {
  const uploads = app.use((s) => s.uploads);
  const ingesting = app.use((s) => s.ingesting);
  const reveal = app.use((s) => s.reveal);
  const [over, setOver] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  const [materials, setMaterials] = React.useState<Material[] | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const [relink, setRelink] = React.useState<{ assetId: string; path: string; acceptChanged: boolean } | null>(null);
  const scan = async () => {
    setScanning(true);
    try {
      const response = await fetch("/api/materials/scan"), data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error?.message ?? "Material scan failed");
      setMaterials(data.materials);
    } catch (error) { app.set({ message: { text: String(error), error: true } }); }
    finally { setScanning(false); }
  };
  const prepare = async (path: string) => {
    setScanning(true);
    try {
      const response = await fetch("/api/materials/prepare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: [path] }) });
      const data = await response.json();
      if (!response.ok || data.error || data.errors?.length) throw new Error(data.error?.message ?? data.errors?.join("; ") ?? "Preparation failed");
      await refresh();
    } catch (error) { app.set({ message: { text: String(error), error: true } }); }
    finally { await scan(); }
  };
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
        <button disabled={scanning} onClick={() => void scan()} title="Explicit source scan; never starts agent analysis">{scanning ? "Scanning…" : "Scan sources"}</button>
        <button onClick={() => input.current!.click()} title={`Import files into raw/ (or drop them here or on the timeline) (${KEYS.import})`}>
          Import…
        </button>
        <input ref={input} type="file" multiple hidden accept="video/*,audio/*,image/*,.cube" onChange={(e) => (upload([...e.currentTarget.files!]), (e.currentTarget.value = ""))} />
      </h3>
      {materials && <div aria-label="Source health">
        {materials.map((material) => <div key={material.path} className="material-health">
          <span title={material.errors?.join("; ")}>{material.path}: {material.health} · source decode {material.measurement?.decode.status ?? "unmeasured"} · audio {material.measurement?.audio.status ?? "unmeasured"}{material.measurement?.audio.status === "measured" && ` · sample ${material.measurement.audio.samplePeak?.dbfs ?? "silent"} / true ${material.measurement.audio.truePeak?.dbfs ?? "silent"} dBFS`}</span>
          {material.health !== "missing" && <button disabled={scanning} onClick={() => void prepare(material.path)} title="Register and prepare thumbnails, waveform and loudness; no agent analysis">Prepare</button>}
          {material.assetId && <button onClick={() => setRelink({ assetId: material.assetId!, path: "raw/", acceptChanged: false })}>Relink…</button>}
        </div>)}
      </div>}
      {relink && <form aria-label="Relink source" onSubmit={async (event) => {
        event.preventDefault();
        if (await op("relinkAsset", relink)) { setRelink(null); await scan(); }
      }}>
        <label>Replacement in raw/ <input value={relink.path} onChange={(event) => setRelink({ ...relink, path: event.target.value })} /></label>
        <label><input type="checkbox" checked={relink.acceptChanged} onChange={(event) => setRelink({ ...relink, acceptChanged: event.target.checked })} />Accept different or unknown content (ranges must fit)</label>
        <button type="submit">Relink source</button><button type="button" onClick={() => setRelink(null)}>Cancel</button>
      </form>}
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
