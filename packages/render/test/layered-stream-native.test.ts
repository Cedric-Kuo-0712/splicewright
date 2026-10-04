import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, watch } from "node:fs";
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

it.skipIf(!available)("streams contiguous muted clips through one encoder with exact decoded pixels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-active-window-equality-"));
  const previousMode = process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW;
  try {
    mkdirSync(join(dir, "raw"));
    const first = join(dir, "raw/first.mp4"), second = join(dir, "raw/second.mp4");
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=32x32:r=30:d=2", "-frames:v", "60", "-c:v", "libx264", "-threads", "1", first]);
    ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=32x32:r=30:d=2", "-frames:v", "60", "-c:v", "libx264", "-threads", "1", second]);
    const project = createProject({ title: "active window equality", width: 32, height: 32, fps: 30 });
    project.assets = { a: { id: "a", kind: "video", path: "raw/first.mp4" }, b: { id: "b", kind: "video", path: "raw/second.mp4" } };
    project.tracks = [{ id: "v", name: "Video", kind: "video", muted: true, items: [
      { id: "a1", assetId: "a", start: 0, duration: 18, sourceIn: 0.15 },
      { id: "b1", assetId: "b", start: 18, duration: 18, sourceIn: 0.27 },
    ] }];
    const probes = Object.fromEntries([["a", first], ["b", second]].map(([id, path]) => [id, {
      kind: "video" as const, path: "raw/" + (id === "a" ? "first.mp4" : "second.mp4"), fingerprint: fingerprint(path)!, width: 32, height: 32, fps: 30, duration: 2, audio: false,
    }]));
    const common = { dir, preset: "h264-cpu", range: [3, 30] as [number, number], project, probes,
      presetOptions: { codec: "h264" as const, crf: 18 }, remotion: { composition: { durationInFrames: 36 }, inputProps: { project } } as unknown as LayeredRenderArgs["remotion"] };
    const reference = join(dir, "reference.mp4"), candidate = join(dir, "active.mp4");
    await renderLayered({ ...common, output: reference });
    process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW = "1";
    let activeEncoderArgs: readonly string[] = [];
    await renderLayered({ ...common, output: candidate, onEncoding: args => { activeEncoderArgs = args; } });
    expect(activeEncoderArgs).toContain("pipe:0");
    const decodedHash = (file: string) => createHash("sha256").update(ffmpeg(["-threads", "2", "-i", file, "-map", "0:v:0", "-pix_fmt", "rgb24", "-f", "hash", "-hash", "sha256", "-"])).digest("hex");
    expect(decodedHash(candidate)).toBe(decodedHash(reference));
  } finally {
    if (previousMode === undefined) delete process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW; else process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW = previousMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

it.skipIf(!available)("matches the existing graph when a video stream ends before its probed duration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-active-window-short-"));
  const previousMode = process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW;
  try {
    mkdirSync(join(dir, "raw"));
    const first = join(dir, "raw/first.mp4"), second = join(dir, "raw/second.mp4");
    // 45 decodable frames, but the probe claims 2 s: the last 9 requested frames of a1 are missing.
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=32x32:r=30", "-frames:v", "45", "-c:v", "libx264", "-threads", "1", first]);
    ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=32x32:r=30:d=2", "-frames:v", "60", "-c:v", "libx264", "-threads", "1", second]);
    const project = createProject({ title: "active window short source", width: 32, height: 32, fps: 30 });
    project.assets = { a: { id: "a", kind: "video", path: "raw/first.mp4" }, b: { id: "b", kind: "video", path: "raw/second.mp4" } };
    project.tracks = [{ id: "v", name: "Video", kind: "video", muted: true, items: [
      { id: "a1", assetId: "a", start: 0, duration: 18, sourceIn: 1.2 },
      { id: "b1", assetId: "b", start: 18, duration: 18, sourceIn: 0 },
    ] }];
    const probes = Object.fromEntries([["a", first], ["b", second]].map(([id, path]) => [id, {
      kind: "video" as const, path: "raw/" + (id === "a" ? "first.mp4" : "second.mp4"), fingerprint: fingerprint(path)!, width: 32, height: 32, fps: 30, duration: 2, audio: false,
    }]));
    const common = { dir, preset: "h264-cpu", project, probes,
      presetOptions: { codec: "h264" as const, crf: 18 }, remotion: { composition: { durationInFrames: 36 }, inputProps: { project } } as unknown as LayeredRenderArgs["remotion"] };
    const reference = join(dir, "reference.mp4"), candidate = join(dir, "active.mp4");
    await renderLayered({ ...common, output: reference });
    process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW = "1";
    let activeEncoderArgs: readonly string[] = [];
    await renderLayered({ ...common, output: candidate, onEncoding: args => { activeEncoderArgs = args; } });
    expect(activeEncoderArgs).toContain("pipe:0");
    const decodedHash = (file: string) => createHash("sha256").update(ffmpeg(["-threads", "2", "-i", file, "-map", "0:v:0", "-pix_fmt", "rgb24", "-f", "hash", "-hash", "sha256", "-"])).digest("hex");
    expect(decodedHash(candidate)).toBe(decodedHash(reference));
  } finally {
    if (previousMode === undefined) delete process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW; else process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW = previousMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

it.skipIf(!available)("streams an unmuted audio source through the active-window path with an audio stream", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-active-window-audio-"));
  const previousMode = process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW;
  try {
    mkdirSync(join(dir, "raw"));
    const source = join(dir, "raw/source.mp4"), output = join(dir, "output.mp4");
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=32x32:r=30:d=1", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:d=1", "-frames:v", "30", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", source]);
    const project = createProject({ title: "active audio fallback", width: 32, height: 32, fps: 30 });
    project.assets = { a: { id: "a", kind: "video", path: "raw/source.mp4" } };
    project.tracks = [{ id: "v", name: "Video", kind: "video", items: [{ id: "clip", assetId: "a", start: 0, duration: 30, sourceIn: 0 }] }];
    const probes = { a: { kind: "video" as const, path: "raw/source.mp4", fingerprint: fingerprint(source)!, width: 32, height: 32, fps: 30, duration: 1, audio: true } };
    process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW = "1";
    let activeEncoderArgs: readonly string[] = [];
    await renderLayered({ dir, output, preset: "h264-cpu", project, probes, presetOptions: { codec: "h264", crf: 18 }, onEncoding: args => { activeEncoderArgs = args; },
      remotion: { composition: { durationInFrames: 30 }, inputProps: { project } } as unknown as LayeredRenderArgs["remotion"],
    });
    expect(activeEncoderArgs).toContain("pipe:0");
    const streams = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", output], { encoding: "utf8" })).streams;
    expect(streams.map((stream: { codec_type: string }) => stream.codec_type)).toContain("audio");
  } finally {
    if (previousMode === undefined) delete process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW; else process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW = previousMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

it.skipIf(!available)("cleans an active-window decoder failure and preserves an existing output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-active-window-failure-"));
  const previousPath = process.env.PATH, previousMode = process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW;
  const previousPhase = process.env.SPLICEWRIGHT_EXPORT_MEMORY_PHASE_FILE, previousEvents = process.env.SPLICEWRIGHT_EXPORT_MEMORY_EVENTS_FILE;
  try {
    mkdirSync(join(dir, "raw"));
    const source = join(dir, "raw/source.mp4"), output = join(dir, "output.mp4");
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=32x32:r=30:d=2", "-frames:v", "60", "-c:v", "libx264", "-threads", "1", source]);
    const fakeBin = join(dir, "bin"); mkdirSync(fakeBin);
    const fakeFfmpeg = join(fakeBin, "ffmpeg");
    writeFileSync(fakeFfmpeg, '#!/bin/sh\ncase "$*" in *"pipe:0"*) last=""; for arg do last="$arg"; done; cat >/dev/null; : > "$last"; exit 0;; esac\necho "injected active reader failure" >&2\nexit 9\n'); chmodSync(fakeFfmpeg, 0o755);
    writeFileSync(output, "existing-output");
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW = "1";
    const project = createProject({ title: "active failure", width: 32, height: 32, fps: 30 });
    project.assets = { a: { id: "a", kind: "video", path: "raw/source.mp4" } };
    project.tracks = [{ id: "v", name: "Video", kind: "video", muted: true, items: [{ id: "clip", assetId: "a", start: 0, duration: 30, sourceIn: 0 }] }];
    const eventsFile = join(dir, "trial-events.jsonl"), phaseFile = join(dir, "trial-phase.json");
    process.env.SPLICEWRIGHT_EXPORT_MEMORY_PHASE_FILE = phaseFile;
    process.env.SPLICEWRIGHT_EXPORT_MEMORY_EVENTS_FILE = eventsFile;
    const probes = { a: { kind: "video" as const, path: "raw/source.mp4", fingerprint: fingerprint(source)!, width: 32, height: 32, fps: 30, duration: 2, audio: false } };
    await expect(renderLayered({ dir, output, preset: "h264-cpu", project, probes, presetOptions: { codec: "h264", crf: 18 },
      remotion: { composition: { durationInFrames: 30 }, inputProps: { project } } as unknown as LayeredRenderArgs["remotion"],
    })).rejects.toThrow(/injected active reader failure/);
    expect(readFileSync(output, "utf8")).toBe("existing-output");
    expect(readFileSync(eventsFile, "utf8")).toContain('"stage":"active-window-reader-failed"');
    expect(readdirSync(dir).some(name => name.includes(".layered-") && name.endsWith(".mp4"))).toBe(false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousMode === undefined) delete process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW; else process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW = previousMode;
    if (previousPhase === undefined) delete process.env.SPLICEWRIGHT_EXPORT_MEMORY_PHASE_FILE; else process.env.SPLICEWRIGHT_EXPORT_MEMORY_PHASE_FILE = previousPhase;
    if (previousEvents === undefined) delete process.env.SPLICEWRIGHT_EXPORT_MEMORY_EVENTS_FILE; else process.env.SPLICEWRIGHT_EXPORT_MEMORY_EVENTS_FILE = previousEvents;
    rmSync(dir, { recursive: true, force: true });
  }
});

