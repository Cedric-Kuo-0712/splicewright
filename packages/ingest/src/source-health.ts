import { spawn } from "node:child_process";
import type { AudioMeasurement, FinalMixMeasurement, SourceHealth } from "@splicewright/core/node";
import { withFfmpegResourceLimits } from "./resource.ts";

const AUDIO_FILTER = "astats=metadata=1:reset=1,ametadata=print,ebur128=metadata=1:peak=true,ametadata=print";

function run(cmd: string, args: string[], onStderr?: (chunk: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-4000);
      onStderr?.(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(tail) : reject(new Error(tail.trim().slice(-1200) || `${cmd} exited ${code}`)));
  });
}

function runStdout(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let tail = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { out += chunk; });
    child.stderr.on("data", (chunk: string) => { tail = (tail + chunk).slice(-1200); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(tail.trim() || `${cmd} exited ${code}`)));
  });
}

function newMeasurement(): AudioMeasurement {
  return {
    integratedLufs: null,
    samplePeak: { dbfs: null, atSeconds: null },
    truePeak: { dbfs: null, atSeconds: null },
  };
}

function audioLog(onStderr: (chunk: string) => void) {
  const measurement = newMeasurement();
  let pending = "";
  let atSeconds = 0;
  const take = (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const time = /pts_time:([+-]?(?:\d+(?:\.\d*)?|\.\d+))/.exec(line);
      if (time) atSeconds = Number(time[1]);
      const sample = /lavfi\.astats\.Overall\.Peak_level=([^\s]+)/.exec(line);
      if (sample) {
        const dbfs = Number(sample[1]);
        if (Number.isFinite(dbfs) && (measurement.samplePeak.dbfs === null || dbfs > measurement.samplePeak.dbfs))
          measurement.samplePeak = { dbfs, atSeconds };
      }
      const peak = /lavfi\.r128\.true_peak=([^\s]+)/.exec(line);
      if (peak) {
        const amplitude = Number(peak[1]);
        const dbfs = amplitude > 0 && Number.isFinite(amplitude) ? 20 * Math.log10(amplitude) : null;
        if (dbfs !== null && (measurement.truePeak.dbfs === null || dbfs > measurement.truePeak.dbfs))
          measurement.truePeak = { dbfs, atSeconds };
      }
    }
    onStderr(chunk);
  };
  return { measurement, take };
}

async function ffprobeHasAudio(file: string): Promise<boolean> {
  const raw = await runStdout("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", file]);
  const info = JSON.parse(raw);
  return info.streams.some((stream: { codec_type?: string }) => stream.codec_type === "audio");
}

async function decode(file: string, hasAudio: boolean): Promise<AudioMeasurement | undefined> {
  const capture = audioLog(() => {});
  const tail = await run("ffmpeg", withFfmpegResourceLimits([
    "-hide_banner", "-loglevel", "info", "-nostats", "-xerror", "-i", file,
    "-map", "0:v?", "-map", "0:a?",
    ...(hasAudio ? ["-filter:a", AUDIO_FILTER] : []),
    "-f", "null", "-",
  ]), capture.take);
  if (!hasAudio) return undefined;
  const integrated = /Integrated loudness:\s*I:\s*([^\s]+) LUFS/.exec(tail);
  if (!integrated) throw new Error("ebur128 printed no integrated loudness summary");
  const lufs = Number(integrated[1]);
  capture.measurement.integratedLufs = Number.isFinite(lufs) && lufs > -70 ? lufs : null;
  // Very short streams may end before the first 100 ms ebur128 metadata block.
  // Its summary still measures the peak, but cannot locate it within the source.
  if (capture.measurement.truePeak.dbfs === null) {
    const summary = /True peak:\s*Peak:\s*([^\s]+) dBFS/.exec(tail);
    if (!summary) throw new Error("ebur128 printed no true peak measurement");
    const dbfs = Number(summary[1]);
    if (Number.isFinite(dbfs)) capture.measurement.truePeak = { dbfs, atSeconds: null };
  }
  return capture.measurement;
}

/** Full-decodes every audio/video stream and measures audio sample/true peaks in the same pass. */
export async function measureFinalMix(file: string): Promise<FinalMixMeasurement> {
  const hasAudio = await ffprobeHasAudio(file);
  const audio = await decode(file, hasAudio);
  return { decoded: true, audio: audio ? { status: "measured", ...audio } : { status: "none" } };
}

/** Ingest result is persisted even when decoding fails, so lint can distinguish a broken source from an unmeasured one. */
export async function measureSourceHealth(file: string, path: string, fingerprint: string, hasAudio: boolean): Promise<SourceHealth> {
  const measuredAt = new Date().toISOString();
  try {
    const audio = await decode(file, hasAudio);
    return {
      format: 1, method: "ffmpeg", path, fingerprint, measuredAt,
      decode: { status: "ok" },
      audio: audio ? { status: "measured", ...audio } : { status: "none" },
    };
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    return {
      format: 1, method: "ffmpeg", path, fingerprint, measuredAt,
      decode: { status: "failed", error: message },
      audio: hasAudio ? { status: "failed", error: message } : { status: "none" },
    };
  }
}
