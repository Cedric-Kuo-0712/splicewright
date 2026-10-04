import type { Preset } from "./config.ts";

export const BUILTIN_PRESETS: Record<string, Preset> = {
  draft: { scale: 0.5, crf: 28 },
  master: { crf: 18 },
  "h264-cpu": { codec: "h264", hardwareAcceleration: "disable", crf: 18 },
  "h264-hardware": { codec: "h264", hardwareAcceleration: "required" },
  "h265-hardware": { codec: "h265", hardwareAcceleration: "required" },
};

export interface ExportDimensions {
  width: number;
  height: number;
  fps: number;
}

/** Use the HEVC MP4 sample entry recommended for Apple playback interoperability. */
export function withExportContainerTag(args: string[], codec: string, output: string): string[] {
  if (codec !== "h265" || !/\.mp4$/i.test(output)) return args;
  return [...args.slice(0, -1), "-tag:v", "hvc1", args.at(-1)!];
}

const BASE_PIXELS_PER_SECOND = 1920 * 1080 * 30;

function scaledBitrate(megapixelsPerSecond: number, baseMbps: number) {
  const mbps = Math.max(1, Math.round(baseMbps * (megapixelsPerSecond / BASE_PIXELS_PER_SECOND)));
  return `${mbps}M`;
}

/** Resolve builtin and project presets into the options passed to Remotion. */
export function resolveExportPreset(
  name: string,
  projectPresets: Record<string, Preset> | undefined,
  dimensions: ExportDimensions,
): Preset {
  const builtin = BUILTIN_PRESETS[name];
  const projectOverride = projectPresets?.[name];
  if (!builtin && !projectOverride) {
    const names = [...new Set([...Object.keys(BUILTIN_PRESETS), ...Object.keys(projectPresets ?? {})])];
    throw new Error(`unknown preset "${name}"; have ${names.join(", ")}`);
  }

  if (builtin?.codec && projectOverride?.codec && projectOverride.codec !== builtin.codec) {
    throw new Error(`preset "${name}" requires codec ${builtin.codec}`);
  }
  if (builtin?.hardwareAcceleration && projectOverride?.hardwareAcceleration && projectOverride.hardwareAcceleration !== builtin.hardwareAcceleration) {
    throw new Error(`preset "${name}" requires hardwareAcceleration ${builtin.hardwareAcceleration}`);
  }

  const scale = projectOverride?.scale ?? builtin?.scale ?? 1;
  const pixelsPerSecond = (dimensions.width * scale) * (dimensions.height * scale) * dimensions.fps;
  // Provisional bitrate starting points, not a guarantee of equivalence to software CRF 18.
  // Calibrate per workload through project presets before changing the default export mode.
  const defaultBitrate = name === "h264-hardware"
    ? scaledBitrate(pixelsPerSecond, 20)
    : name === "h265-hardware"
      ? scaledBitrate(pixelsPerSecond, 12)
      : undefined;
  const explicitMode = !!builtin?.codec;
  const resolved: Preset = {
    ...(explicitMode ? builtin : projectOverride ?? builtin),
    ...(defaultBitrate ? { videoBitrate: defaultBitrate } : {}),
    ...projectOverride,
  };
  // Optional undefined fields must not turn an explicitly selected hardware mode into CPU.
  if (explicitMode) {
    resolved.codec = builtin.codec;
    resolved.hardwareAcceleration = builtin.hardwareAcceleration;
    if (resolved.videoBitrate === undefined && defaultBitrate) resolved.videoBitrate = defaultBitrate;
    if (name === "h264-cpu" && projectOverride?.videoBitrate !== undefined && projectOverride.crf === undefined) delete resolved.crf;
  }

  if (resolved.hardwareAcceleration === "required" && resolved.crf !== undefined) {
    throw new Error(`preset "${name}" cannot combine crf with hardwareAcceleration`);
  }
  if (resolved.crf !== undefined && resolved.videoBitrate !== undefined) {
    throw new Error(`preset "${name}" cannot combine crf with videoBitrate`);
  }
  return resolved;
}