it.skipIf(!available)("keeps the decoder pipe backpressured when the encoder reads slowly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-active-window-backpressure-"));
  const previousPath = process.env.PATH, previousMode = process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW;
  try {
    mkdirSync(join(dir, "raw"));
    const source = join(dir, "raw/source.mp4"), output = join(dir, "output.mp4");
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=32x32:r=30:d=2", "-frames:v", "60", "-c:v", "libx264", "-threads", "1", source]);
    const realFfmpeg = execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
    const fakeBin = join(dir, "bin"); mkdirSync(fakeBin);
    const fakeFfmpeg = join(fakeBin, "ffmpeg");
    writeFileSync(fakeFfmpeg, `#!/usr/bin/env node\nconst fs=require("node:fs"),{spawn}=require("node:child_process"),args=process.argv.slice(2);\nif(args.includes("pipe:0")){process.stderr.write("out_time_us=0\\n");let bytes=0;process.stdin.on("data",chunk=>{process.stdin.pause();bytes+=chunk.length;setTimeout(()=>process.stdin.resume(),2)});process.stdin.on("end",()=>fs.writeFileSync(args.at(-1),String(bytes)));}else{const child=spawn(${JSON.stringify(realFfmpeg)},args,{stdio:"inherit"});child.on("close",code=>process.exit(code??1));}\n`); chmodSync(fakeFfmpeg, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW = "1";
    const project = createProject({ title: "active backpressure", width: 32, height: 32, fps: 30 });
    project.assets = { a: { id: "a", kind: "video", path: "raw/source.mp4" } };
    project.tracks = [{ id: "v", name: "Video", kind: "video", muted: true, items: [
      { id: "clip1", assetId: "a", start: 0, duration: 30, sourceIn: 0 },
      { id: "clip2", assetId: "a", start: 30, duration: 30, sourceIn: 1 },
    ] }];
    const probes = { a: { kind: "video" as const, path: "raw/source.mp4", fingerprint: fingerprint(source)!, width: 32, height: 32, fps: 30, duration: 2, audio: false } };
    const progress: number[] = [];
    let activeEncoderArgs: readonly string[] = [];
    await renderLayered({ dir, output, preset: "h264-cpu", project, probes, presetOptions: { codec: "h264", crf: 18 }, onEncoding: args => { activeEncoderArgs = args; }, onProgress: value => progress.push(value),
      remotion: { composition: { durationInFrames: 60 }, inputProps: { project } } as unknown as LayeredRenderArgs["remotion"],
    });
    expect(activeEncoderArgs).toContain("pipe:0");
    expect(readFileSync(output, "utf8")).toBe(String(60 * 32 * 32 * 4));
    // The encoder reports progress before the first reader finishes; clip completion must not move it backwards.
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousMode === undefined) delete process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW; else process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW = previousMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

it.skipIf(!available)("cancels and closes both the active decoder and encoder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-active-window-cancel-"));
  const previousPath = process.env.PATH, previousMode = process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW;
  const previousPhase = process.env.SPLICEWRIGHT_EXPORT_MEMORY_PHASE_FILE, previousEvents = process.env.SPLICEWRIGHT_EXPORT_MEMORY_EVENTS_FILE;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined, watchHandle: ReturnType<typeof watch> | undefined;
  try {
    mkdirSync(join(dir, "raw"));
    const source = join(dir, "raw/source.mp4"), output = join(dir, "output.mp4");
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=32x32:r=30:d=2", "-frames:v", "60", "-c:v", "libx264", "-threads", "1", source]);
    const marker = join(dir, "closed.txt"), fakeBin = join(dir, "bin"); mkdirSync(fakeBin);
    const fakeFfmpeg = join(fakeBin, "ffmpeg");
    writeFileSync(fakeFfmpeg, `#!/usr/bin/env node\nconst fs=require("node:fs"),args=process.argv.slice(2),marker=${JSON.stringify(marker)};\nconst reader=!args.includes("pipe:0");process.on("SIGTERM",()=>{fs.appendFileSync(marker,reader?"reader-closed\\n":"encoder-closed\\n");process.exit(143)});\nif(reader){fs.writeFileSync(${JSON.stringify(join(dir, "reader-started"))},"started");process.stderr.write("reader-waiting\\n");setInterval(()=>{},1000)}else{process.stdin.resume();process.stdin.on("end",()=>{fs.appendFileSync(marker,"encoder-closed\\n");fs.writeFileSync(args.at(-1),"partial")})}\n`); chmodSync(fakeFfmpeg, 0o755);
    writeFileSync(output, "existing-output");
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW = "1";
    const eventsFile = join(dir, "trial-events.jsonl");
    process.env.SPLICEWRIGHT_EXPORT_MEMORY_PHASE_FILE = join(dir, "trial-phase.json");
    process.env.SPLICEWRIGHT_EXPORT_MEMORY_EVENTS_FILE = eventsFile;
    const project = createProject({ title: "active cancellation", width: 32, height: 32, fps: 30 });
    project.assets = { a: { id: "a", kind: "video", path: "raw/source.mp4" } };
    project.tracks = [{ id: "v", name: "Video", kind: "video", muted: true, items: [{ id: "clip", assetId: "a", start: 0, duration: 60, sourceIn: 0 }] }];
    const probes = { a: { kind: "video" as const, path: "raw/source.mp4", fingerprint: fingerprint(source)!, width: 32, height: 32, fps: 30, duration: 2, audio: false } };
    let cancel: (() => void) | undefined;
    watchHandle = watch(dir, () => {
      if (existsSync(join(dir, "reader-started")) && existsSync(eventsFile) && readFileSync(eventsFile, "utf8").includes('"stage":"active-window-reader-start"') && !cancelTimer && cancel)
        cancelTimer = setTimeout(cancel, 100);
    });
    const renderPromise = renderLayered({ dir, output, preset: "h264-cpu", project, probes, presetOptions: { codec: "h264", crf: 18 },
      cancelSignal: callback => { cancel = callback; },
      remotion: { composition: { durationInFrames: 60 }, inputProps: { project } } as unknown as LayeredRenderArgs["remotion"],
    });
    await expect(renderPromise).rejects.toThrow(/render cancelled/);
    watchHandle.close(); watchHandle = undefined;
    const closed = readFileSync(marker, "utf8");
    expect(closed).toContain("encoder-closed");
    expect(closed).toContain("reader-closed");
    expect(readFileSync(output, "utf8")).toBe("existing-output");
    expect(readdirSync(dir).some(name => name.includes(".layered-") && name.endsWith(".mp4"))).toBe(false);
  } finally {
    if (cancelTimer) clearTimeout(cancelTimer);
    watchHandle?.close();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousMode === undefined) delete process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW; else process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW = previousMode;
    if (previousPhase === undefined) delete process.env.SPLICEWRIGHT_EXPORT_MEMORY_PHASE_FILE; else process.env.SPLICEWRIGHT_EXPORT_MEMORY_PHASE_FILE = previousPhase;
    if (previousEvents === undefined) delete process.env.SPLICEWRIGHT_EXPORT_MEMORY_EVENTS_FILE; else process.env.SPLICEWRIGHT_EXPORT_MEMORY_EVENTS_FILE = previousEvents;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Renders `project` with and without the active-window flag; asserts the flagged render's pixels and PCM match the classic graph.
