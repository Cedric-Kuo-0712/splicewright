import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, createProject, type Ctx, type OpResult, type Project, type VideoItem } from "../src/index.ts";
import { Project as ProjectSchema, validate } from "../src/index.ts";
import { load, redo, run, undo } from "../src/persistence.ts";

const ctx: Ctx = { assetDurations: { a_clip: 10 } };
const ok = (result: OpResult): Project => {
  if ("error" in result) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.project;
};

it("preserves all four media features through project serialization and asset dependency checks", () => {
  let project = createProject({ title: "all media features", fps: 30, width: 320, height: 180 });
  for (const path of ["raw/clip.mp4", "raw/sticker.gif", "raw/brand.woff2"])
    project = ok(apply(project, "importAsset", { path }, ctx));
  project = ok(apply(project, "insertItem", { assetId: "a_clip", at: 0, duration: 90, sourceIn: 2 }, ctx));
  project = ok(apply(project, "setProps", { itemId: "i_1", patch: { reverse: true, audioFx: { pan: -1 } } }, ctx));
  project = ok(apply(project, "insertItem", { component: "Sticker", props: { src: "raw/sticker.gif", fit: "contain" }, at: 0, duration: 90 }, ctx));
  project = ok(apply(project, "insertItem", { component: "Text", props: { text: "brand", textStyle: { font: "a_brand" } }, at: 0, duration: 90 }, ctx));
  const restored = ProjectSchema.parse(JSON.parse(JSON.stringify(project)));
  expect(restored).toEqual(project);
  expect(validate(restored, undefined, ctx)).toEqual([]);
  for (const assetId of ["a_clip", "a_sticker", "a_brand"])
    expect(apply(restored, "removeAsset", { assetId }, ctx)).toHaveProperty("error.code", "invalid");
});

it("splitting a reversed clip with audio processing preserves its source intervals and processing", () => {
  let project = createProject({ title: "combined media", fps: 30, width: 320, height: 180 });
  project = ok(apply(project, "importAsset", { path: "raw/clip.mp4" }, ctx));
  project = ok(apply(project, "insertItem", { assetId: "a_clip", at: 0, duration: 90, sourceIn: 2 }, ctx));
  const audioFx = { eq: [{ hz: 1000, gain: -12 }], pan: -1, denoise: { kind: "fft" } };
  project = ok(apply(project, "setProps", { itemId: "i_1", patch: { reverse: true, speed: 2, audioFx } }, ctx));
  project = ok(apply(project, "split", { itemId: "i_1", at: 30 }, ctx));
  const [left, right] = project.tracks[0].items as VideoItem[];
  // Original interval [2,8) plays backwards: left [6,8), then right [2,6).
  expect(left).toMatchObject({ start: 0, duration: 30, sourceIn: 6, speed: 2, reverse: true, audioFx });
  expect(right).toMatchObject({ start: 30, duration: 60, sourceIn: 2, speed: 2, reverse: true, audioFx });
});

it("undo and redo restore a combined reverse/audioFx edit in one history step", () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-media-history-"));
  try {
    mkdirSync(join(dir, ".splicewright"));
    writeFileSync(join(dir, "project.json"), JSON.stringify(createProject({ title: "history", fps: 30, width: 320, height: 180 })));
    writeFileSync(join(dir, ".splicewright", "assets.json"), JSON.stringify({ a_clip: { duration: 10 } }));
    ok(run(dir, "importAsset", { path: "raw/clip.mp4" }));
    ok(run(dir, "insertItem", { assetId: "a_clip", at: 0, duration: 90, sourceIn: 2 }));
    const before = load(dir).tracks[0].items[0];
    const patch = { reverse: true, audioFx: { pan: -1, eq: [{ hz: 1000, gain: -12 }] } };
    ok(run(dir, "setProps", { itemId: "i_1", patch }));
    expect(load(dir).tracks[0].items[0]).toMatchObject(patch);
    ok(undo(dir));
    expect(load(dir).tracks[0].items[0]).toEqual(before);
    ok(redo(dir));
    expect(load(dir).tracks[0].items[0]).toMatchObject(patch);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
