import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HEIF, type Asset } from "@splicewright/core";
import { cacheDir, fingerprint, load, rawPath, readAssets, writeAtomic, type Probe, type SourceHealth } from "@splicewright/core/node";
import { audioFxPath, ensureAudioFx } from "./audio-fx.ts";
import { createIngestLimiter, limiter, withFfmpegResourceLimits } from "./resource.ts";
import { measureFinalMix, measureSourceHealth } from "./source-health.ts";
export { TTS_LANGUAGES, TTS_VOICES, generateAndInsertTTS, setupTTS, ttsStatus, validateTTSRequest, type TtsLanguage, type TtsRequest, type TtsStatus } from "./tts.ts";

// Spec §8. ffmpeg steps run here; transcript and beats need Python libraries and run ingest/*.py.
// Every step is cached by content fingerprint: a probe entry records, per step, the fingerprint it ran on.

export const STEPS = ["sourceHealth", "proxy", "reverse", "analysis", "thumbs", "waveform", "transcript", "beats", "loudness", "audioFx"] as const;
export type Step = (typeof STEPS)[number];
type Entry = Probe & { done?: Partial<Record<Step, string>> };

/** Shape of ingest/transcribe.py's output; bump when it changes so cached transcripts re-run (2: word timestamps). */
export const TRANSCRIPT_FORMAT = 2;
const IMAGE_PROBE_FORMAT = 1;
const SOURCE_HEALTH_FORMAT = 1;
/** What a step records as done: the content fingerprint, plus the format version for transcripts. */
export const stamp = (fingerprint: string, step: Step) => step === "transcript" ? `${fingerprint}#t${TRANSCRIPT_FORMAT}` : step === "sourceHealth" ? `${fingerprint}#h${SOURCE_HEALTH_FORMAT}` : fingerprint;

const pyDir = join(dirname(fileURLToPath(import.meta.url)), "../../../ingest");

export { limiter } from "./resource.ts";

function exec(cmd: string, args: string[], onData?: (b: Buffer) => void, onErr?: (b: Buffer) => void): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", onData ?? ((d) => (out += d)));
    p.stderr.on("data", (d) => (onErr?.(d), (err = (err + d).slice(-400))));
    p.on("error", fail);
    p.on("close", (code) => (code === 0 ? ok(out) : fail(Object.assign(new Error(err.trim().slice(-400) || `${cmd} exited ${code}`), { code, out }))));
  });
}

/** Apply a per-process codec/filter thread ceiling; SPLICEWRIGHT_FFMPEG_THREADS tunes it for measurement. */
export const ffmpeg = (args: string[], onData?: (b: Buffer) => void) => exec("ffmpeg", ["-loglevel", "error", "-y", ...withFfmpegResourceLimits(args)], onData);

/** The path to import for a project-relative `path`: HEIC/HEIF becomes a JPEG in raw/ (the original stays), anything else is itself. */
export async function displayable(dir: string, path: string): Promise<string> {
  if (!HEIF.test(path)) return path;
  mkdirSync(join(dir, "raw"), { recursive: true });
  const tmp = join(dir, "raw", `.heif-${process.pid}-${Date.now()}.jpg`);
  await ffmpeg(["-i", join(dir, path), "-frames:v", "1", "-q:v", "2", tmp]);
  return rawPath(dir, basename(path).replace(HEIF, ".jpg"), tmp);
}

// ---------- agent views ----------

/** `n` evenly spaced points in [from, to), each in the middle of its slice. */
export const spread = (from: number, to: number, n: number) => Array.from({ length: n }, (_, k) => from + ((k + 0.5) * (to - from)) / n);

/**
 * Tiles `<k>.jpg` (k = 0..n-1) from `dir` into one JPEG, row-major, up to 4 per row.
 * ponytail: no burned-in labels (this ffmpeg has no drawtext); callers return the tile times as text.
 */
