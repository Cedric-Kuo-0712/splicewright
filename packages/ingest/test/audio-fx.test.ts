import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { init, run } from "@splicewright/core/node";
import { audioFxPath, ensureAudioFx, ffmpeg } from "../src/index.ts";

const dirs: string[] = [];
async function fixture(source: string, background?: string) {
  const dir = mkdtempSync(join(tmpdir(), "swr-audiofx-"));
  dirs.push(dir);
  init(dir, { title: "audioFx", fps: 30, width: 320, height: 180 });
  await ffmpeg(["-f", "lavfi", "-i", source, ...(background ? ["-f", "lavfi", "-i", background, "-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0[a]", "-map", "[a]"] : []), "-c:a", "pcm_s16le", join(dir, "source.wav")]);
  const imported = run(dir, "importAsset", { path: "source.wav" });
  if ("error" in imported) throw new Error(imported.error.message);
  const asset = Object.values(imported.project.assets)[0];
  return { dir, asset };
}
function rmsDb(file: string, channel?: "FL" | "FR", bandpass = false) {
  const filter = `${channel ? `pan=mono|c0=${channel},` : ""}${bandpass ? "bandpass=f=1000:w=80," : ""}astats=metadata=1:reset=0,ametadata=print:file=-`;
  const output = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-af", filter, "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const matches = [...output.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?\d+(?:\.\d+)?|-inf)/g)];
  const n = matches.at(-1)?.[1];
  if (!n) throw new Error("ffmpeg astats returned no RMS");
  return n === "-inf" ? -120 : Number(n);
}

afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

it("bakes EQ with the requested cut and invalidates cache when audioFx changes", async () => {
  const { dir, asset } = await fixture("sine=frequency=1000:sample_rate=48000:duration=2", "anoisesrc=color=pink:sample_rate=48000:duration=2:amplitude=0.02:seed=42");
  const fx = { eq: [{ hz: 1000, gain: -12, q: 1 }] };
  const path = await ensureAudioFx(dir, asset.id, asset.path, fx);
  expect(existsSync(join(dir, path))).toBe(true);
  const sourceDb = rmsDb(join(dir, asset.path), undefined, true);
  const bakedDb = rmsDb(join(dir, path), undefined, true);
  expect(sourceDb - bakedDb).toBeGreaterThanOrEqual(11);
  expect(sourceDb - bakedDb).toBeLessThanOrEqual(13);
  expect(audioFxPath(dir, asset.id, asset.path, { eq: [{ hz: 1000, gain: -6 }] })).not.toBe(path);
});

it("hard-pans left without leaking into the right channel", async () => {
  const { dir, asset } = await fixture("aevalsrc=0.4|0.4:s=48000:d=1:c=stereo");
  const path = await ensureAudioFx(dir, asset.id, asset.path, { pan: -1 });
  expect(rmsDb(join(dir, path), "FL")).toBeGreaterThan(-15);
  expect(rmsDb(join(dir, path), "FR")).toBeLessThan(-70);
  const center = await ensureAudioFx(dir, asset.id, asset.path, { pan: 0 });
  expect(Math.abs(rmsDb(join(dir, center), "FL") - rmsDb(join(dir, asset.path), "FL"))).toBeLessThan(0.5);
  expect(Math.abs(rmsDb(join(dir, center), "FR") - rmsDb(join(dir, asset.path), "FR"))).toBeLessThan(0.5);
  const mono = await fixture("sine=frequency=500:sample_rate=48000:duration=1");
  const monoOut = await ensureAudioFx(mono.dir, mono.asset.id, mono.asset.path, { pan: -1 });
  expect(rmsDb(join(mono.dir, monoOut), "FL")).toBeGreaterThan(-25);
  expect(rmsDb(join(mono.dir, monoOut), "FR")).toBeLessThan(-70);
});

it("FFT denoise reduces noise-only RMS and writes no partial artifact after failure", async () => {
  const { dir, asset } = await fixture("anoisesrc=color=pink:sample_rate=48000:duration=2:amplitude=0.3:seed=42");
  const path = await ensureAudioFx(dir, asset.id, asset.path, { denoise: { kind: "fft" } });
  expect(rmsDb(join(dir, path))).toBeLessThan(rmsDb(join(dir, asset.path)) - 3);
  const dry = await ensureAudioFx(dir, asset.id, asset.path, { denoise: { kind: "fft", mix: 0 } });
  expect(Math.abs(rmsDb(join(dir, dry)) - rmsDb(join(dir, asset.path)))).toBeLessThan(0.5);
  const missing = { denoise: { kind: "rnnoise" as const, model: "raw/missing.rnnn" } };
  const audioDir = join(dir, ".splicewright", "audio");
  const before = readdirSync(audioDir);
  await expect(ensureAudioFx(dir, asset.id, asset.path, missing)).rejects.toThrow(/RNNoise model is missing/);
  expect(readdirSync(audioDir)).toEqual(before);
});

it("rejects an incompatible custom RNNoise model without falling back to FFT", async () => {
  const { dir, asset } = await fixture("anoisesrc=color=pink:sample_rate=48000:duration=1:amplitude=0.1:seed=42");
  mkdirSync(join(dir, "raw"), { recursive: true });
  writeFileSync(join(dir, "raw", "invalid.rnnn"), "not an RNNoise model");
  const fx = { denoise: { kind: "rnnoise" as const, model: "raw/invalid.rnnn" } };
  await expect(ensureAudioFx(dir, asset.id, asset.path, fx)).rejects.toThrow(/incompatible with ffmpeg arnndn/);
  expect(existsSync(join(dir, audioFxPath(dir, asset.id, asset.path, fx)))).toBe(false);
});

const upstreamModel = process.env.SWR_RNNOISE_MODEL;
it.skipIf(!upstreamModel)("bakes a user-supplied RNNoise model through ffmpeg arnndn", async () => {
  let { dir, asset } = await fixture("anoisesrc=color=pink:sample_rate=48000:duration=1:amplitude=0.1:seed=42");
  const specialDir = `${dir}-model:a,b'c`;
  renameSync(dir, specialDir);
  dirs[dirs.indexOf(dir)] = specialDir;
  dir = specialDir;
  mkdirSync(join(dir, "raw"), { recursive: true });
  const { copyFileSync } = await import("node:fs");
  copyFileSync(upstreamModel!, join(dir, "raw", "user.rnnn"));
  const path = await ensureAudioFx(dir, asset.id, asset.path, { denoise: { kind: "rnnoise", model: "raw/user.rnnn" } });
  expect(existsSync(join(dir, path))).toBe(true);
  expect(existsSync(join(tmpdir(), "splicewright-audiofx-models"))).toBe(true);
});
