import { describe, expect, it } from "vitest";
import { apply, beatFrames, createProject, getRange, snapPoints, type AudioItem, type BeatAnalysis, type Ctx, type OpResult, type Project } from "../src/index.ts";

const ok = (r: OpResult): Project => {
  if ("error" in r) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.project;
};

// 120 BPM at 30 fps: a beat every 15 frames, starting 0.25 s (7.5 → 8) into the song; accent every 4th.
const analysis: BeatAnalysis = {
  algo: "test",
  version: "0",
  tempo: 120,
  beats: Array.from({ length: 40 }, (_, i) => ({ t: 0.25 + i * 0.5, strength: i % 4 === 1 ? 1 : 0.3 + (i % 3) * 0.1 })),
  downbeats: Array.from({ length: 10 }, (_, i) => 0.25 + 0.5 + i * 2),
};
const ctx: Ctx = { beats: () => analysis, assetDurations: { a_clip: 3, a_song: 20 } };

function slideshow(n = 8): Project {
  let p = createProject({ title: "t", fps: 30, width: 640, height: 360 });
  for (let i = 0; i < n; i++) p = ok(apply(p, "importAsset", { path: `p${i}.jpg` }));
  p = ok(apply(p, "importAsset", { path: "song.mp3" }));
  for (let i = 0; i < n; i++) p = ok(apply(p, "insertItem", { trackId: "t_1", assetId: `a_p${i}`, at: i * 40, duration: 40 }));
  p = ok(apply(p, "insertItem", { trackId: "t_2", assetId: "a_song", at: 0, duration: 600 }, ctx));
  return ok(apply(p, "detectBeats", { itemId: `i_${n + 1}`, density: "all" }, ctx));
}

describe("detectBeats", () => {
  it("densities", () => {
    const p = slideshow();
    const run = (density: string) => (ok(apply(p, "detectBeats", { itemId: "i_9", density }, ctx)).tracks[1].items[0] as AudioItem).beats;
    expect(run("all")).toHaveLength(40);
    expect(run("downbeat")).toEqual(analysis.downbeats);
    expect(run("strong")!.every((t) => (t - 0.75) % 2 === 0)).toBe(true); // accents only
    expect(run("every:2")![0]).toBe(0.75); // counted from the first downbeat
    expect(run("every:2")).toHaveLength(20);
  });

  it("keeps the downbeats that survive the density, and removeBeat/clearBeats drop them too", () => {
    const item = (p: Project) => p.tracks[1].items[0] as AudioItem;
    const p = slideshow();
    expect(item(p).downbeats).toEqual(analysis.downbeats);
    expect(item(ok(apply(p, "detectBeats", { itemId: "i_9", density: "every:4" }, ctx))).downbeats).toEqual(analysis.downbeats);
    // 0.75 s is the first downbeat, frame round(22.5) = 23.
    const q = ok(apply(p, "removeBeat", { itemId: "i_9", at: 23 }));
    expect(item(q).downbeats).toEqual(analysis.downbeats.slice(1));
    expect(beatFrames(q, item(q), item(q).downbeats)[0]).toBe(83);
    expect(item(ok(apply(p, "clearBeats", { itemId: "i_9" })))).not.toHaveProperty("downbeats");
    expect(getRange(p, 0, 90).find((i) => i.id === "i_9")).toMatchObject({ downbeatFrames: [23, 83] });
  });

  it("fails clearly without the ingest cache", () => {
    expect(apply(slideshow(), "detectBeats", { itemId: "i_9" }, {})).toMatchObject({ error: { code: "not_found" } });
  });

  it("maps beats through the item's position and trim; get_range reports frames", () => {
    const p = ok(apply(slideshow(), "move", { itemId: "i_9", to: 100 }));
    expect(beatFrames(p, p.tracks[1].items[0] as AudioItem).slice(0, 2)).toEqual([108, 123]);
    expect(snapPoints(p, [100, 130], { kinds: ["beat"] }).map((s) => s.frame)).toEqual([108, 123]);
    const song = getRange(p, 100, 130).find((i) => i.id === "i_9")!;
    expect(song).toMatchObject({ beatFrames: [108, 123] });
    expect(song).not.toHaveProperty("beats");
  });
});

