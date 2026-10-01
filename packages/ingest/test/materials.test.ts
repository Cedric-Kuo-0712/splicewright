import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { init, load, run } from "@splicewright/core/node";
import { listMaterials, materialPreview, prepareMaterials, recordMaterialReview } from "../src/index.ts";

function project() {
  const dir = mkdtempSync(join(tmpdir(), "swr-materials-"));
  init(dir, { title: "materials", fps: 30, width: 320, height: 180 });
  mkdirSync(join(dir, "raw"), { recursive: true });
  return dir;
}

it("lists raw additions read-only, detects modifications and missing registered files", async () => {
  const dir = project();
  const image = join(dir, "raw", "poster.jpg");
  writeFileSync(image, "first image bytes");
  const before = load(dir).revision;
  const first = await listMaterials(dir);
  expect(first.materials).toMatchObject([{ path: "raw/poster.jpg", kind: "image", status: "unreviewed" }]);
  expect(load(dir).revision).toBe(before);
  const item = first.materials[0];
  await recordMaterialReview(dir, { path: item.path, version: item.version!, summary: "A bright title card." });
  expect((await listMaterials(dir)).materials[0].status).toBe("reviewed");
  const unregistered = join(dir, "raw", "later.mp4");
  writeFileSync(unregistered, "placeholder video");
  const pending = (await listMaterials(dir)).materials.find((material) => material.path === "raw/later.mp4")!;
  await recordMaterialReview(dir, { path: pending.path, version: pending.version!, summary: "A short clip." });
  unlinkSync(unregistered);
  expect((await listMaterials(dir)).materials.find((material) => material.path === pending.path)?.status).toBe("missing");
  writeFileSync(image, "updated image bytes");
  expect((await listMaterials(dir)).materials.find((material) => material.path === item.path)?.status).toBe("changed");
  expect(run(dir, "importAsset", { path: "raw/poster.jpg" })).not.toHaveProperty("error");
  writeFileSync(image, "updated image bytes");
  unlinkSync(image);
  expect((await listMaterials(dir)).materials.find((material) => material.path === item.path)).toMatchObject({ status: "missing", assetId: "a_poster" });
});

it("merges concurrent reviews without dropping another material's entry", async () => {
  const dir = project();
  writeFileSync(join(dir, "raw", "one.mp4"), "clip one");
  writeFileSync(join(dir, "raw", "two.mp4"), "clip two");
  const { materials } = await listMaterials(dir);
  await Promise.all(materials.map((material) => recordMaterialReview(dir, { path: material.path, version: material.version!, summary: `Review of ${material.path}` })));
  expect((await listMaterials(dir)).materials.map((item) => item.status)).toEqual(["reviewed", "reviewed"]);
});

it("refuses stale and malformed review records without overwriting the ledger", async () => {
  const dir = project();
  const file = join(dir, "raw", "clip.mp4");
  writeFileSync(file, "video placeholder");
  const item = (await listMaterials(dir)).materials[0];
  writeFileSync(file, "replacement bytes");
  await expect(recordMaterialReview(dir, { path: item.path, version: item.version!, summary: "Stale." })).rejects.toThrow("changed");
  const ledger = join(dir, ".splicewright", "material-reviews.json");
  mkdirSync(join(dir, ".splicewright"), { recursive: true });
  writeFileSync(ledger, "{broken");
  await expect(listMaterials(dir)).rejects.toThrow("invalid material review ledger JSON");
  await expect(recordMaterialReview(dir, { path: item.path, version: item.version!, summary: "No overwrite." })).rejects.toThrow("invalid material review ledger JSON");
  expect(readFileSync(ledger, "utf8")).toBe("{broken");
});

it("ignores raw symlinks escaping raw and prepares selected unregistered sources without reviewing them", async () => {
  const dir = project();
  const external = join(dir, "outside.wav");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.15", external]);
  symlinkSync(external, join(dir, "raw", "outside.wav"));
  const local = join(dir, "raw", "voice.wav");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=0.15", local]);
  const listed = await listMaterials(dir);
  expect(listed.materials.map((item) => item.path)).toEqual(["raw/voice.wav"]);
  const result = await prepareMaterials(dir, { paths: ["raw/voice.wav"], steps: [] });
  expect(result.errors).toEqual([]);
  expect(result.prepared[0]).toMatchObject({ path: "raw/voice.wav", assetId: "a_voice" });
  expect((await listMaterials(dir)).materials[0].status).toBe("unreviewed");
  expect(JSON.parse(readFileSync(join(dir, ".splicewright", "material-reviews.json"), "utf8")).reviews).toEqual({});
});

it("returns a bounded JPEG preview for a still image", async () => {
  const dir = project();
  const file = join(dir, "raw", "large.png");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=red:s=1400x1000", "-frames:v", "1", file]);
  const material = (await listMaterials(dir)).materials[0];
  const preview = await materialPreview(dir, { path: material.path, version: material.version });
  const output = join(dir, "preview-check.jpg");
  writeFileSync(output, preview.image);
  const dimensions = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", output], { encoding: "utf8" }).trim();
  expect(preview.mimeType).toBe("image/jpeg");
  expect(Math.max(...dimensions.split("x").map(Number))).toBeLessThanOrEqual(960);
});
