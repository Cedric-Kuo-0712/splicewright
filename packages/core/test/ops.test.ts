import { describe, expect, it } from "vitest";
import { apply, captionSpan, createProject, validate, type Ctx, type OpResult, type Project } from "../src/index.ts";

const ctx: Ctx = {
  assetDurations: { a_clip: 10, a_song: 60 },
  transcript: (id) => (id === "a_clip" ? [{ start: 0.5, end: 1.5, text: "hello" }, { start: 6, end: 7, text: "later" }] : undefined),
};

function ok(r: OpResult): Project {
  if ("error" in r) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.project;
}

const err = (r: OpResult) => ("error" in r ? r.error.code : "ok");

/** fps 30; V1 (magnetic) holds i_1 [0,90) and i_2 [90,150), both from a_clip. */
function fixture(): Project {
  let p = createProject({ title: "t", fps: 30, width: 1920, height: 1080 });
  p = ok(apply(p, "importAsset", { path: "raw/clip.mp4" }, ctx));
  p = ok(apply(p, "importAsset", { path: "raw/song.mp3" }, ctx));
  p = ok(apply(p, "insertItem", { assetId: "a_clip", at: 0, duration: 90 }, ctx));
  p = ok(apply(p, "insertItem", { assetId: "a_clip", at: 90, duration: 60, sourceIn: 5 }, ctx));
  return p;
}

const items = (p: Project, trackId: string) => p.tracks.find((t) => t.id === trackId)!.items;
const item = (p: Project, id: string) => p.tracks.flatMap((t) => t.items as { id: string }[]).find((i) => i.id === id) as any;

