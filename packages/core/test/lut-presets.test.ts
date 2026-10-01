import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { LUT_PRESETS, parseCube, type VideoItem } from "../src/index.ts";
import { applyLutPreset, historyList, init, load, loadCtx, run, undo } from "../src/persistence.ts";

const makeProject = () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-lut-preset-"));
  init(dir, { title: "t", fps: 30, width: 640, height: 360 });
  run(dir, "importAsset", { path: "raw/clip.mp4" });
  run(dir, "insertItem", { assetId: "a_clip", at: 0, duration: 30 });
  return dir;
};

it("ships a complete parseable preset catalog with source licenses and stable IDs", { timeout: 30_000 }, () => {
  expect(LUT_PRESETS.length).toBe(14);
  expect(new Set(LUT_PRESETS.map((p) => p.id)).size).toBe(LUT_PRESETS.length);
  for (const preset of LUT_PRESETS) {
    const file = new URL(`../assets/${preset.file}`, import.meta.url);
    expect(preset.license).toBe("MIT");
    expect(preset.commit).toHaveLength(40);
    const bytes = readFileSync(file);
    const cube = gunzipSync(bytes);
    const parsed = parseCube(cube.toString("utf8"));
    expect(parsed.size).toBeGreaterThanOrEqual(2);
    if (preset.format === "cube") {
      expect(createHash("sha1").update(`blob ${cube.length}\0`).update(cube).digest("hex")).toBe(preset.sourceGitBlobSha1);
    } else {
      const record = JSON.parse(readFileSync(new URL("../assets/luts/film/build-record.json", import.meta.url), "utf8")) as { results: { source_git_blob_sha1: string; compressed_sha256: string; cube_sha256: string; error_8bit_levels: { mean: number; p99: number; max: number } }[] };
      const entry = record.results.find((row) => row.source_git_blob_sha1 === preset.sourceGitBlobSha1)!;
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.compressed_sha256);
      expect(createHash("sha256").update(cube).digest("hex")).toBe(entry.cube_sha256);
      expect(entry.error_8bit_levels.p99).toBeLessThan(2);
      expect(parsed.size).toBe(65);
    }
  }
});

it("copies one selected LUT and assigns it in one undoable history step, preserving other grade fields", { timeout: 30_000 }, () => {
  const dir = makeProject();
  expect(run(dir, "setProps", { itemId: "i_1", patch: { grade: { exposure: 0.5, vibrance: 0.2 } } })).not.toHaveProperty("error");
  const beforeHistory = historyList(dir).undo.length;
  const r = applyLutPreset(dir, "i_1", LUT_PRESETS[0].id);
  expect(r).not.toHaveProperty("error");
  const p = load(dir), lut = Object.values(p.assets).find((asset) => asset.kind === "lut")!;
  expect(p.tracks[0].items[0] as VideoItem).toMatchObject({ grade: { exposure: 0.5, vibrance: 0.2, lut: { assetId: lut.id, strength: 1 } } });
  expect(readdirSync(join(dir, "raw", "luts")).filter((name) => name.endsWith(".cube"))).toEqual([lut.path.split("/").at(-1)]);
  expect(readFileSync(join(dir, lut.path)).equals(gunzipSync(readFileSync(new URL(`../assets/${LUT_PRESETS[0].file}`, import.meta.url))))).toBe(true);
  expect(readFileSync(join(dir, "raw", "luts", "licenses", "stripedpurple-MIT.txt"), "utf8")).toContain("Copyright (c) 2020 Nixua");
  expect(JSON.parse(readFileSync(join(dir, "raw", "luts", "licenses", `${LUT_PRESETS[0].id}-attribution.json`), "utf8"))).toMatchObject({
    sourceCommit: LUT_PRESETS[0].commit,
    sourceGitBlobSha1: LUT_PRESETS[0].sourceGitBlobSha1,
    license: "MIT",
    inputProfile: "unspecified",
  });
  expect(historyList(dir).undo).toHaveLength(beforeHistory + 1);
  expect(undo(dir)).not.toHaveProperty("error");
  expect(load(dir).tracks[0].items[0]).toMatchObject({ grade: { exposure: 0.5, vibrance: 0.2 } });
  expect(load(dir).assets[lut.id]).toBeUndefined();
});

