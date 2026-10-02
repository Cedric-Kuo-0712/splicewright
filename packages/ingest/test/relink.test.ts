import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cacheDir, init, load, readAssets, run, undo } from "@splicewright/core/node";
import { ingest, prepareMaterials, relinkMaterial, scanMaterials } from "../src/index.ts";

it("scans explicitly, refuses unsafe relinks and preserves timeline IDs in one undo step", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-relink-"));
  try {
    init(dir, { title: "relink", fps: 30, width: 64, height: 36 });
    mkdirSync(join(dir, "raw"));
    const tone = (name: string, duration: number) => execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`, join(dir, `raw/${name}.wav`)]);
    tone("original", 2); tone("short", 0.25); tone("different", 3);
    const revision = load(dir).revision;
    expect((await scanMaterials(dir)).materials.every((material) => material.health === "new")).toBe(true);
    expect(load(dir).revision).toBe(revision);
    expect(run(dir, "importAsset", { path: "raw/original.wav" })).not.toHaveProperty("error");
    await ingest(dir, { only: [] });
    expect(run(dir, "insertItem", { assetId: "a_original", at: 0, duration: 45 })).not.toHaveProperty("error");
    await prepareMaterials(dir, { paths: ["raw/original.wav"], steps: [] });
    copyFileSync(join(dir, "raw/original.wav"), join(dir, "raw/identical.wav"));
    rmSync(join(dir, "raw/original.wav"));
    expect((await scanMaterials(dir)).materials.find((material) => material.assetId === "a_original")?.health).toBe("missing");
    const before = load(dir);
    expect(await relinkMaterial(dir, { assetId: "a_original", path: "raw/short.wav", acceptChanged: true })).toHaveProperty("error.message", expect.stringContaining("cannot safely preserve usage"));
    expect(await relinkMaterial(dir, { assetId: "a_original", path: "raw/different.wav" })).toHaveProperty("error.message", expect.stringContaining("acceptChanged"));
    expect(load(dir)).toEqual(before);
    mkdirSync(cacheDir(dir, "proxies/edit"), { recursive: true });
    writeFileSync(cacheDir(dir, "proxies/edit/a_original.mp4"), "old proxy");
    expect(await relinkMaterial(dir, { assetId: "a_original", path: "raw/identical.wav" })).not.toHaveProperty("error");
    expect(load(dir).tracks).toEqual(before.tracks);
    expect(load(dir).revision).toBe(before.revision + 1);
    expect(readAssets(dir).a_original.done).toBeUndefined();
    expect(existsSync(cacheDir(dir, "proxies/edit/a_original.mp4"))).toBe(false);
    expect(undo(dir)).not.toHaveProperty("error");
    expect(load(dir).assets.a_original.path).toBe("raw/original.wav");
    expect(await relinkMaterial(dir, { assetId: "a_original", path: "../outside.wav", acceptChanged: true })).toHaveProperty("error");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("reports failed preparation instead of presenting unmeasured sources as healthy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-scan-failed-"));
  try {
    init(dir, { title: "failed source", fps: 30, width: 64, height: 36 }); mkdirSync(join(dir, "raw")); writeFileSync(join(dir, "raw/broken.mp4"), "not a video");
    const result = await prepareMaterials(dir, { paths: ["raw/broken.mp4"], steps: [] });
    expect(result.errors.length).toBeGreaterThan(0);
    expect((await scanMaterials(dir)).materials[0]).toMatchObject({ health: "failed", errors: expect.any(Array) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
