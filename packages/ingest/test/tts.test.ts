import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { init, load, loadCtx, readAssets, run, undo } from "@splicewright/core/node";
import { validate } from "@splicewright/core";
import { generateAndInsertTTS, insertGeneratedWav, ttsStatus, validateTTSRequest } from "../src/tts.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

it("rejects truncated model downloads and concurrent setup in the Python installer", () => {
  execFileSync(process.platform === "win32" ? "py" : "python3", [
    ...(process.platform === "win32" ? ["-3.12"] : []),
    fileURLToPath(new URL("../../../ingest/test_tts.py", import.meta.url)),
  ], { stdio: "pipe" });
});

it("validates bounded text, language-matched voices, speed, frame, and base revision", () => {
  expect(validateTTSRequest({ text: "  Hello  ", language: "en-us", voice: "af_heart", at: 0, base: 2 })).toMatchObject({ text: "Hello", speed: 1, at: 0, base: 2 });
  for (const input of [
    { text: "", language: "en-us", voice: "af_heart", at: 0, base: 0 },
    { text: "hello", language: "zh", voice: "af_heart", at: 0, base: 0 },
    { text: "hello", language: "en-us", voice: "af_heart", speed: 2.1, at: 0, base: 0 },
    { text: "hello", language: "en-us", voice: "af_heart", at: -1, base: 0 },
    { text: "hello", language: "en-us", voice: "af_heart", at: 0, base: 0.5 },
  ]) expect(() => validateTTSRequest(input)).toThrow();
});

it("rejects a stale revision before starting inference or creating project files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-tts-conflict-"));
  try {
    init(dir, { title: "test", fps: 30, width: 640, height: 360 });
    await expect(generateAndInsertTTS(dir, { text: "hello", language: "en-us", voice: "af_heart", at: 0, base: 1 })).rejects.toMatchObject({ code: "conflict" });
    expect(existsSync(join(dir, "raw"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("publishes an already-probed WAV and inserts it in one revision and undo step", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-tts-insert-"));
  const temp = join(dir, "generated.wav");
  try {
    init(dir, { title: "test", fps: 30, width: 640, height: 360 });
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=24000", "-t", "0.2", "-c:a", "pcm_s16le", temp]);
    const initial = load(dir);
    const base = initial.revision;
    const inserted = await insertGeneratedWav(dir, validateTTSRequest({ text: "hello", language: "en-us", voice: "af_heart", at: 18, base }), temp, 0.2);
    expect(inserted).toMatchObject({ revision: base + 1, duration: 6, undoSteps: 1 });
    expect(load(dir).assets[inserted.assetId]).toMatchObject({ kind: "audio", path: expect.stringMatching(/^raw\/narration-/) });
    expect(load(dir).tracks.find((track) => track.id === "t_2")?.items).toMatchObject([{ id: inserted.itemId, start: 18, duration: 6, assetId: inserted.assetId }]);
    const undone = undo(dir, inserted.revision);
    expect("error" in undone).toBe(false);
    const afterUndo = load(dir);
    expect(afterUndo.revision).toBe(base + 2);
    expect(afterUndo.assets).toEqual(initial.assets);
    expect(afterUndo.tracks).toEqual(initial.tracks);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("uses the isolated runtime for status and generation, probes audio, and refuses concurrent edits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-tts-runtime-"));
  const home = join(dir, "tts-home");
  const runtime = join(home, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const oldHome = process.env.SPLICEWRIGHT_TTS_HOME;
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  try {
    mkdirSync(join(runtime, ".."), { recursive: true });
    writeFileSync(runtime, "runtime sentinel");
    process.env.SPLICEWRIGHT_TTS_HOME = home;
    init(dir, { title: "runtime test", fps: 30, width: 640, height: 360 });
    const wav = join(dir, "source.wav");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "0.21", wav]);
    const stub = join(dir, "runtime.mjs");
    writeFileSync(stub, `import {copyFileSync} from 'node:fs';\nlet input=''; for await (const c of process.stdin) input+=c;\nif(input){copyFileSync(${JSON.stringify(wav)},JSON.parse(input).output);}\nconsole.log(JSON.stringify({ok:true,result:input?{}:{ready:true,languages:[],voices:[],setupCommand:'setup'}}));`);
    const runtimeCall = (concurrentEdit = false) => vi.mocked(spawn).mockImplementationOnce((command, args, options) => {
      expect(command).toBe(runtime);
      expect(args?.[0]).toMatch(/tts\.py$/);
      if (concurrentEdit) run(dir, "addTrack", { kind: "audio", name: "Concurrent edit" });
      return actual.spawn(process.execPath, [stub], options);
    });
    runtimeCall();
    expect((await ttsStatus()).ready).toBe(true);
    runtimeCall();
    const inserted = await generateAndInsertTTS(dir, { text: "hello", language: "en-us", voice: "af_heart", at: 18, base: 0 });
    expect(inserted).toMatchObject({ revision: 1, duration: 6, undoSteps: 1 });
    expect(readAssets(dir)[inserted.assetId].duration).toBeCloseTo(0.21);
    expect(validate(load(dir), undefined, loadCtx(dir))).toEqual([]);
    const files = readdirSync(join(dir, "raw"));
    runtimeCall(true);
    await expect(generateAndInsertTTS(dir, { text: "hello", language: "en-us", voice: "af_heart", at: 30, base: 1 })).rejects.toMatchObject({ code: "conflict" });
    expect(readdirSync(join(dir, "raw"))).toEqual(files);
    expect(load(dir).revision).toBe(2);
    const lockedTrack = load(dir).tracks.find((track) => track.kind === "audio")!;
    expect(run(dir, "setTrack", { trackId: lockedTrack.id, patch: { locked: true } })).not.toHaveProperty("error");
    const calls = vi.mocked(spawn).mock.calls.length;
    await expect(generateAndInsertTTS(dir, { text: "hello", language: "en-us", voice: "af_heart", at: 30, base: load(dir).revision, trackId: lockedTrack.id })).rejects.toMatchObject({ code: "locked" });
    expect(vi.mocked(spawn).mock.calls.length).toBe(calls);
  } finally {
    vi.mocked(spawn).mockReset().mockImplementation(actual.spawn);
    if (oldHome === undefined) delete process.env.SPLICEWRIGHT_TTS_HOME; else process.env.SPLICEWRIGHT_TTS_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
