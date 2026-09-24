import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { commit, historyList, init, load, redo, run, undo } from "../src/persistence.ts";

function project() {
  const dir = mkdtempSync(join(tmpdir(), "swr-"));
  init(dir, { title: "t", fps: 30, width: 640, height: 360 });
  mkdirSync(join(dir, ".splicewright", "transcripts"), { recursive: true });
  writeFileSync(join(dir, ".splicewright", "assets.json"), JSON.stringify({ a_clip: { duration: 4 } }));
  writeFileSync(join(dir, ".splicewright", "transcripts", "a_clip.json"), JSON.stringify({ segments: [{ start: 1, end: 2, text: "hi" }] }));
  return dir;
}

it("run commits atomically and reads probe + transcript caches", () => {
  const dir = project();
  expect("error" in run(dir, "importAsset", { path: "raw/clip.mp4" })).toBe(false);
  expect(run(dir, "insertItem", { assetId: "a_clip", at: 0 })).not.toHaveProperty("error");
  expect(load(dir).tracks[0].items[0].duration).toBe(120); // from assets.json
  expect(run(dir, "addCaptionsFromTranscript", { itemId: "i_1" })).not.toHaveProperty("error");
  expect(load(dir)).toMatchObject({ revision: 3 });
  expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
});

it("stale writes are rejected, not merged", () => {
  const dir = project();
  run(dir, "addMarker", { label: "a", start: 0 });
  const r = run(dir, "addMarker", { label: "b", start: 0 }, 0);
  expect(r).toMatchObject({ error: { code: "conflict" } });
  const p = load(dir);
  expect(commit(dir, { ...p, revision: 9 }, 0)).toMatchObject({ error: { code: "conflict" } });
  expect(commit(dir, { ...p, revision: 2, tracks: [{ bad: true }] } as any, 1)).toMatchObject({ error: { code: "invalid" } });
  expect(load(dir).markers).toHaveLength(1);
});

it("undo and redo step one op at a time with fresh revisions; a new op clears redo", () => {
  const dir = project();
  run(dir, "addMarker", { label: "a", start: 0 });
  run(dir, "addMarker", { label: "b", start: 5 });
  expect(historyList(dir).undo.map((e) => e.summary)).toEqual([expect.stringContaining('"b"'), expect.stringContaining('"a"')]);
  expect(undo(dir)).toMatchObject({ changes: { summary: expect.stringMatching(/^undo .*"b"/) } });
  expect(load(dir)).toMatchObject({ revision: 3, markers: [{ label: "a" }] });
  expect(historyList(dir)).toMatchObject({ undo: [{ summary: expect.stringContaining('"a"') }], redo: [{ summary: expect.stringContaining('"b"') }] });
  expect(redo(dir)).not.toHaveProperty("error");
  expect(load(dir)).toMatchObject({ revision: 4, markers: [{ label: "a" }, { label: "b" }] });
  undo(dir);
  undo(dir);
  expect(load(dir).markers).toBeUndefined();
  expect(undo(dir)).toMatchObject({ error: { code: "nothing_to_undo" } });
  run(dir, "addMarker", { label: "c", start: 0 });
  expect(existsSync(join(dir, ".splicewright", "history", "redo"))).toBe(false);
  expect(redo(dir)).toMatchObject({ error: { code: "nothing_to_redo" } });
});

it("undo with a stale baseRevision is refused; undone ids stay taken", () => {
  const dir = project();
  const mine = run(dir, "addMarker", { label: "mine", start: 0 });
  run(dir, "addMarker", { label: "theirs", start: 5 });
  expect(undo(dir, "error" in mine ? -1 : mine.project.revision)).toMatchObject({ error: { code: "conflict" } });
  expect(load(dir).markers).toHaveLength(2);
  expect(undo(dir, 2)).not.toHaveProperty("error");
  expect(run(dir, "addMarker", { label: "new", start: 9 })).toMatchObject({ changes: { summary: expect.stringContaining("m_3") } });
});

it("init refuses to overwrite", () => {
  const dir = project();
  expect(init(dir, { title: "x", fps: 30, width: 1, height: 1 })).toMatchObject({ error: { code: "exists" } });
});
