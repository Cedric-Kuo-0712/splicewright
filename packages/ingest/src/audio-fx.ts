import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { AudioFx } from "@splicewright/core";
import { audioFxCachePath, audioFxModelFile, audioFxModelFingerprint } from "@splicewright/core/node";
import { ffmpeg } from "./index.ts";

const inFlight = new Map<string, Promise<string>>();

function canonicalFx(fx: AudioFx): AudioFx {
  return {
    ...(fx.eq?.length ? { eq: fx.eq.map(({ hz, gain, q }) => ({ hz, gain, ...(q === undefined ? {} : { q }) })) } : {}),
    ...(fx.pan === undefined ? {} : { pan: fx.pan }),
    ...(fx.denoise ? { denoise: { kind: fx.denoise.kind, ...(fx.denoise.mix === undefined ? {} : { mix: fx.denoise.mix }), ...(fx.denoise.model === undefined ? {} : { model: fx.denoise.model }) } } : {}),
  };
}

/** Relative project cache path. Source fingerprint participates so replacing media invalidates the bake. */
export function audioFxPath(dir: string, assetId: string, sourcePath: string, audioFx: AudioFx): string {
  return audioFxCachePath(dir, assetId, sourcePath, audioFx);
}

function modelFilterPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/'/g, "\\'");
}

function cachedRnnoiseModel(dir: string, modelPath: string): string {
  const source = audioFxModelFile(dir, modelPath);
  const bytes = readFileSync(source);
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  // Never pass the user-controlled project path to FFmpeg's filter parser. The only
  // filename supplied to arnndn is the verified model's content-addressed temp copy.
  const modelDir = join(tmpdir(), "splicewright-audiofx-models");
  mkdirSync(modelDir, { recursive: true });
  const realModelDir = realpathSync(modelDir);
  const rel = relative(realpathSync(tmpdir()), realModelDir);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("RNNoise model cache escapes the temporary directory");
  const output = join(realModelDir, `${fingerprint}.rnnn`);
  const validCache = existsSync(output) && lstatSync(output).isFile() && createHash("sha256").update(readFileSync(output)).digest("hex") === fingerprint;
  if (!validCache) {
    const tmp = `${output}.tmp-${process.pid}-${Date.now()}`;
    try { writeFileSync(tmp, bytes); renameSync(tmp, output); }
    catch (error) { rmSync(tmp, { force: true }); throw error; }
  }
  return output;
}

/** Bake a complete source once; the hash-keyed output is renamed into place only after ffmpeg succeeds. */
export async function ensureAudioFx(dir: string, assetId: string, sourcePath: string, audioFx: AudioFx): Promise<string> {
  const modelStamp = audioFx.denoise?.kind === "rnnoise" && audioFx.denoise.model
    ? audioFxModelFingerprint(dir, audioFx.denoise.model)
    : "";
  const relative = audioFxCachePath(dir, assetId, sourcePath, audioFx, modelStamp);
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
        if (!fx.denoise.model) throw new Error("RNNoise requires a custom model path under raw/ (for example raw/denoise.rnnn)");
        const model = cachedRnnoiseModel(dir, fx.denoise.model);
        if (createHash("sha256").update(readFileSync(model)).digest("hex") !== modelStamp) throw new Error("RNNoise model changed while processing; retry the audio bake");
        denoiser = `arnndn=m=${modelFilterPath(model)}:mix=1`;
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
      if (fx.denoise?.kind === "rnnoise" && !(error instanceof Error && /RNNoise/.test(error.message)))
        throw new Error(`RNNoise model is incompatible with ffmpeg arnndn: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  })();
  inFlight.set(output, task);
  try { return await task; } finally { inFlight.delete(output); }
}
