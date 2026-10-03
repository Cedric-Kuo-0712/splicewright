import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { Project } from "@splicewright/core";
import { breezyVoiceStatus, deleteBreezyVoice, generateAndInsertBreezyVoice, generateAndInsertTTS, registerBreezyVoice, setupBreezyVoice, setupTTS, ttsStatus, type TtsLanguage } from "@splicewright/ingest";

type Engine = "kokoro" | "breezyvoice";
type Setup = { engine: Engine; state: "running" | "ready" | "failed"; detail: string };
const setups = new Map<Engine, Setup>();
const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid_args" });
const engineOf = (value: unknown): Engine => {
  if (value !== "kokoro" && value !== "breezyvoice") throw invalid("engine must be kokoro or breezyvoice");
  return value;
};
const send = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};
async function read(req: IncomingMessage, maximum: number): Promise<Buffer> {
  if (Number(req.headers["content-length"]) > maximum) { req.resume(); throw invalid(`request exceeds ${maximum} bytes`); }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > maximum) throw invalid(`request exceeds ${maximum} bytes`);
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data: unknown;
  try { data = JSON.parse((await read(req, 32_000)).toString("utf8")); }
  catch (error) { if ((error as Error & { code?: string }).code) throw error; throw invalid("request must contain a JSON object"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalid("request must contain a JSON object");
  return data as Record<string, unknown>;
}

/** Called after the editor's same-origin check; uploads cannot name server-side files. */
export async function handleTtsRequest(req: IncomingMessage, res: ServerResponse, dir: string, snapshot: (project: Project) => Record<string, unknown>): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/tts")) return false;
  try {
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/tts") {
      const selected = url.searchParams.get("engine");
      if (selected) send(res, 200, await (engineOf(selected) === "breezyvoice" ? breezyVoiceStatus() : ttsStatus()));
      else {
        const [kokoro, breezyvoice] = await Promise.all([ttsStatus(), breezyVoiceStatus()]);
        send(res, 200, { ...kokoro, engines: { kokoro, breezyvoice } });
      }
    } else if (route === "GET /api/tts/setup") {
      const engine = engineOf(url.searchParams.get("engine"));
      send(res, 200, setups.get(engine) ?? { engine, state: "idle", detail: "" });
    } else if (route === "POST /api/tts/setup") {
      const b = await jsonBody(req), engine = engineOf(b.engine);
      if (setups.get(engine)?.state === "running") { send(res, 202, setups.get(engine)); return true; }
      const languages = b.languages ?? ["en-us", "zh"];
      if (!Array.isArray(languages) || !languages.length || languages.some((id) => !["en-us", "en-gb", "zh"].includes(id))) throw invalid("languages must contain en-us, en-gb, or zh");
      const job: Setup = { engine, state: "running", detail: "正在安裝依賴與模型…" };
      setups.set(engine, job);
      const progress = (line: string) => { job.detail = (job.detail + line).slice(-2000); };
      void (async () => {
        try {
          const result = await (engine === "breezyvoice" ? setupBreezyVoice(progress) : setupTTS(languages as TtsLanguage[], progress));
          if (!result.ready) throw new Error(result.detail || "模型安裝未完成。");
          job.state = "ready";
          job.detail = "安裝完成。";
        } catch (error) { job.state = "failed"; job.detail = (error as Error).message; }
      })();
      send(res, 202, job);
    } else if (route === "POST /api/tts/voices") {
      if (!req.headers["content-type"]?.startsWith("multipart/form-data")) throw invalid("voice upload must be multipart/form-data");
      const form = await new Response(new Uint8Array(await read(req, 20 * 1024 * 1024 + 32_000)), { headers: { "Content-Type": req.headers["content-type"] } }).formData();
      const audio = form.get("audio"), name = form.get("name"), transcript = form.get("transcript");
      if (!(audio instanceof File) || !audio.size || audio.size > 20 * 1024 * 1024 || typeof name !== "string" || typeof transcript !== "string") throw invalid("upload requires audio (up to 20 MB), name, and exact transcript");
      const extension = extname(audio.name).toLowerCase();
      if (![".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"].includes(extension)) throw invalid("unsupported reference audio format");
      const temp = mkdtempSync(join(tmpdir(), "swr-voice-upload-"));
      try {
        const audioPath = join(temp, `reference${extension}`);
        writeFileSync(audioPath, Buffer.from(await audio.arrayBuffer()));
        send(res, 201, await registerBreezyVoice({ name, transcript, audioPath }));
      } finally { rmSync(temp, { recursive: true, force: true }); }
    } else if (route === "DELETE /api/tts/voices") {
      const b = await jsonBody(req);
      if (typeof b.voiceId !== "string" || !b.voiceId) throw invalid("voiceId is required");
      send(res, 200, await deleteBreezyVoice(b.voiceId));
    } else if (route === "POST /api/tts") {
      const b = await jsonBody(req), engine = engineOf(b.engine ?? "kokoro");
      if (engine === "breezyvoice" && b.speed !== undefined) throw invalid("BreezyVoice does not support speed");
      const result = engine === "breezyvoice" ? await generateAndInsertBreezyVoice(dir, b) : await generateAndInsertTTS(dir, b);
      send(res, 200, { ...result, ...snapshot(result.project) });
    } else return false;
  } catch (error) {
    const e = error as Error & { code?: string }, code = e.code ?? "tts_failed";
    const status = code === "conflict" || code === "busy" ? 409 : ["invalid_args", "locked", "invalid", "not_found"].includes(code) ? 400 : 500;
    send(res, status, { error: { code, message: e.message } });
  }
  return true;
}
