import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { makeCancelSignal, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { fingerprint, load, loadCtx, readAssets, sizesOf } from "@splicewright/core/node";
import { captionWords, parseCube, type Project } from "@splicewright/core";
import { audioFxPath, ffmpeg, grid, measureFinalMix, reverseAudioPath, scratch, spread } from "@splicewright/ingest";
import type { Preset } from "./config.ts";
import { resolveExportPreset, withExportContainerTag } from "./export-preset.ts";
import type { GradeLut } from "./grade-effect.ts";
import { duckRanges } from "./duck.ts";
import { projectAliases } from "./aliases.ts";

export { duckRanges };

/** FontFace caches must change when switching projects or replacing a font at the same path. */
export function fontVersionsOf(dir: string, project: Project): Record<string, string> {
  const root = realpathSync(dir);
  return Object.fromEntries(Object.values(project.assets).filter((asset) => asset.kind === "font").map((asset) => {
    try {
      const file = realpathSync(resolve(root, asset.path));
      if (!file.startsWith(root + sep)) throw new Error("font path escapes project");
      return [asset.id, fingerprint(file) ?? "missing"];
    } catch { return [asset.id, "missing"]; }
  }));
}

/** An existing reverse file is usable only for the exact source content it was baked from. */
export function reverseProxiesOf(dir: string, project: Project): string[] {
  const probes = readAssets(dir);
  return Object.values(project.assets).filter((asset) => {
    if (asset.kind !== "video") return false;
    const probe = probes[asset.id];
    const current = fingerprint(join(dir, asset.path));
    return !!current && probe?.path === asset.path && probe.fingerprint === current && probe.done?.reverse === current
      && existsSync(join(dir, ".splicewright", "proxies", "reverse", `${asset.id}.mp4`));
  }).map((asset) => asset.id);
}

const here = dirname(fileURLToPath(import.meta.url));
const lutCache = new Map<string, { stamp: string; value: GradeLut }>();
const lutVersions = new WeakMap<object, string>();
/** Parsed tables of the LUTs some item's grade uses. A missing, escaping or invalid file is left out
 * (lookEffects then names the unavailable asset where it is used) so one bad .cube can't take the
 * editor or an unrelated render down. */
export function lutsOf(dir: string, project: Project) {
  const used = new Set(project.tracks.flatMap((t) => t.items.flatMap((i) => ("grade" in i && i.grade?.lut ? [i.grade.lut.assetId, ...(i.lutKeyframes ?? []).map((key) => key.assetId)] : []))));
  const luts: Record<string, GradeLut> = {};
  for (const a of Object.values(project.assets)) {
    if (a.kind !== "lut" || !used.has(a.id)) continue;
    try {
      const root = realpathSync(dir), path = realpathSync(resolve(dir, a.path));
      if (!path.startsWith(root + sep)) throw new Error(`LUT asset path escapes project directory: ${a.path}`);
      const stat = statSync(path), stamp = `${stat.size}:${stat.mtimeMs}`;
      const cacheKey = `${dir}:${a.id}:${a.path}`;
      let cached = lutCache.get(cacheKey);
      if (!cached || cached.stamp !== stamp) {
        const text = readFileSync(path, "utf8");
        cached = { stamp, value: { ...parseCube(text), digest: createHash("sha256").update(text).digest("hex") } };
        lutCache.set(cacheKey, cached);
      }
      luts[a.id] = cached.value;
      lutVersions.set(cached.value, `${a.path}:${stamp}`);
    } catch { /* unavailable: see above */ }
  }
  return luts;
}
/** Changes whenever lutsOf has to re-read the file; lets the editor fetch a table only when it changed. */
export const lutVersion = (lut: object) => lutVersions.get(lut);
/** Folder holding the node_modules Remotion is installed in. Remotion keys its Chrome download and
 * webpack cache on cwd; pinning both here keeps ~100 MB of cache out of every project folder. */
const root = join(dirname(createRequire(import.meta.url).resolve("@remotion/renderer/package.json")), "../../..");
let browser: string | undefined;
function browserExecutable(): string {
  const script = `import("@remotion/renderer").then((r) => r.ensureBrowser()).then((s) => console.log(JSON.stringify(s)))`;
  browser ??= JSON.parse(execFileSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").pop()!).path;
  return browser!;
}
const ID = "SplicewrightProject"; // Root.tsx's COMPOSITION_ID; not imported, Node can't load .tsx

// ponytail: one bundle per project per process; restart `splicewright mcp` after editing
// components/ or splicewright.config.ts. Key on their mtimes if that gets annoying.
const bundles = new Map<string, Promise<string>>();

/** Bundles the composition plus the project's splicewright.config.ts; the project dir is symlinked as public/. */
export function bundleProject(dir: string): Promise<string> {
  if (!bundles.has(dir)) {
    const config = join(dir, "splicewright.config.ts");
    const entry = join(dir, ".splicewright", "entry.tsx");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(
      entry,
      [
        `import { registerRoot } from "remotion";`,
        `import { makeRoot } from ${JSON.stringify(join(here, "Root.tsx"))};`,
        existsSync(config) ? `import config from ${JSON.stringify(config)};` : `const config = {};`,
        `registerRoot(makeRoot(config));`,
      ].join("\n"),
    );
    const promise = bundle({
      entryPoint: entry,
      rootDir: root,
      publicDir: dir,
      symlinkPublicDir: true, // never copy raw footage into the bundle
      webpackOverride: (c) => ({
        ...c,
        resolve: { ...c.resolve, alias: projectAliases(here, c.resolve?.alias as Record<string, unknown> | undefined) },
      }),
    });
    promise.catch(() => bundles.delete(dir));
    bundles.set(dir, promise);
  }
  return bundles.get(dir)!;
}

export function audioFxSources(dir: string, project: Project): Record<string, string> {
  const audioFx: Record<string, string> = {};
  for (const track of project.tracks) for (const item of track.items) {
    if (!("audioFx" in item) || !item.audioFx || !("assetId" in item)) continue;
    const asset = project.assets[item.assetId];
    if (!asset) throw new Error(`audioFx item ${item.id} references missing asset ${item.assetId}`);
    const path = audioFxPath(dir, asset.id, asset.path, item.audioFx);
    if (!existsSync(join(dir, path))) throw new Error(`audioFx artifact for item ${item.id} is missing or stale; wait for processing to finish before rendering`);
    audioFx[item.id] = path;
  }
  return audioFx;
}

export function reverseAudioFxSources(dir: string, project: Project, audioFx: Record<string, string>): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const track of project.tracks) for (const item of track.items) {
    if (!("reverse" in item) || !item.reverse || !item.audioFx) continue;
    const forward = audioFx[item.id];
    if (!forward) throw new Error(`audioFx artifact for reverse item ${item.id} is missing`);
    const path = reverseAudioPath(forward);
    if (!existsSync(join(dir, path))) throw new Error(`reversed audioFx artifact for item ${item.id} is missing; run splicewright ingest --only audioFx`);
    sources[item.id] = path;
  }
  return sources;
}

