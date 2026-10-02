import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { applyEditReview, audioFxCachePath, audioFxModelFile, audioFxModelFingerprint, commit, fingerprint, getEditReview, historyList, init, load, loadCtx, rawPath, redo, revertEditReview, run, setEditReviewStatus, undo, writeAtomic } from "../src/persistence.ts";

function project() {
  const dir = mkdtempSync(join(tmpdir(), "swr-"));
  init(dir, { title: "t", fps: 30, width: 640, height: 360 });
  mkdirSync(join(dir, ".splicewright", "transcripts"), { recursive: true });
  mkdirSync(join(dir, "raw"), { recursive: true });
  writeFileSync(join(dir, "raw/clip.mp4"), "source fixture");
  writeFileSync(join(dir, ".splicewright", "assets.json"), JSON.stringify({ a_clip: { kind: "video", path: "raw/clip.mp4", fingerprint: fingerprint(join(dir, "raw/clip.mp4")), duration: 4 } }));
  writeFileSync(join(dir, ".splicewright", "transcripts", "a_clip.json"), JSON.stringify({ segments: [{ start: 1, end: 2, text: "hi" }] }));
  return dir;
}

it("validates LUT files inside the project and refuses symlinks that escape it", () => {
  const dir = project(), outside = mkdtempSync(join(tmpdir(), "swr-outside-"));
  const table = `LUT_3D_SIZE 2\n${Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`).join("\n")}\n`;
  mkdirSync(join(dir, "raw"), { recursive: true });
  writeFileSync(join(dir, "raw", "ok.cube"), table);
  writeFileSync(join(outside, "outside.cube"), table);
  symlinkSync(join(outside, "outside.cube"), join(dir, "raw", "escape.cube"));
  expect(loadCtx(dir).validateLut).toBeDefined();
  expect(() => loadCtx(dir).validateLut!("raw/ok.cube")).not.toThrow();
  expect(() => loadCtx(dir).validateLut!("raw/escape.cube")).toThrow("escapes project directory");
});

it("validates custom RNNoise models under raw and includes their content in the bake cache key", () => {
  const dir = project(), outside = mkdtempSync(join(tmpdir(), "swr-model-outside-"));
  mkdirSync(join(dir, "raw"), { recursive: true });
  writeFileSync(join(dir, "raw", "clip.wav"), "source bytes");
  writeFileSync(join(dir, "raw", "voice.rnnn"), "model version one");
  writeFileSync(join(outside, "escape.rnnn"), "outside model");
  symlinkSync(join(outside, "escape.rnnn"), join(dir, "raw", "escape.rnnn"));
  const fx = { denoise: { kind: "rnnoise" as const, model: "raw/voice.rnnn" } };
  const first = audioFxCachePath(dir, "a_clip", "raw/clip.wav", fx);
  const fingerprint = audioFxModelFingerprint(dir, fx.denoise.model);
  expect(audioFxModelFile(dir, fx.denoise.model)).toBe(realpathSync(join(dir, "raw", "voice.rnnn")));
  writeFileSync(join(dir, "raw", "voice.rnnn"), "model version two");
  expect(audioFxModelFingerprint(dir, fx.denoise.model)).not.toBe(fingerprint);
  expect(audioFxCachePath(dir, "a_clip", "raw/clip.wav", fx)).not.toBe(first);
  expect(() => audioFxModelFile(dir, "raw/../outside.rnnn")).toThrow(/project-relative/);
  expect(() => audioFxModelFile(dir, "raw/escape.rnnn")).toThrow(/escapes raw/);
  expect(() => audioFxModelFile(dir, "raw/missing.rnnn")).toThrow(/model is missing/);
  expect(() => audioFxModelFile(dir, "raw/wrong.bin")).toThrow(/project-relative/);
});

it("run commits atomically and reads probe + transcript caches", () => {
  const dir = project();
  expect("error" in run(dir, "importAsset", { path: "raw/clip.mp4" })).toBe(false);
  expect(run(dir, "insertItem", { assetId: "a_clip", at: 0 })).not.toHaveProperty("error");
  expect(load(dir).tracks[0].items[0].duration).toBe(120); // from assets.json
  expect(run(dir, "addCaptionsFromTranscript", { itemId: "i_1" })).not.toHaveProperty("error");
  expect(load(dir)).toMatchObject({ revision: 3 });
  expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
});

it("loads baked loudness by item for same-asset items with distinct audioFx", () => {
  const dir = project();
  mkdirSync(join(dir, "raw"), { recursive: true });
  writeFileSync(join(dir, "raw", "music.wav"), "fixture audio source bytes");
  run(dir, "importAsset", { path: "raw/music.wav" });
  run(dir, "insertItem", { assetId: "a_music", at: 0, duration: 30 });
  run(dir, "insertItem", { assetId: "a_music", at: 30, duration: 30 });
  run(dir, "setProps", { itemId: "i_1", patch: { audioFx: { pan: -1 } } });
  run(dir, "setProps", { itemId: "i_2", patch: { audioFx: { eq: [{ hz: 1000, gain: -6 }] } } });
  const p = load(dir);
  const source = p.assets.a_music.path;
  mkdirSync(join(dir, ".splicewright", "audio"), { recursive: true });
  writeAtomic(join(dir, `${audioFxCachePath(dir, "a_music", source, { pan: -1 })}.json`), { lufs: -8 });
  writeAtomic(join(dir, `${audioFxCachePath(dir, "a_music", source, { eq: [{ hz: 1000, gain: -6 }] })}.json`), { lufs: -24 });
  expect(loadCtx(dir).audioFxLoudness).toEqual({ i_1: -8, i_2: -24 });
});

it("cutRanges is one undo step", () => {
  const dir = project();
  run(dir, "importAsset", { path: "raw/clip.mp4" });
  run(dir, "insertItem", { assetId: "a_clip", at: 0 });
  const before = load(dir).tracks;
  expect(run(dir, "cutRanges", { itemId: "i_1", ranges: [[0.5, 1], [2, 2.5]] })).not.toHaveProperty("error");
  expect(load(dir).tracks[0].items).toHaveLength(3);
  undo(dir);
  expect(load(dir).tracks).toEqual(before);
});

it("reverse is persisted and undoable as one video-item edit", () => {
  const dir = project();
  run(dir, "importAsset", { path: "raw/clip.mp4" });
  run(dir, "insertItem", { assetId: "a_clip", at: 0 });
  expect(run(dir, "setProps", { itemId: "i_1", patch: { reverse: true } })).not.toHaveProperty("error");
  expect(load(dir).tracks[0].items[0]).toMatchObject({ reverse: true });
  expect(undo(dir)).not.toHaveProperty("error");
  expect(load(dir).tracks[0].items[0]).not.toHaveProperty("reverse");
  expect(redo(dir)).not.toHaveProperty("error");
  expect(load(dir).tracks[0].items[0]).toMatchObject({ reverse: true });
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

it("persists a validated before/after review and restores it as one undoable monotonic step", () => {
  const dir = project();
  const applied = applyEditReview(dir, [{ op: "addMarker", args: { label: "agent", start: 12 } }], { label: "Cut review", baseRevision: 0 });
  expect(applied).toMatchObject({ project: { revision: 1 }, review: { status: "pending", beforeRevision: 0, afterRevision: 1 } });
  const review = getEditReview(dir, undefined, true)!;
  expect(review).toMatchObject({ label: "Cut review", before: { revision: 0 }, after: { revision: 1, markers: [{ label: "agent", start: 12 }] } });
  expect(getEditReview(dir)).not.toHaveProperty("before");
  expect(review.summary).toContain("markers changed");
  // A pending round can be restored directly, without accepting it first.
  expect(revertEditReview(dir, review.id, 1)).toMatchObject({ project: { revision: 2 }, changes: { summary: expect.stringContaining("reverted") } });
  expect(load(dir).revision).toBe(2);
  expect(load(dir)).not.toHaveProperty("markers");
  expect(getEditReview(dir)).toMatchObject({ status: "reverted", revertedAtRevision: 2 });
  expect(undo(dir, 2)).toMatchObject({ project: { revision: 3, markers: [{ label: "agent" }] } });
  expect(redo(dir, 3)).toMatchObject({ project: { revision: 4 } });
  expect(load(dir)).not.toHaveProperty("markers");
});

it("refuses a stale review and refuses to erase a later human edit without changing history", () => {
  const dir = project();
  run(dir, "addMarker", { label: "human first", start: 2 });
  expect(applyEditReview(dir, [{ op: "addMarker", args: { label: "stale", start: 4 } }], { baseRevision: 0 })).toMatchObject({ error: { code: "conflict" } });
  const applied = applyEditReview(dir, [{ op: "addMarker", args: { label: "agent", start: 6 } }], { baseRevision: 1 }) as any;
  setEditReviewStatus(dir, applied.review.id, "dismissed");
  run(dir, "addMarker", { label: "human later", start: 8 }, 2);
  const before = load(dir), history = historyList(dir);
  expect(revertEditReview(dir, applied.review.id, before.revision)).toMatchObject({ error: { code: "conflict" } });
  expect(load(dir)).toEqual(before);
  expect(historyList(dir)).toEqual(history);
});

it("rejects corrupt review metadata and all writers honor the shared project lock", () => {
  const dir = project();
  const review = applyEditReview(dir, [{ op: "addMarker", args: { label: "agent", start: 1 } }]) as any;
  writeFileSync(join(dir, ".splicewright", "edit-review.json"), JSON.stringify({ version: 99 }));
  expect(() => getEditReview(dir)).toThrow(/invalid edit review record/);
  expect(applyEditReview(dir, [{ op: "addMarker", args: { label: "unsafe", start: 3 } }])).toMatchObject({ error: { code: "invalid_review" } });
  writeFileSync(join(dir, ".splicewright", "edit-review.json"), "{}");
  // A process holding the lock forces the same deterministic refusal for review and normal ops.
  writeFileSync(join(dir, ".splicewright", "project.lock"), String(process.pid));
  expect(run(dir, "addMarker", { label: "blocked", start: 3 })).toMatchObject({ error: { code: "busy" } });
  expect(revertEditReview(dir, review.review.id)).toMatchObject({ error: { code: "busy" } });
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

it("persists Sticker props and restores them through undo and redo", () => {
  const dir = project();
  expect(run(dir, "importAsset", { path: "raw/loop.gif" })).not.toHaveProperty("error");
  expect(run(dir, "insertItem", { component: "Sticker", props: { src: "raw/loop.gif", fit: "cover" }, at: 12, duration: 60 })).not.toHaveProperty("error");
  const sticker = () => load(dir).tracks.find((t) => t.kind === "overlay")?.items[0];
  expect(sticker()).toMatchObject({ component: "Sticker", start: 12, duration: 60, props: { src: "raw/loop.gif", fit: "cover" } });
  expect(undo(dir)).not.toHaveProperty("error");
  expect(sticker()).toBeUndefined();
  expect(redo(dir)).not.toHaveProperty("error");
  expect(sticker()).toMatchObject({ component: "Sticker", props: { src: "raw/loop.gif", fit: "cover" } });
  expect(run(dir, "removeAsset", { assetId: "a_loop" })).toMatchObject({ error: { code: "invalid" } });
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

it("rawPath reuses a raw/ file only when the bytes match, whatever the mtime", () => {
  const dir = project();
  mkdirSync(join(dir, "raw"), { recursive: true });
  const tmp = (text: string) => (writeFileSync(join(dir, "tmp"), text), join(dir, "tmp"));
  expect(rawPath(dir, "a.mp4", tmp("same"))).toBe(join("raw", "a.mp4"));
  utimesSync(join(dir, "raw", "a.mp4"), 1, 1);
  expect(rawPath(dir, "a.mp4", tmp("same"))).toBe(join("raw", "a.mp4"));
  expect(rawPath(dir, "a.mp4", tmp("diff"))).toBe(join("raw", "a-2.mp4"));
  expect(existsSync(join(dir, "tmp"))).toBe(false);
});

it("init refuses to overwrite", () => {
  const dir = project();
  expect(init(dir, { title: "x", fps: 30, width: 1, height: 1 })).toMatchObject({ error: { code: "exists" } });
});
