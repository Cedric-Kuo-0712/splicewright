import type { Project, VideoItem } from "@splicewright/core";

/** Picture bounds at scale 1, shared by the player and editing tools. */
export function mediaBox(p: Project, item: VideoItem, size?: [number, number]) {
  const { width: W, height: H } = p.meta;
  const a = p.assets[item.assetId]?.rotation ?? 0;
  const rot = a + (item.transform?.rotation ?? 0);
  const [ew, eh] = Math.abs(rot % 180) === 90 ? [H, W] : [W, H];
  const [w, h] = size ?? [ew, eh];
  const s = (item.fit === "cover" ? Math.max : Math.min)(ew / w, eh / h);
  const [vw, vh] = [Math.min(ew, w * s), Math.min(eh, h * s)];
  const turn = ((Math.round(a / 90) % 4) + 4) % 4;
  return { ew, eh, vw, vh, rot, turn, display: (turn % 2 ? [vh, vw] : [vw, vh]) as [number, number] };
}

export type PipPreset = "tl" | "tr" | "bl" | "br" | "left" | "right" | "circle";

/** Shared PiP setProps patch; dimensions and placement match the player geometry. */
export function pip(p: Project, item: VideoItem, size: [number, number] | undefined, preset: PipPreset) {
  const { width: W, height: H } = p.meta;
  const [vw, vh] = mediaBox(p, item, size).display;
  if (preset === "circle") {
    const d = Math.min(vw, vh);
    const [w, h] = [d / vw, d / vh];
    return { mask: { shape: "ellipse" as const, x: (1 - w) / 2, y: (1 - h) / 2, w, h } };
  }
  const { mask, crop = {} } = item;
  const [rx, ry, rw, rh] = mask && !mask.invert
    ? [mask.x, mask.y, mask.w, mask.h]
    : [crop.left ?? 0, crop.top ?? 0, 1 - (crop.left ?? 0) - (crop.right ?? 0), 1 - (crop.top ?? 0) - (crop.bottom ?? 0)];
  const [bw, bh] = [rw * vw, rh * vh];
  const [ox, oy] = [(rx + rw / 2 - 0.5) * vw, (ry + rh / 2 - 0.5) * vh];
  const side = preset === "left" || preset === "right";
  const scale = side ? Math.min(W / 2 / bw, H / bh) : 0.3;
  const m = 0.04 * Math.min(W, H);
  const cx = side ? (preset === "left" ? -W / 4 : W / 4) : (preset.endsWith("l") ? -1 : 1) * (W / 2 - m - (scale * bw) / 2);
  const cy = side ? 0 : (preset.startsWith("t") ? -1 : 1) * (H / 2 - m - (scale * bh) / 2);
  const t = item.transform ?? {};
  return { transform: { ...t, x: +(cx - scale * ox).toFixed(2), y: +(cy - scale * oy).toFixed(2), scale: +scale.toFixed(4) } };
}
