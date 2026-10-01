import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AudioFx } from "@splicewright/core";
import { audioFxCachePath } from "@splicewright/core/node";
import { ffmpeg } from "./index.ts";

const MODEL = join(dirname(fileURLToPath(import.meta.url)), "../models/std.rnnn");
const inFlight = new Map<string, Promise<string>>();

function canonicalFx(fx: AudioFx): AudioFx {
  return {
    ...(fx.eq?.length ? { eq: fx.eq.map(({ hz, gain, q }) => ({ hz, gain, ...(q === undefined ? {} : { q }) })) } : {}),
    ...(fx.pan === undefined ? {} : { pan: fx.pan }),
    ...(fx.denoise ? { denoise: { kind: fx.denoise.kind, ...(fx.denoise.mix === undefined ? {} : { mix: fx.denoise.mix }) } } : {}),
  };
}

/** Relative project cache path. Source fingerprint participates so replacing media invalidates the bake. */
export function audioFxPath(dir: string, assetId: string, sourcePath: string, audioFx: AudioFx): string {
  const model = audioFx.denoise?.kind === "rnnoise" ? "model-missing" : "";
  return audioFxCachePath(dir, assetId, sourcePath, audioFx, model);
}

/** Bake a complete source once; the hash-keyed output is renamed into place only after ffmpeg succeeds. */
export async function ensureAudioFx(dir: string, assetId: string, sourcePath: string, audioFx: AudioFx): Promise<string> {
  const relative = audioFxPath(dir, assetId, sourcePath, audioFx);
  const output = join(dir, relative);
  if (existsSync(output)) return relative;
  const active = inFlight.get(output);
  if (active) return active;
  const task = (async () => {
    mkdirSync(dirname(output), { recursive: true });
    const tmp = output.replace(/\.m4a$/, `.tmp-${process.pid}-${Date.now()}.m4a`);
    const postFilters: string[] = [];
    const fx = canonicalFx(audioFx);
    for (const band of fx.eq ?? []) postFilters.push(`equalizer=f=${band.hz}:t=q:w=${band.q ?? 1}:g=${band.gain}`);
    if (fx.pan !== undefined) {
      const left = Math.min(1, Math.max(0, 1 - fx.pan));
      const right = Math.min(1, Math.max(0, 1 + fx.pan));
      postFilters.push(`aformat=channel_layouts=stereo,pan=stereo|c0=${left}*FL|c1=${right}*FR`);
    }
    let complex: string | undefined;
    if (fx.denoise) {
      const mix = fx.denoise.mix ?? 1;
      let denoiser: string;
      if (fx.denoise.kind === "fft") denoiser = "afftdn=nr=48:nf=-20:tn=1";
      else {
        if (!existsSync(MODEL)) throw new Error(`RNNoise model is missing: ${MODEL}`);
        denoiser = `arnndn=m='${MODEL.replace(/:/g, "\\:")}':mix=1`;
      }
      complex = `[0:a:0]asplit=2[dry][wet];[wet]${denoiser}[clean];[dry][clean]amix=inputs=2:weights='${(1 - mix).toFixed(6)} ${mix.toFixed(6)}':normalize=0${postFilters.length ? `,${postFilters.join(",")}` : ""}[aout]`;
    }
    try {
      await ffmpeg(["-i", join(dir, sourcePath), ...(complex ? ["-filter_complex", complex, "-map", "[aout]"] : ["-map", "0:a:0?", ...(postFilters.length ? ["-af", postFilters.join(",")] : [])]), "-vn", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", tmp]);
      if (!existsSync(tmp)) throw new Error(`ffmpeg did not create audioFx output for ${assetId}`);
      renameSync(tmp, output);
      return relative;
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  })();
  inFlight.set(output, task);
  try { return await task; } finally { inFlight.delete(output); }
}