async function expectActiveAudioEquality(dir: string, project: ReturnType<typeof createProject>, probes: Record<string, any>, range: [number, number] | undefined, frames: number, expectActive = true) {
  const previousMode = process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW;
  try {
    const common = { dir, preset: "h264-cpu", ...(range ? { range } : {}), project, probes,
      presetOptions: { codec: "h264" as const, crf: 18 }, remotion: { composition: { durationInFrames: frames }, inputProps: { project } } as unknown as LayeredRenderArgs["remotion"] };
    const reference = join(dir, "reference.mp4"), candidate = join(dir, "active.mp4");
    delete process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW;
    await renderLayered({ ...common, output: reference });
    process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW = "1";
    let encoderArgs: readonly string[] = [];
    await renderLayered({ ...common, output: candidate, onEncoding: args => { encoderArgs = args; } });
    if (expectActive) expect(encoderArgs).toContain("pipe:0"); else expect(encoderArgs).not.toContain("pipe:0");
    const video = (file: string) => createHash("sha256").update(ffmpeg(["-threads", "2", "-i", file, "-map", "0:v:0", "-pix_fmt", "rgb24", "-f", "hash", "-hash", "sha256", "-"])).digest("hex");
    const pcm = (file: string) => createHash("sha256").update(ffmpeg(["-i", file, "-map", "0:a:0", "-f", "s16le", "-"])).digest("hex");
    expect(video(candidate)).toBe(video(reference));
    expect(pcm(candidate)).toBe(pcm(reference));
  } finally {
    if (previousMode === undefined) delete process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW; else process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW = previousMode;
  }
}