it("reuses a valid content-addressed asset id and is idempotent for an already applied preset", () => {
  const dir = makeProject(), presetId = LUT_PRESETS[0].id;
  const first = applyLutPreset(dir, "i_1", presetId);
  expect(first).not.toHaveProperty("error");
  const assetId = (load(dir).tracks[0].items[0] as VideoItem).grade?.lut?.assetId;
  const revision = load(dir).revision, history = historyList(dir).undo.length;
  expect(applyLutPreset(dir, "i_1", presetId)).not.toHaveProperty("error");
  expect(load(dir).revision).toBe(revision);
  expect(historyList(dir).undo).toHaveLength(history);
  expect((load(dir).tracks[0].items[0] as VideoItem).grade?.lut?.assetId).toBe(assetId);
  const source = new URL(`../assets/${LUT_PRESETS[0].file}`, import.meta.url);
  expect(createHash("sha256").update(gunzipSync(readFileSync(source))).digest("hex")).toBe(assetId!.slice("a_lut_".length));
});

it("rejects invalid IDs, bad project destinations, and tampered copies without project mutation", () => {
  const dir = makeProject(), revision = load(dir).revision;
  expect(applyLutPreset(dir, "../outside", LUT_PRESETS[0].id)).toMatchObject({ error: { code: "not_found" } });
  expect(applyLutPreset(dir, "i_1", "../../outside")).toMatchObject({ error: { code: "invalid" } });
  expect(load(dir).revision).toBe(revision);
  const outside = mkdtempSync(join(tmpdir(), "swr-outside-lut-"));
  mkdirSync(join(dir, "raw"));
  symlinkSync(outside, join(dir, "raw", "luts"));
  expect(applyLutPreset(dir, "i_1", LUT_PRESETS[0].id)).toMatchObject({ error: { code: "invalid" } });
  expect(readdirSync(outside)).toEqual([]);
  expect(load(dir).revision).toBe(revision);
  const rawLinkProject = makeProject();
  const rawOutside = mkdtempSync(join(tmpdir(), "swr-outside-raw-"));
  symlinkSync(rawOutside, join(rawLinkProject, "raw"));
  expect(applyLutPreset(rawLinkProject, "i_1", LUT_PRESETS[0].id)).toMatchObject({ error: { code: "invalid" } });
  expect(readdirSync(rawOutside)).toEqual([]);
});

it("remains portable after the project directory moves", () => {
  const dir = makeProject();
  expect(applyLutPreset(dir, "i_1", LUT_PRESETS[0].id)).not.toHaveProperty("error");
  const moved = mkdtempSync(join(tmpdir(), "swr-lut-moved-"));
  const target = join(moved, "project");
  cpSync(dir, target, { recursive: true });
  const lut = Object.values(load(target).assets).find((asset) => asset.kind === "lut")!;
  expect(() => loadCtx(target).validateLut?.(lut.path)).not.toThrow();
  expect(existsSync(join(target, lut.path))).toBe(true);
});

it("keeps a committed LUT intact when post-commit undo history writing fails", () => {
  const dir = makeProject();
  mkdirSync(join(dir, ".splicewright", "history", "undo", "000000003.json"), { recursive: true });
  const result = applyLutPreset(dir, "i_1", LUT_PRESETS[0].id);
  if ("error" in result) throw new Error(result.error.message);
  expect(result.changes.summary).toContain("undo history failed");
  const project = load(dir);
  const item = project.tracks[0].items[0] as VideoItem;
  expect(item.grade?.lut?.assetId).toBeTruthy();
  const lut = project.assets[item.grade!.lut!.assetId];
  expect(lut?.kind).toBe("lut");
  expect(existsSync(join(dir, lut!.path))).toBe(true);
  expect(parseCube(readFileSync(join(dir, lut!.path), "utf8")).size).toBe(64);
});
