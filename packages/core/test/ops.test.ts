import { describe, expect, it } from "vitest";
import { animate, apply, bezier, Keyframes, badFont, builtinTheme, captionWords, createProject, itemSpan, textCss, THEME_IDS, validate, valueAt, type Ctx, type OpResult, type Project } from "../src/index.ts";

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

  it("removeAsset drops an unused asset from the list and refuses one in use", () => {
    const p = fixture();
    expect(err(apply(p, "removeAsset", { assetId: "a_clip" }, ctx))).toBe("invalid");
    const next = ok(apply(p, "removeAsset", { assetId: "a_song" }, ctx));
    expect(next.assets.a_song).toBeUndefined();
    expect(next.assets.a_clip).toBeDefined();
    expect(err(apply(next, "removeAsset", { assetId: "a_song" }, ctx))).toBe("not_found");
  });

  it("a track an op empties is removed; magnetic and deliberately empty tracks stay", () => {
    let p = fixture();
    p = ok(apply(p, "insertItem", { assetId: "a_song", at: 0, duration: 30 }, ctx));
    const audio = p.tracks.find((t) => t.kind === "audio")!;
    p = ok(apply(p, "addTrack", { kind: "overlay" }, ctx));
    const overlay = p.tracks.at(-1)!.id;
    p = ok(apply(p, "delete", { itemIds: [audio.items[0].id, "i_1", "i_2"] }, ctx));
    expect(p.tracks.find((t) => t.id === audio.id)).toBeUndefined();
    expect(p.tracks.find((t) => t.id === "t_1")?.items).toEqual([]);
    expect(p.tracks.find((t) => t.id === overlay)).toBeDefined();
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
    expect(err(apply(p, "importAsset", { path: "../outside/x.mp4" }))).toBe("invalid");
    expect(err(apply(p, "importAsset", { path: "notes.txt" }))).toBe("invalid");
  });

  it("never reuses a deleted id, so ids predicted for a batch hold", () => {
    const p = ok(apply(fixture(), "batch", { ops: [
      { op: "delete", args: { itemIds: ["i_2"], ripple: false } },
      { op: "insertItem", args: { trackId: "t_1", assetId: "a_clip", at: 90, duration: 60, ripple: false } },
      { op: "setProps", args: { itemId: "i_3", patch: { volume: 0.5 } } },
    ] }, ctx));
    expect(item(p, "i_3")).toMatchObject({ start: 90, volume: 0.5 });
    expect(item(p, "i_2")).toBeUndefined();
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
    expect(p.tracks.find((t) => t.id === "t_3")).toBeUndefined(); // emptied caption track is removed
  });

  it("closeGap shifts later items left to meet the previous one", () => {
    let p = ok(apply(fixture(), "insertItem", { assetId: "a_song", at: 30, duration: 20 }, ctx)); // t_2: [30,50)
    p = ok(apply(p, "insertItem", { assetId: "a_song", at: 80, duration: 10, trackId: "t_2" }, ctx)); // [80,90)
    p = ok(apply(p, "insertItem", { assetId: "a_song", at: 100, duration: 10, trackId: "t_2" }, ctx)); // [100,110)
    const r = apply(p, "closeGap", { trackId: "t_2", at: 60 }, ctx);
    expect(r).toMatchObject({ changes: { summary: "closed gap [50, 80) on t_2 (30f)" } });
    expect(items(ok(r), "t_2").map((i) => i.start)).toEqual([30, 50, 70]);
    expect(items(ok(apply(p, "closeGap", { trackId: "t_2", at: 10 }, ctx)), "t_2")[0].start).toBe(0); // leading gap
    expect(err(apply(p, "closeGap", { trackId: "t_2", at: 40 }, ctx))).toBe("invalid"); // inside an item
    expect(err(apply(p, "closeGap", { trackId: "t_2", at: 200 }, ctx))).toBe("invalid"); // nothing after
    const locked = ok(apply(p, "setTrack", { trackId: "t_2", patch: { locked: true } }, ctx));
    expect(err(apply(locked, "closeGap", { trackId: "t_2", at: 60 }, ctx))).toBe("invalid");
  });

  it("setProps and setTrack enforce whitelists; null unsets", () => {
    const p = fixture();
    const v = ok(apply(p, "setProps", { itemId: "i_1", patch: { volume: 0.5, fit: "cover" } }, ctx));
    expect(item(v, "i_1")).toMatchObject({ volume: 0.5, fit: "cover" });
    const keyed = ok(apply(v, "setProps", { itemId: "i_1", patch: { key: { kind: "chroma", color: "#00ff00", similarity: 0.45, smoothness: 0.08 } } }, ctx));
    expect(item(keyed, "i_1").key).toEqual({ kind: "chroma", color: "#00ff00", similarity: 0.45, smoothness: 0.08 });
    expect(err(apply(v, "setProps", { itemId: "i_1", patch: { key: { kind: "chroma", color: "", similarity: 0.45, smoothness: 0.08 } } }, ctx))).toBe("invalid");
    expect(err(apply(v, "setProps", { itemId: "i_1", patch: { key: { kind: "chroma", color: "green", similarity: 1.1, smoothness: 0.08 } } }, ctx))).toBe("invalid");
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
    expect(itemSpan(p, item(p, cap.id))).toBeNull();
    expect(item(p, cap.id)).toBeDefined();

    let q = ok(apply(fixture(), "addCaptionsFromTranscript", { itemId: "i_1" }, ctx));
    q = ok(apply(q, "split", { itemId: "i_1", at: 10 }, ctx));
    expect(item(q, cap.id).itemId).toBe("i_3");
  });

  it("anchored items can be fine-tuned by trim/move and stay anchored", () => {
    let p = ok(apply(fixture(), "addCaptionsFromTranscript", { itemId: "i_1" }, ctx));
    const id = (items(p, "t_3")[0] as any).id; // [15, 45) ← source 0.5–1.5s
    p = ok(apply(p, "trim", { itemId: id, edge: "end", to: 60 }, ctx));
    expect(item(p, id)).toMatchObject({ mode: "anchored", start: 15, duration: 45, sourceEnd: 2 });
    p = ok(apply(p, "move", { itemId: id, to: 5 }, ctx));
    expect(item(p, id)).toMatchObject({ start: 5, duration: 45 });
    expect(item(p, id).sourceStart).toBeCloseTo(1 / 6);
    // Still anchored: a ripple trim on i_1 carries the fine-tuned caption along.
    p = ok(apply(p, "trim", { itemId: "i_1", edge: "start", to: 3 }, ctx));
    expect(item(p, id)).toMatchObject({ start: 2, duration: 45 });
    expect(err(apply(p, "trim", { itemId: id, edge: "end", to: 2 }, ctx))).toBe("invalid");
  });

  it("attached overlays follow ripple edits; detaching freezes them for manual placement", () => {
    let p = ok(apply(fixture(), "insertItem", { component: "Card", props: {}, at: 100, duration: 30 }, ctx)); // i_3 over i_2
    p = ok(apply(p, "attach", { itemId: "i_3", to: "i_2" }, ctx));
    expect(item(p, "i_3").anchor).toMatchObject({ itemId: "i_2" });
    p = ok(apply(p, "trim", { itemId: "i_1", edge: "end", to: 60 }, ctx)); // i_2 ripples 90 → 60
    expect(item(p, "i_3")).toMatchObject({ start: 70, duration: 30 });
    // Split i_2 before the card: the card's first frame lies in the second half.
    p = ok(apply(p, "split", { itemId: "i_2", at: 65 }, ctx));
    expect(item(p, "i_3").anchor.itemId).toBe("i_4");
    // Detach, then place by hand: now it ignores edits to i_4.
    p = ok(apply(p, "attach", { itemId: "i_3", to: null }, ctx));
    expect(item(p, "i_3").anchor).toBeUndefined();
    p = ok(apply(p, "move", { itemId: "i_3", to: 200 }, ctx));
    p = ok(apply(p, "delete", { itemIds: ["i_1"] }, ctx));
    expect(item(p, "i_3").start).toBe(200);
    expect(err(apply(p, "attach", { itemId: "i_2", to: "i_4" }, ctx))).toBe("invalid");
  });

  it("deleting an anchor target detaches overlays in place and removes its captions", () => {
    let p = ok(apply(fixture(), "insertItem", { component: "Card", props: {}, at: 100, duration: 30 }, ctx));
    p = ok(apply(p, "attach", { itemId: "i_3", to: "i_2" }, ctx));
    const r = apply(p, "delete", { itemIds: ["i_2"] }, ctx);
    expect("changes" in r && r.changes.summary).toContain("detached 1 overlays");
    expect(item(ok(r), "i_3")).toMatchObject({ start: 100, duration: 30 });
    expect(item(ok(r), "i_3").anchor).toBeUndefined();
  });

  it("removeTrack on a video track removes its anchored captions and detaches overlays, like delete", () => {
    let p = ok(apply(fixture(), "addCaptionsFromTranscript", { itemId: "i_1" }, ctx));
    p = ok(apply(p, "insertItem", { component: "Card", props: {}, at: 100, duration: 30 }, ctx)); // i_3 over i_2
    p = ok(apply(p, "attach", { itemId: "i_3", to: "i_2" }, ctx));
    const r = apply(p, "removeTrack", { trackId: "t_1" }, ctx);
    expect("changes" in r && r.changes.summary).toMatch(/removed \d+ anchored captions; detached 1 overlays/);
    const after = ok(r);
    expect(item(after, "i_3")).toMatchObject({ start: 100, duration: 30 });
    expect(item(after, "i_3").anchor).toBeUndefined();
    expect(after.tracks.find((t) => t.kind === "caption")).toBeUndefined(); // emptied caption track is removed
  });

  it("editCaption with empty text hides; markers add and remove", () => {
    let p = ok(apply(fixture(), "insertItem", { text: "hi", at: 0, duration: 30 }, ctx));
    p = ok(apply(p, "editCaption", { captionId: "c_1", text: "" }, ctx));
    expect(item(p, "c_1").text).toBe("");
    p = ok(apply(p, "addMarker", { label: "Day 1", start: 0 }, ctx));
    expect(p.markers).toEqual([{ id: "m_1", label: "Day 1", start: 0 }]);
    p = ok(apply(p, "addMarker", { label: "B", start: 60 }, ctx));
    p = ok(apply(p, "setMarker", { markerId: "m_2", patch: { label: "Chorus", start: 10 } }, ctx));
    expect(p.markers!.map((m) => [m.id, m.label, m.start])).toEqual([["m_1", "Day 1", 0], ["m_2", "Chorus", 10]]);
    expect(err(apply(p, "setMarker", { markerId: "m_2", patch: { id: "x" } }, ctx))).toBe("invalid");
    p = ok(apply(p, "removeMarker", { markerId: "m_1" }, ctx));
    expect(p.markers!.map((m) => m.id)).toEqual(["m_2"]);
  });

  it("moveTrack reorders layers", () => {
    const p = ok(apply(fixture(), "moveTrack", { trackId: "t_3", to: 0 }, ctx));
    expect(p.tracks.map((t) => t.id)).toEqual(["t_3", "t_1", "t_2"]);
    expect(ok(apply(p, "moveTrack", { trackId: "t_3", to: 99 }, ctx)).tracks.map((t) => t.id)).toEqual(["t_1", "t_2", "t_3"]);
  });

  it("setSpeed scales duration over the same source; split and trim read source at that speed", () => {
    const p = ok(apply(fixture(), "setSpeed", { itemId: "i_1", speed: 2 }, ctx));
    expect(item(p, "i_1")).toMatchObject({ duration: 45, speed: 2, sourceIn: 0 });
    expect(item(p, "i_2").start).toBe(45); // magnetic: later items follow
    const cut = ok(apply(p, "split", { itemId: "i_1", at: 15 }, ctx));
    expect(item(cut, "i_3").sourceIn).toBeCloseTo(1);
    expect(item(ok(apply(p, "trim", { itemId: "i_1", edge: "start", to: 15 }, ctx)), "i_1").sourceIn).toBeCloseTo(1);
    expect(item(ok(apply(p, "setSpeed", { itemId: "i_1", speed: 1 }, ctx)), "i_1").speed).toBeUndefined();
    // setProps speed keeps the duration, so i_2 would read 5 s + 60f × 4 / 30 = 13 s of a 10 s clip.
    expect(err(apply(fixture(), "setProps", { itemId: "i_2", patch: { speed: 4 } }, ctx))).toBe("invalid");
  });

  it("effects and crop patch like any prop; a crop that hides the picture is rejected", () => {
    const p = ok(apply(fixture(), "setProps", { itemId: "i_1", patch: { effects: { grayscale: 1 }, crop: { left: 0.2, right: 0.3 } } }, ctx));
    expect(item(p, "i_1")).toMatchObject({ effects: { grayscale: 1 }, crop: { left: 0.2, right: 0.3 } });
    expect(err(apply(p, "setProps", { itemId: "i_1", patch: { crop: { left: 0.6, right: 0.5 } } }, ctx))).toBe("invalid");
  });

  it("keyframes interpolate in source time, so split and speed keep them on the same content", () => {
    let p = ok(apply(fixture(), "setKeyframe", { itemId: "i_1", prop: "opacity", at: 0, value: 0 }, ctx));
    p = ok(apply(p, "setKeyframe", { itemId: "i_1", prop: "opacity", at: 30, value: 1 }, ctx));
    const v = () => item(p, "i_1");
    expect(valueAt(p, v(), "opacity", 15)).toBeCloseTo(0.5);
    expect(valueAt(p, v(), "opacity", 60)).toBe(1); // held past the last key
    expect(animate(p, v(), 15).transform?.opacity).toBeCloseTo(0.5);
    p = ok(apply(p, "setKeyframe", { itemId: "i_1", prop: "opacity", at: 30, value: 0.8 }, ctx)); // same frame replaces
    expect(v().keyframes.opacity).toHaveLength(2);
    const fast = ok(apply(p, "setSpeed", { itemId: "i_1", speed: 2 }, ctx));
    expect(valueAt(fast, item(fast, "i_1"), "opacity", 15)).toBeCloseTo(0.8); // source 1 s is now frame 15
    const cut = ok(apply(p, "split", { itemId: "i_1", at: 15 }, ctx));
    expect(valueAt(cut, item(cut, "i_3"), "opacity", 15)).toBeCloseTo(0.4);
    expect(err(apply(p, "setKeyframe", { itemId: "i_1", prop: "opacity", at: 30, value: 2 }, ctx))).toBe("invalid"); // out of range
    expect(err(apply(p, "setKeyframe", { itemId: "i_1", prop: "opacity", at: 90, value: 1 }, ctx))).toBe("invalid"); // outside the item
    expect(err(apply(p, "setKeyframe", { itemId: "i_1", prop: "opacity", at: 10, value: null }, ctx))).toBe("invalid"); // no key there
    p = ok(apply(p, "setKeyframe", { itemId: "i_1", prop: "opacity", at: 0, value: null }, ctx));
    p = ok(apply(p, "setKeyframe", { itemId: "i_1", prop: "opacity", at: 30, value: null }, ctx));
    expect(v().keyframes).toBeUndefined();
  });

  it("masks: setProps validates them, keys need a mask and ride split and trim, keyed values override", () => {
    const set = (p: Project, mask: unknown) => apply(p, "setProps", { itemId: "i_1", patch: { mask } }, ctx);
    const base = { shape: "ellipse", x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
    expect(err(apply(fixture(), "setKeyframe", { itemId: "i_1", prop: "maskW", at: 0, value: 0.5 }, ctx))).toBe("invalid"); // no mask yet
    for (const bad of [{ ...base, w: 0 }, { ...base, shape: "polygon" }, { ...base, points: [[0, 0], [1, 0], [1, 1]] }, { ...base, shape: "heart" }, { ...base, feather: 201 }, { ...base, radius: 0.1 }])
      expect(err(set(fixture(), bad))).toBe("invalid");
    let p = ok(set(fixture(), base));
    p = ok(apply(p, "setProps", { itemId: "i_1", patch: { blend: "screen" } }, ctx));
    ok(set(p, { shape: "polygon", x: 0, y: 0, w: 1, h: 1, points: [[0, 0], [1, 0], [1, 1]] }));
    ok(set(p, { shape: "rect", x: -0.5, y: 0, w: 2, h: 1, radius: 0.5, feather: 200, invert: true }));
    p = ok(apply(p, "setKeyframe", { itemId: "i_1", prop: "maskW", at: 0, value: 0.2 }, ctx));
    p = ok(apply(p, "setKeyframe", { itemId: "i_1", prop: "maskW", at: 60, value: 1 }, ctx));
    expect(err(apply(p, "setKeyframe", { itemId: "i_1", prop: "maskW", at: 30, value: 0 }, ctx))).toBe("invalid"); // w must stay > 0
    expect(animate(p, item(p, "i_1"), 30).mask!.w).toBeCloseTo(0.6);
    expect(item(p, "i_1").mask.w).toBe(0.6); // plain value untouched
    const cut = ok(apply(p, "split", { itemId: "i_1", at: 30 }, ctx));
    expect(item(cut, "i_3").mask).toEqual(base);
    expect(animate(cut, item(cut, "i_3"), 30).mask!.w).toBeCloseTo(0.6); // same content, same value
    const trimmed = ok(apply(p, "trim", { itemId: "i_1", edge: "start", to: 30 }, ctx));
    expect(animate(trimmed, item(trimmed, "i_1"), item(trimmed, "i_1").start).mask!.w).toBeCloseTo(0.6); // its first frame is source 1 s
    expect(validate(trimmed, p, ctx)).toEqual([]);
    // removing the mask drops its keys, so a new mask isn't overridden by stale ones
    const opacity = ok(apply(p, "setKeyframe", { itemId: "i_1", prop: "opacity", at: 0, value: 0.5 }, ctx));
    const off = ok(apply(opacity, "setProps", { itemId: "i_1", patch: { mask: null } }, ctx));
    expect(Object.keys(item(off, "i_1").keyframes)).toEqual(["opacity"]);
    const gone = ok(apply(p, "setProps", { itemId: "i_1", patch: { mask: null } }, ctx));
    expect(item(gone, "i_1").keyframes).toBeUndefined();
    const again = ok(set(gone, { ...base, w: 0.4 }));
    expect(animate(again, item(again, "i_1"), 30).mask!.w).toBe(0.4);
  });

  it("dissolve needs source past both sides of the cut; dip doesn't; split keeps it on the second half", () => {
    const tr = (kind: string) => ({ itemId: "i_1", patch: { transition: { kind, duration: 30 } } });
    const p = ok(apply(fixture(), "setProps", tr("dissolve"), ctx));
    const slipped = ok(apply(fixture(), "slip", { itemId: "i_2", deltaSec: -5 }, ctx)); // i_2 now starts at source 0
    expect(err(apply(slipped, "setProps", tr("dissolve"), ctx))).toBe("invalid");
    ok(apply(slipped, "setProps", tr("dip"), ctx));
    const cut = ok(apply(p, "split", { itemId: "i_1", at: 30 }, ctx));
    expect(item(cut, "i_1").transition).toBeUndefined();
    expect(item(cut, "i_3").transition).toMatchObject({ kind: "dissolve" });
  });

  it("slide, push and zoom need handles like dissolve; direction round-trips", () => {
    const slipped = ok(apply(fixture(), "slip", { itemId: "i_2", deltaSec: -5 }, ctx)); // i_2 now starts at source 0
    for (const kind of ["slide", "push", "zoom"]) {
      const patch = { transition: { kind, duration: 30, direction: "up" } };
      expect(err(apply(slipped, "setProps", { itemId: "i_1", patch }, ctx))).toBe("invalid");
      const p = ok(apply(fixture(), "setProps", { itemId: "i_1", patch }, ctx));
      expect(item(p, "i_1").transition).toEqual({ kind, duration: 30, direction: "up" });
      expect(item(ok(apply(p, "split", { itemId: "i_1", at: 30 }, ctx)), "i_3").transition?.direction).toBe("up");
    }
    expect(err(apply(fixture(), "setProps", { itemId: "i_1", patch: { transition: { kind: "wipe", duration: 30, direction: "diagonal" } } }, ctx))).toBe("invalid");
  });

  it("cutRanges removes source ranges in one revision; captions follow; ripple false leaves gaps; outside ranges are ignored", () => {
    const base = ok(apply(fixture(), "addCaptionsFromTranscript", { itemId: "i_1" }, ctx)); // "hello" at source 0.5–1.5 → frames 15–45
    const ranges = [[2, 2.5], [0.1, 0.3]]; // frames 60–75 and 3–9, out of order on purpose
    const v1 = (p: Project) => items(p, "t_1").map((i) => [i.start, i.duration]);
    const cap = (p: Project) => item(p, "c_1");

    const p = ok(apply(base, "cutRanges", { itemId: "i_1", ranges }, ctx));
    expect(p.revision).toBe(base.revision + 1); // one op, one undo step
    expect(v1(p)).toEqual([[0, 3], [3, 51], [54, 15], [69, 60]]); // 150 − 21 frames, no gaps
    expect(cap(p)).toMatchObject({ start: 9, duration: 30 }); // 6 frames were removed before it
    expect(validate(p, base, ctx)).toEqual([]);

    const gaps = ok(apply(base, "cutRanges", { itemId: "i_1", ranges, ripple: false }, ctx));
    expect(v1(gaps)).toEqual([[0, 3], [9, 51], [75, 15], [90, 60]]);
    expect(cap(gaps)).toMatchObject({ start: 15 });

    // a range straddling the item's end is clamped; one outside it (and a sub-frame one) cuts nothing
    expect(v1(ok(apply(base, "cutRanges", { itemId: "i_1", ranges: [[2.5, 9]] }, ctx)))).toEqual([[0, 75], [75, 60]]);
    expect(v1(ok(apply(base, "cutRanges", { itemId: "i_1", ranges: [[8, 9], [1, 1.01]] }, ctx)))).toEqual([[0, 90], [90, 60]]);
    expect(v1(ok(apply(base, "cutRanges", { itemId: "i_1", ranges: [[0, 1], [0.5, 1.5]] }, ctx)))).toEqual([[0, 45], [45, 60]]); // overlapping ranges merge
    expect(err(apply(base, "cutRanges", { itemId: "c_1", ranges: [[0, 1]] }, ctx))).toBe("invalid");
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

  it("detachAudio copies the sound to a new or existing audio track and silences the video, in one revision", () => {
    let p = ok(apply(fixture(), "setProps", { itemId: "i_1", patch: { volume: 0.8, fadeIn: 5, fadeOut: 10 } }, ctx));
    const a = ok(apply(p, "detachAudio", { itemId: "i_1" }, ctx));
    expect(a.revision).toBe(p.revision + 1);
    const t = a.tracks.find((x) => x.kind === "audio")!;
    expect(t.items).toEqual([{ id: "i_3", start: 0, duration: 90, assetId: "a_clip", sourceIn: 0, volume: 0.8, fadeIn: 5, fadeOut: 10 }]);
    expect(item(a, "i_1").volume).toBe(0);
    expect(validate(a, p, ctx)).toEqual([]);
    // the second detach reuses the audio track: i_2 starts where i_1's audio ends
    const b = ok(apply(a, "detachAudio", { itemId: "i_2" }, ctx));
    expect(b.tracks.filter((x) => x.kind === "audio")).toHaveLength(1);
    expect(item(b, "i_4")).toMatchObject({ start: 90, sourceIn: 5, duration: 60 });
    // a split of the video leaves the audio alone
    const s = ok(apply(a, "split", { itemId: "i_1", at: 30 }, ctx));
    expect(item(s, "i_3")).toMatchObject({ start: 0, duration: 90 });
    // occupied audio track: a new one is added
    p = ok(apply(a, "insertItem", { assetId: "a_song", at: 0, duration: 200 }, ctx));
    const c = ok(apply(p, "detachAudio", { itemId: "i_2" }, ctx));
    expect(c.tracks.filter((x) => x.kind === "audio")).toHaveLength(2);
  });

  it("detachAudio skips audio tracks that would change the sound and refuses a muted or hidden video track", () => {
    const base = ok(apply(fixture(), "addTrack", { kind: "audio" }));
    const a1 = base.tracks.find((t) => t.kind === "audio")!.id;
    for (const patch of [{ volume: 0.3 }, { muted: true }, { hidden: true }]) {
      const p = ok(apply(base, "setTrack", { trackId: a1, patch }, ctx));
      const d = ok(apply(p, "detachAudio", { itemId: "i_1" }, ctx));
      expect(items(d, a1)).toHaveLength(0);
      expect(d.tracks.filter((t) => t.kind === "audio")).toHaveLength(2);
    }
    for (const patch of [{ muted: true }, { hidden: true }]) {
      const p = ok(apply(base, "setTrack", { trackId: "t_1", patch }, ctx));
      expect(err(apply(p, "detachAudio", { itemId: "i_1" }, ctx))).toBe("invalid");
    }
  });

  it("detachAudio moves volume keys to the audio item", () => {
    let p = ok(apply(fixture(), "setKeyframe", { itemId: "i_1", prop: "volume", at: 30, value: 0.5 }, ctx));
    p = ok(apply(p, "setKeyframe", { itemId: "i_1", prop: "brightness", at: 30, value: 1.2 }, ctx));
    const d = ok(apply(p, "detachAudio", { itemId: "i_1" }, ctx));
    expect(item(d, "i_3").keyframes).toEqual({ volume: [{ t: 1, v: 0.5 }] });
    expect(item(d, "i_1").keyframes).toEqual({ brightness: [{ t: 1, v: 1.2 }] });
    expect(validate(d, p, ctx)).toEqual([]);
  });

  /** i_3: a_song on the audio track, frames [0, 200), keyed 1 → 0.2 between frames 30 and 90. */
  function keyed() {
    let p = ok(apply(fixture(), "insertItem", { assetId: "a_song", at: 0, duration: 200 }, ctx));
    p = ok(apply(p, "setKeyframe", { itemId: "i_3", prop: "volume", at: 30, value: 1 }, ctx));
    return ok(apply(p, "setKeyframe", { itemId: "i_3", prop: "volume", at: 90, value: 0.2 }, ctx));
  }

  it("keys an audio item's volume only, and interpolates in source time", () => {
    const p = keyed();
    expect(item(p, "i_3").keyframes.volume).toEqual([{ t: 1, v: 1 }, { t: 3, v: 0.2 }]);
    expect(valueAt(p, item(p, "i_3"), "volume", 60)).toBeCloseTo(0.6);
    expect(err(apply(p, "setKeyframe", { itemId: "i_3", prop: "brightness", at: 30, value: 1 }, ctx))).toBe("invalid");
    expect(err(apply(p, "setProps", { itemId: "i_3", patch: { keyframes: { blur: [{ t: 0, v: 1 }] } } }, ctx))).toBe("invalid");
    const off = ok(apply(p, "setKeyframe", { itemId: "i_3", prop: "volume", at: 30, value: null }, ctx));
    expect(item(off, "i_3").keyframes.volume).toHaveLength(1);
  });

  it("split, trim and slip keep audio keys on the same source content", () => {
    const p = keyed();
    const s = ok(apply(p, "split", { itemId: "i_3", at: 100 }, ctx));
    expect(item(s, "i_3").keyframes).toEqual(item(p, "i_3").keyframes);
    expect(item(s, "i_4").keyframes).toEqual(item(p, "i_3").keyframes);
    expect(valueAt(s, item(s, "i_4"), "volume", 100)).toBe(0.2); // held past the last key
    const t = ok(apply(p, "trim", { itemId: "i_3", edge: "start", to: 60 }, ctx));
    expect(item(t, "i_3")).toMatchObject({ sourceIn: 2, keyframes: item(p, "i_3").keyframes });
    expect(valueAt(t, item(t, "i_3"), "volume", 60)).toBeCloseTo(0.6);
    const sl = ok(apply(p, "slip", { itemId: "i_3", deltaSec: 1 }, ctx));
    expect(valueAt(sl, item(sl, "i_3"), "volume", 30)).toBeCloseTo(0.6);
  });

  it("setMeta toggles the limiter and refuses fps/size", () => {
    const on = ok(apply(fixture(), "setMeta", { limiter: true }, ctx));
    expect(on.meta.limiter).toBe(true);
    expect("limiter" in ok(apply(on, "setMeta", { limiter: null }, ctx)).meta).toBe(false);
    expect(apply(on, "setMeta", { fps: 25 }, ctx)).toHaveProperty("error");
    expect(apply(on, "setMeta", { title: null }, ctx)).toHaveProperty("error");
  });

  it("normalizeLoudness leaves silenced items alone, e.g. the video after detachAudio", () => {
    const d = ok(apply(fixture(), "detachAudio", { itemId: "i_1" }, ctx));
    const r = apply(d, "normalizeLoudness", { itemIds: ["i_1", "i_3"] }, { ...ctx, loudness: { a_clip: -20 } });
    const n = ok(r);
    expect(item(n, "i_1").volume).toBe(0);
    expect(item(n, "i_3").volume).toBeCloseTo(10 ** (6 / 20));
    expect((r as { changes: { summary: string } }).changes.summary).toBe("normalized 1 items to -14 LUFS; skipped 1 silent (volume 0)");
    expect(ok(apply(d, "normalizeLoudness", { itemIds: ["i_1"] }, ctx)).revision).toBe(d.revision + 1);
  });

  it("normalizeLoudness sets volume from LUFS, clamped to 0..2, in one revision", () => {
    let p = ok(apply(fixture(), "insertItem", { assetId: "a_song", at: 0, duration: 200 }, ctx));
    const lctx: Ctx = { ...ctx, loudness: { a_clip: -20, a_song: -40 } };
    const n = ok(apply(p, "normalizeLoudness", { itemIds: ["i_1", "i_3"] }, lctx));
    expect(n.revision).toBe(p.revision + 1);
    expect(item(n, "i_1").volume).toBeCloseTo(10 ** (6 / 20)); // -20 → -14 LUFS: +6 dB
    expect(item(n, "i_3").volume).toBe(2); // +26 dB wanted, capped
    expect(item(ok(apply(p, "normalizeLoudness", { itemIds: ["i_1"], target: -23 }, lctx)), "i_1").volume).toBeCloseTo(10 ** (-3 / 20));
    expect(err(apply(p, "normalizeLoudness", { itemIds: ["i_1"] }, ctx))).toBe("not_found");
    p = ok(apply(p, "setKeyframe", { itemId: "i_1", prop: "volume", at: 0, value: 1 }, ctx));
    expect(err(apply(p, "normalizeLoudness", { itemIds: ["i_1"] }, lctx))).toBe("invalid");
  });

  it("detachAudio refuses images, speed ≠ 1 and silent items", () => {
    const p = fixture();
    const silent = ok(apply(p, "setProps", { itemId: "i_1", patch: { volume: 0 } }, ctx));
    expect(err(apply(silent, "detachAudio", { itemId: "i_1" }, ctx))).toBe("invalid");
    const fast = ok(apply(p, "setSpeed", { itemId: "i_1", speed: 2 }, ctx));
    expect(err(apply(fast, "detachAudio", { itemId: "i_1" }, ctx))).toBe("invalid");
    let img = ok(apply(p, "importAsset", { path: "raw/photo.jpg" }, ctx));
    img = ok(apply(img, "insertItem", { assetId: "a_photo", at: 150, duration: 30 }, ctx));
    expect(err(apply(img, "detachAudio", { itemId: "i_3" }, ctx))).toBe("invalid");
  });

  it("imports LUT assets separately, validates look references and luma thresholds", () => {
    const p = fixture();
    const lutCtx = { ...ctx, validateLut: () => {} };
    const withLut = ok(apply(p, "importAsset", { path: "raw/film.cube" }, lutCtx));
    expect(withLut.assets.a_film?.kind).toBe("lut");
    expect(err(apply(p, "importAsset", { path: "raw/other.cube", kind: "image" }, lutCtx))).toBe("invalid");
    expect(err(apply(p, "importAsset", { path: "raw/other.png", kind: "lut" }, lutCtx))).toBe("invalid");
    expect(err(apply(withLut, "insertItem", { assetId: "a_film", at: 0, duration: 30 }, lutCtx))).toBe("invalid");
    const invalidTrackProject = structuredClone(p);
    invalidTrackProject.assets.a_film = { id: "a_film", path: "raw/film.cube", kind: "lut" };
    (invalidTrackProject.tracks[0].items[0] as { assetId: string }).assetId = "a_film";
    expect(validate(invalidTrackProject)).toContain("i_1: LUT assets cannot be placed on a track");
    const looked = ok(apply(withLut, "setProps", { itemId: "i_1", patch: { grade: { exposure: 1.5, lut: { assetId: "a_film", strength: 0.5 } } } }, lutCtx));
    expect(item(looked, "i_1").grade?.exposure).toBe(1.5);
    expect(err(apply(withLut, "setProps", { itemId: "i_1", patch: { grade: { lut: { assetId: "missing" } } } }, lutCtx))).toBe("invalid");
    expect(err(apply(p, "setProps", { itemId: "i_1", patch: { key: { kind: "luma", low: 0.5, high: 0.5 } } }, ctx))).toBe("invalid");
    expect(err(apply(p, "setProps", { itemId: "i_1", patch: { grade: { curves: { r: [[0,0],[0,1],[1,1]] } } } }, ctx))).toBe("invalid");
  });
});

describe("text themes", () => {
  const withText = () => {
    let p = ok(apply(fixture(), "insertItem", { component: "Text", at: 0, duration: 30, props: { text: "Hi" } }, ctx));
    p = ok(apply(p, "setTrack", { trackId: "t_3", patch: { textStyle: { size: 40 }, highlight: "word" } }, ctx));
    return p;
  };

  it("setMeta theme is one op (one revision) and validates the id", () => {
    const p = withText();
    const t = ok(apply(p, "setMeta", { theme: "luxury" }, ctx));
    expect(t.meta.theme).toBe("luxury");
    expect(t.revision).toBe(p.revision + 1);
    expect(err(apply(p, "setMeta", { theme: "nope" }, ctx))).toBe("invalid");
    expect(ok(apply(t, "setMeta", { theme: null }, ctx)).meta.theme).toBeUndefined();
  });

  it("resolves role -> theme, textStyle over it, CJK fallback, weight clamp", () => {
    const p = ok(apply(withText(), "setMeta", { theme: "travel-cinematic" }, ctx));
    const title = textCss(p, "title", undefined, "Hello");
    expect(title.fontFamily).toBe('"Bebas Neue", sans-serif');
    expect(title.fontSize).toBe(Math.round(0.09 * 1080));
    expect(textCss(p, "title", { size: 10, weight: 900 }, "Hello")).toMatchObject({ fontSize: 10, fontWeight: 400 }); // Bebas has only 400
    expect(textCss(p, "title", undefined, "你好").fontFamily).toBe('"Bebas Neue", "Noto Sans TC Variable", sans-serif');
    expect(textCss(ok(apply(p, "setMeta", { theme: null }, ctx)), "title", undefined, "Hi")).toEqual({}); // no theme: today's look
  });

  it("captionWords reads each asset's transcript once however many captions share it", () => {
    const base = withText();
    const caption = (id: string, sourceStart: number) => ({ id, start: 0, duration: 30, mode: "anchored" as const, itemId: "i_1", sourceStart, sourceEnd: sourceStart + 1, text: "w" });
    const p = { ...base, tracks: [...base.tracks, { id: "t_9", kind: "caption" as const, name: "C", highlight: "word" as const, items: [caption("c_1", 0), caption("c_2", 6)] }] } as Project;
    let reads = 0;
    const words = captionWords(p, { transcript: () => (reads++, [{ start: 0, end: 7, text: "x", words: [{ start: 0.5, end: 0.9, text: "a" }, { start: 6.2, end: 6.6, text: "b" }] }]) });
    expect(reads).toBe(1);
    expect(words).toEqual({ c_1: [{ start: 0.5, end: 0.9, text: "a" }], c_2: [{ start: 6.2, end: 6.6, text: "b" }] });
  });

  it("builds every built-in theme with all four roles and known fonts", () => {
    for (const id of THEME_IDS) {
      const t = builtinTheme(id, 1080)!;
      for (const r of ["title", "subtitle", "emphasis", "handwritten"] as const) expect(badFont(t.roles[r]), `${id}/${r}`).toBeUndefined();
    }
  });

  it("rejects an unknown font, bad role, and a project theme removed while in use", () => {
    const p = withText();
    expect(err(apply(p, "setProps", { itemId: "i_3", patch: { props: { text: "x", textStyle: { font: "Comic Sans" } } } }, ctx))).toBe("invalid");
    expect(err(apply(p, "setProps", { itemId: "i_3", patch: { props: { text: "x", role: "huge" } } }, ctx))).toBe("invalid");
    expect(err(apply(p, "setTrack", { trackId: "t_3", patch: { textStyle: { font: "Comic Sans" } } }, ctx))).toBe("invalid");
    // the same checks apply when the Text overlay is created, not only when it is patched
    const insert = (props: Record<string, unknown>) => err(apply(fixture(), "insertItem", { component: "Text", at: 0, duration: 30, props }, ctx));
    expect(insert({ text: "x", textStyle: { font: "Comic Sans" } })).toBe("invalid");
    expect(insert({ text: "x", role: "huge" })).toBe("invalid");
    expect(insert({ text: "x", role: "title", textStyle: { font: "Anton" } })).toBe("ok");
    const mine = { mine: { name: "mine", roles: { title: { font: "Anton" } } } };
    const q = ok(apply(ok(apply(p, "setMeta", { themes: mine }, ctx)), "setMeta", { theme: "mine" }, ctx));
    expect(err(apply(q, "setMeta", { themes: null }, ctx))).toBe("invalid");
  });
});

describe("bezier ease", () => {
  // Reference: 60-step bisection on the parametric curve, independent of the Newton solver.
  const ref = (x1: number, y1: number, x2: number, y2: number, x: number) => {
    const c = (a: number, b: number, s: number) => 3 * a * (1 - s) ** 2 * s + 3 * b * (1 - s) * s * s + s ** 3;
    let [lo, hi] = [0, 1];
    for (let i = 0; i < 60; i++) (c(x1, x2, (lo + hi) / 2) < x ? (lo = (lo + hi) / 2) : (hi = (lo + hi) / 2));
    return c(y1, y2, (lo + hi) / 2);
  };
  const curves: [number, number, number, number][] = [[0.42, 0, 1, 1], [0, 0, 0.58, 1], [0.42, 0, 0.58, 1], [0.34, 1.56, 0.64, 1], [0.25, 0.1, 0.25, 1], [1, 0, 0, 1]];

  it("matches the parametric reference within 1e-3 and hits both endpoints", () => {
    for (const c of curves) {
      expect(bezier(...c, 0)).toBe(0);
      expect(bezier(...c, 1)).toBe(1);
      for (const x of [0.05, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.97]) expect(Math.abs(bezier(...c, x) - ref(...c, x))).toBeLessThan(1e-3);
    }
    expect(bezier(0.34, 1.56, 0.64, 1, 0.5)).toBeGreaterThan(1); // overshoot
    expect(bezier(0, 0, 1, 1, 0.3)).toBeCloseTo(0.3, 6);
  });

  it("schema rejects x outside [0, 1]; keys without a tuple are unchanged", () => {
    const key = (ease: unknown) => Keyframes.safeParse({ opacity: [{ t: 0, v: 0, ease }, { t: 1, v: 1 }] }).success;
    expect(key([0.3, 2, 0.6, 1])).toBe(true);
    expect(key([1.2, 0, 0.5, 1])).toBe(false);
    expect(key([0.2, 0, -0.1, 1])).toBe(false);
    expect(key([0.2, 0, 0.5])).toBe(false);
    expect(key("linear") && key("ease") && key(undefined)).toBe(true);
  });

  it("setKeyframe with a tuple ease round-trips and drives valueAt; re-keying keeps it", () => {
    let p = ok(apply(fixture(), "setKeyframe", { itemId: "i_1", prop: "opacity", at: 0, value: 0, ease: [0.42, 0, 0.58, 1] }, ctx));
    p = ok(apply(p, "setKeyframe", { itemId: "i_1", prop: "opacity", at: 30, value: 1 }, ctx));
    expect(item(p, "i_1").keyframes.opacity[0].ease).toEqual([0.42, 0, 0.58, 1]);
    expect(validate(p)).toEqual([]);
    expect(valueAt(p, item(p, "i_1"), "opacity", 15)).toBeCloseTo(0.5, 3);
    expect(valueAt(p, item(p, "i_1"), "opacity", 7)).toBeLessThan(7 / 30);
    p = ok(apply(p, "setKeyframe", { itemId: "i_1", prop: "opacity", at: 0, value: 0.2 }, ctx));
    expect(item(p, "i_1").keyframes.opacity[0].ease).toEqual([0.42, 0, 0.58, 1]);
    expect(err(apply(p, "setKeyframe", { itemId: "i_1", prop: "opacity", at: 0, value: 0, ease: [2, 0, 0.5, 1] }, ctx))).not.toBe("ok");
  });
});
