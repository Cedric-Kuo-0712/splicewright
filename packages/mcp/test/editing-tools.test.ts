import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { fingerprint, init, load, run, writeAtomic, cacheDir } from "@splicewright/core/node";

const CLI = join(import.meta.dirname, "../../cli/src/main.ts");
const imageDimensions = (file: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file], { encoding: "utf8" })).streams[0];

it("exposes bounded source frames, safe PiP presets, and paged source transcripts over MCP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-editing-mcp-"));
  const outside = mkdtempSync(join(tmpdir(), "swr-outside-"));
  const client = new Client({ name: "editing-tools-test", version: "0" });
  try {
    init(dir, { title: "editing tools", fps: 30, width: 640, height: 360 });
    mkdirSync(join(dir, "raw"), { recursive: true });
    mkdirSync(join(dir, ".splicewright"), { recursive: true });
    const videoPath = join(dir, "raw", "clip.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=1600x900:rate=10:duration=2", "-pix_fmt", "yuv420p", "-y", videoPath]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-y", join(dir, "raw", "voice.wav")]);
    const v = run(dir, "importAsset", { path: "raw/clip.mp4", kind: "video" });
    const a = run(dir, "importAsset", { path: "raw/voice.wav", kind: "audio" });
    expect("error" in v).toBe(false);
    expect("error" in a).toBe(false);
    const project = load(dir);
    const videoId = Object.keys(project.assets).find((id) => project.assets[id].kind === "video")!;
    const audioId = Object.keys(project.assets).find((id) => project.assets[id].kind === "audio")!;
    const clientTransport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], cwd: dir, stderr: "inherit" });
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { type: string; text?: string }[]).find((block) => block.type === "text");
      return { result, body: text?.type === "text" ? JSON.parse(text.text!) : undefined };
    };

    const frame = await call("source_frame", { assetId: videoId, at: 0.7, maxSize: 300 });
    expect(frame.result.isError).not.toBe(true);
    expect(frame.body.seconds).toBeCloseTo(0.7, 2);
    const frameImage = (frame.result.content as { type: string; data?: string }[]).find((block) => block.type === "image");
    expect(frameImage?.type).toBe("image");
    if (frameImage?.type === "image") {
      const preview = join(dir, "preview.jpg");
      writeFileSync(preview, Buffer.from(frameImage.data!, "base64"));
      const dims = imageDimensions(preview);
      expect(Math.max(dims.width, dims.height)).toBeLessThanOrEqual(300);
    }
    expect((await call("source_frame", { assetId: videoId, at: 2 })).result.isError).toBe(true);
    expect((await call("source_frame", { assetId: audioId, at: 0 })).result.isError).toBe(true);
    copyFileSync(videoPath, join(outside, "outside.mp4"));
    symlinkSync(join(outside, "outside.mp4"), join(dir, "raw", "escape.mp4"));
    const escaped = load(dir);
    escaped.assets[videoId].path = "raw/escape.mp4";
    writeAtomic(join(dir, "project.json"), escaped);
    expect((await call("source_frame", { assetId: videoId, at: 0.5 })).result.isError).toBe(true);
    escaped.assets[videoId].path = "raw/clip.mp4";
    writeAtomic(join(dir, "project.json"), escaped);

    const audioInserted = await call("splicewright_insertItem", { assetId: audioId, at: 0, duration: 30, sourceIn: 0 });
    expect(audioInserted.result.isError).not.toBe(true);
    const audioItem = load(dir).tracks.find((track) => track.kind === "audio")!.items[0];
    expect((await call("apply_pip_preset", { itemId: audioItem.id, preset: "br" })).body.code).toBe("invalid_item_kind");

    const inserted = await call("splicewright_insertItem", { assetId: videoId, at: 0, duration: 30, sourceIn: 0 });
    expect(inserted.result.isError).not.toBe(true);
    const item = load(dir).tracks.find((track) => track.kind === "video")!.items[0];
    const beforePipRevision = load(dir).revision;
    const pip = await call("apply_pip_preset", { itemId: item.id, preset: "br", baseRevision: beforePipRevision });
    expect(pip.result.isError).not.toBe(true);
    expect(pip.body.revision).toBe(beforePipRevision + 1);
    expect((load(dir).tracks.find((track) => track.kind === "video")!.items[0] as { transform?: { scale?: number } }).transform?.scale).toBe(0.3);
    const undo = await call("splicewright_undo", { baseRevision: pip.body.revision });
    expect(undo.result.isError).not.toBe(true);
    expect(load(dir).revision).toBe(beforePipRevision + 2);
    expect((load(dir).tracks.find((track) => track.kind === "video")!.items[0] as { transform?: { scale?: number } }).transform?.scale).toBeUndefined();
    expect((await call("apply_pip_preset", { itemId: item.id, preset: "br", baseRevision: beforePipRevision })).body.code).toBe("conflict");

    const restored = load(dir);
    const restoredVideo = restored.tracks.find((track) => track.kind === "video")!.items[0] as { id: string; keyframes?: Record<string, unknown[]>; mask?: { shape: "ellipse"; x: number; y: number; w: number; h: number } };
    restoredVideo.keyframes = { x: [{ t: 0, v: 0 }] };
    writeAtomic(join(dir, "project.json"), restored);
    expect((await call("apply_pip_preset", { itemId: item.id, preset: "tl" })).body.code).toBe("position_keyframes");
    restoredVideo.keyframes = { maskX: [{ t: 0, v: 0.2 }] };
    restoredVideo.mask = { shape: "ellipse", x: 0, y: 0, w: 1, h: 1 };
    writeAtomic(join(dir, "project.json"), restored);
    expect((await call("apply_pip_preset", { itemId: item.id, preset: "circle" })).body.code).toBe("position_keyframes");
    await call("splicewright_setProps", { itemId: item.id, patch: { keyframes: null, transform: { rotation: 180 }, crop: { left: 0.1 } } });
    const rotatedRevision = load(dir).revision;
    expect((await call("apply_pip_preset", { itemId: item.id, preset: "tl" })).body.code).toBe("rotated_geometry");
    expect(load(dir).revision).toBe(rotatedRevision);

    const missing = await call("get_asset_transcript", { assetId: audioId });
    expect(missing.body).toMatchObject({ available: false, reason: "missing_or_stale", segments: [] });
    const assetsFile = cacheDir(dir, "assets.json");
    mkdirSync(cacheDir(dir, "transcripts"), { recursive: true });
    const assetCache = {
      [videoId]: { path: "raw/clip.mp4", fingerprint: fingerprint(videoPath)!, kind: "video", duration: 2, width: 1600, height: 900 },
      [audioId]: { path: "raw/voice.wav", fingerprint: fingerprint(join(dir, "raw", "voice.wav"))!, kind: "audio", duration: 2, done: { transcript: `${fingerprint(join(dir, "raw", "voice.wav"))}#t2` } },
    };
    writeAtomic(assetsFile, assetCache);
    writeAtomic(cacheDir(dir, "transcripts", `${audioId}.json`), { segments: [
      { start: 0, end: 1, text: "First hello" }, { start: 1, end: 2, text: "Second goodbye" }, { start: 2, end: 3, text: "Third hello" },
    ] });
    const page = await call("get_asset_transcript", { assetId: audioId, from: 0.5, to: 2.5, query: "HELLO", limit: 1, offset: 0 });
    expect(page.body).toMatchObject({ available: true, total: 2, offset: 0, limit: 1, hasMore: true });
    expect(page.body.segments[0].text).toBe("First hello");
    const next = await call("get_asset_transcript", { assetId: audioId, query: "hello", limit: 1, offset: 1 });
    expect(next.body.segments[0].text).toBe("Third hello");
    writeAtomic(cacheDir(dir, "transcripts", `${audioId}.json`), { segments: [] });
    expect((await call("get_asset_transcript", { assetId: audioId })).body).toMatchObject({ available: true, total: 0, segments: [] });
    assetCache[audioId]!.done = { transcript: "stale" };
    writeAtomic(assetsFile, assetCache);
    expect((await call("get_asset_transcript", { assetId: audioId })).body.available).toBe(false);
  } finally {
    await client.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}, 30_000);