async function prepare(dir: string) {
  const project = load(dir);
  const ctx = loadCtx(dir);
  const probes = readAssets(dir);
  const reverseProxies = reverseProxiesOf(dir, project);
  for (const track of project.tracks) for (const item of track.items)
    if (track.kind === "video" && "reverse" in item && item.reverse && !reverseProxies.includes(item.assetId))
      throw new Error(`reverse proxy missing for ${item.id} (${item.assetId}); run splicewright ingest --only reverse`);
  const durations = Object.fromEntries(Object.entries(probes).flatMap(([id, asset]) => (asset.duration ? [[id, asset.duration]] : [])));
  const frameRates = Object.fromEntries(Object.entries(probes).flatMap(([id, asset]) => (asset.fps ? [[id, asset.fps]] : [])));
  const audioFx = audioFxSources(dir, project);
  const reverseAudioFx = reverseAudioFxSources(dir, project, audioFx);
  const inputProps = { project, duck: duckRanges(project, ctx), sizes: sizesOf(probes), durations, frameRates, reverseProxies, animated: Object.fromEntries(Object.entries(probes).flatMap(([id, probe]) => probe.animated ? [[id, true]] : [])), words: captionWords(project, ctx), luts: lutsOf(dir, project), audioFx, reverseAudioFx, fontVersions: fontVersionsOf(dir, project) };
  const serveUrl = await bundleProject(dir);
  // Canvas effects need a WebGL2 context in Remotion's headless Chromium. Keep the legacy render
  // defaults for projects that do not opt into the per-pixel path.
  const needsCanvasEffects = project.tracks.some((track) => track.kind === "video" && track.items.some((item) => item.key || item.grade));
  const opts = { serveUrl, inputProps, browserExecutable: browserExecutable(), ...(needsCanvasEffects ? { chromiumOptions: { gl: "angle" as const } } : {}) };
  const composition = await selectComposition({ ...opts, id: ID });
  return { ...opts, composition };
}