const probeOf = (kind: "video" | "audio", file: string, path: string, audio: boolean) => ({ kind, path, fingerprint: fingerprint(file)!, width: 32, height: 32, fps: 30, duration: 2, audio });
const makeAv = (dir: string) => {
  mkdirSync(join(dir, "raw"));
  const first = join(dir, "raw/first.mp4"), second = join(dir, "raw/second.mp4"), music = join(dir, "raw/music.m4a");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=32x32:r=30:d=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=2", "-frames:v", "60", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", first]);
  ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=32x32:r=30:d=2", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:d=2", "-frames:v", "60", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", second]);
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:d=2", "-c:a", "aac", music]);
  return { first, second, music };
};
const twoClips = (muted = false) => ({ id: "v", name: "Video", kind: "video" as const, ...(muted ? { muted: true } : {}), items: [
  { id: "a1", assetId: "a", start: 0, duration: 18, sourceIn: 0.15 },
  { id: "b1", assetId: "b", start: 18, duration: 18, sourceIn: 0.27, volume: 0.5 },
] });
const avAssets = { a: { id: "a", kind: "video" as const, path: "raw/first.mp4" }, b: { id: "b", kind: "video" as const, path: "raw/second.mp4" }, m: { id: "m", kind: "audio" as const, path: "raw/music.m4a" } };
const avProbes = (f: ReturnType<typeof makeAv>) => ({ a: probeOf("video", f.first, "raw/first.mp4", true), b: probeOf("video", f.second, "raw/second.mp4", true), m: probeOf("audio", f.music, "raw/music.m4a", true) });

