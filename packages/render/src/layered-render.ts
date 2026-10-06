import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { availableParallelism, totalmem } from "node:os";
import { appendFileSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Writable } from "node:stream";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { openBrowser, renderFrames, renderMedia } from "@remotion/renderer";
import type { Project } from "@splicewright/core";
import { fingerprint, type Probe } from "@splicewright/core/node";
import { audioTransitionFades, LayeredUnsupportedError, planLayeredExport, staticRuns, type LayeredPlan } from "./layered.ts";
import { withExportContainerTag } from "./export-preset.ts";
import { graphicsFrameBatches, pipeGraphicsFrames } from "./graphics-stream.ts";

type RenderPreset = { crf?: number; scale?: number; concurrency?: number; codec?: "h264" | "h265"; videoBitrate?: string; hardwareAcceleration?: "disable" | "if-possible" | "required" };
type RenderLike = Parameters<typeof renderMedia>[0];
type BrowserPage = Awaited<ReturnType<Awaited<ReturnType<typeof openBrowser>>["pages"]>>[number];
export interface RenderResources {
  concurrency?: number;
  mediaCacheSizeInBytes?: number | null;
  offthreadVideoCacheSizeInBytes?: number | null;
  /** Opt-in layered experiments; defaults preserve the original scheduling. */
  graphicsScheduling?: "serial" | "grouped";
  filterThreads?: number;
  encoderThreads?: number;
}
export interface LayeredRenderArgs {
  dir: string;
  output: string;
  preset: string;
  range?: [number, number];
  project: Project;
  probes: Record<string, Probe>;
  presetOptions: RenderPreset;
  remotion: Omit<RenderLike, "composition" | "inputProps" | "outputLocation" | "frameRange" | "onProgress" | "codec" | "crf" | "scale" | "hardwareAcceleration" | "videoBitrate" | "imageFormat" | "pixelFormat"> & { composition: RenderLike["composition"]; inputProps: Record<string, unknown> };
  cancelSignal?: RenderLike["cancelSignal"];
  shouldCancel?: () => boolean;
  onProgress?: (value: number) => void;
  onEncoding?: (args: readonly string[]) => void;
  resources?: RenderResources;
}

const seconds = (frames: number, fps: number) => Number((frames / fps).toFixed(9));
const time = (frames: number, fps: number) => seconds(frames, fps).toFixed(9);
const sourceTime = (value: number, fps: number) => (Math.round(value * fps) / fps).toFixed(9);
export function setExportMemoryPhase(stage: string, batch: number | null = null) {
  const path = process.env.SPLICEWRIGHT_EXPORT_MEMORY_PHASE_FILE;
  if (!path?.endsWith("-phase.json")) return;
  const eventPath = process.env.SPLICEWRIGHT_EXPORT_MEMORY_EVENTS_FILE;
  const event = JSON.stringify({ stage, batch, at: new Date().toISOString() });
  try {
    writeFileSync(path, event);
    if (eventPath?.endsWith("-events.jsonl")) appendFileSync(eventPath, `${event}\n`);
  } catch { /* Optional telemetry must not change render or cleanup outcomes. */ }
}
export function filterBufferedFramesArgs(value: number | undefined, supportsOption: boolean) {
  if (value === undefined) return [];
  if (value !== 64 && value !== 128) throw new Error("filterBufferedFrames must be 64 or 128");
  if (!supportsOption) throw new Error("This FFmpeg build does not support -filter_buffered_frames");
  return ["-filter_buffered_frames", String(value)];
}
/** Historical public name retained for compatibility; streamed frame buffers use the queue limit below. */
export const LAYERED_GRAPHICS_STAGING_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;
export const LAYERED_GRAPHICS_QUEUE_LIMIT_BYTES = 256 * 1024 * 1024;
export function estimateGraphicsStagingBytes(width: number, height: number, frames: number) {
  if (![width, height, frames].every(Number.isSafeInteger) || width < 1 || height < 1 || frames < 0) return Infinity;
  const scanlineBytes = (width * 4 + 1) * height;
  if (!Number.isSafeInteger(scanlineBytes)) return Infinity;
  const perFrameBytes = Math.ceil(scanlineBytes * 1.01) + 64 * 1024;
  const estimate = perFrameBytes * frames;
  return Number.isSafeInteger(estimate) ? estimate : Infinity;
}
/**
 * Chrome page concurrency when the caller does not pick one. Measured on one M5 / 16 GiB / 1080p caption export:
 * 2 -> 4 pages cut render time ~47% for ~350 MiB more RSS; 5+ pages added RAM without a clear further gain.
 * Scale with cores and RAM, and never past the PNG queue limit, so an export the old default of 2 admitted still fits.
 */
export function defaultGraphicsConcurrency(frameBytes: number, cores = availableParallelism(), memoryBytes = totalmem()) {
  const byMachine = Math.min(4, cores >> 1, Math.floor(memoryBytes / (4 * 1024 ** 3)));
  const byQueue = Math.max(2, Math.floor(LAYERED_GRAPHICS_QUEUE_LIMIT_BYTES / frameBytes) - 2);
  return Math.max(1, Math.min(byMachine, byQueue));
}
// Honor source packet timestamps before establishing a continuous mix clock.
// Resetting PTS first compresses gaps/overlaps (observed in DJI AAC sources).
// min_hard_comp must exceed the packet-timestamp jitter: DJI sources wobble up to 21.2 ms (peak to peak) around the
// 1024-sample grid, and a one-sample threshold turned that into ~20 ms of inserted silence about once a second.
// 50 ms still keeps real gaps (the 100 ms case is tested) while leaving jittery-but-continuous audio untouched.
export const audioClipFilters = (frames: number, fps: number) =>
  `aresample=48000:async=1:min_hard_comp=0.05:first_pts=0,apad,atrim=end_sample=${Math.round(frames * 48000 / fps)},asetpts=N/SR/TB`;