describe("ops", () => {
  it("bumps revision, never mutates input, and leaves a valid project", () => {
    const p = fixture();
    const before = JSON.stringify(p);
    const next = ok(apply(p, "split", { itemId: "i_1", at: 30 }, ctx));
    expect(JSON.stringify(p)).toBe(before);
    expect(next.revision).toBe(p.revision + 1);
    expect(validate(next, p, ctx)).toEqual([]);
  });

  it("importAsset derives readable ids, is idempotent by path, rejects absolute paths", () => {
    let p = createProject({ title: "t", fps: 30, width: 1, height: 1 });
    p = ok(apply(p, "importAsset", { path: "raw/VID_20260627_191257.mp4" }));
    expect(Object.keys(p.assets)).toEqual(["a_vid20260627191257"]);
    p = ok(apply(p, "importAsset", { path: "raw/VID_20260627_191257.mp4" }));
    expect(Object.keys(p.assets)).toHaveLength(1);
    p = ok(apply(p, "importAsset", { path: "other/VID_20260627_191257.mp4" }));
    expect(Object.keys(p.assets)).toContain("a_vid20260627191257_2");
    expect(err(apply(p, "importAsset", { path: "/abs/x.mp4" }))).toBe("invalid");
    expect(err(apply(p, "importAsset", { path: "notes.txt" }))).toBe("invalid");
  });

  it("insertItem picks a track with room, defaults duration from the probe, ripples on magnetic tracks", () => {
    const p = fixture();
    const song = ok(apply(p, "insertItem", { assetId: "a_song", at: 0 }, ctx));
    expect(items(song, "t_2")[0]).toMatchObject({ duration: 1800 });
    const rippled = ok(apply(p, "insertItem", { assetId: "a_clip", at: 90, duration: 15 }, ctx));
    expect(item(rippled, "i_2").start).toBe(105);
    const stacked = ok(apply(p, "insertItem", { assetId: "a_clip", at: 10, duration: 15, ripple: false }, ctx));
    expect(stacked.tracks.filter((t) => t.kind === "video")).toHaveLength(2);
    expect(err(apply(p, "insertItem", { assetId: "a_song", at: 0, trackId: "t_1", duration: 5 }, ctx))).toBe("invalid");
    expect(err(apply(p, "insertItem", { at: 0, duration: 5 }, ctx))).toBe("invalid_args");
    expect(err(apply(p, "insertItem", { assetId: "a_clip", at: 0, sourceIn: 9, duration: 60, ripple: true }, ctx))).toBe("invalid");
  });

  it("split gives the second half a new id and advances its sourceIn", () => {
    const p = ok(apply(fixture(), "split", { itemId: "i_2", at: 120 }, ctx));
    expect(items(p, "t_1").map((i) => i.id)).toEqual(["i_1", "i_2", "i_3"]);
    expect(item(p, "i_2")).toMatchObject({ start: 90, duration: 30, sourceIn: 5 });
    expect(item(p, "i_3")).toMatchObject({ start: 120, duration: 30, sourceIn: 6, assetId: "a_clip" });
    expect(err(apply(p, "split", { itemId: "i_3", at: 120 }, ctx))).toBe("invalid");
  });

  it("trim start keeps the right edge; ripple trim end pulls later items", () => {
    const p = fixture();
    const t1 = ok(apply(p, "trim", { itemId: "i_1", edge: "start", to: 30, ripple: false }, ctx));
    expect(item(t1, "i_1")).toMatchObject({ start: 30, duration: 60, sourceIn: 1 });
    const t2 = ok(apply(p, "trim", { itemId: "i_1", edge: "end", to: 60 }, ctx));
    expect(item(t2, "i_2").start).toBe(60);
    const t3 = ok(apply(p, "trim", { itemId: "i_1", edge: "start", to: 30 }, ctx));
    expect(item(t3, "i_1")).toMatchObject({ start: 0, duration: 60, sourceIn: 1 });
    expect(item(t3, "i_2").start).toBe(60);
    expect(err(apply(p, "trim", { itemId: "i_1", edge: "end", to: 0 }, ctx))).toBe("invalid");
    expect(err(apply(p, "trim", { itemId: "i_1", edge: "start", to: -1 }, ctx))).toBe("invalid_args");
  });

  it("move rejects overlap unless ripple; ripple reorders a magnetic track", () => {
    const p = fixture();
    expect(err(apply(p, "move", { itemId: "i_1", to: 100, ripple: false }, ctx))).toBe("invalid");
    const r = ok(apply(p, "move", { itemId: "i_2", to: 0 }, ctx));
    expect(items(r, "t_1").map((i) => [i.id, i.start])).toEqual([["i_2", 0], ["i_1", 60]]);
    const v2 = ok(apply(p, "addTrack", { kind: "video" }));
    const moved = ok(apply(v2, "move", { itemId: "i_2", to: 200, trackId: "t_4" }, ctx));
    expect(items(moved, "t_4")[0]).toMatchObject({ id: "i_2", start: 200 });
    expect(err(apply(p, "move", { itemId: "i_2", to: 0, trackId: "t_2" }, ctx))).toBe("invalid");
  });

  it("delete ripples on magnetic tracks and takes anchored captions with it", () => {
    let p = ok(apply(fixture(), "addCaptionsFromTranscript", { itemId: "i_1" }, ctx));
    expect(items(p, "t_3")).toHaveLength(1);
    p = ok(apply(p, "delete", { itemIds: ["i_1", "i_1"] }, ctx));
    expect(item(p, "i_2").start).toBe(0);
    expect(items(p, "t_3")).toHaveLength(0);
  });

  it("setProps and setTrack enforce whitelists; null unsets", () => {
    const p = fixture();
    const v = ok(apply(p, "setProps", { itemId: "i_1", patch: { volume: 0.5, fit: "cover" } }, ctx));
    expect(item(v, "i_1")).toMatchObject({ volume: 0.5, fit: "cover" });
    expect(item(ok(apply(v, "setProps", { itemId: "i_1", patch: { volume: null } }, ctx)), "i_1").volume).toBeUndefined();
    expect(err(apply(p, "setProps", { itemId: "i_1", patch: { start: 5 } }, ctx))).toBe("invalid");
    expect(err(apply(p, "setProps", { itemId: "i_1", patch: { volume: 9 } }, ctx))).toBe("invalid");
    expect(err(apply(p, "setTrack", { trackId: "t_1", patch: { style: "x" } }, ctx))).toBe("invalid");
  });

  it("slip changes sourceIn only and respects the probed duration", () => {
    const p = ok(apply(fixture(), "slip", { itemId: "i_2", deltaSec: 1 }, ctx));
    expect(item(p, "i_2")).toMatchObject({ start: 90, sourceIn: 6 });
    expect(err(apply(p, "slip", { itemId: "i_2", deltaSec: 3 }, ctx))).toBe("invalid");
  });

  it("locked tracks reject item edits but allow unlocking and track settings", () => {
    const p = ok(apply(fixture(), "setTrack", { trackId: "t_1", patch: { locked: true } }, ctx));
    expect(err(apply(p, "split", { itemId: "i_1", at: 10 }, ctx))).toBe("invalid");
    expect(err(apply(p, "removeTrack", { trackId: "t_1" }, ctx))).toBe("invalid");
    ok(apply(p, "setTrack", { trackId: "t_1", patch: { muted: true } }, ctx));
    const u = ok(apply(p, "setTrack", { trackId: "t_1", patch: { locked: false } }, ctx));
    ok(apply(u, "split", { itemId: "i_1", at: 10 }, ctx));
  });

  it("anchored captions follow trims, hide when out of range, and re-point on split", () => {
    let p = ok(apply(fixture(), "addCaptionsFromTranscript", { itemId: "i_1" }, ctx));
    const cap = items(p, "t_3")[0] as any;
    expect(cap).toMatchObject({ mode: "anchored", itemId: "i_1", start: 15, duration: 30, text: "hello" });
    // Trim 10 frames off the start (ripple): caption moves 10 frames earlier on the timeline.
    p = ok(apply(p, "trim", { itemId: "i_1", edge: "start", to: 10 }, ctx));
    expect(item(p, cap.id)).toMatchObject({ start: 5, duration: 30 });
    // Trim past the caption's source range: hidden, not deleted.
    p = ok(apply(p, "trim", { itemId: "i_1", edge: "start", to: 50 }, ctx));
    expect(captionSpan(p, item(p, cap.id))).toBeNull();
    expect(item(p, cap.id)).toBeDefined();

    let q = ok(apply(fixture(), "addCaptionsFromTranscript", { itemId: "i_1" }, ctx));
    q = ok(apply(q, "split", { itemId: "i_1", at: 10 }, ctx));
    expect(item(q, cap.id).itemId).toBe("i_3");
    expect(err(apply(q, "trim", { itemId: cap.id, edge: "end", to: 99 }, ctx))).toBe("invalid");
  });

  it("editCaption with empty text hides; markers add and remove", () => {
    let p = ok(apply(fixture(), "insertItem", { text: "hi", at: 0, duration: 30 }, ctx));
    p = ok(apply(p, "editCaption", { captionId: "c_1", text: "" }, ctx));
    expect(item(p, "c_1").text).toBe("");
    p = ok(apply(p, "addMarker", { label: "Day 1", start: 0 }, ctx));
    expect(p.markers).toEqual([{ id: "m_1", label: "Day 1", start: 0 }]);
    p = ok(apply(p, "removeMarker", { markerId: "m_1" }, ctx));
    expect(p.markers).toEqual([]);
  });

  it("batch is atomic: all or nothing, one revision", () => {
    const p = fixture();
    const swap = ok(
      apply(p, "batch", { ops: [
        { op: "move", args: { itemId: "i_1", to: 60, ripple: false } },
        { op: "move", args: { itemId: "i_2", to: 0, ripple: false } },
      ] }, ctx),
    );
    expect(swap.revision).toBe(p.revision + 1);
    expect(item(swap, "i_2").start).toBe(0);
    const bad = apply(p, "batch", { ops: [{ op: "split", args: { itemId: "i_1", at: 10 } }, { op: "split", args: { itemId: "nope", at: 1 } }] }, ctx);
    expect(err(bad)).toBe("not_found");
  });
});
