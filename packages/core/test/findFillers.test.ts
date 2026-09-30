import { describe, expect, it } from "vitest";
import { apply, createProject, findFillers, type Ctx, type OpResult, type Project } from "../src/index.ts";

const ok = (r: OpResult): Project => {
  if ("error" in r) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.project;
};

const w = (start: number, end: number, text: string) => ({ start, end, text });
const words = [
  w(0.5, 0.7, " Um,"), w(0.72, 0.85, " uh"), w(1.0, 1.3, " hello"), // um + uh touch once padded (2 frames = 0.067 s)
  w(2.1, 2.4, " world"), w(2.45, 2.6, " 嗯。"), w(2.95, 3.1, " Um"), // 0.8 s of silence before world; Um runs past the item's end (3 s)
  w(4.95, 5.1, " uh"), w(5.5, 5.8, " right"), // starts before i_2's sourceIn (5 s)
];
const ctx: Ctx = { transcript: (id) => (id === "a_clip" ? [{ start: 0.5, end: 5.8, text: "…", words }] : undefined) };

/** fps 30: i_1 shows a_clip 0–3 s, i_2 shows 5–7 s. */
function fixture() {
  let p = createProject({ title: "t", fps: 30, width: 1920, height: 1080 });
  p = ok(apply(p, "importAsset", { path: "raw/clip.mp4" }));
  p = ok(apply(p, "insertItem", { assetId: "a_clip", at: 0, duration: 90 }, { assetDurations: { a_clip: 10 } }));
  return ok(apply(p, "insertItem", { assetId: "a_clip", at: 90, duration: 60, sourceIn: 5 }, { assetDurations: { a_clip: 10 } }));
}

describe("findFillers", () => {
  it("finds filler words and long silences, padded, merged and clamped to the item's visible source", () => {
    const { items, hints } = findFillers(fixture(), ctx);
    expect(hints).toBeUndefined();
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      itemId: "i_1",
      assetId: "a_clip",
      ranges: [[0.433, 0.917], [1.367, 2.033], [2.383, 2.667], [2.883, 3]], // um+uh merged; silence shrunk 2f each side; last clamped to 3 s
      what: ["um, uh", "silence 0.80s", "嗯", "um"],
    });
    expect(items[1]).toMatchObject({ itemId: "i_2", ranges: [[5, 5.167]] }); // the 4.95 s "uh" is clamped to sourceIn
  });

  it("takes custom words and minSilence, and can target one item", () => {
    const only = findFillers(fixture(), ctx, { itemId: "i_1", words: ["HELLO!"], minSilence: 1 });
    expect(only.items).toEqual([expect.objectContaining({ itemId: "i_1", ranges: [[0.933, 1.367]], what: ["hello"] })]);
  });

  it("matches 那個 as Whisper writes it (simplified, with punctuation)", () => {
    const zh: Ctx = { transcript: () => [{ start: 0, end: 1, text: "那个,", words: [w(0.2, 0.5, "那个,")] }] };
    expect(findFillers(fixture(), zh, { itemId: "i_1" }).items[0].what).toEqual(["那个"]);
  });

  it("says to re-transcribe when the transcript has no word timestamps, instead of failing", () => {
    const old: Ctx = { transcript: () => [{ start: 0, end: 1, text: "hi" }] };
    const r = findFillers(fixture(), old);
    expect(r.items).toEqual([]);
    expect(r.hints).toEqual([expect.stringContaining("i_1"), expect.stringContaining("i_2")]);
    expect(r.hints![0]).toContain("--only transcript");
    expect(findFillers(fixture(), {}, { itemId: "i_1" }).hints).toHaveLength(1); // asked for by name: no transcript at all is worth saying
    expect(findFillers(fixture(), {}).hints).toBeUndefined(); // sweeping every item stays quiet for assets never transcribed
  });
});
