import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ingest } from "./index.ts";
import { insertGeneratedWav, preflightGeneratedAudioInsert, type GeneratedAudioInsertRequest } from "./tts.ts";

export type BreezyVoiceProfile = { id: string; name: string; transcript: string; durationSeconds: number; language: "zh" };
export type BreezyVoiceStatus = { ready: boolean; setupCommand: string; detail?: string; device?: string; voices: BreezyVoiceProfile[]; root?: string };
export type BreezyVoiceGenerationRequest = GeneratedAudioInsertRequest & { text: string; voiceId: string };
export type BreezyVoiceRegistration = { name: string; audioPath: string; transcript: string };

const setupScript = fileURLToPath(new URL("../../../ingest/setup_breezyvoice.py", import.meta.url));
const backendScript = fileURLToPath(new URL("../../../ingest/breezyvoice.py", import.meta.url));
const setupCommand = "splicewright tts setup --engine breezyvoice";
const root = () => process.env.SPLICEWRIGHT_BREEZYVOICE_HOME || join(homedir(), ".splicewright", "breezyvoice");
const python = () => process.env.SPLICEWRIGHT_BREEZYVOICE_PYTHON || (process.platform === "win32" ? "py" : "python3");
const pythonArgs = () => process.env.SPLICEWRIGHT_BREEZYVOICE_PYTHON_ARGS?.split(" ").filter(Boolean) ?? (process.platform === "win32" ? ["-3.12"] : []);

