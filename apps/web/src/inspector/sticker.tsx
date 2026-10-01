import type { OverlayItem, Project } from "@splicewright/core";

/** Image source and fit controls for the built-in Sticker overlay. */
export function StickerFields({ p, item, set }: { p: Project; item: OverlayItem; set: (patch: Record<string, unknown>) => void }) {
  const props = item.props as { src?: string; fit?: "contain" | "cover" };
  const images = Object.values(p.assets).filter((asset) => asset.kind === "image");
  const put = (next: Record<string, unknown>) => set({ props: { ...props, ...next } });
  return (
    <>
      <label className="field">
        <span>image</span>
        <select value={props.src ?? ""} onChange={(e) => put({ src: e.target.value })}>
          <option value="" disabled>Choose imported image</option>
          {images.map((asset) => <option key={asset.id} value={asset.path}>{asset.path.split("/").pop()}</option>)}
        </select>
      </label>
      <label className="field">
        <span>fit</span>
        <select value={props.fit ?? "contain"} onChange={(e) => put({ fit: e.target.value })}>
          <option value="contain">contain</option>
          <option value="cover">cover</option>
        </select>
      </label>
    </>
  );
}