export async function grid(dir: string, n: number): Promise<Buffer> {
  const cols = Math.min(4, n);
  const out = join(dir, "grid.jpg");
  await ffmpeg(["-framerate", "1", "-i", join(dir, "%d.jpg"), "-vf", `tile=${cols}x${Math.ceil(n / cols)}:padding=4`, "-frames:v", "1", "-q:v", "4", out]);
  return readFileSync(out);
}

/** A temp dir for one call's frames, removed afterwards. */
export async function scratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "swr-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A grid of `n` frames from a video asset's source seconds [from, to), 320 px per tile. Reads the analysis
 * proxy when its frame spacing is fine enough (and it is current), else decodes the source.
 */
export async function peek(dir: string, assetId: string, { from = 0, to, n = 12 }: { from?: number; to?: number; n?: number } = {}) {
  const asset = load(dir).assets[assetId];
  if (!asset) throw new Error(`asset ${assetId} not found`);
  if (asset.kind !== "video") throw new Error(`${assetId} is ${asset.kind}; peek reads video assets`);
  const e = readAssets(dir)[assetId] as Entry | undefined;
  const duration = e?.duration ?? (await probe(join(dir, asset.path), "video")).duration ?? 0;
  to = Math.min(to ?? duration, duration);
  if (!(to > from)) throw new Error(`empty range [${from}, ${to}) in ${assetId} (${duration.toFixed(2)} s)`);
  n = Math.max(1, Math.min(24, Math.round(n)));
  const step = analysisStep(duration);
  const proxy = cacheDir(dir, "proxies", "analysis", `${assetId}.mp4`);
  const useProxy = (to - from) / n >= step && existsSync(proxy) && !!e && e.done?.analysis === e.fingerprint;
  // The proxy holds a frame every `step` s; report the frame actually shown, not the requested time.
  const last = useProxy ? Math.floor((duration - 1e-3) / step) * step : duration - 0.05;
  const times = spread(from, to, n).map((t) => +Math.min(useProxy ? Math.floor(t / step) * step : t, last).toFixed(2));
  const image = await scratch(async (tmp) => {
    await Promise.all(
      times.map((t, k) =>
        ffmpeg(["-ss", String(t), "-i", useProxy ? proxy : join(dir, asset.path), "-frames:v", "1", "-vf", "scale=320:320:force_original_aspect_ratio=decrease", "-q:v", "5", join(tmp, `${k}.jpg`)]),
      ),
    );
    return grid(tmp, n);
  });
  return { image, times, source: useProxy ? "analysis proxy" : "source" };
}

// ---------- probe ----------

export async function probe(file: string, kind: Asset["kind"]): Promise<Omit<Probe, "path" | "fingerprint">> {
  if (kind === "font") {
    const data = readFileSync(file);
    const magic = data.subarray(0, 4).toString("ascii");
    if (!(magic === "wOFF" || magic === "wOF2" || magic === "OTTO" || magic === "true" || data.readUInt32BE(0) === 0x00010000))
      throw new Error("invalid font file: expected TrueType, OpenType, WOFF, or WOFF2 data");
    return { kind };
  }
  const info = JSON.parse(await exec("ffprobe", ["-v", "error", ...(kind === "image" ? ["-count_frames"] : []), "-print_format", "json", "-show_format", "-show_streams", file]));
  const v = info.streams.find((s: any) => s.codec_type === "video");
  if ((kind === "video" || kind === "image") && (!v?.width || !v.height)) throw new Error(`source declared as ${kind} has no readable visual stream`);
  if (kind === "audio" && !info.streams.some((s: any) => s.codec_type === "audio")) throw new Error("source declared as audio has no readable audio stream");
  const [num, den] = String(v?.avg_frame_rate ?? "0/1").split("/").map(Number);
  const rotation = v?.side_data_list?.find((d: any) => "rotation" in d)?.rotation ?? (v?.tags?.rotate ? Number(v.tags.rotate) : undefined);
  const duration = Number(info.format.duration);
  return {
    kind,
    ...(kind !== "image" && Number.isFinite(duration) && { duration }),
    ...(v && { width: v.width, height: v.height }),
    ...(kind === "image" && Number(v?.nb_read_frames ?? v?.nb_frames ?? 0) > 1 && { animated: true }),
    ...(kind === "image" && { imageProbeVersion: IMAGE_PROBE_FORMAT }),
    ...(kind === "video" && den && num && { fps: +(num / den).toFixed(3) }),
    ...(rotation && { rotation }),
    audio: info.streams.some((s: any) => s.codec_type === "audio"),
  };
}

