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

function exifOriginalSegment() {
  const tiff = Buffer.alloc(96);
  tiff.write("II", 0, "ascii"); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8769, 10); tiff.writeUInt16LE(4, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(2, 26);
  tiff.writeUInt16LE(0x9003, 28); tiff.writeUInt16LE(2, 30); tiff.writeUInt32LE(20, 32); tiff.writeUInt32LE(56, 36);
  tiff.writeUInt16LE(0x9011, 40); tiff.writeUInt16LE(2, 42); tiff.writeUInt32LE(7, 44); tiff.writeUInt32LE(76, 48);
  tiff.writeUInt32LE(0, 52);
  tiff.write("2021:03:04 05:06:07\0", 56, "ascii");
  tiff.write("+01:00\0", 76, "ascii");
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const segment = Buffer.alloc(payload.length + 4);
  segment[0] = 0xff; segment[1] = 0xe1; segment.writeUInt16BE(payload.length + 2, 2); payload.copy(segment, 4);
  return segment;
}

function addExifOriginal(file: string) {
  const jpeg = readFileSync(file);
  writeFileSync(file, Buffer.concat([jpeg.subarray(0, 2), exifOriginalSegment(), jpeg.subarray(2)]));
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

it("stores bounded planning fields and rejects coverage outside the media duration", async () => {
  const dir = project();
  const file = join(dir, "raw", "planning.wav");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3", file]);
  await prepareMaterials(dir, { paths: ["raw/planning.wav"], steps: [] });
  const material = (await listMaterials(dir)).materials[0];
  expect(material.captureTime).toBeNull(); // Filesystem dates are not a recording-time fallback.
  const planning = { storyRoles: ["process" as const, "detail" as const], tags: ["workshop"], coverage: { method: "sampled playback", extent: "partial" as const, ranges: [{ from: 0.05, to: 0.2 }] }, suitableUses: ["live-audio" as const], cautions: ["Room tone is audible."] };
  await recordMaterialReview(dir, { path: material.path, version: material.version!, summary: "Workshop ambience.", planning });
  expect((await listMaterials(dir)).materials[0].review?.planning).toEqual(planning);
  await expect(recordMaterialReview(dir, { path: material.path, version: material.version!, summary: "Too long.", planning: { coverage: { method: "sampled", extent: "partial", ranges: [{ from: 0, to: 2 }] } } })).rejects.toThrow("duration");
  await expect(recordMaterialReview(dir, { path: material.path, version: material.version!, summary: "Unknown field.", planning: { extra: { arbitrary: true } } as never })).rejects.toThrow("planning fields");
});

it("extracts EXIF original time and filename guesses during prepare, retaining timezone ambiguity", async () => {
  const dir = project();
  const relative = "raw/2024-03-05_06-07-08.jpg";
  const file = join(dir, relative);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", file]);
  addExifOriginal(file);
  expect((await listMaterials(dir)).materials[0].captureTime).toBeNull();
  const prepared = await prepareMaterials(dir, { paths: [relative], steps: [] });
  expect(prepared.errors).toEqual([]);
  expect((await listMaterials(dir)).materials[0].captureTime).toEqual({
    selected: { value: "2021-03-04T05:06:07+01:00", source: "exif-original", precision: "second", timezone: "explicit", certainty: "explicit" },
    candidates: [
      { value: "2021-03-04T05:06:07+01:00", source: "exif-original", precision: "second", timezone: "explicit", certainty: "explicit" },
      { value: "2024-03-05T06:07:08", source: "filename", precision: "second", timezone: "unknown-local", certainty: "inferred" },
    ],
    timezoneAmbiguous: true,
  });
});

it("keeps container creation provenance and invalidates chronology when the source changes", async () => {
  const dir = project();
  const relative = "raw/20240101_120000.mov";
  const file = join(dir, relative);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=32x32", "-t", "0.2", "-c:v", "mpeg4", "-metadata", "creation_time=2022-06-07T08:09:10Z", file]);
  await prepareMaterials(dir, { paths: [relative], steps: [] });
  const material = (await listMaterials(dir)).materials[0];
  expect(material.captureTime?.selected).toMatchObject({ value: "2022-06-07T08:09:10Z", source: "container-creation" });
  expect(material.captureTime?.candidates).toContainEqual(expect.objectContaining({ source: "filename", certainty: "inferred" }));
  // A stale timestamp must not be presented as evidence for replaced media.
  writeFileSync(file, "changed source");
  expect((await listMaterials(dir)).materials[0].captureTime).toBeNull();
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

it("dispatches standalone audio to STT and reuses its cached transcript without marking it read", async () => {
  const dir = project();
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=660:duration=0.15", join(dir, "raw/voice.wav")]);
  // A deterministic STT adapter tests dispatch and cache semantics without downloading a speech model.
  const adapter = join(dir, "stt-test.mjs");
  writeFileSync(adapter, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
if (!process.argv[2].endsWith('/transcribe.py')) process.exit(1);
for (let i = 3; i < process.argv.length; i += 2) {
  const output = process.argv[i + 1];
  writeFileSync(output, JSON.stringify({ language: 'en', segments: [{ start: 0, end: 0.1, text: 'hello', words: [{start: 0, end: 0.1, text: 'hello'}] }] }));
  console.log(JSON.stringify({ ok: output }));
}
`, { mode: 0o755 });
  const previous = process.env.SPLICEWRIGHT_PYTHON;
  process.env.SPLICEWRIGHT_PYTHON = adapter;
  try {
    const first = await prepareMaterials(dir, { paths: ["raw/voice.wav"], steps: ["transcript"] });
    expect(first.errors).toEqual([]);
    expect(first.steps?.transcript.ran).toBe(1);
    const second = await prepareMaterials(dir, { paths: ["raw/voice.wav"], steps: ["transcript"] });
    expect(second.steps?.transcript.cached).toBe(1);
    expect((await listMaterials(dir)).materials[0].status).toBe("unreviewed");
  } finally {
    if (previous === undefined) delete process.env.SPLICEWRIGHT_PYTHON;
    else process.env.SPLICEWRIGHT_PYTHON = previous;
  }
});
