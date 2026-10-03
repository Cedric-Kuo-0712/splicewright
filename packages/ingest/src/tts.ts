import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apply, nextId, type Project } from "@splicewright/core";
import { fingerprint, load, loadCtx, run } from "@splicewright/core/node";
import { ingest } from "./index.ts";

export const TTS_LANGUAGES = ["en-us", "en-gb", "zh"] as const;
export type TtsLanguage = (typeof TTS_LANGUAGES)[number];
export const TTS_VOICES = [
  { id: "af_heart", name: "Heart (US, feminine)", language: "en-us" },
  { id: "am_adam", name: "Adam (US, masculine)", language: "en-us" },
  { id: "bf_emma", name: "Emma (UK, feminine)", language: "en-gb" },
  { id: "bm_george", name: "George (UK, masculine)", language: "en-gb" },
  { id: "zf_001", name: "Chinese voice 001 (feminine)", language: "zh" },
  { id: "zm_010", name: "Chinese voice 010 (masculine)", language: "zh" },
] as const;
export type GeneratedAudioInsertRequest = { at: number; trackId?: string; base: number };
export type TtsRequest = GeneratedAudioInsertRequest & { text: string; language: TtsLanguage; voice: string; speed?: number };

const script = fileURLToPath(new URL("../../../ingest/tts.py", import.meta.url));
const root = () => process.env.SPLICEWRIGHT_TTS_HOME || join(homedir(), ".splicewright", "tts");
const python = () => process.env.SPLICEWRIGHT_TTS_PYTHON || (process.platform === "win32" ? "py" : "python3");
const pythonPrefix = () => process.env.SPLICEWRIGHT_TTS_PYTHON_ARGS?.split(" ").filter(Boolean) ?? (process.platform === "win32" ? ["-3.12"] : []);

