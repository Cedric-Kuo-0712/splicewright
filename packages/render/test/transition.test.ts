import { describe, expect, it } from "vitest";
import type { Project, VideoItem } from "@splicewright/core";
import { look, pip } from "../src/Composition.tsx";

// Two touching 100-frame items; frame 100 is the cut, so with a 30-frame transition (15 + 15) it is t = 0.5 for both.
// Outgoing side: the cut is item end, frame 200.
const item = { id: "i_1", start: 100, duration: 100, assetId: "a", sourceIn: 0 } as VideoItem;
const tr = (kind: string, direction?: string) => ({ kind, direction, before: 15, after: 15, next: item }) as never;
const DIRS = ["left", "right", "up", "down"] as const;

describe("look", () => {
  it("dissolve, dip and zoom at t = 0.5", () => {
    expect(look(item, 100, tr("dissolve"))).toMatchObject({ opacity: 0.5, gain: 0.5, dx: 0, dy: 0, zoom: 1 });
    expect(look(item, 200, undefined, tr("dissolve"))).toMatchObject({ opacity: 1, gain: 0.5 }); // outgoing stays put
    expect(look(item, 100, tr("zoom"))).toMatchObject({ opacity: 0.5, gain: 0.5, zoom: 1.125 });
    expect(look(item, 200, undefined, tr("zoom"))).toMatchObject({ opacity: 1, gain: 0.5, zoom: 1.125 });
    expect(look(item, 100, tr("dip"))).toMatchObject({ bright: 0, gain: 0, zoom: 1 });
  });

  it("wipe reveals from the entry side; left is the old string", () => {
    const clip = (d?: string) => look(item, 100, tr("wipe", d)).clip;
    expect(clip()).toBe("inset(0 50% 0 0)");
    expect(DIRS.map(clip)).toEqual(["inset(0 50% 0 0)", "inset(0 0 0 50%)", "inset(0 0 50% 0)", "inset(50% 0 0 0)"]);
    expect(look(item, 100, tr("wipe")).gain).toBe(0.5);
  });

  it("slide moves the incoming item in from its side; push also moves the outgoing one out", () => {
    const off = (kind: string, d: string, side: "inc" | "out") => {
      const l = side === "inc" ? look(item, 100, tr(kind, d)) : look(item, 200, undefined, tr(kind, d));
      return [l.dx + 0, l.dy + 0]; // + 0 turns -0 into 0
    };
    expect(DIRS.map((d) => off("slide", d, "inc"))).toEqual([[-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5]]);
    expect(DIRS.map((d) => off("push", d, "inc"))).toEqual([[-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5]]);
    expect(DIRS.map((d) => off("push", d, "out"))).toEqual([[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]]);
    expect(DIRS.map((d) => off("slide", d, "out"))).toEqual(DIRS.map(() => [0, 0]));
    expect(look(item, 85, tr("slide", "left"))).toMatchObject({ dx: -1, gain: 0 }); // starts fully off-screen
    expect(look(item, 115, tr("slide", "left"))).toMatchObject({ dx: 0, gain: 1 }); // lands
  });
});

describe("pip", () => {
  const p = { meta: { width: 320, height: 180, fps: 30 }, assets: { a: { id: "a", kind: "video", path: "a.mp4" } } } as unknown as Project;
  const at = (it: Partial<VideoItem>, preset: Parameters<typeof pip>[3], size: [number, number] = [320, 180]) => pip(p, { ...item, ...it }, size, preset);
  const tf = (r: ReturnType<typeof pip>) => ("transform" in r ? r.transform : undefined)!;

  it("corners: 0.3 scale, 4% margin from the frame edges", () => {
    // margin 7.2px; the 96×54 picture's centre sits 7.2 + 48 / 27 from the corner
    for (const [preset, sx, sy] of [["tl", -1, -1], ["tr", 1, -1], ["bl", -1, 1], ["br", 1, 1]] as const) {
      const t = tf(at({}, preset));
      expect(t.scale).toBe(0.3);
      expect(t.x).toBeCloseTo(sx * 104.8, 1);
      expect(t.y).toBeCloseTo(sy * 55.8, 1);
    }
  });

  it("side by side fills a half, centred, and keeps other transform fields", () => {
    expect(tf(at({}, "left"))).toEqual({ x: -80, y: 0, scale: 0.5 });
    expect(tf(at({}, "right"))).toEqual({ x: 80, y: 0, scale: 0.5 });
    expect(tf(at({ transform: { opacity: 0.5, rotation: 0, scale: 2, x: 9 } }, "tl"))).toMatchObject({ opacity: 0.5, rotation: 0, scale: 0.3 });
  });

  it("circle masks the picture box to its short side and leaves the transform alone", () => {
    const r = at({}, "circle");
    expect(r).toEqual({ mask: { shape: "ellipse", x: 0.21875, y: 0, w: 0.5625, h: 1 } });
    // a 100×200 portrait picture in the 320×180 frame shows as 90×180; d = 90
    const m = (at({}, "circle", [100, 200]) as { mask: { w: number; h: number } }).mask;
    expect(m.w).toBeCloseTo(1);
    expect(m.h).toBeCloseTo(0.5);
  });

  it("corners position the visible region: mask box, else crop box", () => {
    // mask on the picture's bottom-right quarter (160×90): its top-left corner must land at (7.2, 7.2) from the frame's
    const masked = tf(at({ mask: { shape: "rect", x: 0.5, y: 0.5, w: 0.5, h: 0.5 } }, "tl"));
    expect(masked.x).toBeCloseTo(-152.8, 1); // left edge: x + 0.3 * 0 (mask left is the picture centre)
    expect(masked.y).toBeCloseTo(-82.8, 1);
    // an inverted mask shows the outside of its box, so the whole picture is placed
    expect(tf(at({ mask: { shape: "rect", x: 0.5, y: 0.5, w: 0.5, h: 0.5, invert: true } }, "tl"))).toMatchObject(tf(at({}, "tl")));
    const cropped = tf(at({ crop: { left: 0.5, top: 0.5 } }, "br"));
    expect(cropped.x).toBeCloseTo(160 - 7.2 - 0.3 * 80 - 0.3 * 80, 1); // right edge at 7.2 from the frame's
    expect(cropped.y).toBeCloseTo(90 - 7.2 - 0.3 * 45 - 0.3 * 45, 1);
  });
});
