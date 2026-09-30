import { describe, expect, it } from "vitest";
import { maskStyle } from "../src/Composition.tsx";

const frame: [number, number] = [320, 180];
const base = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
const svgOf = (s: ReturnType<typeof maskStyle>) => decodeURIComponent(String(s.maskImage).slice('url("data:image/svg+xml,'.length, -2));

describe("maskStyle", () => {
  it("plain shapes are clip-paths in frame px, measured in the picture box", () => {
    expect(maskStyle({ shape: "rect", ...base }, frame, frame)).toEqual({ clipPath: "inset(36px 64px 36px 64px)" });
    expect(maskStyle({ shape: "rect", ...base, radius: 0.5 }, frame, frame)).toEqual({ clipPath: "inset(36px 64px 36px 64px round 54px)" });
    expect(maskStyle({ shape: "ellipse", ...base }, frame, frame)).toEqual({ clipPath: "ellipse(96px 54px at 160px 90px)" });
    expect(maskStyle({ shape: "diamond", ...base }, frame, frame)).toEqual({ clipPath: "polygon(160px 36px, 256px 90px, 160px 144px, 64px 90px)" });
    expect(maskStyle({ shape: "polygon", ...base, points: [[0, 0], [1, 0], [0.5, 1]] }, frame, frame)).toEqual({ clipPath: "polygon(64px 36px, 256px 36px, 160px 144px)" });
    expect((maskStyle({ shape: "star", ...base }, frame, frame).clipPath as string).match(/px \d/g)).toHaveLength(10);
    // a 160×90 picture centred in the frame: x=0 is the picture's left edge (80px), not the frame's
    expect(maskStyle({ shape: "rect", x: 0, y: 0, w: 1, h: 1 }, frame, [160, 90])).toEqual({ clipPath: "inset(45px 80px 45px 80px)" });
  });

  it("feather and invert become one SVG mask-image", () => {
    const feathered = maskStyle({ shape: "ellipse", ...base, feather: 20 }, frame, frame);
    expect(feathered.clipPath).toBeUndefined();
    expect(svgOf(feathered)).toContain('<feGaussianBlur stdDeviation="10"/>');
    expect(svgOf(feathered)).toContain('<ellipse cx="160" cy="90" rx="96" ry="54"/>');
    expect(svgOf(feathered)).not.toContain("<mask");
    const inverted = svgOf(maskStyle({ shape: "rect", ...base, invert: true }, frame, frame));
    expect(inverted).toContain('<mask id="m"><rect width="320" height="180" fill="#fff"/>');
    expect(inverted).not.toContain("feGaussianBlur");
  });
});
