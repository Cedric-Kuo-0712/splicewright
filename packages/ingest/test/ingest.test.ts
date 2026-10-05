import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { beatFrames, type AudioItem } from "@splicewright/core";
import { cacheDir, init, load, readAssets, run, writeAtomic } from "@splicewright/core/node";
import { ingest, peek, reverseAudioPath, reverseFile, reverseProjectAudio, stamp, TRANSCRIPT_FORMAT } from "../src/index.ts";

const example = join(import.meta.dirname, "../../../examples/basic");
const venv = join(import.meta.dirname, "../../../ingest/.venv/bin/python");
const hasLibrosa = spawnSync(process.env.SPLICEWRIGHT_PYTHON ?? (existsSync(venv) ? venv : "python3"), ["-c", "import librosa"]).status === 0;
const hasMagick = spawnSync("magick", ["-version"], { stdio: "ignore" }).status === 0;

function project() {
  const dir = join(mkdtempSync(join(tmpdir(), "swr-ingest-")), "p");
  cpSync(example, dir, { recursive: true, filter: (f) => !f.includes(".splicewright") && !f.includes("/out") });
  return dir;
}

describe("ingest", () => {
  it("upgrades legacy image probes once without losing completed ingest steps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swr-image-probe-upgrade-"));
    init(dir, { title: "legacy animation", fps: 30, width: 32, height: 18 });
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=16x16:r=2:d=1", "-loop", "0", join(dir, "loop.gif")]);
    expect(run(dir, "importAsset", { path: "loop.gif" })).not.toHaveProperty("error");
    expect((await ingest(dir, { only: [] })).errors).toBeUndefined();
    const cached = readAssets(dir);
    delete cached.a_loop.animated;
    delete cached.a_loop.imageProbeVersion;
    writeAtomic(cacheDir(dir, "assets.json"), { ...cached, a_loop: { ...cached.a_loop, done: { proxy: cached.a_loop.fingerprint } } });
    const upgraded = await ingest(dir, { only: [] });
    expect(upgraded.errors).toBeUndefined();
    expect(upgraded.steps.probe.ran).toBe(1);
    expect(readAssets(dir).a_loop.animated).toBe(true);
    expect(JSON.parse(readFileSync(cacheDir(dir, "assets.json"), "utf8")).a_loop.done.proxy).toBe(cached.a_loop.fingerprint);
    expect((await ingest(dir, { only: [] })).steps.probe.cached).toBe(1);
  });

  it.skipIf(!hasMagick)("marks only multi-frame GIF and WebP images animated at probe time", async () => {
    const dir = project();
    for (const [name, args] of [
      ["animated.gif", ["-delay", "10", "-size", "2x2", "xc:red", "-delay", "10", "-size", "2x2", "xc:blue", "-loop", "0"]],
      ["still.gif", ["-size", "2x2", "xc:red"]],
      ["animated.webp", ["-delay", "10", "-size", "2x2", "xc:red", "-delay", "10", "-size", "2x2", "xc:blue", "-loop", "0"]],
      ["still.webp", ["-size", "2x2", "xc:red"]],
    ] as const) execFileSync("magick", [...args, join(dir, name)]);
    for (const name of ["animated.gif", "still.gif", "animated.webp", "still.webp"]) expect(run(dir, "importAsset", { path: name })).not.toHaveProperty("error");
    const result = await ingest(dir, { only: [] });
    expect(result.errors).toBeUndefined();
    const probes = readAssets(dir);
    expect(probes.a_animated).toMatchObject({ kind: "image", animated: true });
    expect(probes.a_still).toMatchObject({ kind: "image" });
    expect(probes.a_still.animated).toBeUndefined();
    expect(probes.a_animated_2).toMatchObject({ kind: "image", animated: true });
    expect(probes.a_still_2.animated).toBeUndefined();
  });

  it("reverses numbered frames across chunk boundaries and reverses audio numerically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swr-reverse-"));
    const video = join(dir, "numbered.mkv");
    const reversedVideo = join(dir, "numbered-reversed.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=black:s=32x32:r=1:d=22,format=gray,geq=lum='N*8'", "-frames:v", "22", "-c:v", "ffv1", video]);
    await reverseFile(video, reversedVideo);
    const levels = (path: string) => {
      const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
      return Array.from({ length: raw.length / (32 * 32) }, (_, i) => raw[i * 32 * 32]);
    };
    const forward = levels(video);
    const backward = levels(reversedVideo);
    expect(backward).toHaveLength(22);
    for (let k = 0; k < backward.length; k++) expect(Math.abs(backward[k] - forward[forward.length - 1 - k]), `frame ${k}: reverse=${backward[k]} source=${forward[forward.length - 1 - k]}`).toBeLessThan(15);
    expect(backward[9]).toBeGreaterThan(backward[10]); // crosses the 10 s reversed-chunk join

    const audioRelative = ".splicewright/audio/ramp-hash.m4a";
    const audio = join(dir, audioRelative);
    mkdirSync(join(dir, ".splicewright", "audio"), { recursive: true });
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "aevalsrc='0.8*(0.1+mod(floor(t),22)*0.03)*sin(2*PI*440*t)':s=44100:d=22", "-c:a", "aac", audio]);
    const reversedRelative = await reverseProjectAudio(dir, audioRelative);
    const reversedAudio = join(dir, reversedRelative);
    expect(reverseAudioPath(audioRelative)).toBe(reversedRelative);
    await expect(reverseProjectAudio(dir, "../ramp.m4a")).rejects.toThrow("missing or outside project");
    const decoded = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", reversedAudio, "-f", "f32le", "-acodec", "pcm_f32le", "-"], { maxBuffer: 8 * 1024 * 1024 });
    const samples = new Float32Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 4);
    const rms = (second: number) => {
      const start = Math.round((second + 0.15) * 44100), end = Math.round((second + 0.85) * 44100);
      return Math.sqrt(samples.slice(start, end).reduce((sum, x) => sum + x * x, 0) / (end - start));
    };
    for (const second of [0, 9, 10, 11, 20]) expect(Math.abs(rms(second) - (0.8 * (0.1 + (21 - second) * 0.03)) / Math.sqrt(2))).toBeLessThan(0.025);
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("does not send LUT assets to ffprobe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swr-lut-ingest-"));
    init(dir, { title: "lut only", fps: 30, width: 320, height: 180 });
    writeFileSync(join(dir, "identity.cube"), `LUT_3D_SIZE 2\n${Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`).join("\n")}\n`);
    expect(run(dir, "importAsset", { path: "identity.cube" })).not.toHaveProperty("error");
    const result = await ingest(dir);
    expect(result.errors).toBeUndefined();
    expect(result.steps.probe).toMatchObject({ ran: 0, skipped: 1, failed: 0 });
    expect(readAssets(dir).a_identity).toBeUndefined();
  });

  it("probes, builds ffmpeg caches, and skips unchanged assets", async () => {
    const dir = project();
    const only = ["proxy", "reverse", "thumbs", "waveform"] as const;
    const first = await ingest(dir, { only: [...only] });
    expect(first.errors).toBeUndefined();
    expect(first.steps.proxy).toMatchObject({ ran: 1 });
    expect(first.steps.reverse).toMatchObject({ ran: 1 });
    const probe = readAssets(dir).a_clip;
    expect(probe).toMatchObject({ kind: "video", duration: 2, width: 320, height: 180, fps: 30 });
    for (const f of ["proxies/edit/a_clip.mp4", "proxies/reverse/a_clip.mp4", "thumbs/a_clip/1.jpg", "contact-sheets/a_clip.jpg"]) expect(existsSync(join(dir, ".splicewright", f))).toBe(true);

    const again = await ingest(dir, { only: [...only] });
    expect(again.steps).toMatchObject({ probe: { ran: 0, cached: 1 }, proxy: { ran: 0, cached: 1 }, reverse: { ran: 0, cached: 1 }, thumbs: { cached: 1 } });
    // insertItem can now default the duration from the probe.
    expect(run(dir, "insertItem", { assetId: "a_clip", at: 500 })).toMatchObject({ changes: { summary: expect.stringContaining("(60f)") } });
  }, 60_000);

  it("default ingest builds a reverse proxy only for a video a reversed item uses", async () => {
    const dir = project();
    expect((await ingest(dir, { only: ["proxy"] })).steps.proxy).toMatchObject({ ran: 1 });
    const unused = await ingest(dir);
    expect(unused.steps.reverse).toMatchObject({ ran: 0, skipped: 1 });
    expect(existsSync(join(dir, ".splicewright/proxies/reverse/a_clip.mp4"))).toBe(false);
    expect(run(dir, "setProps", { itemId: "i_1", patch: { reverse: true } })).not.toHaveProperty("error");
    // Default ingest also runs transcript/beats, whose Python deps may be absent; only reverse matters here.
    const used = await ingest(dir);
    expect(used.steps.reverse).toMatchObject({ ran: 1, failed: 0 });
    expect(existsSync(join(dir, ".splicewright/proxies/reverse/a_clip.mp4"))).toBe(true);
  }, 60_000);

  it("loudness caches integrated LUFS like a direct ebur128 run, and skips silent assets", async () => {
    const dir = project();
    const r = await ingest(dir, { only: ["loudness"] });
    expect(r.errors).toBeUndefined();
    const direct = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", join(dir, "clip.mp4"), "-vn", "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const want = +/Integrated loudness:\s+I:\s+(\S+) LUFS/.exec(direct)![1];
    const got = readAssets(dir).a_clip.loudness!;
    expect(Math.abs(got - want)).toBeLessThanOrEqual(0.1);
    expect((await ingest(dir, { only: ["loudness"] })).steps.loudness).toMatchObject({ ran: 0, cached: 1 });
    // digital silence reads -70 (the gate floor): no value, but the step still counts as done
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=d=1", join(dir, "silent.wav")]);
    run(dir, "importAsset", { path: "silent.wav" });
    const s = await ingest(dir, { only: ["loudness"] });
    expect(s.errors).toBeUndefined();
    expect(readAssets(dir).a_silent.loudness).toBeUndefined();
    expect((readAssets(dir).a_silent as { done?: Record<string, string> }).done?.loudness).toBeDefined();
  }, 60_000);

  it("keeps entries another process wrote to assets.json while this run was probing", async () => {
    const dir = project();
    const other = { path: "raw/other.mp4", fingerprint: "abc", kind: "video", duration: 3 };
    // `log` runs after the probe and before the save, which is where a second ingest's write would land.
    const r = await ingest(dir, {
      only: [],
      log: () => (mkdirSync(cacheDir(dir), { recursive: true }), writeAtomic(cacheDir(dir, "assets.json"), { a_other: other })),
    });
    expect(r.errors).toBeUndefined();
    expect(readAssets(dir)).toMatchObject({ a_clip: { kind: "video", duration: 2 }, a_other: other });
  }, 60_000);

  it("peek reads the analysis proxy when spacing allows, else the source, and reports shown times", async () => {
    const dir = project();
    const before = await peek(dir, "a_clip", { n: 2 }); // no proxy yet
    expect(before).toMatchObject({ source: "source", times: [0.5, 1.5] });
    await ingest(dir, { only: ["analysis"] });
    expect(await peek(dir, "a_clip", { n: 2 })).toMatchObject({ source: "analysis proxy", times: [0, 1] }); // 1 fps frames
    expect(await peek(dir, "a_clip", { n: 4 })).toMatchObject({ source: "source", times: [0.25, 0.75, 1.25, 1.75] });
    expect(before.image.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG
    await expect(peek(dir, "a_clip", { from: 3 })).rejects.toThrow("empty range");
  }, 30_000);

  it("re-points a moved file by fingerprint instead of importing it twice", async () => {
    const dir = project();
    await ingest(dir, { only: [] });
    renameSync(join(dir, "clip.mp4"), join(dir, "moved.mp4"));
    expect(run(dir, "importAsset", { path: "moved.mp4" })).toMatchObject({ changes: { summary: "re-pointed a_clip from clip.mp4 (missing) to moved.mp4" } });
    expect(Object.keys(load(dir).assets)).toEqual(["a_clip"]);
  }, 30_000);

  // §15.5: 120 BPM clicks starting at 0.25 s, accent every 4th; beats within ±1 frame, downbeats on accents.
  it.skipIf(!hasLibrosa)("detects a synthetic click track within one frame", async () => {
    const dir = project();
    const expr =
      "gte(t,0.25)*exp(-mod(t-0.25,0.5)*60)*if(eq(mod(floor((t-0.25)/0.5),4),0),0.9*sin(2*PI*80*t)+0.3*sin(2*PI*2000*t),0.5*sin(2*PI*1500*t))";
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", `aevalsrc='${expr}':s=44100:d=20`, "-c:a", "aac", join(dir, "click.m4a")]);
    run(dir, "importAsset", { path: "click.m4a" });
    const r = await ingest(dir, { only: ["beats"] });
    expect(r.errors).toBeUndefined();
    const analysis = JSON.parse(readFileSync(join(dir, ".splicewright/beats/a_click.json"), "utf8"));
    const fps = load(dir).meta.fps;
    const truth = Array.from({ length: 40 }, (_, k) => 0.25 + k * 0.5);
    const beats: number[] = analysis.beats.map((b: { t: number }) => b.t);
    expect(beats.length).toBe(40);
    for (const t of beats) expect(Math.min(...truth.map((x) => Math.abs(x - t))) * fps).toBeLessThanOrEqual(1);
    for (const t of analysis.downbeats) expect(Math.round((t - 0.25) / 0.5) % 4).toBe(0);
    expect(analysis.tempo).toBeCloseTo(120, 0);

    // And through the ops: detectBeats puts them on the timeline.
    run(dir, "insertItem", { assetId: "a_click", at: 0, trackId: load(dir).tracks.find((t) => t.kind === "audio")!.id });
    const song = () => load(dir).tracks.find((t) => t.kind === "audio")!.items[0] as AudioItem;
    run(dir, "detectBeats", { itemId: song().id, density: "downbeat" });
    const item = song();
    expect(beatFrames(load(dir), item)).toEqual([8, 68, 128, 188, 248, 308, 368, 428, 488, 548]);
  }, 60_000);
});

it("a transcript is done only at the current format, so word-less transcripts re-run", () => {
  expect(stamp("abc", "transcript")).toBe(`abc#t${TRANSCRIPT_FORMAT}`);
  expect(stamp("abc", "transcript")).not.toBe("abc"); // what a pre-words run recorded
  expect(stamp("abc", "waveform")).toBe("abc");
});
