import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { renderFrames, renderMedia } from "@remotion/renderer";
import type { Project } from "@splicewright/core";
import { fingerprint, type Probe } from "@splicewright/core/node";
import { audioTransitionFades, planLayeredExport, type LayeredPlan } from "./layered.ts";
import { withExportContainerTag } from "./export-preset.ts";

type RenderPreset = { crf?: number; scale?: number; concurrency?: number; codec?: "h264" | "h265"; videoBitrate?: string; hardwareAcceleration?: "disable" | "if-possible" | "required" };
type RenderLike = Parameters<typeof renderMedia>[0];
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
// Honor source packet timestamps before establishing a continuous mix clock.
// Resetting PTS first compresses gaps/overlaps (observed in DJI AAC sources).
export const audioClipFilters = (frames: number, fps: number) =>
  `aresample=48000:async=1:min_hard_comp=0.000020833:first_pts=0,apad,atrim=end_sample=${Math.round(frames * 48000 / fps)},asetpts=N/SR/TB`;
const safeColor = (color: string) => {
  if (color === "transparent") return "black";
  if (/^#[\da-f]{3}$/i.test(color)) return `0x${[...color.slice(1)].map((value) => value + value).join("")}`;
  return color.startsWith("#") ? `0x${color.slice(1)}` : color;
};
function verifiedMediaProperties(path: string) {
  const output = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt,color_space,color_transfer,color_primaries,color_range,sample_aspect_ratio", "-of", "json", path], { encoding: "utf8" });
  const stream = (JSON.parse(output) as { streams?: { pix_fmt?: string; color_space?: string; color_transfer?: string; color_primaries?: string; color_range?: string; sample_aspect_ratio?: string }[] }).streams?.[0];
  if (!stream) throw new Error(`layered export unsupported: cannot probe video stream in ${path}`);
  if (/(?:p|gray)(?:10|12|14|16)(?:le|be)?|p0(?:10|12|16)/i.test(stream.pix_fmt ?? "")) throw new Error(`layered export unsupported: HDR or high bit depth video (${stream.pix_fmt})`);
  if (stream.sample_aspect_ratio && !["1:1", "N/A"].includes(stream.sample_aspect_ratio)) throw new Error(`layered export unsupported: non-square pixel aspect ratio ${stream.sample_aspect_ratio}`);
  for (const [name, value] of [["color space", stream.color_space], ["transfer", stream.color_transfer], ["primaries", stream.color_primaries]] as const)
    if (value && !["bt709", "unknown", "reserved"].includes(value)) throw new Error(`layered export unsupported: ${name} ${value}`);
}

function addVideoFade(filters: string[], options: { start: number; duration: number; color?: boolean; alpha?: boolean }, fps: number, direction: "in" | "out") {
  if (options.duration <= 0) return;
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

function addAudioEffects(item: { fadeIn?: number; fadeOut?: number }, offset: number, duration: number, out: string[], fps: number, transition?: { in?: number; outStart?: number; out?: number }) {
  if (item.fadeIn) out.push(`afade=t=in:st=${time(offset, fps)}:d=${time(item.fadeIn, fps)}`);
  if (item.fadeOut) out.push(`afade=t=out:st=${time(offset + duration - item.fadeOut, fps)}:d=${time(item.fadeOut, fps)}`);
  if (transition?.in) out.push(`afade=t=in:st=0:d=${time(transition.in, fps)}`);
  if (transition?.out && transition.outStart !== undefined) out.push(`afade=t=out:st=${time(transition.outStart, fps)}:d=${time(transition.out, fps)}`);
}

async function runFfmpeg(args: string[], cancelSignal: RenderLike["cancelSignal"], shouldCancel: (() => boolean) | undefined, onProgress: (value: number) => void, durationSeconds: number) {
  if (shouldCancel?.()) throw new Error("render cancelled");
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:2", "-nostats", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let progressLine = "";
    let cancelled = false;
    cancelSignal?.(() => { cancelled = true; child.kill("SIGTERM"); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      progressLine += chunk;
      const lines = progressLine.split(/\r?\n/);
      progressLine = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (match) onProgress(Math.min(1, Number(match[1]) / 1_000_000 / durationSeconds));
        else if (!line.startsWith("frame=") && !line.startsWith("fps=") && !line.startsWith("speed=") && !line.startsWith("progress=")) stderr = `${stderr}${line}\n`.slice(-2000);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (cancelled || shouldCancel?.()) reject(new Error("render cancelled"));
      else if (code === 0) { onProgress(1); resolvePromise(); }
      else reject(new Error(stderr.trim() || `ffmpeg exited ${code}`));
    });
  });
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
    throw new Error("layered export unsupported: project configuration requires the Remotion route");
  }
  for (const track of project.tracks) for (const item of track.items) {
    if (track.hidden || !("assetId" in item)) continue;
    if (track.kind !== "video" && track.kind !== "audio") continue;
    const asset = project.assets[item.assetId];
    const probe = probes[item.assetId];
    if (!asset || !probe || probe.path !== asset.path || probe.fingerprint !== fingerprint(resolveProjectAsset(dir, asset.path)))
      throw new Error(`layered export unsupported: media probe for ${item.id} is stale`);
  }
  const plan = planLayeredExport(project, probes, ...(range ?? [0, Math.max(1, args.remotion.composition.durationInFrames)]), args.presetOptions.scale ?? 1);
  const work = mkdtempSync(join(tmpdir(), "swr-layered-"));
  const outputExt = extname(output) || ".mp4";
  const stagedOutput = join(dirname(output), `.${basename(output, outputExt)}.layered-${randomUUID()}${outputExt}`);
  try {
    mkdirSync(dirname(output), { recursive: true });
    const frameCount = plan.to - plan.from;
    let activeFrames = 0;
    for (const [start, end] of plan.windows) activeFrames += end - start;
    let renderedFrames = 0;
    const overlayStart = performance.now();
    const overlayPaths: { path: string; firstFrame: number; start: number; end: number }[] = [];
    const graphicsGroups = scheduling === "grouped" && plan.windows.length ? [plan.windows] : plan.windows.map(window => [window]);
    for (const [windowIndex, windows] of graphicsGroups.entries()) {
      if (shouldCancel()) throw new Error("render cancelled");
      const path = join(work, `graphics-${windowIndex}`);
      const inputProps = { ...args.remotion.inputProps, graphicsOnly: true };
      // PNG keeps browser RGB and alpha intact. VP9 intermediates introduce
      // another lossy generation and require a special decoder for alpha.
      const frames = await renderFrames({
        ...args.remotion,
        inputProps,
        composition: { ...args.remotion.composition, props: { ...args.remotion.composition.props, graphicsOnly: true } },
        outputDir: path,
        // Multi-range frameRange renumbers images from zero in Remotion.
        // Explicit frames keeps original timeline numbers across sparse windows.
        ...(scheduling === "grouped"
          ? { frames: windows.flatMap(([start, end]) => Array.from({ length: end - start }, (_, i) => start + i)) }
          : { frameRange: [windows[0][0], windows[0][1] - 1] as [number, number] }),
        imageFormat: "png",
        muted: true,
        onStart: () => {},
        concurrency: args.resources?.concurrency ?? args.presetOptions.concurrency ?? 2,
        ...(args.resources?.mediaCacheSizeInBytes !== undefined ? { mediaCacheSizeInBytes: args.resources.mediaCacheSizeInBytes } : {}),
        ...(args.resources?.offthreadVideoCacheSizeInBytes !== undefined ? { offthreadVideoCacheSizeInBytes: args.resources.offthreadVideoCacheSizeInBytes } : {}),
        scale: args.presetOptions.scale ?? 1,
        onFrameUpdate: (count) => args.onProgress?.(activeFrames ? 0.72 * (renderedFrames + count) / activeFrames : 0.72),
        cancelSignal: args.cancelSignal,
      });
      renderedFrames += windows.reduce((sum, [start, end]) => sum + end - start, 0);
      for (const [start, end] of windows)
        overlayPaths.push({ path: frames.assetsInfo.imageSequenceName, firstFrame: scheduling === "grouped" ? start : frames.assetsInfo.firstFrameIndex, start, end });
    }
    const graphicsMs = performance.now() - overlayStart;

    const inputs: string[] = [];
    const filters: string[] = [];
    const audioLabels: string[] = [];
    let inputIndex = 0;
    for (const segment of plan.video) {
      const path = resolveProjectAsset(dir, project.assets[segment.item.assetId].path);
      verifiedMediaProperties(path);
      const sourceIn = segment.sourceIn - seconds(segment.lead, plan.fps);
      inputs.push("-threads", "2", "-ss", sourceTime(sourceIn, plan.fps), "-i", path);
      if (segment.videoAudio) {
        const duration = segment.lead + segment.duration + segment.tail;
        const effects = [`volume=${segment.item.volume ?? 1}`];
        const transitionFades = audioTransitionFades(segment);
        addAudioEffects(segment.item, segment.lead, segment.duration, effects, plan.fps, {
          in: transitionFades.incoming,
          outStart: transitionFades.outgoing?.start,
          out: transitionFades.outgoing?.duration,
        });
        const label = `aud${inputIndex}`;
        filters.push(`[${inputIndex}:a:0]${audioClipFilters(duration, plan.fps)},${effects.join(",")},adelay=delays=${Math.round((segment.item.start - segment.lead) * 48000 / plan.fps)}S:all=1[${label}]`);
        audioLabels.push(`[${label}]`);
      }
      inputIndex++;
    }
    const videoChain = makeVideoChain(plan, filters, 0);
    inputIndex = videoChain.nextInput;
    for (const entry of plan.audio) {
      const track = project.tracks.find((candidate) => candidate.items.some((item) => item.id === entry.item.id));
      if (track?.kind !== "audio" || track.muted) continue;
      const path = resolveProjectAsset(dir, project.assets[entry.item.assetId].path);
      inputs.push("-threads", "2", "-ss", sourceTime(entry.item.sourceIn, plan.fps), "-i", path);
      const gain = (entry.item.volume ?? 1) * (track.volume ?? 1);
      const effects = [`volume=${gain}`];
      if (entry.item.fadeIn) effects.push(`afade=t=in:st=0:d=${time(entry.item.fadeIn, plan.fps)}`);
      if (entry.item.fadeOut) effects.push(`afade=t=out:st=${time(entry.duration - entry.item.fadeOut, plan.fps)}:d=${time(entry.item.fadeOut, plan.fps)}`);
      const label = `aud${inputIndex}`;
      filters.push(`[${inputIndex}:a:0]${audioClipFilters(entry.duration, plan.fps)},${effects.join(",")},adelay=delays=${Math.round(entry.start * 48000 / plan.fps)}S:all=1[${label}]`);
      audioLabels.push(`[${label}]`);
      inputIndex++;
    }
    for (const overlay of overlayPaths) {
      inputs.push("-threads", "2", "-framerate", String(plan.fps), "-start_number", String(overlay.firstFrame), "-i", overlay.path);
      const label = `graphic${inputIndex}`;
      filters.push(`[${inputIndex}:v:0]format=rgba,setpts=PTS+${time(overlay.start, plan.fps)}/TB[${label}]`);
      const next = `baseg${inputIndex}`;
      filters.push(`[${videoChain.videoLabel}][${label}]overlay=format=rgb:eof_action=pass:shortest=0:enable='gte(t,${time(overlay.start, plan.fps)})*lt(t,${time(overlay.end, plan.fps)})'[${next}]`);
      videoChain.videoLabel = next;
      inputIndex++;
    }
    // Keep composition in RGB until this single, explicit output conversion.
    // Merely tagging a default BT.601 conversion as BT.709 changes colors.
    filters.push(`[${videoChain.videoLabel}]trim=start=${time(plan.from, plan.fps)}:duration=${time(frameCount, plan.fps)},setpts=PTS-STARTPTS,fps=${plan.fps},scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p[vout]`);
    if (audioLabels.length) {
      filters.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,atrim=start=${time(plan.from, plan.fps)}:duration=${time(frameCount, plan.fps)},asetpts=PTS-STARTPTS${project.meta.limiter ? ",alimiter=limit=0.891:attack=1:release=120:level=disabled" : ""}[aout]`);
    }
    const encoder = videoEncoder(args.presetOptions, encoderThreads);
    const ffmpegArgs = ["-filter_complex_threads", String(filterThreads), ...inputs, "-filter_complex", filters.join(";"), "-map", "[vout]", ...(audioLabels.length ? ["-map", "[aout]"] : []), "-c:v", encoder.name, "-pix_fmt", "yuv420p", "-threads", String(encoderThreads), ...encoder.options, ...(audioLabels.length ? ["-c:a", "aac", "-b:a", "320k", "-ar", "48000"] : []), ...(/\.(?:mp4|mov)$/i.test(outputExt) ? ["-movflags", "+faststart"] : []), "-t", time(frameCount, plan.fps), "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", stagedOutput];
    const tagged = withExportContainerTag(ffmpegArgs, args.presetOptions.codec ?? "h264", stagedOutput);
    args.onEncoding?.(tagged);
    const encodeStart = performance.now();
    if (shouldCancel()) throw new Error("render cancelled");
    await runFfmpeg(tagged, args.cancelSignal, shouldCancel, (p) => args.onProgress?.(0.72 + p * 0.28), seconds(frameCount, plan.fps));
    const encodeMs = performance.now() - encodeStart;
    if (shouldCancel()) throw new Error("render cancelled");
    renameSync(stagedOutput, output);
    args.onProgress?.(1);
    return { output, frames: frameCount, preset, pipelineUsed: "layered" as const, fallbackReason: undefined, timingsMs: { graphics: Math.round(graphicsMs), encode: Math.round(encodeMs) } };
  } finally {
    rmSync(stagedOutput, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
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
    if (required) throw new Error(`layered export unsupported: required hardware preset ${codec} needs an explicit bitrate`);
  }
  if (required) throw new Error(`layered export unsupported: required hardware encoder ${preferred.join(" or ")} is unavailable`);
  if (preset.crf === undefined) throw new Error(`layered export unsupported: ${codec} preset needs a CRF for software encoding`);
  return { name: codec === "h264" ? "libx264" : "libx265", options: ["-preset", "medium", "-crf", String(preset.crf), ...(codec === "h265" ? ["-x265-params", `pools=${threads}:frame-threads=${threads}`] : [])] };
}

export function makeVideoChain(plan: LayeredPlan, filters: string[], firstInput: number) {
  filters.push(`color=c=${safeColor(plan.background)}:s=${plan.width}x${plan.height}:r=${plan.fps}:d=${time(plan.to, plan.fps)},format=rgba[bg]`);
  let videoLabel = "bg";
  let index = firstInput;
  for (const segment of plan.video) {
    const item = segment.item;
    const clipStart = item.start - segment.lead;
    const duration = segment.lead + item.duration + segment.tail;
    const fit = item.fit === "cover"
      ? [`scale=${plan.width}:${plan.height}:force_original_aspect_ratio=increase`, `crop=${plan.width}:${plan.height}`]
      : [`scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease`, "format=rgba", `pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`];
    // FFmpeg's RGB fade also fades the alpha channel on RGBA input, which
    // squares dip brightness after overlay. Darken opaque RGB before fitting
    // and adding transparency for letterboxing/dissolves/clip fades.
    const brightness: string[] = [];
    if (segment.incoming?.kind === "dip") addVideoFade(brightness, { start: 0, duration: segment.incoming.after, color: true }, plan.fps, "in");
    if (segment.outgoing?.kind === "dip") addVideoFade(brightness, { start: segment.lead + segment.duration - segment.outgoing.before, duration: segment.outgoing.before, color: true }, plan.fps, "out");
    const chain = [`[${index}:v:0]trim=duration=${time(duration, plan.fps)}`, "setpts=PTS-STARTPTS", `fps=${plan.fps}`, "format=rgb24", ...brightness, ...fit, "setsar=1", "format=rgba"];
    const effects: string[] = [];
    addVideoFade(effects, { start: segment.lead, duration: item.fadeIn ?? 0, alpha: true }, plan.fps, "in");
    addVideoFade(effects, { start: segment.lead + item.duration - (item.fadeOut ?? 0), duration: item.fadeOut ?? 0, alpha: true }, plan.fps, "out");
    if (segment.incoming?.kind === "dissolve") addVideoFade(effects, { start: 0, duration: segment.incoming.before + segment.incoming.after, alpha: true }, plan.fps, "in");
    const label = `vc${index}`;
    chain.push(...effects, `setpts=PTS+${time(clipStart, plan.fps)}/TB[${label}]`);
    filters.push(chain.join(","));
    const next = `base${index}`;
    filters.push(`[${videoLabel}][${label}]overlay=format=rgb:eof_action=pass:shortest=0:enable='gte(t,${time(Math.max(0, clipStart), plan.fps)})*lt(t,${time(clipStart + duration, plan.fps)})'[${next}]`);
    videoLabel = next;
    index++;
  }
  return { nextInput: index, videoLabel };
}
