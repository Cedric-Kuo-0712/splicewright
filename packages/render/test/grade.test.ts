import { expect, it } from "vitest";
import { curveTable, curveTexture } from "../src/grade-effect.ts";

it("builds one 256x1 RGBA curve texture with identity defaults", () => {
  const data = curveTexture({});
  expect(data).toHaveLength(256 * 4);
  expect([...data.filter((_, i) => i % 4 === 0)]).toEqual(Array.from({ length: 256 }, (_, i) => i));
  expect([...data.filter((_, i) => i % 4 === 3)]).toEqual(Array.from({ length: 256 }, (_, i) => i));
});

it("clamps endpoints and keeps rising/falling curve segments shape preserving", () => {
  const descending = curveTable([[0.2, 1], [0.8, 0]]);
  expect(descending[0]).toBe(1);
  expect(descending[255]).toBe(0);
  for (let i = 1; i < 256; i++) expect(descending[i]).toBeLessThanOrEqual(descending[i - 1]);
  const valley = curveTable([[0, 0.2], [0.5, 0.8], [1, 0.1]]);
  const peak = valley.indexOf(Math.max(...valley));
  for (let i = 0; i < peak; i++) expect(valley[i]).toBeLessThanOrEqual(valley[i + 1]);
  for (let i = peak; i < 255; i++) expect(valley[i]).toBeGreaterThanOrEqual(valley[i + 1]);
  const uneven = curveTable([[0, 0], [0.01, 0.8], [0.9, 0.82], [1, 1]]);
  for (let i = 0; i < 255; i++) {
    const x = i / 255;
    const segment = x < 0.01 ? [0, 0.8] : x < 0.9 ? [0.8, 0.82] : [0.82, 1];
    expect(uneven[i]).toBeGreaterThanOrEqual(segment[0] - 1 / 255);
    expect(uneven[i]).toBeLessThanOrEqual(segment[1] + 1 / 255);
  }
});