/** Renders one frame. `output` null returns the image buffer; `maxWidth` scales down (MCP uses 960). */
export async function still(dir: string, frame: number, output: string | null, maxWidth?: number) {
  const { composition, ...opts } = await prepare(dir);
  if (!Number.isInteger(frame) || frame < 0 || frame >= composition.durationInFrames)
    throw new Error(`frame ${frame} outside 0..${composition.durationInFrames - 1}`);
  if (output) mkdirSync(dirname(output), { recursive: true });
  const { buffer } = await renderStill({
    ...opts,
    composition,
    frame,
    output,
    imageFormat: output?.endsWith(".png") ? "png" : "jpeg",
    scale: maxWidth ? Math.min(1, maxWidth / composition.width) : 1,
  });
  return { frame, output, buffer };
}

/**
 * `n` composition frames from timeline frames [from, to) as one grid, 320 px on the long side per tile:
 * the edit as a viewer sees it, at a fraction of the tokens of `n` stills.
 * ponytail: stills render one after another (~0.3 s each); render them concurrently if n grows.
 */
export async function storyboard(dir: string, { from = 0, to, n = 12 }: { from?: number; to?: number; n?: number } = {}) {
  const { composition, ...opts } = await prepare(dir);
  to = Math.min(to ?? composition.durationInFrames, composition.durationInFrames);
  if (!(to > from)) throw new Error(`empty range [${from}, ${to}) of 0..${composition.durationInFrames}`);
  n = Math.max(1, Math.min(24, Math.round(n), to - from));
  const frames = [...new Set(spread(from, to, n).map(Math.floor))];
  const scale = 320 / Math.max(composition.width, composition.height);
  const image = await scratch(async (tmp) => {
    for (const [k, frame] of frames.entries()) await renderStill({ ...opts, composition, frame, output: join(tmp, `${k}.jpg`), imageFormat: "jpeg", scale });
    return grid(tmp, frames.length);
  });
  return { image, frames };
}

export interface RenderOptions {
  output: string;
  preset?: string;
  /** Timeline frames [from, to). */
  range?: [number, number];
  onProgress?: (progress: number) => void;
  /** Optional diagnostics for experiments; observes the selected encoder without changing args. */
  onEncoding?: (args: readonly string[]) => void;
  /** Internal cancellation hook used by background export jobs. */
  cancelSignal?: Parameters<typeof renderMedia>[0]["cancelSignal"];
  /** Internal cancellation check around preparation steps that do not accept a signal. */
  shouldCancel?: () => boolean;
}

/**
 * Master limiter: re-muxes `file` in place with ffmpeg's alimiter at −1 dBFS, video untouched.
 * `level=disabled`: alimiter's default auto-level would scale the peak back up to 0 dBFS.
 * ponytail: the preview has no limiter (Remotion's <Audio> exposes a volume curve, not a node graph), so
 * it can differ from the render on peaks above −1 dBFS; add a Web Audio DynamicsCompressor there if that matters.
 */
