import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Asset } from "@splicewright/core";
import { cacheDir, fingerprint, load, readAssets, writeAtomic, type Probe } from "@splicewright/core/node";

// Spec §8. ffmpeg steps run here; transcript and beats need Python libraries and run ingest/*.py.
// Every step is cached by content fingerprint: a probe entry records, per step, the fingerprint it ran on.

export const STEPS = ["proxy", "analysis", "thumbs", "waveform", "transcript", "beats"] as const;
export type Step = (typeof STEPS)[number];
type Entry = Probe & { done?: Partial<Record<Step, string>> };

const pyDir = join(dirname(fileURLToPath(import.meta.url)), "../../../ingest");

/** FIFO limit on concurrent jobs. */
export function limiter(n: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (running >= n) await new Promise<void>((r) => waiting.push(r));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

function exec(cmd: string, args: string[], onData?: (b: Buffer) => void): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", onData ?? ((d) => (out += d)));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", fail);
    p.on("close", (code) => (code === 0 ? ok(out) : fail(Object.assign(new Error(err.trim().slice(-400) || `${cmd} exited ${code}`), { code, out }))));
  });
}

export const ffmpeg = (args: string[], onData?: (b: Buffer) => void) => exec("ffmpeg", ["-loglevel", "error", "-y", ...args], onData);

// ---------- probe ----------

export async function probe(file: string, kind: Asset["kind"]): Promise<Omit<Probe, "path" | "fingerprint">> {
  const info = JSON.parse(await exec("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]));
  const v = info.streams.find((s: any) => s.codec_type === "video");
  const [num, den] = String(v?.avg_frame_rate ?? "0/1").split("/").map(Number);
  const rotation = v?.side_data_list?.find((d: any) => "rotation" in d)?.rotation ?? (v?.tags?.rotate ? Number(v.tags.rotate) : undefined);
  const duration = Number(info.format.duration);
  return {
    kind,
    ...(kind !== "image" && Number.isFinite(duration) && { duration }),
    ...(v && { width: v.width, height: v.height }),
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

/** 360p at 0.5–1 fps: cheap frames for agent visual inspection. */
const analysisProxy = (src: string, out: string, duration = 0) =>
  ffmpeg(["-i", src, "-vf", `fps=${duration > 60 ? 0.5 : 1},${shortSide(360)}`, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", out]);

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
  /** Concurrent ffmpeg jobs; default cores − 2 (§8). */
  jobs?: number;
  log?: (line: string) => void;
}

type Tally = { ran: number; cached: number; skipped: number; failed: number };

/** Probe every asset, then run the requested steps on whatever changed since they last ran. */
export async function ingest(dir: string, opts: IngestOptions = {}) {
  const log = opts.log ?? (() => {});
  const run = limiter(opts.jobs ?? Math.max(1, availableParallelism() - 2));
  const steps = new Set(opts.only ?? STEPS);
  const project = load(dir);
  const assets = Object.values(project.assets).filter((a) => !opts.assets || opts.assets.includes(a.id));
  const cache: Record<string, Entry> = readAssets(dir);
  const tally = Object.fromEntries(["probe", ...steps].map((s) => [s, { ran: 0, cached: 0, skipped: 0, failed: 0 } as Tally]));
  const errors: string[] = [];
  const fail = (step: string, id: string, e: unknown) => (tally[step].failed++, errors.push(`${step} ${id}: ${(e as Error).message ?? e}`));
  const save = () => (mkdirSync(cacheDir(dir), { recursive: true }), writeAtomic(cacheDir(dir, "assets.json"), cache));

  // probe
  const ready: Entry[] = [];
  await Promise.all(
    assets.map(async (a) => {
      const src = join(dir, a.path);
      const fp = fingerprint(src);
      if (!fp) return fail("probe", a.id, new Error(`${a.path} not found`));
      if (cache[a.id]?.fingerprint === fp && cache[a.id].path === a.path) {
        tally.probe.cached++;
        return ready.push(cache[a.id]);
      }
      try {
        const done = cache[a.id]?.fingerprint === fp ? cache[a.id].done : undefined; // renamed, same content
        cache[a.id] = { path: a.path, fingerprint: fp, ...(await run(() => probe(src, a.kind))), ...(done && { done }) };
        tally.probe.ran++;
        log(`probe ${a.id}`);
        ready.push(cache[a.id]);
      } catch (e) {
        fail("probe", a.id, e);
      }
    }),
  );
  save();

  const idOf = new Map(ready.map((e) => [e, Object.keys(cache).find((k) => cache[k] === e)!]));
  const outputs: Record<Step, (id: string) => string> = {
    proxy: (id) => cacheDir(dir, "proxies", "edit", `${id}.mp4`),
    analysis: (id) => cacheDir(dir, "proxies", "analysis", `${id}.mp4`),
    thumbs: (id) => cacheDir(dir, "contact-sheets", `${id}.jpg`),
    waveform: (id) => cacheDir(dir, "waveforms", `${id}.json`),
    transcript: (id) => cacheDir(dir, "transcripts", `${id}.json`),
    beats: (id) => cacheDir(dir, "beats", `${id}.json`),
  };
  const applies: Record<Step, (e: Entry) => boolean> = {
    proxy: (e) => e.kind === "video",
    analysis: (e) => e.kind === "video",
    thumbs: (e) => e.kind === "video",
    waveform: (e) => e.kind !== "image" && !!e.audio,
    transcript: (e) => e.kind === "video" && !!e.audio,
    beats: (e) => e.kind === "audio",
  };
  /** Entries this step still has to process; the rest are tallied as cached or skipped. */
  const todo = (step: Step) =>
    ready.filter((e) => {
      if (!applies[step](e)) return tally[step].skipped++, false;
      if (e.done?.[step] === e.fingerprint && existsSync(outputs[step](idOf.get(e)!))) return tally[step].cached++, false;
      return true;
    });
  const mark = (e: Entry, step: Step) => ((e.done ??= {})[step] = e.fingerprint);

  const ff: Record<"proxy" | "analysis" | "thumbs" | "waveform", (e: Entry, id: string, out: string) => Promise<unknown>> = {
    proxy: (e, _, out) => run(() => editProxy(join(dir, e.path), out)),
    analysis: (e, _, out) => run(() => analysisProxy(join(dir, e.path), out, e.duration)),
    thumbs: (e, id, out) => run(() => thumbs(join(dir, e.path), cacheDir(dir, "thumbs", id), out, e.duration)),
    waveform: (e, id) => waveform(dir, id, e.path, run, true),
  };
  await Promise.all(
    (["proxy", "analysis", "thumbs", "waveform"] as const).filter((s) => steps.has(s)).flatMap((step) =>
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

  return { assets: assets.length, steps: tally, ...(errors.length && { errors }) };
}