describe("addBeat / removeBeat", () => {
  it("round-trips at a frame, and snaps with { near }", () => {
    let p = ok(apply(slideshow(), "clearBeats", { itemId: "i_9" }));
    p = ok(apply(p, "addBeat", { itemId: "i_9", at: 31 }));
    p = ok(apply(p, "addBeat", { itemId: "i_9", at: 10 }));
    expect(beatFrames(p, p.tracks[1].items[0] as AudioItem)).toEqual([10, 31]);
    p = ok(apply(p, "removeBeat", { itemId: "i_9", at: { near: 29, snapTo: ["beat"] } }));
    expect((p.tracks[1].items[0] as AudioItem).beats).toEqual([0.3333]); // stored to 0.1 ms
    expect(apply(p, "removeBeat", { itemId: "i_9", at: 31 })).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("moving music snaps its own beats", () => {
  it("lands a beat on a video cut", () => {
    // Cuts at 40, 80, …; the song's first beat is 8 frames in. Near 30 → beat at 38 is 2 from the cut at 40.
    const p = ok(apply(slideshow(), "move", { itemId: "i_9", to: { near: 30, within: 5 } }));
    expect(p.tracks[1].items[0].start).toBe(32);
  });
});

describe("fitToBeats", () => {
  it("puts every cut of an 8-image slideshow on a beat, with the right total", () => {
    const p = ok(apply(slideshow(), "fitToBeats", { trackId: "t_1", audioItemId: "i_9", every: 2 }, ctx));
    const beats = beatFrames(p, p.tracks[1].items[0] as AudioItem);
    const v = p.tracks[0].items;
    expect(v).toHaveLength(8);
    for (let i = 1; i < v.length; i++) expect(v[i].start).toBe(v[i - 1].start + v[i - 1].duration); // still contiguous
    for (const item of v) expect(beats).toContain(item.start + item.duration);
    // No beat at or before 0, so the first cut is on beat 2 (23); then every 2 beats (30 frames).
    expect(v.map((i) => i.duration)).toEqual([23, 30, 30, 30, 30, 30, 30, 30]);
    expect(v.at(-1)!.start + v.at(-1)!.duration).toBe(23 + 7 * 30);
    // `from` moves the grid origin onto the first beat.
    const q = ok(apply(slideshow(), "fitToBeats", { trackId: "t_1", audioItemId: "i_9", every: 2, from: 8 }, ctx));
    expect(q.tracks[0].items[0].duration).toBe(38);
  });

  it("is one undo step and reports skipped items", () => {
    const r = apply(slideshow(), "fitToBeats", { trackId: "t_1", audioItemId: "i_9", every: 8 }, ctx);
    expect(r).toMatchObject({ changes: { summary: expect.stringContaining("i_6 skipped (no more beats)") } });
  });

  it("never trims video past its source; uses the nearest reachable beat", () => {
    let p = ok(apply(slideshow(2), "importAsset", { path: "clip.mp4" }));
    p = ok(apply(p, "insertItem", { trackId: "t_1", assetId: "a_clip", at: 80, duration: 30 }, ctx)); // 3 s source
    const r = apply(p, "fitToBeats", { trackId: "t_1", audioItemId: "i_3", every: 8 }, ctx);
    const v = ok(r).tracks[0].items;
    // Images end on beats 113 and 233; the clip can run 90 frames (3 s), so beat 353 is out of reach and 323 is used.
    expect(v.map((i) => i.start + i.duration)).toEqual([113, 233, 323]);
    expect(r).toMatchObject({ changes: { summary: expect.stringContaining("i_4 cut at beat 323") } });
  });

  it("limits to a marker range", () => {
    let p = ok(apply(slideshow(), "addMarker", { label: "Day 2", start: 160, duration: 160 }));
    p = ok(apply(p, "fitToBeats", { trackId: "t_1", audioItemId: "i_9", range: "Day 2" }, ctx));
    expect(p.tracks[0].items.map((i) => i.duration)).toEqual([40, 40, 40, 40, 13, 15, 15, 15]);
  });
});