const safeColor = (color: string) => {
  if (color === "transparent") return "black";
  if (/^#[\da-f]{3}$/i.test(color)) return `0x${[...color.slice(1)].map((value) => value + value).join("")}`;
  return color.startsWith("#") ? `0x${color.slice(1)}` : color;
};
function verifiedMediaProperties(path: string, cache: Map<string, string>) {
  const canonical = realpathSync(path);
  let output = cache.get(canonical);
  if (output === undefined) {
    output = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt,color_space,color_transfer,color_primaries,color_range,sample_aspect_ratio", "-of", "json", canonical], { encoding: "utf8" });
    cache.set(canonical, output);
  }
  const stream = (JSON.parse(output) as { streams?: { pix_fmt?: string; color_space?: string; color_transfer?: string; color_primaries?: string; color_range?: string; sample_aspect_ratio?: string }[] }).streams?.[0];
  if (!stream) throw new LayeredUnsupportedError(`cannot probe video stream in ${path}`);
  // 10-bit SDR is fine: the graph converts to rgb24 first, and HDR is refused below by its colour tags.
  if (/(?:p|gray)(?:12|14|16)(?:le|be)?|p0(?:12|16)/i.test(stream.pix_fmt ?? "")) throw new LayeredUnsupportedError(`high bit depth video (${stream.pix_fmt})`);
  if (stream.sample_aspect_ratio && !["1:1", "N/A"].includes(stream.sample_aspect_ratio)) throw new LayeredUnsupportedError(`non-square pixel aspect ratio ${stream.sample_aspect_ratio}`);
  for (const [name, value] of [["color space", stream.color_space], ["transfer", stream.color_transfer], ["primaries", stream.color_primaries]] as const)
    if (value && !["bt709", "unknown", "reserved"].includes(value)) throw new LayeredUnsupportedError(`${name} ${value}`);
}

function addVideoFade(filters: string[], options: { start: number; duration: number; color?: boolean; alpha?: boolean }, fps: number, direction: "in" | "out") {
  if (options.duration <= 0 || options.start + options.duration <= 0) return;
  if (options.start < 0) throw new Error("layered export range fade pre-roll invariant failed");
  const fade = [`fade=t=${direction}`, `st=${time(options.start, fps)}`, `d=${time(options.duration, fps)}`];
  if (options.alpha) fade.push("alpha=1");
  if (options.color) fade.push("color=black");
  filters.push(fade.join(":"));
}

function resolveProjectAsset(dir: string, path: string) {
  const root = realpathSync(dir);
  if (isAbsolute(path) || /^[a-z]:[\\/]/i.test(path) || path.split(/[\\/]/).some((part) => part === ".."))
    throw new Error(`layered export asset path contains traversal: ${path}`);
  return realpathSync(resolve(root, path));
}

/** Validate only the media that survived range planning; safe to run before Remotion setup. */
export function validateLayeredMedia(dir: string, project: Project, probes: Record<string, Probe>, plan: LayeredPlan) {
  for (const item of [...plan.video.map((entry) => entry.item), ...plan.audio.map((entry) => entry.item)]) {
    const asset = project.assets[item.assetId];
    const probe = probes[item.assetId];
    if (!asset || !probe || probe.path !== asset.path || probe.fingerprint !== fingerprint(resolveProjectAsset(dir, asset.path)))
      throw new LayeredUnsupportedError(`media probe for ${item.id} is stale`);
  }
}

function addAudioEffects(item: { fadeIn?: number; fadeOut?: number }, offset: number, duration: number, out: string[], fps: number, transition?: { in?: number; outStart?: number; out?: number }, phaseShift = 0) {
  const add = (direction: "in" | "out", start: number, fadeDuration: number) => {
    if (start + fadeDuration <= 0) return;
    if (start < 0) throw new Error("layered export range audio fade pre-roll invariant failed");
    out.push(`afade=t=${direction}:st=${time(start, fps)}:d=${time(fadeDuration, fps)}`);
  };
  if (item.fadeIn) add("in", offset + phaseShift, item.fadeIn);
  if (item.fadeOut) add("out", offset + duration - item.fadeOut + phaseShift, item.fadeOut);
  if (transition?.in) add("in", phaseShift, transition.in);
  if (transition?.out && transition.outStart !== undefined) add("out", transition.outStart + phaseShift, transition.out);
}

function activeWindowPlan(project: Project, probes: Record<string, Probe>, plan: LayeredPlan, scale: number) {
  if (scale !== 1 || plan.windows.length) return false;
  if (plan.video.some(segment => segment.lead || segment.tail || segment.incoming || segment.outgoing || segment.item.fadeIn || segment.item.fadeOut ||
    segment.item.speed && segment.item.speed !== 1 || segment.item.reverse || segment.item.grade || segment.item.key || segment.item.lutKeyframes?.length ||
    segment.place || segment.item.mask || segment.item.crop || segment.item.effects || segment.item.blend && segment.item.blend !== "normal" ||
    Object.keys(segment.item.keyframes ?? {}).length || segment.decodeStart !== segment.renderStart ||
    probesDimensionsMismatch(project, probes, segment.item.assetId, plan.width, plan.height))) return false;
  if (!plan.video.length || plan.video[0].renderStart !== plan.from || plan.video.at(-1)!.renderEnd !== plan.to) return false;
  return plan.video.every((segment, index) => index === 0 || plan.video[index - 1]!.renderEnd === segment.renderStart);
}

function probesDimensionsMismatch(project: Project, probes: Record<string, Probe>, assetId: string, width: number, height: number) {
  const asset = project.assets[assetId];
  const probe = probes[assetId];
  return !asset || asset.kind !== "video" || asset.rotation !== undefined || !probe || probe.width !== width || probe.height !== height;
}

function activeWindowFilter(segment: LayeredPlan["video"][number], plan: LayeredPlan) {
  const item = segment.item;
  const fit = item.fit === "cover"
    ? [`scale=${plan.width}:${plan.height}:force_original_aspect_ratio=increase`, `crop=${plan.width}:${plan.height}`]
    : [`scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease`, "format=rgba", `pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`];
  // The reader runs the whole colour pipeline so only 1.5 bytes/px cross the pipe (RGBA was 4). Clips here are opaque and
  // output-sized, so the classic overlay onto the background is an identity and the conversion can move upstream of it.
  // tpad fills a stream that ends before its probe with that background, as the classic graph's eof_action=pass shows it.
  return [`trim=duration=${time(segment.renderEnd - segment.decodeStart, plan.fps)}`, "setpts=PTS-STARTPTS", `fps=${plan.fps}`, "format=rgb24", ...fit, "setsar=1", "format=rgba",
    `tpad=stop=-1:stop_mode=add:color=${safeColor(plan.background)}`, "scale=in_range=pc:out_range=tv:out_color_matrix=bt709", "format=yuv420p"].join(",");
}

async function pipeActiveWindowReader(args: string[], input: Writable, signal: AbortSignal, expectedBytes: number, batch: number) {
  if (signal.aborted) throw signal.reason ?? new Error("render cancelled");
  setExportMemoryPhase("active-window-reader-start", batch);
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "", bytes = 0, killTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
    killTimer.unref();
  };
  const onData = (chunk: Buffer) => { bytes += chunk.length; };
  child.stdout!.on("data", onData);
  child.stderr!.setEncoding("utf8").on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-2000); });
  child.stdout!.pipe(input, { end: false });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const result = await new Promise<{ code: number | null; error?: Error }>(resolve => {
      child.once("error", error => resolve({ code: null, error }));
      child.once("close", code => resolve({ code }));
    });
    if (signal.aborted) throw signal.reason ?? new Error("render cancelled");
    if (result.error) throw result.error;
    if (result.code !== 0) throw new Error(stderr.trim() || `active-window FFmpeg reader exited ${result.code}`);
    if (bytes !== expectedBytes) throw new Error(`active-window reader returned ${bytes} bytes; expected ${expectedBytes}`);
    setExportMemoryPhase("active-window-reader-end", batch);
  } catch (error) {
    setExportMemoryPhase("active-window-reader-failed", batch);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    if (killTimer) clearTimeout(killTimer);
  }
}