it.skipIf(!available)("matches the classic graph for two unmuted clips with embedded audio over a partial range", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-active-window-embedded-audio-"));
  try {
    const f = makeAv(dir);
    const project = createProject({ title: "embedded audio", width: 32, height: 32, fps: 30 });
    project.assets = avAssets;
    project.tracks = [twoClips()];
    await expectActiveAudioEquality(dir, project, avProbes(f), [3, 30], 36);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(!available)("matches the classic graph for a faded audio-track item with the limiter on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-active-window-track-audio-"));
  try {
    const f = makeAv(dir);
    const project = createProject({ title: "track audio", width: 32, height: 32, fps: 30 });
    project.meta.limiter = true;
    project.assets = avAssets;
    project.tracks = [twoClips(true), { id: "au", name: "Audio", kind: "audio", items: [{ id: "m1", assetId: "m", start: 2, duration: 30, sourceIn: 0.1, volume: 1.5, fadeIn: 6, fadeOut: 8 }] }];
    await expectActiveAudioEquality(dir, project, avProbes(f), undefined, 36);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(!available)("matches the classic graph for unmuted clips mixed with an audio-track item", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-active-window-mix-"));
  try {
    const f = makeAv(dir);
    const project = createProject({ title: "mix", width: 32, height: 32, fps: 30 });
    project.assets = avAssets;
    project.tracks = [twoClips(), { id: "au", name: "Audio", kind: "audio", items: [{ id: "m1", assetId: "m", start: 0, duration: 36, sourceIn: 0.2 }] }];
    await expectActiveAudioEquality(dir, project, avProbes(f), [3, 30], 36);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(!available)("matches the classic graph for muted video plus an audio-track item", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-active-window-muted-mix-"));
  try {
    const f = makeAv(dir);
    const project = createProject({ title: "muted mix", width: 32, height: 32, fps: 30 });
    project.assets = avAssets;
    project.tracks = [twoClips(true), { id: "au", name: "Audio", kind: "audio", items: [{ id: "m1", assetId: "m", start: 0, duration: 36, sourceIn: 0.2 }] }];
    await expectActiveAudioEquality(dir, project, avProbes(f), [3, 30], 36);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(!available)("still falls back to the classic graph when a clip has a fade", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-active-window-fade-fallback-"));
  try {
    const f = makeAv(dir);
    const project = createProject({ title: "fade fallback", width: 32, height: 32, fps: 30 });
    project.assets = avAssets;
    project.tracks = [{ id: "v", name: "Video", kind: "video", items: [{ id: "a1", assetId: "a", start: 0, duration: 30, sourceIn: 0, fadeIn: 6 }] }];
    await expectActiveAudioEquality(dir, project, avProbes(f), undefined, 30, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
