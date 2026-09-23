import { createProject, type Project } from "@splicewright/core";
import { expect, it } from "vitest";
import { duckGain, duckRanges } from "../src/duck.ts";

it("maps speech in visible source ranges to timeline frames", () => {
  const p: Project = createProject({ title: "t", fps: 10, width: 64, height: 36 });
  p.assets.a_v = { id: "a_v", path: "v.mp4", kind: "video" };
  p.assets.a_m = { id: "a_m", path: "m.mp3", kind: "audio" };
  // Clip plays source 2s..5s at timeline frame 10.
  p.tracks[0].items.push({ id: "i_v", assetId: "a_v", sourceIn: 2, start: 10, duration: 30 } as never);
  p.tracks[1].items.push({ id: "i_m", assetId: "a_m", sourceIn: 0, start: 0, duration: 100, duck: { under: ["t_1"], level: 0.2 } } as never);
  const segs = [{ start: 0, end: 1, text: "cut" }, { start: 1.5, end: 3, text: "head" }, { start: 4, end: 9, text: "tail" }];
  expect(duckRanges(p, { transcript: () => segs })).toEqual({ i_m: [[10, 20], [30, 40]] });
});

it("ducks inside speech and ramps back outside", () => {
  const r: [number, number][] = [[10, 20]];
  expect(duckGain(15, r, 0.2)).toBe(0.2);
  expect(duckGain(19, r, 0.2)).toBe(0.2);
  expect(duckGain(20, r, 0.2)).toBeCloseTo(0.2 + 0.8 / 6);
  expect(duckGain(40, r, 0.2)).toBe(1);
  expect(duckGain(5, [], 0.2)).toBe(1);
});
