import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createProject } from "@splicewright/core";
import { fingerprint } from "@splicewright/core/node";
import { transparentPng } from "../src/graphics-stream.ts";

const pngs = vi.hoisted(() => ({ red: Buffer.alloc(0), blue: Buffer.alloc(0) }));
vi.mock("@remotion/renderer", () => ({ openBrowser: async () => ({ pages: async () => [], close: async () => {} }), renderFrames: async (options: any) => {
  for (let index = 0; index < options.frames.length; index += options.concurrency) {
    await Promise.all(options.frames.slice(index, index + options.concurrency).reverse()
      .map((frame: number) => options.onFrameBuffer(frame < 310 ? pngs.red : pngs.blue, frame)));
  }
  options.onFrameUpdate(options.frames.length);
} }));
import { renderLayered, audioClipFilters, type LayeredRenderArgs } from "../src/layered-render.ts";

let available = false;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); available = true; } catch {}
const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", ...args], { timeout: 10000 });

it.skipIf(!available)("matches staged PNG pixels and PCM through real FFmpeg across sparse windows and a partial range", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-stream-native-"));
  try {
    mkdirSync(join(dir, "raw")); mkdirSync(join(dir, "frames"));
    const source = join(dir, "raw/source.mp4"), output = join(dir, "stream.mp4"), reference = join(dir, "reference.mp4");
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=32x32:r=30", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000", "-frames:v", "324", "-t", "10.8", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", source]);
    const colorPng = (color: string) => ffmpeg(["-f", "lavfi", "-i", `color=c=${color}@0.5:s=32x32,format=rgba`, "-frames:v", "1", "-threads", "1", "-c:v", "png", "-f", "image2pipe", "-"]);
    pngs.red = colorPng("red"); pngs.blue = colorPng("blue");
    const project = createProject({ title: "stream", width: 32, height: 32, fps: 30 });
    project.assets = { a: { id: "a", kind: "video", path: "raw/source.mp4" } };
    project.tracks = [
      { id: "v", name: "Video", kind: "video", items: [{ id: "clip", assetId: "a", start: 0, duration: 324, sourceIn: 0 }] },
      { id: "g", name: "Graphics", kind: "overlay", items: [
        { id: "g4", component: "CaptionLayer", start: 4, duration: 306, props: { texts: ["test"], css: { backdropFilter: "none" } } },
        { id: "g320", component: "CaptionLayer", start: 320, duration: 2, props: { texts: ["gap"], css: { backdropFilter: "none" } } },
      ] },
    ];
    const progress: number[] = [];
    await renderLayered({ dir, output, preset: "h264-cpu", range: [2, 324], project,
      probes: { a: { kind: "video", path: "raw/source.mp4", fingerprint: fingerprint(source)!, width: 32, height: 32, fps: 30, duration: 10.8, audio: true } },
      presetOptions: { codec: "h264", crf: 18 }, onProgress: value => progress.push(value),
      remotion: { composition: { durationInFrames: 18 }, inputProps: { project } } as unknown as LayeredRenderArgs["remotion"],
    });
    const blank = transparentPng(32, 32);
    for (let frame = 2; frame < 324; frame++) writeFileSync(join(dir, "frames", `${frame - 2}.png`), frame >= 4 && frame < 310 ? pngs.red : frame >= 320 && frame < 322 ? pngs.blue : blank);
    const filters = `[0:v]trim=duration=10.733333333,setpts=PTS-STARTPTS,fps=30,format=rgb24[v];[1:v]format=rgba[g];[v][g]overlay=format=rgb:eof_action=pass:shortest=0,scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p[vout];[0:a]${audioClipFilters(322, 30)},volume=1,atrim=duration=10.733333333,asetpts=PTS-STARTPTS[aout]`;
    ffmpeg(["-filter_complex_threads", "2", "-threads", "2", "-ss", "0.066666667", "-i", source, "-threads", "2", "-framerate", "30", "-i", join(dir, "frames/%d.png"), "-filter_complex", filters, "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "2", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-t", "10.733333333", reference]);
    const videoHash = (file: string) => ffmpeg(["-threads", "2", "-i", file, "-map", "0:v", "-threads", "2", "-f", "framemd5", "-"]).toString();
    const audioHash = (file: string) => createHash("sha256").update(ffmpeg(["-i", file, "-map", "0:a", "-f", "s16le", "-"])).digest("hex");
    expect(videoHash(output)).toBe(videoHash(reference));
    expect(audioHash(output)).toBe(audioHash(reference));
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(!available)("cleans failed capped encodes and preserves an existing destination", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-filter-cap-failure-"));
  const oldPath = process.env.PATH, oldCap = process.env.SPLICEWRIGHT_EXPERIMENTAL_FILTER_BUFFERED_FRAMES;
  try {
    const raw = join(dir, "raw"); mkdirSync(raw);
    const source = join(raw, "source.mp4"), output = join(dir, "output.mp4");
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=32x32:r=30", "-frames:v", "30", "-c:v", "libx264", "-threads", "1", source]);
    const fakeBin = join(dir, "bin"); mkdirSync(fakeBin);
    const fakeFfmpeg = join(fakeBin, "ffmpeg");
    writeFileSync(fakeFfmpeg, '#!/bin/sh\ncase "$*" in *"-h full"*) echo "-filter_buffered_frames"; exit 0;; esac\necho "Too many frames buffered in filtergraph" >&2\nexit 1\n'); chmodSync(fakeFfmpeg, 0o755);
    writeFileSync(output, "preserve-this-output");
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
    process.env.SPLICEWRIGHT_EXPERIMENTAL_FILTER_BUFFERED_FRAMES = "64";
    const project = createProject({ title: "cap failure", width: 32, height: 32, fps: 30 });
    project.assets = { a: { id: "a", kind: "video", path: "raw/source.mp4" } };
    project.tracks = [
      { id: "v", name: "Video", kind: "video", items: [{ id: "clip", assetId: "a", start: 0, duration: 30, sourceIn: 0 }] },
      { id: "g", name: "Graphics", kind: "overlay", items: [{ id: "g1", component: "CaptionLayer", start: 0, duration: 30, props: { texts: ["test"], css: { backdropFilter: "none" } } }] },
    ];
    await expect(renderLayered({ dir, output, preset: "h264-cpu", project,
      probes: { a: { kind: "video", path: "raw/source.mp4", fingerprint: fingerprint(source)!, width: 32, height: 32, fps: 30, duration: 1, audio: false } },
      presetOptions: { codec: "h264", crf: 18 }, remotion: { composition: { durationInFrames: 30 }, inputProps: { project } } as unknown as LayeredRenderArgs["remotion"],
    })).rejects.toThrow(/Too many frames buffered/);
    expect(readFileSync(output, "utf8")).toBe("preserve-this-output");
    expect(readdirSync(dir).some(name => name.includes(".layered-") && name.endsWith(".mp4"))).toBe(false);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldCap === undefined) delete process.env.SPLICEWRIGHT_EXPERIMENTAL_FILTER_BUFFERED_FRAMES; else process.env.SPLICEWRIGHT_EXPERIMENTAL_FILTER_BUFFERED_FRAMES = oldCap;
    rmSync(dir, { recursive: true, force: true });
  }
});
