import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { init, load } from "@splicewright/core/node";
import { breezyVoiceStatus, generateAndInsertBreezyVoice, listBreezyVoices } from "../src/breezyvoice.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

it("reports a missing local runtime without exposing profiles or failing the status call", async () => {
  const root = mkdtempSync(join(tmpdir(), "swr-breezy-status-"));
  const old = process.env.SPLICEWRIGHT_BREEZYVOICE_HOME;
  try {
    process.env.SPLICEWRIGHT_BREEZYVOICE_HOME = root;
    const state = await breezyVoiceStatus();
    expect(state).toMatchObject({ ready: false, setupCommand: "splicewright tts setup --engine breezyvoice", voices: [] });
    expect(state.root).toBe(realpathSync(root));
    expect(await listBreezyVoices()).toEqual([]);
    expect(existsSync(join(root, "source"))).toBe(false);
  } finally {
    if (old === undefined) delete process.env.SPLICEWRIGHT_BREEZYVOICE_HOME; else process.env.SPLICEWRIGHT_BREEZYVOICE_HOME = old;
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects stale revisions and non-Mandarin text before starting synthesis", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-breezy-preflight-"));
  try {
    init(dir, { title: "test", fps: 30, width: 640, height: 360 });
    await expect(generateAndInsertBreezyVoice(dir, { text: "你好", voiceId: "voice", at: 0, base: 1 })).rejects.toMatchObject({ code: "conflict" });
    await expect(generateAndInsertBreezyVoice(dir, { text: "hello", voiceId: "voice", at: 0, base: load(dir).revision })).rejects.toMatchObject({ code: "invalid_args" });
    expect(load(dir).revision).toBe(0);
    expect(existsSync(join(dir, "raw"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("uses the configured BreezyVoice Python bridge", async () => {
  const old = process.env.SPLICEWRIGHT_BREEZYVOICE_HOME;
  const root = mkdtempSync(join(tmpdir(), "swr-breezy-bridge-"));
  try {
    process.env.SPLICEWRIGHT_BREEZYVOICE_HOME = root;
    await breezyVoiceStatus();
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining([expect.stringMatching(/breezyvoice\.py$/), "status", "--root", root]));
  } finally {
    if (old === undefined) delete process.env.SPLICEWRIGHT_BREEZYVOICE_HOME; else process.env.SPLICEWRIGHT_BREEZYVOICE_HOME = old;
    rmSync(root, { recursive: true, force: true });
  }
});
