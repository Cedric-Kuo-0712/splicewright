import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createProject } from "@splicewright/core";

const service = vi.hoisted(() => ({ kokoro: vi.fn(), breezy: vi.fn(), register: vi.fn(), remove: vi.fn(), clone: vi.fn(), fixed: vi.fn(), install: vi.fn() }));
vi.mock("@splicewright/ingest", () => ({ ttsStatus: service.kokoro, breezyVoiceStatus: service.breezy, registerBreezyVoice: service.register, deleteBreezyVoice: service.remove, generateAndInsertBreezyVoice: service.clone, generateAndInsertTTS: service.fixed, setupBreezyVoice: service.install, setupTTS: service.install }));
import { handleTtsRequest } from "../tts-api.ts";

const p = createProject({ title: "narration", fps: 30, width: 640, height: 360 });
const profile = { id: "voice", name: "旅行旁白", transcript: "你好", durationSeconds: 15, language: "zh" };
const server = createServer((req, res) => { void handleTtsRequest(req, res, "/project", (project) => ({ project })).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }); });
let url = "";
beforeAll(async () => { await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (typeof address === "object" && address) url = `http://127.0.0.1:${address.port}`; });
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => {
  vi.clearAllMocks();
  service.kokoro.mockResolvedValue({ ready: true, voices: [{ id: "af_heart" }], languages: [{ id: "en-us", ready: true }] });
  service.breezy.mockResolvedValue({ ready: true, device: "mps", voices: [profile] });
  service.clone.mockResolvedValue({ project: p, revision: 1, undoSteps: 1 });
  service.register.mockResolvedValue(profile);
  service.remove.mockResolvedValue({ deleted: "voice" });
});
const post = (path: string, value: unknown, method = "POST") => fetch(url + path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });

it("keeps legacy Kokoro status fields and exposes the saved BreezyVoice engine", async () => {
  expect(await (await fetch(url + "/api/tts")).json()).toMatchObject({ ready: true, voices: [{ id: "af_heart" }], engines: { breezyvoice: { voices: [profile], device: "mps" } } });
});
it("dispatches cloning to the shared service and rejects unsupported speed/engines", async () => {
  const request = { engine: "breezyvoice", text: "早安", voiceId: "voice", at: 0, base: 0 };
  expect((await post("/api/tts", request)).status).toBe(200);
  expect(service.clone).toHaveBeenCalledWith("/project", request);
  expect((await post("/api/tts", { ...request, speed: 1 })).status).toBe(400);
  expect((await post("/api/tts", { ...request, engine: "unknown" })).status).toBe(400);
  expect(service.clone).toHaveBeenCalledTimes(1);
});
it("accepts a browser upload in a private temp file and always removes that file", async () => {
  let temporary = "";
  service.register.mockImplementation(async (value) => { temporary = value.audioPath; expect(existsSync(temporary)).toBe(true); return profile; });
  const form = new FormData(); form.set("name", profile.name); form.set("transcript", profile.transcript); form.set("audio", new File(["fake test audio"], "../../reference.wav"));
  expect((await fetch(url + "/api/tts/voices", { method: "POST", body: form })).status).toBe(201);
  expect(existsSync(temporary)).toBe(false);
  expect((await post("/api/tts/voices", { audioPath: "/outside/private.wav", name: "x", transcript: "x" })).status).toBe(400);
  expect(service.register).toHaveBeenCalledTimes(1);
});
it("returns a JSON deletion result and rejects oversized requests before dispatch", async () => {
  expect(await (await post("/api/tts/voices", { voiceId: "voice" }, "DELETE")).json()).toEqual({ deleted: "voice" });
  expect((await post("/api/tts", { text: "x".repeat(33_000) })).status).toBe(400);
  expect(service.clone).not.toHaveBeenCalled();
});
it("returns an installation job immediately and exposes completion without repeating setup", async () => {
  let complete!: (value: unknown) => void;
  service.install.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const started = await post("/api/tts/setup", { engine: "breezyvoice" });
  expect(started.status).toBe(202);
  expect((await started.json()).state).toBe("running");
  await post("/api/tts/setup", { engine: "breezyvoice" });
  expect(service.install).toHaveBeenCalledTimes(1);
  complete({ ready: true });
  await Promise.resolve();
  expect((await (await fetch(url + "/api/tts/setup?engine=breezyvoice")).json()).state).toBe("ready");
});
