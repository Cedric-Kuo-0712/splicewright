import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { init, run } from "@splicewright/core/node";
import { still } from "../src/node.ts";

const pixel = (png: string, x: number, y: number) => {
  const rgb = execFileSync("ffmpeg", ["-loglevel", "error", "-i", png, "-vf", `crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  return [...rgb];
};

it("renders keyed overlay translation at the selected frame", { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-overlay-keyframes-"));
  init(dir, { title: "overlay keys", fps: 30, width: 32, height: 18 });
  mkdirSync(join(dir, "raw"), { recursive: true });
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=8x8", "-frames:v", "1", "-y", join(dir, "raw", "red.png")]);
  expect(run(dir, "importAsset", { path: "raw/red.png" })).not.toHaveProperty("error");
  expect(run(dir, "insertItem", { component: "Image", props: { src: "raw/red.png" }, at: 0, duration: 60 })).not.toHaveProperty("error");
  expect(run(dir, "setKeyframe", { itemId: "i_1", prop: "x", at: 0, value: 0 })).not.toHaveProperty("error");
  expect(run(dir, "setKeyframe", { itemId: "i_1", prop: "x", at: 30, value: 12 })).not.toHaveProperty("error");
  const a = join(dir, "a.png"), b = join(dir, "b.png");
  await still(dir, 0, a);
  await still(dir, 30, b);
  expect(pixel(a, 9, 8)[0]).toBeGreaterThan(180);
  expect(pixel(b, 9, 8)[0]).toBeLessThan(40);
});

it("renders interpolated Color and a discrete LUT switch on video frames", { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-color-keyframes-"));
  init(dir, { title: "grade keys", fps: 30, width: 32, height: 18 });
  mkdirSync(join(dir, "raw"), { recursive: true });
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x404040:s=32x18", "-frames:v", "1", "-y", join(dir, "raw", "gray.png")]);
  const identity = Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`).join("\n");
  writeFileSync(join(dir, "raw", "identity.cube"), `LUT_3D_SIZE 2\n${identity}\n`);
  writeFileSync(join(dir, "raw", "white.cube"), `LUT_3D_SIZE 2\n${Array.from({ length: 8 }, () => "1 1 1").join("\n")}\n`);
  expect(run(dir, "importAsset", { path: "raw/gray.png" })).not.toHaveProperty("error");
  expect(run(dir, "importAsset", { path: "raw/identity.cube" })).not.toHaveProperty("error");
  expect(run(dir, "importAsset", { path: "raw/white.cube" })).not.toHaveProperty("error");
  expect(run(dir, "insertItem", { assetId: "a_gray", at: 0, duration: 60 })).not.toHaveProperty("error");
  expect(run(dir, "setProps", { itemId: "i_1", patch: { grade: { exposure: 0, lut: { assetId: "a_identity", strength: 1 } } } })).not.toHaveProperty("error");
  expect(run(dir, "setKeyframe", { itemId: "i_1", prop: "exposure", at: 0, value: 0 })).not.toHaveProperty("error");
  expect(run(dir, "setKeyframe", { itemId: "i_1", prop: "exposure", at: 15, value: 2 })).not.toHaveProperty("error");
  expect(run(dir, "setKeyframe", { itemId: "i_1", prop: "exposure", at: 30, value: 0 })).not.toHaveProperty("error");
  expect(run(dir, "setLutKeyframe", { itemId: "i_1", at: 30, assetId: "a_white" })).not.toHaveProperty("error");
  const frames = [0, 15, 30];
  const pixels = [];
  for (const frame of frames) {
    const png = join(dir, `f${frame}.png`);
    await still(dir, frame, png);
    pixels.push(pixel(png, 16, 9));
  }
  expect(pixels[0][0]).toBeGreaterThan(40);
  expect(pixels[1][0]).toBeGreaterThan(pixels[0][0] + 60); // exposure key is interpolated at the midpoint
  expect(pixels[2][0]).toBeGreaterThan(240); // LUT switch selects the all-white table at frame 30
});
