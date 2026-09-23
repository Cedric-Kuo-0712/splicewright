import { describe, expect, it } from "vitest";
import { apply, createProject, rulerTicks, snap, snapPoints, snapSpan, tickSteps, type OpResult, type Project, type SnapPoint } from "../src/index.ts";

const ok = (r: OpResult): Project => {
  if ("error" in r) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.project;
};

describe("rulerTicks", () => {
  // Label width budget: "00:00:00" at ~7 px/char.
  const LABEL_PX = 60;
  for (const fps of [24, 25, 29.97, 30, 60])
    for (const ppf of [0.005, 0.05, 0.5, 3, 24])
      it(`fps ${fps} at ${ppf} px/frame`, () => {
        const t = rulerTicks(fps, ppf, [0, 20_000]);
        const all = [...t.major, ...t.minor];
        expect(all.every(Number.isInteger)).toBe(true);
        if (t.majorStep * ppf >= 80) expect(tickSteps(fps).filter((s) => s < t.majorStep).every((s) => s * ppf < 80)).toBe(true);
        for (let i = 1; i < t.labels.length; i++) expect((t.labels[i].frame - t.labels[i - 1].frame) * ppf).toBeGreaterThanOrEqual(LABEL_PX);
        if (t.minorStep) {
          expect(t.majorStep % t.minorStep).toBe(0);
          expect(t.minorStep * ppf).toBeGreaterThanOrEqual(8);
        }
        expect(t.minor.some((f) => t.major.includes(f))).toBe(false);
      });

  it("labels follow the major step", () => {
    expect(rulerTicks(30, 24, [0, 60]).labels.slice(0, 2)).toEqual([{ frame: 0, text: "00:00:00" }, { frame: 5, text: "00:00:05" }]);
    expect(rulerTicks(30, 1, [0, 400]).labels.slice(0, 2).map((l) => l.text)).toEqual(["00:00", "00:05"]);
    expect(rulerTicks(30, 0.0005, [0, 30 * 7200]).labels[1].text).toBe("1:00:00");
  });

  it("starts at the first step inside the range", () => {
    expect(rulerTicks(30, 1, [95, 400]).major[0]).toBe(150);
  });
});

describe("snap", () => {
  const pts: SnapPoint[] = [
    { frame: 100, kind: "caption", ref: "c_1" },
    { frame: 100, kind: "edge", ref: "i_1" },
    { frame: 110, kind: "marker", ref: "m_1" },
  ];

  it("threshold is in frames converted from pixels by the caller", () => {
    // 8 px at three zoom levels: 0.5, 4, 24 px/frame → 16, 2, 1 (floor of 1) frames.
    for (const [ppf, hit] of [[0.5, true], [4, false], [24, false]] as const)
      expect(snap(pts, 97, Math.max(1, 8 / ppf)).target !== null).toBe(hit);
    expect(snap(pts, 99, Math.max(1, 8 / 24)).frame).toBe(100);
  });

  it("equal distance goes to the higher-priority kind", () => {
    expect(snap(pts, 100, 5).target).toMatchObject({ kind: "edge" });
    expect(snap(pts, 105, 5).target).toMatchObject({ kind: "edge" }); // 100 edge vs 110 marker, both 5 away
  });

  it("excludes the dragged item's own points", () => {
    expect(snap(pts, 101, 5, ["i_1"]).target).toMatchObject({ kind: "caption" });
  });

  it("snapSpan lands either edge", () => {
    expect(snapSpan(pts, 48, 60, 5)).toMatchObject({ frame: 50, target: { frame: 110 } }); // end 108 → 110
    expect(snapSpan(pts, 98, 60, 5)).toMatchObject({ frame: 100 });
  });
});

describe("{ near } frame args", () => {
  function fixture() {
    let p = createProject({ title: "t", fps: 30, width: 640, height: 360 });
    p = ok(apply(p, "importAsset", { path: "clip.mp4" }));
    p = ok(apply(p, "insertItem", { assetId: "a_clip", at: 0, duration: 90 }));
    p = ok(apply(p, "insertItem", { assetId: "a_clip", at: 90, duration: 60 }));
    p = ok(apply(p, "addMarker", { label: "m", start: 200 }));
    return ok(apply(p, "insertItem", { component: "Text", props: { text: "x" }, at: 10, duration: 30 }));
  }

  it("snaps a move by either edge, ignoring the item's own edges", () => {
    // Start 165 is 15 from i_2's end (150); end 195 is 5 from the marker (200), so the end wins.
    const p = ok(apply(fixture(), "move", { itemId: "i_3", to: { near: 165 } }));
    expect(p.tracks[3].items[0].start).toBe(170);
    expect(snapPoints(p, [0, Infinity], { kinds: ["marker"] })).toEqual([{ frame: 200, kind: "marker", ref: "m_1" }]);
  });

  it("snaps split and trim to markers or edges", () => {
    const p = fixture();
    expect((ok(apply(p, "trim", { itemId: "i_3", edge: "end", to: { near: 85, snapTo: ["edge"] } })).tracks[3].items[0]).duration).toBe(80);
    expect(ok(apply(p, "split", { itemId: "i_1", at: { near: 12 } })).tracks[0].items[0].duration).toBe(10); // overlay start
  });

  it("fails clearly when nothing is in reach", () => {
    const r = apply(fixture(), "split", { itemId: "i_1", at: { near: 60, within: 5 } });
    expect(r).toMatchObject({ error: { code: "no_snap_target" } });
  });

  it("works inside batch against the intermediate state", () => {
    const p = ok(apply(fixture(), "batch", { ops: [{ op: "addMarker", args: { label: "b", start: 300 } }, { op: "move", args: { itemId: "i_3", to: { near: 275 } } }] }));
    expect(p.tracks[3].items[0].start).toBe(270); // end lands on the new marker
  });
});
