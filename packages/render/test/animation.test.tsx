import { renderToStaticMarkup } from "react-dom/server";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import flubber from "flubber";
import { MorphPath, SketchPath } from "../src/animation.tsx";
import { projectAliases } from "../src/aliases.ts";
import { bundleProject } from "../src/node.ts";

describe("animation primitives", () => {
  it("generates the same rough path for a fixed seed and clamps draw progress", () => {
    const render = (progress: number) => renderToStaticMarkup(<svg><SketchPath d="M0 0 L100 0" progress={progress} /></svg>);
    const middle = render(0.5);
    expect(middle).toBe(render(0.5));
    expect(middle).toContain('stroke-dashoffset="0.5"');
    expect(render(0)).toContain('stroke-dashoffset="1"');
    expect(render(2)).toContain('stroke-dashoffset="0"');
    expect(render(2)).toBe(render(1));
    const filledStart = renderToStaticMarkup(<svg><SketchPath d="M0 0 L100 0 L100 100 Z" fill="red" progress={0} /></svg>);
    const filledEnd = renderToStaticMarkup(<svg><SketchPath d="M0 0 L100 0 L100 100 Z" fill="red" progress={1} /></svg>);
    expect(filledStart).not.toContain('fill="red"');
    expect(filledEnd).toContain('fill="red"');
    const hachure = renderToStaticMarkup(<svg><SketchPath d="M0 0 L100 0 L100 100 Z" fill="red" fillStyle="hachure" progress={0.5} /></svg>);
    expect(hachure).toContain('stroke="red"');
    expect(hachure).toContain('stroke-dashoffset="0.5"');
  });

  it("rejects seeds that make Rough.js geometry nondeterministic", () => {
    expect(() => renderToStaticMarkup(<svg><SketchPath d="M0 0 L10 10" seed={0} /></svg>))
      .toThrow("SketchPath seed must be an integer from 1 to 2147483647");
  });

  it("matches morph endpoints and clamps progress", () => {
    const from = "M0,0 L100,0 L100,100 Z";
    const to = "M0,0 C50,100 100,100 100,0 Z";
    const d = (progress: number) => renderToStaticMarkup(<MorphPath from={from} to={to} progress={progress} />).match(/ d="([^"]*)"/)?.[1];
    expect(d(0)).toBe(flubber.interpolate(from, to)(0));
    expect(d(1)).toBe(flubber.interpolate(from, to)(1));
    expect(d(-1)).toBe(d(0));
    expect(d(2)).toBe(d(1));
  });
});

it("resolves the animation subpath without changing the legacy config alias", () => {
  expect(projectAliases("/render/src", { existing: "/existing" })).toEqual({
    existing: "/existing",
    splicewright: "/render/src/config.ts",
    "splicewright/animation$": "/render/src/animation.tsx",
  });
});

it("bundles an external overlay importing splicewright/animation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-animation-bundle-"));
  mkdirSync(join(dir, ".splicewright"), { recursive: true });
  copyFileSync(join(import.meta.dirname, "../../cli/src/skills/splicewright-animation/assets/BoldTitle.tsx.template"), join(dir, "BoldTitle.tsx"));
  writeFileSync(join(dir, "splicewright.config.ts"), [
    'import { createElement } from "react";',
    'import { BoldTitle } from "./BoldTitle";',
    'import { SketchPath, MorphPath, Lottie, Arrow, Rect, Circle, Star, Callout } from "splicewright/animation";',
    'const Probe = () => createElement("svg", { viewBox: "0 0 100 100" }, createElement(SketchPath, { d: "M0 0 L100 100" }), createElement(MorphPath, { from: "M0 0L1 0L1 1Z", to: "M0 0H1V1H0Z", progress: 1 }));',
    'export default { components: { Probe, BoldTitle }, animationExports: [SketchPath, MorphPath, Lottie, Arrow, Rect, Circle, Star, Callout] };',
  ].join("\n"));
  try {
    expect(await bundleProject(dir)).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