// ---------- ffmpeg steps ----------

/** Short side to `n` px (portrait phone footage stays portrait). */
const shortSide = (n: number) => `scale='if(gt(iw,ih),-2,${n})':'if(gt(iw,ih),${n},-2)'`;

let videotoolbox: Promise<boolean> | undefined;

/** 540p, source fps, all-intra (every frame a keyframe) so scrubbing never decodes a GOP. */
async function editProxy(src: string, out: string) {
  // Detected, not assumed (§8): the encoder must be listed, and a failed hardware encode falls back to x264.
  videotoolbox ??= exec("ffmpeg", ["-hide_banner", "-encoders"]).then((s) => s.includes("h264_videotoolbox"), () => false);
  const common = ["-i", src, "-vf", `${shortSide(540)},format=yuv420p`, "-g", "1", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"];
  // ponytail: VideoToolbox or CPU only; add h264_nvenc when someone ingests on a CUDA box.
  if (await videotoolbox) {
    try {
      return await ffmpeg([...common, "-c:v", "h264_videotoolbox", "-b:v", "6M", out]);
    } catch {}
  }
  await ffmpeg([...common, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", out]);
}

/** Reverse a source with bounded memory: reverse each ~10 s decoded chunk, then concatenate chunks backwards. */
export async function reverseFile(src: string, out: string) {
  const info = JSON.parse(await exec("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", src]));
  const video = info.streams.find((s: any) => s.codec_type === "video");
  const duration = Number(video?.duration ?? info.format.duration);
  const audio = info.streams.some((s: any) => s.codec_type === "audio");
  if (!Number.isFinite(duration) || duration <= 0 || (!video && !audio)) throw new Error(`cannot reverse media with duration ${duration}`);
  await scratch(async (tmp) => {
    const sourcePattern = join(tmp, `source-%06d.${video ? "mkv" : "wav"}`);
    const split = ["-i", src];
    if (video) split.push("-map", "0:v:0", "-c:v", "ffv1", "-g", "1", "-force_key_frames", "expr:gte(t,n_forced*10)");
    if (audio) split.push("-map", "0:a:0", "-c:a", "pcm_s16le");
    split.push("-f", "segment", "-segment_time", "10", "-reset_timestamps", "1");
    if (video) split.push("-segment_format", "matroska");
    else split.push("-segment_format", "wav");
    await ffmpeg([...split, sourcePattern]);
    const sourceChunks = readdirSync(tmp).filter((name) => name.startsWith("source-")).sort();
    if (!sourceChunks.length) throw new Error("ffmpeg produced no reverse chunks");
    const reversed: string[] = [];
    for (const [index, name] of sourceChunks.entries()) {
      const path = join(tmp, `reverse-${String(index).padStart(6, "0")}.mkv`);
      const args = ["-i", join(tmp, name)];
      if (video) args.push("-map", "0:v:0", "-vf", "reverse", "-c:v", "ffv1", "-g", "1");
      if (audio) args.push("-map", "0:a:0", "-af", "areverse", "-c:a", "pcm_s16le");
      args.push("-f", "matroska", path);
      await ffmpeg(args);
      rmSync(join(tmp, name));
      reversed.push(path);
    }
    const list = join(tmp, "concat.txt");
    writeFileSync(list, reversed.reverse().map((path) => `file '${path}'`).join("\n") + "\n");
    const args = ["-f", "concat", "-safe", "0", "-i", list];
    if (video) args.push("-map", "0:v:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p");
    else args.push("-vn");
    if (audio) args.push("-map", "0:a:0", "-c:a", "aac", "-b:a", "192k");
    else args.push("-an");
    args.push("-movflags", "+faststart", out);
    await ffmpeg(args);
  });
}

/** Stable companion name for a hash-addressed, project-relative audio bake. */
export function reverseAudioPath(projectPath: string): string {
  if (!projectPath.toLowerCase().endsWith(".m4a")) throw new Error(`reverse audio requires an .m4a path: ${projectPath}`);
  return `${projectPath.slice(0, -4)}-reverse.m4a`;
}

/** Ensure a reverse-ordered companion for a project-relative processed audio file. */
export async function reverseProjectAudio(dir: string, projectPath: string): Promise<string> {
  const root = realpathSync(dir);
  const sourcePath = resolve(root, projectPath);
  if (relative(root, sourcePath).startsWith("..") || !existsSync(sourcePath)) throw new Error(`processed audio is missing or outside project: ${projectPath}`);
  const source = realpathSync(sourcePath);
  if (relative(root, source).startsWith("..")) throw new Error(`processed audio is missing or outside project: ${projectPath}`);
  const outputPath = reverseAudioPath(projectPath);
  const outputPathOnDisk = resolve(root, outputPath);
  mkdirSync(dirname(outputPathOnDisk), { recursive: true });
  const outputDir = realpathSync(dirname(outputPathOnDisk));
  if (relative(root, outputDir).startsWith("..")) throw new Error(`reverse audio output is outside project: ${outputPath}`);
  const output = join(outputDir, basename(outputPathOnDisk));
  if (!existsSync(output)) {
    const temp = `${output.slice(0, -4)}.tmp-${process.pid}.m4a`;
    try {
      await reverseFile(source, temp);
      renameSync(temp, output);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
  return outputPath;
}

/** Seconds between analysis-proxy frames. */
const analysisStep = (duration = 0) => (duration > 60 ? 2 : 1);

/** 360p at 0.5–1 fps: cheap frames for agent visual inspection (read by `peek`). */
const analysisProxy = (src: string, out: string, duration = 0) =>
  ffmpeg(["-i", src, "-vf", `fps=${1 / analysisStep(duration)},${shortSide(360)}`, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", out]);

/** One 72 px thumbnail per source second, named `<second>.jpg` (what the timeline requests), plus a 4×3 contact sheet. */
async function thumbs(src: string, outDir: string, sheet: string, duration = 1) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  await ffmpeg(["-i", src, "-vf", "fps=1,scale=-2:72", "-q:v", "6", "-start_number", "0", join(outDir, "%d.jpg")]);
  mkdirSync(dirname(sheet), { recursive: true });
  await ffmpeg(["-i", src, "-vf", `fps=${12 / Math.max(duration, 0.1)},scale=320:-2,tile=4x3`, "-frames:v", "1", "-q:v", "4", sheet]);
}

/** A single thumbnail at source second `t`, for the UI when ingest hasn't run. */
export async function thumb(dir: string, assetId: string, path: string, t: number, run = limiter(1)): Promise<string> {
  const out = cacheDir(dir, "thumbs", assetId, `${t}.jpg`);
  if (!existsSync(out)) {
    mkdirSync(dirname(out), { recursive: true });
    await run(() => ffmpeg(["-ss", String(t), "-i", join(dir, path), "-frames:v", "1", "-vf", "scale=-2:72", "-q:v", "6", out]));
  }
  return out;
}

const WAVE_RATE = 100; // peaks per second

/** Peaks 0–255 at 100/s from 4 kHz mono: `{ rate, peaks }`. */
export async function waveform(dir: string, assetId: string, path: string, run = limiter(1), force = false): Promise<string> {
  const out = cacheDir(dir, "waveforms", `${assetId}.json`);
  if (existsSync(out) && !force) return out;
  const per = 4000 / WAVE_RATE;
  const peaks: number[] = [];
  let [max, n] = [0, 0];
  let carry: Buffer | null = null;
  await run(() =>
    ffmpeg(["-i", join(dir, path), "-vn", "-ac", "1", "-ar", "4000", "-f", "s16le", "pipe:1"], (chunk) => {
      const b: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
      const whole = b.length & ~1;
      for (let i = 0; i < whole; i += 2) {
        max = Math.max(max, Math.abs(b.readInt16LE(i)));
        if (++n === per) peaks.push(Math.round((max / 32768) * 255)), (max = 0), (n = 0);
      }
      carry = whole < b.length ? b.subarray(whole) : null;
    }),
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ rate: WAVE_RATE, peaks }));
  return out;
}

/** Integrated loudness in LUFS from ebur128's summary; undefined when the audio is silent (ebur128 floors it at -70, sometimes prints -inf). */
export async function loudness(file: string): Promise<number | undefined> {
  let tail = "";
  await exec("ffmpeg", withFfmpegResourceLimits(["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "ebur128", "-f", "null", "-"]), undefined, (d) => (tail = (tail + d).slice(-2000)));
  const m = /Integrated loudness:\s+I:\s+(\S+) LUFS/.exec(tail);
  if (!m) throw new Error("ebur128 printed no summary");
  return +m[1] > -70 ? +m[1] : undefined;
}

// ---------- python steps ----------

const python = () => process.env.SPLICEWRIGHT_PYTHON ?? (existsSync(join(pyDir, ".venv/bin/python")) ? join(pyDir, ".venv/bin/python") : "python3");

/** Runs ingest/<script>.py over [input, output] pairs; returns the outputs it wrote, or why it could not run. */
async function py(script: string, pairs: [string, string][], log: (s: string) => void): Promise<{ written: Set<string>; missing?: string }> {
  const written = new Set<string>();
  const lines = (s: string) => s.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  try {
    const out = await exec(python(), [join(pyDir, `${script}.py`), ...pairs.flat()]);
    for (const l of lines(out)) l.ok ? written.add(l.ok) : log(`${script}: ${l.error}: ${l.message}`);
    return { written };
  } catch (e: any) {
    const missing = e.code === 3 ? lines(e.out ?? "")[0]?.missing : undefined;
    return { written, missing: missing ? `python module ${missing}; pip install -r ingest/requirements.txt (python: ${python()})` : e.message };
  }
}

// ---------- pipeline ----------

export interface IngestOptions {
  only?: Step[];
  /** Asset ids; default all. */
  assets?: string[];
  /** Concurrent ffmpeg jobs; defaults to max(1, min(2, cores − 2)); positive integer only. */
  jobs?: number;
  log?: (line: string) => void;
}

type Tally = { ran: number; cached: number; skipped: number; failed: number };

/** Probe every asset, then run the requested steps on whatever changed since they last ran. */
export async function ingest(dir: string, opts: IngestOptions = {}) {
  const log = opts.log ?? (() => {});
  const run = createIngestLimiter(opts.jobs);
  const steps = new Set(opts.only ?? STEPS);
  const project = load(dir);
  const assets = Object.values(project.assets).filter((a) => a.kind !== "lut" && (!opts.assets || opts.assets.includes(a.id)));
  const cache: Record<string, Entry> = readAssets(dir);
  const tally = Object.fromEntries(["probe", ...steps].map((s) => [s, { ran: 0, cached: 0, skipped: 0, failed: 0 } as Tally]));
  tally.probe.skipped += Object.values(project.assets).filter((a) => a.kind === "lut" && (!opts.assets || opts.assets.includes(a.id))).length;
  const errors: string[] = [];
  const fail = (step: string, id: string, e: unknown) => (tally[step].failed++, errors.push(`${step} ${id}: ${(e as Error).message ?? e}`));
  /** Ids whose entry this run changed. */
  const dirty = new Set<string>();
  // Merge into what is on disk now, not the snapshot from the start: another process (MCP, web) may have
  // probed other assets meanwhile, and writing the whole snapshot back would drop them.
  // ponytail: read-merge-rename is not a lock; two saves in the same instant can still lose an entry. Add a lockfile if that shows up.
  const save = () => {
    const disk = readAssets(dir);
    for (const id of dirty) disk[id] = cache[id];
    mkdirSync(cacheDir(dir), { recursive: true });
    writeAtomic(cacheDir(dir, "assets.json"), disk);
  };

  // probe
  const ready: Entry[] = [];
  await Promise.all(
    assets.map(async (a) => {
      const src = join(dir, a.path);
      const fp = fingerprint(src);
      if (!fp) return fail("probe", a.id, new Error(`${a.path} not found`));
      if (cache[a.id]?.fingerprint === fp && cache[a.id].path === a.path && (a.kind !== "image" || cache[a.id].imageProbeVersion === IMAGE_PROBE_FORMAT)) {
        const health = cache[a.id].sourceHealth;
        if (health?.method === "ffprobe" && health.decode.status === "failed")
          return fail("probe", a.id, new Error(`cached probe failure: ${health.decode.error}`));
        tally.probe.cached++;
        return ready.push(cache[a.id]);
      }
      try {
        const same = cache[a.id]?.fingerprint === fp ? cache[a.id] : undefined; // renamed, same content
        const priorHealth = same?.sourceHealth?.fingerprint === fp ? { ...same.sourceHealth, path: a.path } : undefined;
        cache[a.id] = { path: a.path, fingerprint: fp, ...(await run(() => probe(src, a.kind))), ...(same?.done && { done: same.done }), ...(same?.loudness !== undefined && { loudness: same.loudness }), ...(priorHealth && { sourceHealth: priorHealth }) };
        dirty.add(a.id);
        tally.probe.ran++;
        log(`probe ${a.id}`);
        ready.push(cache[a.id]);
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        cache[a.id] = {
          path: a.path,
          fingerprint: fp,
          kind: a.kind as Probe["kind"],
          done: { sourceHealth: stamp(fp, "sourceHealth") },
          sourceHealth: {
            format: SOURCE_HEALTH_FORMAT, method: "ffprobe", path: a.path, fingerprint: fp, measuredAt: new Date().toISOString(),
            decode: { status: "failed", error: message },
            audio: a.kind === "audio" ? { status: "failed", error: message } : a.kind === "video" ? { status: "unmeasured" } : { status: "none" },
          },
        };
        dirty.add(a.id);
        if (steps.has("sourceHealth")) tally.sourceHealth.failed++;
        fail("probe", a.id, e);
      }
    }),
  );
  save();

  const idOf = new Map(ready.map((e) => [e, Object.keys(cache).find((k) => cache[k] === e)!]));
  // A reverse proxy costs several times the source decode; build it on request or for reversed items only.
  const reversed = new Set(project.tracks.flatMap((t) => t.items.flatMap((i) => ("reverse" in i && i.reverse ? [i.assetId] : []))));
  // loudness has no file: its value lives on the probe entry.
  const outputs: Record<Exclude<Step, "loudness" | "audioFx" | "sourceHealth">, (id: string) => string> = {
    proxy: (id) => cacheDir(dir, "proxies", "edit", `${id}.mp4`),
    reverse: (id) => cacheDir(dir, "proxies", "reverse", `${id}.mp4`),
    analysis: (id) => cacheDir(dir, "proxies", "analysis", `${id}.mp4`),
    thumbs: (id) => cacheDir(dir, "contact-sheets", `${id}.jpg`),
    waveform: (id) => cacheDir(dir, "waveforms", `${id}.json`),
    transcript: (id) => cacheDir(dir, "transcripts", `${id}.json`),
    beats: (id) => cacheDir(dir, "beats", `${id}.json`),
  };
  const applies: Record<Exclude<Step, "audioFx">, (e: Entry) => boolean> = {
    sourceHealth: (e) => e.kind !== "font",
    proxy: (e) => e.kind === "video",
    reverse: (e) => e.kind === "video" && (!!opts.only?.includes("reverse") || reversed.has(idOf.get(e)!)),
    analysis: (e) => e.kind === "video",
    thumbs: (e) => e.kind === "video",
    waveform: (e) => e.kind !== "image" && !!e.audio,
    transcript: (e) => (e.kind === "video" || e.kind === "audio") && !!e.audio,
    beats: (e) => e.kind === "audio",
    loudness: (e) => e.kind !== "image" && !!e.audio,
  };
  /** Entries this step still has to process; the rest are tallied as cached or skipped. */
  const todo = (step: Exclude<Step, "audioFx">) =>
    ready.filter((e) => {
      if (!applies[step](e)) return tally[step].skipped++, false;
      if (e.done?.[step] === stamp(e.fingerprint, step) && (step === "loudness" || step === "sourceHealth" || existsSync(outputs[step](idOf.get(e)!)))) {
        if (step === "sourceHealth") {
          if (!e.sourceHealth || e.sourceHealth.format !== SOURCE_HEALTH_FORMAT) return true;
          if (e.sourceHealth.decode.status === "failed") errors.push(`sourceHealth ${idOf.get(e)!}: cached decode failure: ${e.sourceHealth.decode.error}`);
          else if (e.sourceHealth.audio.status === "failed") errors.push(`sourceHealth ${idOf.get(e)!}: cached audio measurement failure: ${e.sourceHealth.audio.error}`);
        }
        tally[step].cached++;
        if (step === "sourceHealth" && e.sourceHealth?.decode.status === "failed") {
          tally.sourceHealth.failed++;
          errors.push(`sourceHealth ${idOf.get(e)!}: ${e.sourceHealth.decode.error}`);
        }
        return false;
      }
      return true;
    });
  const mark = (e: Entry, step: Step) => (dirty.add(idOf.get(e)!), ((e.done ??= {})[step] = stamp(e.fingerprint, step)));

  if (steps.has("sourceHealth"))
    await Promise.all(todo("sourceHealth").map(async (e) => {
      const id = idOf.get(e)!;
      try {
        const health = await run(() => measureSourceHealth(join(dir, e.path), e.path, e.fingerprint, !!e.audio));
        e.sourceHealth = health;
        mark(e, "sourceHealth");
        if (health.decode.status === "failed") fail("sourceHealth", id, new Error(health.decode.error));
        else tally.sourceHealth.ran++, log(`sourceHealth ${id}${health.audio.status === "measured" ? ` (true peak ${health.audio.truePeak.dbfs ?? "silent"} dBFS)` : " (no audio)"}`);
      } catch (err) {
        // `measureSourceHealth` returns decode failures as data; this catches process-launch failures only.
        const message = (err as Error).message ?? String(err);
        e.sourceHealth = {
          format: SOURCE_HEALTH_FORMAT, method: "ffmpeg", path: e.path, fingerprint: e.fingerprint, measuredAt: new Date().toISOString(),
          decode: { status: "failed", error: message },
          audio: e.audio ? { status: "failed", error: message } : { status: "none" },
        } satisfies SourceHealth;
        mark(e, "sourceHealth");
        fail("sourceHealth", id, err);
      }
    }));
  save();

  const ff: Record<"proxy" | "reverse" | "analysis" | "thumbs" | "waveform", (e: Entry, id: string, out: string) => Promise<unknown>> = {
    proxy: (e, _, out) => run(() => editProxy(join(dir, e.path), out)),
    reverse: (e, _, out) => run(() => reverseFile(join(dir, e.path), out)),
    analysis: (e, _, out) => run(() => analysisProxy(join(dir, e.path), out, e.duration)),
    thumbs: (e, id, out) => run(() => thumbs(join(dir, e.path), cacheDir(dir, "thumbs", id), out, e.duration)),
    waveform: (e, id) => waveform(dir, id, e.path, run, true),
  };
  await Promise.all(
    (["proxy", "reverse", "analysis", "thumbs", "waveform"] as const).filter((s) => steps.has(s)).flatMap((step) =>
      todo(step).map(async (e) => {
        const id = idOf.get(e)!;
        const out = outputs[step](id);
        mkdirSync(dirname(out), { recursive: true });
        try {
          await ff[step](e, id, out);
          mark(e, step);
          tally[step].ran++;
          log(`${step} ${id}`);
        } catch (err) {
          rmSync(out, { force: true }); // never leave a half-written proxy that looks done
          fail(step, id, err);
        }
      }),
    ),
  );
  save();

  if (steps.has("loudness"))
    await Promise.all(
      todo("loudness").map(async (e) => {
        const id = idOf.get(e)!;
        try {
          const l = await run(() => loudness(join(dir, e.path)));
          if (l === undefined) delete e.loudness;
          else e.loudness = l;
          mark(e, "loudness");
          tally.loudness.ran++;
          log(`loudness ${id}${l === undefined ? " (silent)" : ""}`);
        } catch (err) {
          fail("loudness", id, err);
        }
      }),
    );
  save();

  for (const step of ["transcript", "beats"] as const) {
    if (!steps.has(step)) continue;
    const list = todo(step);
    if (!list.length) continue;
    const pairs = list.map((e): [string, string] => [join(dir, e.path), outputs[step](idOf.get(e)!)]);
    mkdirSync(dirname(pairs[0][1]), { recursive: true });
    log(`${step}: ${list.length} assets`);
    const { written, missing } = await py(step === "beats" ? "beats" : "transcribe", pairs, log);
    list.forEach((e, i) => {
      if (written.has(pairs[i][1])) mark(e, step), tally[step].ran++;
      else if (missing) tally[step].skipped++;
      else fail(step, idOf.get(e)!, new Error("no output; see log"));
    });
    if (missing) errors.push(`${step} skipped: ${missing}`);
    save();
  }

  if (steps.has("audioFx")) {
    const items = project.tracks.flatMap((track) => track.items.flatMap((item) =>
      "audioFx" in item && item.audioFx && "assetId" in item && (!opts.assets || opts.assets.includes(item.assetId))
        ? [{ item, asset: project.assets[item.assetId] }]
        : [],
    )).filter((x) => !!x.asset);
    await Promise.all(items.map(async ({ item, asset }) => {
      const id = item.id;
      try {
        const output = audioFxPath(dir, asset.id, asset.path, item.audioFx!);
        const reverse = "reverse" in item && item.reverse;
        if (existsSync(join(dir, output)) && existsSync(join(dir, `${output}.json`)) && (!reverse || existsSync(join(dir, reverseAudioPath(output))))) {
          tally.audioFx.cached++;
          return;
        }
        const made = await run(() => ensureAudioFx(dir, asset.id, asset.path, item.audioFx!));
        if (reverse) await run(() => reverseProjectAudio(dir, made));
        const lufs = await loudness(join(dir, made));
        writeAtomic(join(dir, `${made}.json`), { lufs: lufs ?? null });
        tally.audioFx.ran++;
        log(`audioFx ${id}${lufs === undefined ? " (silent)" : ` (${lufs.toFixed(1)} LUFS)`}`);
      } catch (err) {
        fail("audioFx", id, err);
      }
    }));
    tally.audioFx.skipped += project.tracks.reduce((n, track) => n + track.items.filter((item) => "assetId" in item && (!opts.assets || opts.assets.includes(item.assetId)) && !("audioFx" in item && item.audioFx)).length, 0);
  }

  return { assets: assets.length, steps: tally, ...(errors.length && { errors }) };
}

export { audioFxPath, ensureAudioFx, measureFinalMix };
export type { AudioMeasurement, AudioPeak, FinalMixMeasurement, SourceHealth } from "@splicewright/core/node";
export { scanMaterials, relinkMaterial, listMaterials, prepareMaterials, recordMaterialReview, materialPreview, type ListedMaterial, type MaterialReview, type MaterialReviewPlanning, type MaterialCoverage, type MaterialStoryRole, type MaterialSuitableUse, type CaptureTime, type CaptureCandidate, type PrepareStep } from "./materials.ts";
export { sourceFrame } from "./source-frame.ts";

export { checkOutput } from "./output-health.ts";
export * from "./breezyvoice.ts";