async function runFfmpeg(args: string[], cancelSignal: RenderLike["cancelSignal"], shouldCancel: (() => boolean) | undefined, onProgress: (value: number) => void, durationSeconds: number, produceGraphics?: (input: Writable, signal: AbortSignal) => Promise<void>) {
  if (shouldCancel?.()) throw new Error("render cancelled");
  const controller = new AbortController();
  const rawCap = process.env.SPLICEWRIGHT_EXPERIMENTAL_FILTER_BUFFERED_FRAMES;
  const filterBufferedFrames = rawCap === undefined ? undefined : Number(rawCap);
  const supportsCap = filterBufferedFrames === undefined || execFileSync("ffmpeg", ["-hide_banner", "-h", "full"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).includes("-filter_buffered_frames");
  const capArgs = filterBufferedFramesArgs(filterBufferedFrames, supportsCap);
  setExportMemoryPhase("native-ffmpeg");
  const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:2", "-nostats", ...capArgs, ...args], { stdio: [produceGraphics ? "pipe" : "ignore", "ignore", "pipe"] });
  let stderr = "", progressLine = "", producerDone = !produceGraphics, closed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = (error: unknown) => {
    if (!controller.signal.aborted) controller.abort(error);
    child.stdin?.destroy();
    if (!closed) {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
      killTimer.unref();
    }
  };
  cancelSignal?.(() => abort(new Error("render cancelled")));
  child.stdin?.on("error", abort);
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
    progressLine += chunk;
    const lines = progressLine.split(/\r?\n/); progressLine = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^out_time_us=(\d+)/.exec(line);
      if (match) {
        try { onProgress(Math.min(1, Number(match[1]) / 1_000_000 / durationSeconds)); }
        catch (error) { abort(error); }
      } else if (!line.startsWith("frame=") && !line.startsWith("fps=") && !line.startsWith("speed=") && !line.startsWith("progress=")) stderr = `${stderr}${line}\n`.slice(-2000);
    }
  });
  const exit = new Promise<void>((resolve, reject) => {
    child.once("error", error => { abort(error); reject(error); });
    child.once("close", code => {
      closed = true; if (killTimer) clearTimeout(killTimer);
      if (controller.signal.aborted || shouldCancel?.()) reject(controller.signal.reason ?? new Error("render cancelled"));
      else if (code !== 0 || !producerDone) {
        const error = new Error(stderr.trim() || `ffmpeg exited ${code}${producerDone ? "" : " before graphics finished"}`);
        abort(error); reject(error);
      } else resolve();
    });
  });
  const producer = produceGraphics ? Promise.resolve().then(async () => {
    await produceGraphics(child.stdin!, controller.signal);
    producerDone = true; child.stdin!.end();
  }).catch(error => { abort(error); throw error; }) : Promise.resolve();
  try { await Promise.all([exit, producer]); onProgress(1); }
  catch (error) { abort(error); await Promise.allSettled([exit, producer]); throw error; }
}