type PythonReply<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };
function invokePython<T>(command: "status" | "setup" | "generate", input?: unknown, timeout = 30_000, progress?: (line: string) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const runtime = join(root(), ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const useRuntime = command !== "setup" && existsSync(runtime);
    const executable = useRuntime ? runtime : python();
    const child = spawn(executable, [...(useRuntime ? [] : pythonPrefix()), script, command, "--root", root()], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", finalJson = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try { const value = JSON.parse(line); if (value && typeof value === "object" && "ok" in value) finalJson = line; else progress?.(`${line}\n`); }
        catch { if (line) progress?.(`${line}\n`); }
      }
      if (stdout.length > 64_000) stdout = stdout.slice(-64_000);
    });
    child.stderr.on("data", (chunk: Buffer) => { const text = chunk.toString(); stderr = (stderr + text).slice(-4_000); progress?.(text); });
    child.on("error", (error) => { clearTimeout(timer); reject(new Error(`cannot start Python (${executable}): ${error.message}`)); });
    child.stdin.on("error", (error) => { clearTimeout(timer); child.kill(); reject(new Error(`cannot send Kokoro request: ${error.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`Kokoro ${command} timed out after ${Math.round(timeout / 1000)} seconds`));
      let reply: PythonReply<T>;
      const last = stdout.trim();
      try { reply = JSON.parse(finalJson || last) as PythonReply<T>; }
      catch { return reject(new Error(stderr.trim() || `Kokoro ${command} failed (Python exited ${code})`)); }
      if (code !== 0 || !reply.ok) return reject(new Error(reply.ok ? `Kokoro ${command} failed (Python exited ${code})` : reply.error.message));
      resolve(reply.result);
    });
    if (input === undefined) child.stdin.end(); else child.stdin.end(JSON.stringify(input));
  });
}

export type TtsStatus = {
  ready: boolean; voices: typeof TTS_VOICES; languages: { id: TtsLanguage; name: string; ready: boolean }[];
  installedLanguages?: TtsLanguage[]; pythonInstalled?: boolean; setupCommand: string; root?: string; detail?: string;
};

export async function ttsStatus(): Promise<TtsStatus> {
  try { return await invokePython<TtsStatus>("status"); }
  catch (error) {
    return { ready: false, voices: TTS_VOICES, languages: TTS_LANGUAGES.map((id) => ({ id, name: id === "zh" ? "Mandarin Chinese" : id === "en-us" ? "English (US)" : "English (UK)", ready: false })), setupCommand: "splicewright tts setup --language en-us,zh", detail: (error as Error).message };
  }
}

export async function setupTTS(languages: TtsLanguage[], progress?: (line: string) => void) {
  if (!languages.length || languages.some((language) => !TTS_LANGUAGES.includes(language))) throw new Error("choose one or more supported languages: en-us, en-gb, zh");
  return invokePython<TtsStatus & { installed: TtsLanguage[] }>("setup", { languages: [...new Set(languages)] }, 20 * 60_000, progress);
}

export function validateTTSRequest(input: unknown): TtsRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("request must be a JSON object"), { code: "invalid_args" });
  const b = input as Record<string, unknown>;
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text || text.length > 2000) throw Object.assign(new Error("text must contain 1 to 2000 characters"), { code: "invalid_args" });
  if (!TTS_LANGUAGES.includes(b.language as TtsLanguage)) throw Object.assign(new Error("language must be en-us, en-gb, or zh"), { code: "invalid_args" });
  const language = b.language as TtsLanguage;
  if (!TTS_VOICES.some((voice) => voice.id === b.voice && voice.language === language)) throw Object.assign(new Error(`voice is not available for ${language}`), { code: "invalid_args" });
  const speed = b.speed === undefined ? 1 : b.speed;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.5 || speed > 2) throw Object.assign(new Error("speed must be a number between 0.5 and 2"), { code: "invalid_args" });
  if (!Number.isSafeInteger(b.base) || (b.base as number) < 0) throw Object.assign(new Error("base must be the current non-negative project revision"), { code: "invalid_args" });
  if (!Number.isSafeInteger(b.at) || (b.at as number) < 0) throw Object.assign(new Error("at must be a non-negative timeline frame"), { code: "invalid_args" });
  if (b.trackId !== undefined && (typeof b.trackId !== "string" || !b.trackId.trim())) throw Object.assign(new Error("trackId must be a non-empty string"), { code: "invalid_args" });
  return { text, language, voice: b.voice as string, speed, base: b.base as number, at: b.at as number, ...(typeof b.trackId === "string" && { trackId: b.trackId.trim() }) };
}

async function probeDuration(path: string): Promise<number> {
  const child = await new Promise<{ stdout: string; stderr: string }>((ok, fail) => {
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,duration", "-of", "json", path], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    p.stderr.on("data", (b: Buffer) => { stderr = (stderr + b.toString()).slice(-1000); });
    const timer = setTimeout(() => { p.kill("SIGKILL"); fail(new Error("ffprobe timed out while validating generated WAV")); }, 15_000);
    p.on("error", (error) => { clearTimeout(timer); fail(new Error(`cannot validate generated WAV: ${error.message}`)); });
    p.on("close", (code) => { clearTimeout(timer); code === 0 ? ok({ stdout, stderr }) : fail(new Error(stderr || `ffprobe exited ${code}`)); });
  });
  const streams = JSON.parse(child.stdout).streams ?? [];
  const duration = Number(streams[0]?.duration);
  if (!streams.length || !Number.isFinite(duration) || duration <= 0) throw new Error("generated file is not a valid non-empty WAV");
  return duration;
}

function trackForInsertion(project: Project, trackId: string | undefined, at: number, duration: number): { trackId: string; create: boolean } {
  if (trackId) {
    const track = project.tracks.find((item) => item.id === trackId);
    if (!track || track.kind !== "audio") throw Object.assign(new Error(`track ${trackId} is not an audio track`), { code: "invalid_args" });
    if (track.locked) throw Object.assign(new Error(`audio track ${trackId} is locked`), { code: "locked" });
    return { trackId, create: false };
  }
  const track = project.tracks.find((item) => item.kind === "audio" && !item.locked && (item.magnetic || !item.items.some((item) => at < item.start + item.duration && at + duration > item.start)));
  return track ? { trackId: track.id, create: false } : { trackId: nextId(project, "t"), create: true };
}

/** Reject stale edits and explicit locked/invalid tracks before expensive audio generation. */
export function preflightGeneratedAudioInsert(dir: string, request: GeneratedAudioInsertRequest): void {
  const project = load(dir);
  if (project.revision !== request.base) throw Object.assign(new Error(`project is at revision ${project.revision}; generation was based on ${request.base}`), { code: "conflict" });
  if (request.trackId) trackForInsertion(project, request.trackId, request.at, 1);
}

export async function generateAndInsertTTS(dir: string, untrusted: unknown) {
  const request = validateTTSRequest(untrusted);
  const before = load(dir);
  if (before.revision !== request.base) throw Object.assign(new Error(`project is at revision ${before.revision}; generation was based on ${request.base}`), { code: "conflict" });
  if (request.trackId) trackForInsertion(before, request.trackId, request.at, 1);
  const tempDir = mkdtempSync(join(tmpdir(), "swr-tts-"));
  const tempPath = join(tempDir, "narration.wav");
  try {
    await invokePython("generate", { text: request.text, language: request.language, voice: request.voice, speed: request.speed, output: tempPath }, 180_000);
    const seconds = await probeDuration(tempPath);
    const result = await insertGeneratedWav(dir, request, tempPath, seconds);
    // The edit is already committed; preparation failures must not delete its source or suggest retrying the edit.
    let warnings: string[] = [];
    try {
      const prepared = await ingest(dir, { only: ["waveform"], assets: [result.assetId], jobs: 1 });
      warnings = prepared.errors?.map((error) => `Narration added; media preparation: ${JSON.stringify(error)}`) ?? [];
    } catch (error) { warnings = [`Narration added; media preparation failed: ${(error as Error).message}`]; }
    return { ...result, ...(warnings.length && { warnings }) };
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
}

/** Publish a probed WAV and atomically register+insert it as one undoable project change. */
export async function insertGeneratedWav(dir: string, request: GeneratedAudioInsertRequest, tempPath: string, seconds: number) {
  const before = load(dir);
  if (before.revision !== request.base) throw Object.assign(new Error(`project changed during speech generation; expected revision ${request.base}`), { code: "conflict" });
  const duration = Math.floor(seconds * before.meta.fps + 1e-6);
  if (!Number.isSafeInteger(duration) || duration < 1) throw new Error("generated audio must contain at least one timeline frame");
  const relativePath = `raw/narration-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.wav`;
  mkdirSync(join(dir, "raw"), { recursive: true });
  copyFileSync(tempPath, join(dir, relativePath));
  try {
    const imported = apply(before, "importAsset", { path: relativePath }, loadCtx(dir, before));
    if ("error" in imported) throw Object.assign(new Error(imported.error.message), { code: imported.error.code });
    const ctx = loadCtx(dir, imported.project);
    const fp = fingerprint(join(dir, relativePath));
    const assetId = Object.values(imported.project.assets).find((asset) => asset.path === relativePath)?.id
      ?? Object.values(imported.project.assets).find((asset) => ctx.fingerprints?.[asset.id] === fp)?.id;
    if (!assetId) throw new Error("unable to identify generated audio asset");
    const itemId = nextId(imported.project, "i");
    const track = trackForInsertion(imported.project, request.trackId, request.at, duration);
    const ops = [
      { op: "importAsset", args: { path: relativePath } },
      ...(track.create ? [{ op: "addTrack", args: { kind: "audio", name: "Narration" } }] : []),
      { op: "insertItem", args: { assetId, trackId: track.trackId, at: request.at, duration } },
    ];
    const result = run(dir, "batch", { ops }, request.base, { assetDurations: { ...ctx.assetDurations, [assetId]: seconds } });
    if ("error" in result) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    const asset = result.project.assets[assetId];
    if (asset?.path !== relativePath) rmSync(join(dir, relativePath), { force: true });
    return { project: result.project, revision: result.project.revision, summary: result.changes.summary, assetId, itemId, duration, undoSteps: 1 };
  } catch (error) {
    rmSync(join(dir, relativePath), { force: true });
    throw error;
  }
}