type PythonReply<T> = { ok: true; result: T } | { ok: false; error: { code?: string; message: string } };
function invoke<T>(script: string, command: string | undefined, input?: unknown, timeout = 30_000, progress?: (line: string) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const runtime = join(root(), "env", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const useRuntime = script === backendScript && existsSync(runtime);
    const executable = useRuntime ? runtime : python();
    const args = [...(useRuntime ? [] : pythonArgs()), script, ...(command ? [command] : []), ...(script === setupScript ? [] : ["--root", root()])];
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    let stdout = "", stderr = "", finalJson = "", timedOut = false, settled = false;
    const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill pip/model grandchildren too, so timed-out requests release their hardware and locks.
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch { child.kill("SIGKILL"); }
    }, timeout);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try { const value = JSON.parse(line); if (value && typeof value === "object" && "ok" in value) finalJson = line; else if (line) progress?.(`${line}\n`); }
        catch { if (line) progress?.(`${line}\n`); }
      }
      if (stdout.length > 64_000) stdout = stdout.slice(-64_000);
    });
    child.stderr.on("data", (chunk: Buffer) => { const value = chunk.toString(); stderr = (stderr + value).slice(-4_000); progress?.(value); });
    child.on("error", (error) => fail(new Error(`cannot start BreezyVoice Python (${executable}): ${error.message}`)));
    child.stdin.on("error", (error) => { child.kill(); fail(new Error(`cannot send BreezyVoice request: ${error.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (timedOut) return fail(new Error(`BreezyVoice ${command ?? "setup"} timed out after ${Math.round(timeout / 1000)} seconds`));
      let reply: PythonReply<T>;
      try { reply = JSON.parse(finalJson || stdout.trim()) as PythonReply<T>; }
      catch { return fail(new Error(stderr.trim() || `BreezyVoice failed (Python exited ${code})`)); }
      if (code !== 0 || !reply.ok) return fail(Object.assign(new Error(reply.ok ? `BreezyVoice failed (Python exited ${code})` : reply.error.message), { code: reply.ok ? "breezyvoice_failed" : reply.error.code ?? "breezyvoice_failed" }));
      settled = true;
      resolve(reply.result);
    });
    if (input === undefined) child.stdin.end(); else child.stdin.end(JSON.stringify(input));
  });
}

function profile(value: unknown): BreezyVoiceProfile {
  if (!value || typeof value !== "object") throw new Error("BreezyVoice returned an invalid voice profile");
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.transcript !== "string" || typeof entry.durationSeconds !== "number" || entry.language !== "zh") {
    throw new Error("BreezyVoice returned an invalid voice profile");
  }
  return { id: entry.id, name: entry.name, transcript: entry.transcript, durationSeconds: entry.durationSeconds, language: "zh" };
}

export async function breezyVoiceStatus(): Promise<BreezyVoiceStatus> {
  try {
    const value = await invoke<Record<string, unknown>>(backendScript, "status");
    return { ready: value.ready === true, setupCommand: String(value.setupCommand || setupCommand), ...(typeof value.detail === "string" && { detail: value.detail }), ...(typeof value.device === "string" && { device: value.device }), voices: Array.isArray(value.voices) ? value.voices.map(profile) : [], ...(typeof value.root === "string" && { root: value.root }) };
  } catch (error) { return { ready: false, setupCommand, voices: [], detail: (error as Error).message }; }
}

export async function setupBreezyVoice(progress?: (line: string) => void): Promise<BreezyVoiceStatus> {
  const result = await invoke<Record<string, unknown>>(setupScript, undefined, { root: root() }, 30 * 60_000, progress);
  return { ready: result.ready === true, setupCommand: String(result.setupCommand || setupCommand), ...(typeof result.detail === "string" && { detail: result.detail }), ...(typeof result.device === "string" && { device: result.device }), voices: Array.isArray(result.voices) ? result.voices.map(profile) : [], ...(typeof result.root === "string" && { root: result.root }) };
}

export async function listBreezyVoices(): Promise<BreezyVoiceProfile[]> {
  const voices = await invoke<unknown[]>(backendScript, "voices");
  if (!Array.isArray(voices)) throw new Error("BreezyVoice returned an invalid voice list");
  return voices.map(profile);
}

export async function registerBreezyVoice(request: BreezyVoiceRegistration): Promise<BreezyVoiceProfile> {
  return profile(await invoke(backendScript, "register", request, 150_000));
}

export async function deleteBreezyVoice(voiceId: string): Promise<{ deleted: string }> {
  return invoke(backendScript, "delete", { voiceId });
}

export function validateBreezyVoiceRequest(untrusted: unknown): BreezyVoiceGenerationRequest {
  if (!untrusted || typeof untrusted !== "object" || Array.isArray(untrusted)) throw Object.assign(new Error("request must be a JSON object"), { code: "invalid_args" });
  const value = untrusted as Record<string, unknown>;
  const text = typeof value.text === "string" ? value.text.trim() : "";
  const voiceId = typeof value.voiceId === "string" ? value.voiceId.trim() : "";
  const base = value.base;
  const at = value.at;
  const trackId = value.trackId;
  if (!text || text.length > 300 || !/[\u3400-\u9fff]/u.test(text)) throw Object.assign(new Error("text must contain 1 to 300 Taiwanese Mandarin characters"), { code: "invalid_args" });
  if (!voiceId) throw Object.assign(new Error("voiceId is required"), { code: "invalid_args" });
  if (!Number.isSafeInteger(base) || (base as number) < 0 || !Number.isSafeInteger(at) || (at as number) < 0) throw Object.assign(new Error("base and at must be non-negative integer values"), { code: "invalid_args" });
  if (trackId !== undefined && (typeof trackId !== "string" || !trackId.trim())) throw Object.assign(new Error("trackId must be a non-empty string"), { code: "invalid_args" });
  return { text, voiceId, base: base as number, at: at as number, ...(typeof trackId === "string" && { trackId: trackId.trim() }) };
}

export async function generateAndInsertBreezyVoice(dir: string, untrusted: unknown) {
  const request = validateBreezyVoiceRequest(untrusted);
  const { voiceId } = request;
  preflightGeneratedAudioInsert(dir, request);
  const tempDir = mkdtempSync(join(tmpdir(), "swr-breezyvoice-"));
  const tempPath = join(tempDir, "narration.wav");
  try {
    const generated = await invoke<{ durationSeconds: number }>(backendScript, "generate", { text: request.text, voiceId, output: tempPath }, 12 * 60_000);
    if (!Number.isFinite(generated.durationSeconds) || generated.durationSeconds <= 0) throw new Error("BreezyVoice returned an invalid audio duration");
    const result = await insertGeneratedWav(dir, request, tempPath, generated.durationSeconds);
    let warnings: string[] = [];
    try {
      const prepared = await ingest(dir, { only: ["sourceHealth", "waveform"], assets: [result.assetId], jobs: 1 });
      warnings = prepared.errors?.map((error) => `Narration added; media preparation: ${JSON.stringify(error)}`) ?? [];
    } catch (error) { warnings = [`Narration added; media preparation failed: ${(error as Error).message}`]; }
    return { ...result, ...(warnings.length && { warnings }) };
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
}