export async function limit(file: string) {
  const tmp = `${file}.limited${extname(file)}`;
  try {
    await ffmpeg(["-i", file, "-c:v", "copy", "-c:a", "aac", "-b:a", "320k", "-af", "alimiter=limit=0.891:attack=1:release=120:level=disabled", tmp]);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export async function render(dir: string, { output, preset = "master", range, onProgress, onEncoding, cancelSignal, shouldCancel }: RenderOptions) {
  if (shouldCancel?.()) throw new Error("render cancelled");
  const { composition, ...opts } = await prepare(dir);
  if (shouldCancel?.()) throw new Error("render cancelled");
  const exportPreset = resolveExportPreset(
    preset,
    composition.props.presets as Record<string, Preset> | undefined,
    { width: composition.width, height: composition.height, fps: composition.fps },
  );
  mkdirSync(dirname(output), { recursive: true });
  await renderMedia({
    ...opts,
    ...exportPreset,
    composition,
    codec: exportPreset.codec ?? "h264",
    outputLocation: output,
    cancelSignal,
    frameRange: range ? [range[0], range[1] - 1] : null,
    onProgress: ({ progress }) => onProgress?.(progress),
    ffmpegOverride: ({ args }) => {
      const tagged = withExportContainerTag(args, exportPreset.codec ?? "h264", output);
      onEncoding?.([...tagged]);
      return tagged;
    },
  });
  if ((composition.props.project as Project).meta.limiter) await limit(output);
  return { output, frames: range ? range[1] - range[0] : composition.durationInFrames, preset };
}

export interface Job {
  id: string;
  status: "running" | "done" | "error" | "cancelled";
  progress: number;
  output: string;
  preset: string;
  finalMix?: { status: "measuring" } | ({ status: "measured"; measuredAt: string } & Awaited<ReturnType<typeof measureFinalMix>>);
  error?: string;
}

const jobs = new Map<string, Job>();
const controls = new Map<string, { cancel: () => void; cancelled: boolean; staging: string }>();

/** Starts an atomic background render. Only completed output is published at the requested path. */
export function startRender(dir: string, opts: RenderOptions): Job {
  const id = `r_${randomUUID()}`;
  const ext = extname(opts.output) || ".mp4";
  const staging = join(dirname(opts.output), `.${basename(opts.output, ext)}.partial-${id}${ext}`);
  const { cancel, cancelSignal } = makeCancelSignal();
  const control = { cancel, cancelled: false, staging };
  const job: Job = { id, status: "running", progress: 0, output: opts.output, preset: opts.preset ?? "master" };
  jobs.set(job.id, job);
  controls.set(id, control);
  render(dir, { ...opts, output: staging, cancelSignal, shouldCancel: () => control.cancelled, onProgress: (p) => (job.progress = +p.toFixed(3)) }).then(async () => {
    if (control.cancelled) throw new Error("render cancelled");
    if (!existsSync(staging) || !statSync(staging).size) throw new Error("render produced no output file");
    job.finalMix = { status: "measuring" };
    const finalMix = await measureFinalMix(staging);
    if (control.cancelled) throw new Error("render cancelled");
    job.finalMix = { status: "measured", measuredAt: new Date().toISOString(), ...finalMix };
    renameSync(staging, opts.output);
    Object.assign(job, { status: "done", progress: 1 });
  }).catch((e: unknown) => {
    if (control.cancelled) Object.assign(job, { status: "cancelled", error: undefined });
    else Object.assign(job, { status: "error", error: e instanceof Error ? e.message : String(e) });
    try { rmSync(staging, { force: true }); }
    catch (cleanupError) {
      job.error = `${job.error ?? "render cancelled"}; staging cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
    }
  }).finally(() => controls.delete(id));
  return job;
}

export const renderStatus = (id: string) => jobs.get(id);

/** Request cancellation of a running export. Returns false once it has settled or if unknown. */
export function cancelRender(id: string): boolean {
  const control = controls.get(id);
  const job = jobs.get(id);
  if (!control || control.cancelled || !job || job.status !== "running") return false;
  control.cancelled = true;
  control.cancel();
  Object.assign(job, { status: "cancelled", error: undefined });
  return true;
}
