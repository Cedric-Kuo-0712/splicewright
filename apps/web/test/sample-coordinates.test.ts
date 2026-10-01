import { expect, it } from "vitest";
import { mapSamplePoint, multiplyMatrix, sampledRgb } from "../src/sample-coordinates.ts";

const canvas = { width: 200, height: 100, clientWidth: 200, clientHeight: 100 };
const identity = { a: 1, b: 0, c: 0, d: 1 };

it("maps scaled preview coordinates back to source pixels", () => {
  const pixel = mapSamplePoint({ point: { x: 280, y: 120 }, rect: { left: 0, top: 0, width: 400, height: 200 }, canvas, fit: "contain", transform: identity }, 2);
  expect(pixel).toEqual({ x: 140, y: 60 });
});

it("inverts an item rotation around its center", () => {
  const pixel = mapSamplePoint({ point: { x: 125, y: 100 }, rect: { left: 50, top: -50, width: 100, height: 200 }, canvas, fit: "contain", transform: { a: 0, b: 1, c: -1, d: 0 } });
  expect(pixel).toEqual({ x: 150, y: 25 });
});

it("accounts for contain letterboxing and cover cropping", () => {
  const contain = mapSamplePoint({ point: { x: 100, y: 20 }, rect: { left: 0, top: 0, width: 200, height: 200 }, canvas: { ...canvas, clientHeight: 200 }, fit: "contain", transform: identity });
  expect(contain).toBeNull();
  const cover = mapSamplePoint({ point: { x: 100, y: 0 }, rect: { left: 0, top: 0, width: 200, height: 50 }, canvas: { ...canvas, clientHeight: 50 }, fit: "cover", transform: identity });
  expect(cover).toEqual({ x: 100, y: 25 });
});

it("composes an item's rotation with an ancestor zoom", () => {
  const combined = multiplyMatrix({ a: 2, b: 0, c: 0, d: 2 }, { a: 0, b: 1, c: -1, d: 0 });
  const pixel = mapSamplePoint({ point: { x: 200, y: 300 }, rect: { left: 50, top: 0, width: 200, height: 400 }, canvas, fit: "contain", transform: combined });
  expect(pixel).toEqual({ x: 150, y: 25 });
});

it("unpremultiplies sampled WebGL colors and ignores fully transparent pixels", () => {
  expect(sampledRgb([64, 32, 16, 128], true)).toEqual([128, 64, 32]);
  expect(sampledRgb([64, 32, 16, 128], false)).toEqual([64, 32, 16]);
  expect(sampledRgb([0, 0, 0, 0], true)).toBeNull();
});