export async function renderLayered(args: LayeredRenderArgs) {
  const { dir, output, preset, range, project, probes } = args;
  const scheduling = args.resources?.graphicsScheduling ?? "serial";
  if (scheduling !== "serial" && scheduling !== "grouped") throw new Error("invalid layered graphics scheduling");
  const filterThreads = args.resources?.filterThreads ?? 2;
  const encoderThreads = args.resources?.encoderThreads ?? 2;
  for (const count of [filterThreads, encoderThreads])
    if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error("layered experiment threads must be an integer from 1 to 4");
  let cancelled = false;
  args.cancelSignal?.(() => { cancelled = true; });
  const shouldCancel = () => cancelled || !!args.shouldCancel?.();
  if (shouldCancel()) throw new Error("render cancelled");
  if (existsSync(join(dir, "splicewright.config.ts"))) {
    // Ceiling: arbitrary TS can re-export or compute a custom registry. Source
    // regexes cannot establish eligibility; expose resolved registry metadata
    // before allowing configured projects in this experimental route.
    throw new LayeredUnsupportedError("project configuration requires the Remotion route");
  }
  const plan = planLayeredExport(project, probes, ...(range ?? [0, Math.max(1, args.remotion.composition.durationInFrames)]), args.presetOptions.scale ?? 1);
  validateLayeredMedia(dir, project, probes, plan);
  const activeWindowUsed = process.env.SPLICEWRIGHT_EXPERIMENTAL_ACTIVE_WINDOW === "1" && activeWindowPlan(project, probes, plan, args.presetOptions.scale ?? 1);
  const outputWidth = Math.round(project.meta.width * (args.presetOptions.scale ?? 1));
  const outputHeight = Math.round(project.meta.height * (args.presetOptions.scale ?? 1));
  const frameEstimate = estimateGraphicsStagingBytes(outputWidth, outputHeight, 1);
  const frameConcurrency = args.resources?.concurrency ?? args.presetOptions.concurrency ?? defaultGraphicsConcurrency(frameEstimate);
  if (!Number.isInteger(frameConcurrency) || frameConcurrency < 1 || frameConcurrency > 4)
    throw new Error("layered graphics concurrency must be an integer from 1 to 4");
  // Include the reusable blank frame and the current pipe write, not timeline duration.
  const liveEstimate = frameEstimate * (frameConcurrency + 2);
  if (plan.windows.length && (!Number.isSafeInteger(liveEstimate) || liveEstimate > LAYERED_GRAPHICS_STAGING_LIMIT_BYTES || liveEstimate > LAYERED_GRAPHICS_QUEUE_LIMIT_BYTES))
    throw new LayeredUnsupportedError(`estimated live graphics working set ${liveEstimate} bytes exceeds the bounded ${LAYERED_GRAPHICS_STAGING_LIMIT_BYTES}-byte limit`);
  const outputExt = extname(output) || ".mp4";
  const stagedOutput = join(dirname(output), `.${basename(output, outputExt)}.layered-${randomUUID()}${outputExt}`);
  const maskDir = join(dirname(output), `.${basename(output, outputExt)}.masks-${randomUUID()}`);
  try {
    mkdirSync(dirname(output), { recursive: true });
    let graphicsMs = 0, graphicsProgress = plan.windows.length || activeWindowUsed ? 0 : 1, encodeProgress = 0;
    const frameCount = plan.to - plan.from;
    const reportProgress = () => args.onProgress?.(0.72 * graphicsProgress + 0.28 * encodeProgress);
    const produceGraphics = async (input: Writable, signal: AbortSignal) => {
      const overlayStart = performance.now();
      if (shouldCancel()) throw new Error("render cancelled");
      const activeFrameCount = plan.windows.reduce((count, [start, end]) => count + end - start, 0);
      let completedFrames = 0;
      // Runs of identical overlay frames are rendered once and written repeatedly; progress counts the frames they cover.
      const repeats = process.env.SPLICEWRIGHT_GRAPHICS_DEDUP === "0" ? undefined : staticRuns(project, plan.windows);
      const covered = (frames: number[]) => frames.reduce((sum, frame) => sum + (repeats?.get(frame) ?? 1), 0);
      let graphicsBatchIndex = 0;
      // Remotion registers several cancellation listeners per call. Retain all
      // of the current batch's listeners, then release them before the next one.
      const batchCancelCallbacks = new Set<() => void>();
      const graphicsCancelSignal: NonNullable<RenderLike["cancelSignal"]> = callback => { batchCancelCallbacks.add(callback); if (signal.aborted) callback(); };
      const cancelGraphics = () => { for (const callback of batchCancelCallbacks) callback(); };
      signal.addEventListener("abort", cancelGraphics, { once: true });
      let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
      const ownsBrowser = !args.remotion.puppeteerInstance;
      let graphicsCompleted = false;
      try {
        browser = args.remotion.puppeteerInstance ?? await openBrowser("chrome", {
          browserExecutable: args.remotion.browserExecutable,
          chromiumOptions: args.remotion.chromiumOptions,
          chromeMode: args.remotion.chromeMode,
          logLevel: args.remotion.logLevel,
        });
        await pipeGraphicsFrames({ input, from: plan.from, to: plan.to, width: outputWidth, height: outputHeight,
          batches: graphicsFrameBatches(plan.windows, scheduling, undefined, repeats), repeats, concurrency: frameConcurrency, limitBytes: LAYERED_GRAPHICS_QUEUE_LIMIT_BYTES, signal,
          render: async (frames, onFrameBuffer) => {
            const batch = graphicsBatchIndex++;
            setExportMemoryPhase("graphics-batch-start", batch);
            let pagesBefore: Set<BrowserPage> | undefined;
            try {
              pagesBefore = new Set(await browser!.pages());
              await renderFrames({
                ...args.remotion,
                inputProps: { ...args.remotion.inputProps, graphicsOnly: true },
                composition: { ...args.remotion.composition, props: { ...args.remotion.composition.props, graphicsOnly: true } },
                outputDir: null, frames, imageFormat: "png", muted: true, onStart: () => {}, concurrency: frameConcurrency,
                ...(args.resources?.mediaCacheSizeInBytes !== undefined ? { mediaCacheSizeInBytes: args.resources.mediaCacheSizeInBytes } : {}),
                ...(args.resources?.offthreadVideoCacheSizeInBytes !== undefined ? { offthreadVideoCacheSizeInBytes: args.resources.offthreadVideoCacheSizeInBytes } : {}),
                scale: args.presetOptions.scale ?? 1, puppeteerInstance: browser, cancelSignal: graphicsCancelSignal,
                onFrameUpdate: count => { graphicsProgress = Math.max(graphicsProgress, (completedFrames + covered(frames.slice(0, count))) / activeFrameCount); reportProgress(); },
                onFrameBuffer: async (buffer, frame) => { if (shouldCancel()) throw new Error("render cancelled"); await onFrameBuffer(buffer, frame); },
              });
              completedFrames += covered(frames);
            } finally {
              setExportMemoryPhase("graphics-batch-cleanup-start", batch);
              try {
                // Remotion closes these pages asynchronously for a caller-owned browser.
                batchCancelCallbacks.clear();
                const priorPages = pagesBefore;
                if (browser && priorPages) await Promise.all((await browser.pages()).filter(page => !priorPages.has(page)).map(async page => {
                  try { await page.close(); }
                  catch (error) {
                    // Remotion can win the concurrent close. Ignore that race only
                    // after verifying that the page is actually gone.
                    if ((await browser!.pages()).includes(page)) throw error;
                  }
                }));
              } finally {
                setExportMemoryPhase("graphics-batch-cleanup-end", batch);
                setExportMemoryPhase("graphics-batch-end", batch);
              }
            }
          },
        });
        graphicsCompleted = true;
        graphicsProgress = 1; reportProgress(); graphicsMs = performance.now() - overlayStart;
      } finally {
        batchCancelCallbacks.clear();
        signal.removeEventListener("abort", cancelGraphics);
        if (browser && ownsBrowser) await browser.close({ silent: true });
        if (graphicsCompleted) setExportMemoryPhase("native-encode-after-graphics");
      }
    };

    const maskFiles = await renderMaskImages(args, plan, maskDir);
    const inputs: string[] = [];
    const verifiedMediaCache = new Map<string, string>();
    const filters: string[] = [];
    const audioLabels: string[] = [];
    // Shared by the classic graph and the active-window graph so audio filter strings stay identical.
    const segmentInput = (segment: LayeredPlan["video"][number]) => {
      const path = resolveProjectAsset(dir, project.assets[segment.item.assetId].path);
      verifiedMediaProperties(path, verifiedMediaCache);
      const clipStart = segment.item.start - segment.lead;
      const offset = segment.decodeStart - clipStart;
      const sourceIn = segment.sourceIn - seconds(segment.lead, plan.fps) + seconds(offset, plan.fps);
      return { offset, args: ["-threads", "2", "-ss", sourceTime(sourceIn, plan.fps), "-i", path] };
    };
    const addVideoAudio = (segment: LayeredPlan["video"][number], offset: number, index: number) => {
      const duration = segment.renderEnd - segment.decodeStart;
      const effects = [`volume=${segment.item.volume ?? 1}`];
      const transitionFades = audioTransitionFades(segment);
      addAudioEffects(segment.item, segment.lead, segment.duration, effects, plan.fps, {
        in: transitionFades.incoming,
        outStart: transitionFades.outgoing?.start,
        out: transitionFades.outgoing?.duration,
      }, -offset);
      const label = `aud${index}`;
      const preroll = segment.renderStart - segment.decodeStart;
      filters.push(`[${index}:a:0]${audioClipFilters(duration, plan.fps)},${effects.join(",")},atrim=start=${time(preroll, plan.fps)}:duration=${time(segment.renderEnd - segment.renderStart, plan.fps)},asetpts=PTS-STARTPTS,adelay=delays=${Math.round((segment.renderStart - plan.from) * 48000 / plan.fps)}S:all=1[${label}]`);
      audioLabels.push(`[${label}]`);
    };
    // Pushes the input args for an audio-track item (prefixed by `inputPrefix`) and its filter; returns false when skipped.
    const addTrackAudio = (entry: LayeredPlan["audio"][number], index: number, inputPrefix: string[] = []) => {
      const track = project.tracks.find((candidate) => candidate.items.some((item) => item.id === entry.item.id));
      if (track?.kind !== "audio" || track.muted) return false;
      const path = resolveProjectAsset(dir, project.assets[entry.item.assetId].path);
      const offset = entry.decodeStart - entry.start;
      const preroll = entry.renderStart - entry.decodeStart;
      const duration = entry.renderEnd - entry.decodeStart;
      inputs.push(...inputPrefix, "-threads", "2", "-ss", sourceTime(entry.item.sourceIn + seconds(offset, plan.fps), plan.fps), "-i", path);
      const gain = (entry.item.volume ?? 1) * (track.volume ?? 1);
      const effects = [`volume=${gain}`];
      addAudioEffects(entry.item, entry.start - entry.decodeStart, entry.duration, effects, plan.fps);
      const label = `aud${index}`;
      filters.push(`[${index}:a:0]${audioClipFilters(duration, plan.fps)},${effects.join(",")},atrim=start=${time(preroll, plan.fps)}:duration=${time(entry.renderEnd - entry.renderStart, plan.fps)},asetpts=PTS-STARTPTS,adelay=delays=${Math.round((entry.renderStart - plan.from) * 48000 / plan.fps)}S:all=1[${label}]`);
      audioLabels.push(`[${label}]`);
      return true;
    };
    let inputIndex = 0;
    const maskInputs = new Map<string, number>();
    if (!activeWindowUsed) {
      for (const segment of plan.video) {
        const input = segmentInput(segment);
        inputs.push(...input.args);
        if (segment.videoAudio) addVideoAudio(segment, input.offset, inputIndex);
        inputIndex++;
      }
      for (const [id, file] of maskFiles) {
        inputs.push("-loop", "1", "-framerate", String(plan.fps), "-t", time(frameCount, plan.fps), "-i", file);
        maskInputs.set(id, inputIndex++);
      }
    }
    // Active-window: input 0 is the rawvideo pipe; audio-only inputs (-vn) follow it.
    if (activeWindowUsed) {
      inputIndex = 1;
      for (const segment of plan.video) {
        // segmentInput verifies media properties; muted clips need that check too.
        const input = segmentInput(segment);
        if (!segment.videoAudio) continue;
        inputs.push("-vn", ...input.args);
        addVideoAudio(segment, input.offset, inputIndex++);
      }
      for (const entry of plan.audio) {
        if (addTrackAudio(entry, inputIndex, ["-vn"])) inputIndex++;
      }
    }
    const videoChain = activeWindowUsed ? { videoLabel: "", nextInput: inputIndex } : makeVideoChain(plan, filters, 0, maskInputs);
    if (!activeWindowUsed) {
      inputIndex = videoChain.nextInput;
      for (const entry of plan.audio) {
        if (addTrackAudio(entry, inputIndex)) inputIndex++;
      }
    }
    if (plan.windows.length) {
      inputs.push("-threads", "2", "-thread_queue_size", "2", "-f", "image2pipe", "-vcodec", "png", "-framerate", String(plan.fps), "-i", "pipe:0");
      const graphicsLabel = `graphic${inputIndex}`;
      filters.push(`[${inputIndex}:v:0]format=rgba,setpts=PTS-STARTPTS[${graphicsLabel}]`);
      const composited = `baseg${inputIndex}`;
      filters.push(`[${videoChain.videoLabel}][${graphicsLabel}]overlay=format=rgb:eof_action=pass:shortest=0[${composited}]`);
      videoChain.videoLabel = composited;
      inputIndex++;
    }
    // Keep composition in RGB until this single, explicit output conversion.
    // Merely tagging a default BT.601 conversion as BT.709 changes colors.
    if (!activeWindowUsed) filters.push(`[${videoChain.videoLabel}]trim=duration=${time(frameCount, plan.fps)},setpts=PTS-STARTPTS,fps=${plan.fps},scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p[vout]`);
    if (audioLabels.length) {
      filters.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,atrim=duration=${time(frameCount, plan.fps)},asetpts=PTS-STARTPTS${project.meta.limiter ? ",alimiter=limit=0.891:attack=1:release=120:level=disabled" : ""}[aout]`);
    }
    const encoder = videoEncoder(args.presetOptions, encoderThreads);
    let activeWindowProducer: ((input: Writable, signal: AbortSignal) => Promise<void>) | undefined;
    let ffmpegArgs: string[];
    if (activeWindowUsed) {
      // rawvideo carries no colour tags; restore what the classic graph's scale stage gives its frames.
      const filter = ["[0:v:0]setparams=range=tv:colorspace=bt709,setpts=PTS-STARTPTS[vout]", ...filters].join(";");
      const rawInput = ["-threads", "2", "-thread_queue_size", "2", "-f", "rawvideo", "-pixel_format", "yuv420p", "-video_size", `${plan.width}x${plan.height}`, "-framerate", String(plan.fps), "-i", "pipe:0"];
      ffmpegArgs = ["-filter_complex_threads", String(filterThreads), ...rawInput, ...inputs, "-filter_complex", filter, "-map", "[vout]", ...(audioLabels.length ? ["-map", "[aout]"] : []), "-c:v", encoder.name, "-pix_fmt", "yuv420p", "-threads", String(encoderThreads), ...encoder.options, ...(audioLabels.length ? ["-c:a", "aac", "-b:a", "320k", "-ar", "48000"] : []), ...(/\.(?:mp4|mov)$/i.test(outputExt) ? ["-movflags", "+faststart"] : []), "-t", time(frameCount, plan.fps), "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", stagedOutput];
      activeWindowProducer = async (input, signal) => {
        for (const [batch, segment] of plan.video.entries()) {
          if (shouldCancel() || signal.aborted) throw signal.reason ?? new Error("render cancelled");
          const path = resolveProjectAsset(dir, project.assets[segment.item.assetId]!.path);
          const offset = segment.renderStart - segment.start;
          const sourceIn = segment.sourceIn + seconds(offset, plan.fps);
          const frames = segment.renderEnd - segment.renderStart;
          const expectedBytes = frames * (plan.width * plan.height * 3 / 2); // output dimensions are even, so 4:2:0 frames are whole bytes
          if (!Number.isSafeInteger(expectedBytes)) throw new Error("active-window frame byte size exceeds exact integer range");
          const readerArgs = ["-hide_banner", "-loglevel", "error", "-threads", "2", "-ss", sourceTime(sourceIn, plan.fps), "-i", path, "-filter_threads", String(filterThreads), "-vf", activeWindowFilter(segment, plan), "-an", "-frames:v", String(frames), "-pix_fmt", "yuv420p", "-f", "rawvideo", "pipe:1"];
          await pipeActiveWindowReader(readerArgs, input, signal, expectedBytes, batch);
          graphicsProgress = (batch + 1) / plan.video.length;
          reportProgress();
        }
      };
    } else {
      ffmpegArgs = ["-filter_complex_threads", String(filterThreads), ...inputs, "-filter_complex", filters.join(";"), "-map", "[vout]", ...(audioLabels.length ? ["-map", "[aout]"] : []), "-c:v", encoder.name, "-pix_fmt", "yuv420p", "-threads", String(encoderThreads), ...encoder.options, ...(audioLabels.length ? ["-c:a", "aac", "-b:a", "320k", "-ar", "48000"] : []), ...(/\.(?:mp4|mov)$/i.test(outputExt) ? ["-movflags", "+faststart"] : []), "-t", time(frameCount, plan.fps), "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", stagedOutput];
    }
    const tagged = withExportContainerTag(ffmpegArgs, args.presetOptions.codec ?? "h264", stagedOutput);
    args.onEncoding?.(tagged);
    const encodeStart = performance.now();
    if (shouldCancel()) throw new Error("render cancelled");
    await runFfmpeg(tagged, args.cancelSignal, shouldCancel, (p) => { encodeProgress = Math.max(encodeProgress, p); reportProgress(); }, seconds(frameCount, plan.fps), activeWindowProducer ?? (plan.windows.length ? produceGraphics : undefined));
    setExportMemoryPhase("render-complete");
    const encodeMs = performance.now() - encodeStart;
    if (shouldCancel()) throw new Error("render cancelled");
    renameSync(stagedOutput, output);
    args.onProgress?.(1);
    return { output, frames: frameCount, preset, pipelineUsed: "layered" as const, fallbackReason: undefined, timingsMs: { graphics: Math.round(graphicsMs), encode: Math.round(encodeMs) } };
  } finally {
    rmSync(stagedOutput, { force: true });
    rmSync(maskDir, { recursive: true, force: true });
  }
}

/**
 * One PNG per masked video item, drawn by the preview's own mask code (Composition `maskOf`) at output size: alpha is the mask coverage.
 * Static masks only; keyframed mask geometry is refused by the planner.
 */
async function renderMaskImages(args: LayeredRenderArgs, plan: LayeredPlan, dir: string) {
  const files = new Map<string, string>();
  const ids = [...new Set(plan.video.filter((segment) => segment.item.mask).map((segment) => segment.item.id))];
  if (!ids.length) return files;
  mkdirSync(dir, { recursive: true });
  const ownsBrowser = !args.remotion.puppeteerInstance;
  const browser = args.remotion.puppeteerInstance ?? await openBrowser("chrome", {
    browserExecutable: args.remotion.browserExecutable, chromiumOptions: args.remotion.chromiumOptions, chromeMode: args.remotion.chromeMode, logLevel: args.remotion.logLevel,
  });
  try {
    for (const id of ids) {
      let png: Buffer | undefined;
      await renderFrames({
        ...args.remotion,
        inputProps: { ...args.remotion.inputProps, maskOf: id },
        composition: { ...args.remotion.composition, props: { ...args.remotion.composition.props, maskOf: id } },
        outputDir: null, frames: [0], imageFormat: "png", muted: true, onStart: () => {}, concurrency: 1,
        scale: args.presetOptions.scale ?? 1, puppeteerInstance: browser, cancelSignal: args.cancelSignal,
        onFrameUpdate: () => {}, onFrameBuffer: (buffer) => { png = buffer; },
      });
      if (!png) throw new Error(`mask image for ${id} was not rendered`);
      const file = join(dir, `${files.size}.png`);
      writeFileSync(file, png);
      files.set(id, file);
    }
  } finally {
    if (ownsBrowser) await browser.close({ silent: true });
  }
  return files;
}

/**
 * Preset for callers that name none. Hardware H.264 only where it is known to work: macOS with VideoToolbox, the one
 * encoder measured so far (6-9x faster than the CRF 18 software master; VMAF 97.6 vs 99.1 against a lossless composite,
 * and higher than the 12M HEVC preset's 92.0). Listing nvenc/qsv in `ffmpeg -encoders` does not prove a GPU is present,
 * and that failure would surface mid-export instead of falling back, so other platforms keep the software master.
 */
export function defaultLayeredPreset(): "h264-hardware" | "master" {
  if (process.platform !== "darwin") return "master";
  try {
    return execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).includes("h264_videotoolbox") ? "h264-hardware" : "master";
  } catch { return "master"; }
}

function videoEncoder(preset: RenderPreset, threads: number) {
  const codec = preset.codec ?? "h264";
  const required = preset.hardwareAcceleration === "required";
  const optional = preset.hardwareAcceleration === "if-possible";
  const encoders = required || optional ? execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }) : "";
  const preferred = process.platform === "darwin"
    ? codec === "h264" ? ["h264_videotoolbox"] : ["hevc_videotoolbox"]
    : codec === "h264" ? ["h264_nvenc", "h264_qsv"] : ["hevc_nvenc", "hevc_qsv"];
  const hardware = preferred.find((name) => encoders.includes(name));
  if ((required || optional) && hardware) {
    if (preset.videoBitrate) return { name: hardware, options: ["-b:v", preset.videoBitrate] };
    if (required) throw new LayeredUnsupportedError(`required hardware preset ${codec} needs an explicit bitrate`);
  }
  if (required) throw new LayeredUnsupportedError(`required hardware encoder ${preferred.join(" or ")} is unavailable`);
  if (preset.crf === undefined) throw new LayeredUnsupportedError(`${codec} preset needs a CRF for software encoding`);
  return { name: codec === "h264" ? "libx264" : "libx265", options: ["-preset", "medium", "-crf", String(preset.crf), ...(codec === "h265" ? ["-x265-params", `pools=${threads}:frame-threads=${threads}`] : [])] };
}

/** Unit vector from the frame centre toward the side a transition's incoming picture enters from (Composition.tsx ENTRY). */
const ENTRY = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] } as const;
/** `maskInputs` maps a masked item id to the ffmpeg input holding its mask image (alpha = mask coverage, at output size). */
export function makeVideoChain(plan: LayeredPlan, filters: string[], firstInput: number, maskInputs: ReadonlyMap<string, number> = new Map()) {
  filters.push(`color=c=${safeColor(plan.background)}:s=${plan.width}x${plan.height}:r=${plan.fps}:d=${time(plan.to - plan.from, plan.fps)},format=rgba[bg]`);
  let videoLabel = "bg";
  let index = firstInput;
  for (const segment of plan.video) {
    const item = segment.item;
    const clipStart = item.start - segment.lead;
    const offset = segment.decodeStart - clipStart;
    const preroll = segment.renderStart - segment.decodeStart;
    const duration = segment.renderEnd - segment.decodeStart;
    // A scaled item is fitted straight into its final size, then positioned by the overlay below.
    const place = segment.place;
    const [fitWidth, fitHeight] = place ? [place.width, place.height] : [plan.width, plan.height];
    const fit = item.fit === "cover"
      ? [`scale=${fitWidth}:${fitHeight}:force_original_aspect_ratio=increase`, `crop=${fitWidth}:${fitHeight}`]
      : [`scale=${fitWidth}:${fitHeight}:force_original_aspect_ratio=decrease`, "format=rgba", `pad=${fitWidth}:${fitHeight}:(ow-iw)/2:(oh-ih)/2:color=black@0`];
    // FFmpeg's RGB fade also fades the alpha channel on RGBA input, which
    // squares dip brightness after overlay. Darken opaque RGB before fitting
    // and adding transparency for letterboxing/dissolves/clip fades.
    const brightness: string[] = [];
    if (segment.incoming?.kind === "dip") addVideoFade(brightness, { start: -offset, duration: segment.incoming.after, color: true }, plan.fps, "in");
    if (segment.outgoing?.kind === "dip") addVideoFade(brightness, { start: segment.lead + segment.duration - segment.outgoing.before - offset, duration: segment.outgoing.before, color: true }, plan.fps, "out");
    let chain = [`[${index}:v:0]trim=duration=${time(duration, plan.fps)}`, "setpts=PTS-STARTPTS", `fps=${plan.fps}`, "format=rgb24", ...brightness, ...fit, "setsar=1", "format=rgba"];
    if (item.mask) {
      // The mask applies to the fitted picture before it is scaled and moved, like Composition.tsx. Multiply with the picture's own
      // alpha so letterbox padding stays transparent, then merge the product back.
      const maskInput = maskInputs.get(item.id);
      if (maskInput === undefined) throw new Error(`layered export has no mask image for ${item.id}`);
      filters.push([...chain, `split[mkv${index}][mka${index}]`].join(","));
      filters.push(`[mka${index}]alphaextract[mkp${index}]`);
      filters.push(`[${maskInput}:v:0]scale=${fitWidth}:${fitHeight},format=rgba,alphaextract[mks${index}]`);
      filters.push(`[mkp${index}][mks${index}]blend=all_mode=multiply[mkc${index}]`);
      chain = [`[mkv${index}][mkc${index}]alphamerge`];
    }
    const effects: string[] = place && place.opacity !== 1 ? [`colorchannelmixer=aa=${place.opacity}`] : [];
    addVideoFade(effects, { start: segment.lead - offset, duration: item.fadeIn ?? 0, alpha: true }, plan.fps, "in");
    addVideoFade(effects, { start: segment.lead + segment.duration - (item.fadeOut ?? 0) - offset, duration: item.fadeOut ?? 0, alpha: true }, plan.fps, "out");
    if (segment.incoming && (segment.incoming.kind === "dissolve" || segment.incoming.kind === "zoom")) addVideoFade(effects, { start: -offset, duration: segment.incoming.before + segment.incoming.after, alpha: true }, plan.fps, "in");
    const label = `vc${index}`;
    // slide, push and zoom, as Composition.look() sees them: progress is 0..1 across the transition, in output seconds.
    const progress = (startFrame: number, frames: number) => `clip((t-${time(startFrame - plan.from, plan.fps)})/${time(frames, plan.fps)},0,1)`;
    const shift = { x: [] as string[], y: [] as string[] }, zoom: string[] = [];
    const { incoming, outgoing } = segment;
    if (incoming && incoming.kind !== "dip") {
      const [vx, vy] = ENTRY[incoming.direction], t = progress(clipStart, incoming.before + incoming.after);
      if (incoming.kind === "slide" || incoming.kind === "push") { if (vx) shift.x.push(`${vx * plan.width}*(1-${t})`); if (vy) shift.y.push(`${vy * plan.height}*(1-${t})`); }
      if (incoming.kind === "zoom") zoom.push(`(1.25-0.25*${t})`);
    }
    if (outgoing && outgoing.kind !== "dip") {
      const [vx, vy] = ENTRY[outgoing.direction], t = progress(item.start + item.duration - outgoing.before, outgoing.before + outgoing.after);
      if (outgoing.kind === "push") { if (vx) shift.x.push(`${-vx * plan.width}*${t}`); if (vy) shift.y.push(`${-vy * plan.height}*${t}`); }
      if (outgoing.kind === "zoom") zoom.push(`(1+0.25*${t})`);
    }
    chain.push(...effects, `trim=start=${time(preroll, plan.fps)}:duration=${time(segment.renderEnd - segment.renderStart, plan.fps)}`, "setpts=PTS-STARTPTS", `setpts=PTS+${time(segment.renderStart - plan.from, plan.fps)}/TB`);
    // After the pts shift `t` is timeline time. The scale is re-evaluated per frame; the overlay then centres the scaled picture.
    const zoomScale = zoom.length ? `scale=w='round(${plan.width}*${zoom.join("*")})':h='round(${plan.height}*${zoom.join("*")})':eval=frame` : undefined;
    if (incoming?.kind === "wipe") {
      // The incoming picture is revealed from the entry side: a white rectangle slides in over a transparent canvas, and its alpha,
      // multiplied with the clip's own, is the clip's new alpha (Composition.look() clips it with an inset that shrinks the opposite side).
      const [vx, vy] = ENTRY[incoming.direction], t = progress(clipStart, incoming.before + incoming.after);
      const canvas = (color: string) => `color=${color}:s=${plan.width}x${plan.height}:r=${plan.fps}:d=${time(plan.to - plan.from, plan.fps)},format=rgba`;
      filters.push([...chain, `split[wv${index}][wa${index}]`].join(","));
      filters.push(`[wa${index}]alphaextract,format=gray[wp${index}]`);
      filters.push(`${canvas("black@0")}[wb${index}]`, `${canvas("white")}[ww${index}]`);
      filters.push(`[wb${index}][ww${index}]overlay=x='${vx * plan.width}*(1-${t})':y='${vy * plan.height}*(1-${t})':format=auto:eof_action=pass,format=rgba,alphaextract,format=gray[wm${index}]`);
      filters.push(`[wp${index}][wm${index}]blend=all_mode=multiply:shortest=1[wc${index}]`);
      filters.push(`[wv${index}][wc${index}]alphamerge${zoomScale ? `,${zoomScale}` : ""}[${label}]`);
    } else {
      if (zoomScale) chain.push(zoomScale);
      chain[chain.length - 1] += `[${label}]`;
      filters.push(chain.join(","));
    }
    const next = `base${index}`;
    const axis = (size: number, fit: number, offset: number, keyed?: string) => keyed ? `'round(${(size - fit) / 2}+${keyed})'` : Math.round((size - fit) / 2 + offset);
    const moved = (size: "main_w" | "main_h", own: "overlay_w" | "overlay_h", parts: string[]) => `'round(${[...(zoom.length ? [`(${size}-${own})/2`] : []), ...parts].join("+")})'`;
    const at = place ? `:x=${axis(plan.width, fitWidth, place.x, place.xExpr)}:y=${axis(plan.height, fitHeight, place.y, place.yExpr)}`
      : shift.x.length || shift.y.length || zoom.length ? `:x=${moved("main_w", "overlay_w", shift.x.length ? shift.x : ["0"])}:y=${moved("main_h", "overlay_h", shift.y.length ? shift.y : ["0"])}` : "";
    filters.push(`[${videoLabel}][${label}]overlay=format=rgb:eof_action=pass:shortest=0${at}:enable='gte(t,${time(segment.renderStart - plan.from, plan.fps)})*lt(t,${time(segment.renderEnd - plan.from, plan.fps)})'[${next}]`);
    videoLabel = next;
    index++;
  }
  return { nextInput: Math.max(index, ...[...maskInputs.values()].map((input) => input + 1)), videoLabel };
}
