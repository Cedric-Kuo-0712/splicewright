import { describe, expect, it } from "vitest";
import { validate } from "@splicewright/core";
import { createFixtureProject, makeCaptions } from "./export-comparison-fixtures.mjs";

const source = { path: "raw/source.mp4", duration: 31, width: 3840, height: 2160, fps: 30, audio: true };

describe("export comparison fixture configuration", () => {
  it("rejects asset paths that escape the public project directory", () => {
    expect(() => createFixtureProject({ caseId: "diagnostic", variant: "hardcut", media: { ...source, path: "../shared/diagnostic.mp4" } })).toThrow(/asset paths/);
    const project = createFixtureProject({ caseId: "diagnostic", variant: "hardcut", media: { ...source, path: "shared/diagnostic.mp4" } });
    expect(project.assets.diagnostic_source.path).toBe("shared/diagnostic.mp4");
  });
  it("emits stable seven-caption schedules for a fixed seed", () => {
    const first = makeCaptions(20261004);
    expect(makeCaptions(20261004)).toEqual(first);
    expect(first).toHaveLength(7);
    expect(first.every(({ start, duration }) => start >= 0 && start + duration <= 180)).toBe(true);
    expect(new Set(first.map(({ text }) => text)).size).toBe(7);
  });

  it("keeps hard-cut and transition variants schema-valid with matching timeline and source handles", () => {
    const hardcut = createFixtureProject({ caseId: "real", variant: "hardcut", seed: 20261004, media: source });
    const transitioned = createFixtureProject({ caseId: "real", variant: "overlay-transition", seed: 20261004, media: source });
    const durations = { real_source: source.duration };
    expect(validate(hardcut, undefined, { assetDurations: durations })).toEqual([]);
    expect(validate(transitioned, undefined, { assetDurations: durations })).toEqual([]);
    expect(hardcut.meta).toMatchObject({ fps: 30, width: 1920, height: 1080 });
    expect(hardcut.tracks[0].items.map(({ start, duration }) => [start, duration])).toEqual([[0, 90], [90, 90]]);
    expect(hardcut.tracks[1].items).toEqual(transitioned.tracks[1].items);
    expect(hardcut.tracks[0].items.some((item) => item.transition)).toBe(false);
    expect(transitioned.tracks[0].items[0].transition).toEqual({ kind: "dip", duration: 18 });
    expect(transitioned.tracks[0].items[1].transition).toBeUndefined();
  });

  it("retains the probed source frame rate when it differs from the project frame rate", () => {
    const media = [
      { ...source, id: "real_source_1", path: "raw/first.mp4", fps: 48, sourceInSeconds: 12 },
      { ...source, id: "real_source_2", path: "raw/second.mp4", fps: 24, sourceInSeconds: 40 },
    ];
    const fixture = createFixtureProject({ caseId: "real", variant: "overlay-transition", media });
    expect(fixture.meta.fps).toBe(30);
    expect(fixture.tracks[0].items.map((item) => item.assetId)).toEqual(["real_source_1", "real_source_2"]);
    expect(fixture.tracks[0].items[0].sourceIn * media[0].fps).toBe(Math.round(fixture.tracks[0].items[0].sourceIn * media[0].fps));
    expect(fixture.tracks[0].items[1].sourceIn * media[1].fps).toBe(Math.round(fixture.tracks[0].items[1].sourceIn * media[1].fps));
    expect(validate(fixture, undefined, { assetDurations: { real_source_1: 51, real_source_2: 81 } })).toEqual([]);
  });

  it("builds a bounded-graphics stress fixture with overlapping safe captions and alternating transitions", () => {
    const fixture = createFixtureProject({ caseId: "real", variant: "chunk-stress", seed: 20261004, media: source });
    const video = fixture.tracks.find(track => track.kind === "video");
    const overlays = fixture.tracks.find(track => track.kind === "overlay");
    expect(validate(fixture, undefined, { assetDurations: { real_source: source.duration } })).toHaveLength(9);
    expect(video.items).toHaveLength(6);
    expect(video.items.slice(0, 5).map(item => item.transition.kind)).toEqual(["dissolve", "dip", "dissolve", "dip", "dissolve"]);
    expect(overlays.items).toHaveLength(10);
    expect(overlays.items.some((item, index) => index > 0 && item.start < overlays.items[index - 1].start + overlays.items[index - 1].duration)).toBe(true);
    expect(overlays.items.every(item => item.component === "CaptionLayer" && item.props.css.backdropFilter === "none")).toBe(true);
  });
});
