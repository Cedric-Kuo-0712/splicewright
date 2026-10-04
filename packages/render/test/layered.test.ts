import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "@splicewright/core/node";
import type { AudioItem, Project, Track, VideoItem } from "@splicewright/core";
import type { Probe } from "@splicewright/core/node";
import { audioTransitionFades, planLayeredExport } from "../src/layered.ts";
import { renderLayered, validateLayeredMedia, type LayeredRenderArgs } from "../src/layered-render.ts";

const video = (id: string, start: number, transition?: VideoItem["transition"]): VideoItem => ({ id, assetId: `a_${id}`, start, duration: 90, sourceIn: 1, transition });
const project = (items = [video("v1", 0), video("v2", 90)], more: Track[] = []): Project => ({
  schemaVersion: 1,
  revision: 0,
  meta: { title: "layered", fps: 30, width: 64, height: 36 },
  assets: Object.fromEntries(items.map((item) => [item.assetId, { id: item.assetId, kind: "video", path: `raw/${item.assetId}.mp4` }])),
  tracks: [{ id: "video", kind: "video", items }, ...more],
} as unknown as Project);
const probes = (items: VideoItem[]) => Object.fromEntries(items.map((item) => [item.assetId, { path: `raw/${item.assetId}.mp4`, fingerprint: "x", kind: "video", width: 64, height: 36, fps: 48, duration: 8, audio: false } satisfies Probe]));

describe("layered export planning", () => {
  it("validates selected source fingerprints before renderer preparation", () => {
    const dir = mkdtempSync(join(tmpdir(), "swr-layered-probe-"));
    try {
      mkdirSync(join(dir, "raw"));
      const items = [video("v1", 0)];
      const file = join(dir, "raw/a_v1.mp4");
      writeFileSync(file, "source before encoding");
      const p = project(items), media = probes(items);
      media.a_v1.fingerprint = fingerprint(file)!;
      const plan = planLayeredExport(p, media);
      expect(() => validateLayeredMedia(dir, p, media, plan)).not.toThrow();
      media.a_v1.fingerprint = "stale";
      expect(() => validateLayeredMedia(dir, p, media, plan)).toThrow("media probe for v1 is stale");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects an unsupported transition affecting the range after its outgoing clip has ended", () => {
    const items = [video("v1", 0, { kind: "wipe", duration: 30 }), video("v2", 90)];
    expect(() => planLayeredExport(project(items), probes(items), 96, 100)).toThrow(/wipe transition/);
  });

  it("ignores unsupported transition phases that do not intersect the requested range", () => {
    const items = [video("v1", 0, { kind: "wipe", duration: 30 }), video("v2", 90)];
    expect(planLayeredExport(project(items), probes(items), 0, 30).video[0].outgoing).toBeUndefined();
    expect(planLayeredExport(project(items), probes(items), 120, 150).video[0].incoming).toBeUndefined();
  });
  it("keeps the Remotion timeline frame range and maps dissolve handles to source time", () => {
    const items = [video("v1", 0, { kind: "dissolve", duration: 30 }), video("v2", 90)];
    const plan = planLayeredExport(project(items), probes(items), 30, 150);
    expect(plan.video.map(({ start, sourceIn, lead, tail, incoming, outgoing }) => ({ start, sourceIn, lead, tail, incoming, outgoing }))).toEqual([
      { start: 0, sourceIn: 1, lead: 0, tail: 15, incoming: undefined, outgoing: { kind: "dissolve", before: 15, after: 15 } },
      { start: 90, sourceIn: 1, lead: 15, tail: 0, incoming: { kind: "dissolve", before: 15, after: 15 }, outgoing: undefined },
    ]);
    expect(plan.from).toBe(30);
    expect(plan.to).toBe(150);
  });

  it("renders dip as a cut with no source handles and uses its exact asymmetric frame halves", () => {
    const items = [video("v1", 0, { kind: "dip", duration: 31 }), video("v2", 90)];
    const plan = planLayeredExport(project(items), probes(items));
    expect(plan.video[0]).toMatchObject({ lead: 0, tail: 0, outgoing: { kind: "dip", before: 15, after: 16 } });
    expect(plan.video[1]).toMatchObject({ lead: 0, tail: 0, incoming: { kind: "dip", before: 15, after: 16 } });
    expect(audioTransitionFades(plan.video[0])).toEqual({ incoming: undefined, outgoing: { start: 75, duration: 15 } });
    expect(audioTransitionFades(plan.video[1])).toEqual({ incoming: 16, outgoing: undefined });
  });

  it("fades dissolve audio across both sides of the cut", () => {
    const items = [video("v1", 0, { kind: "dissolve", duration: 30 }), video("v2", 90)];
    const plan = planLayeredExport(project(items), probes(items));
    expect(audioTransitionFades(plan.video[0]).outgoing).toEqual({ start: 75, duration: 30 });
    expect(audioTransitionFades(plan.video[1]).incoming).toBe(30);
  });

  it("prunes native media to the requested range while retaining transition handles and global phase", () => {
    const items = [video("v1", 0, { kind: "dissolve", duration: 30 }), video("v2", 90), video("v3", 180)];
    const music: AudioItem = { id: "music", assetId: "music", start: 90, duration: 60, sourceIn: 2, fadeIn: 20 };
    const p = project(items, [{ id: "music-track", kind: "audio", items: [music] } as unknown as Track]);
    p.assets.music = { id: "music", kind: "audio", path: "raw/music.wav" } as Project["assets"][string];
    const plan = planLayeredExport(p, {
      ...probes(items), music: { path: "raw/music.wav", fingerprint: "x", kind: "audio", duration: 10, audio: true },
    }, 96, 100);
    expect(plan.video.map((segment) => ({ id: segment.item.id, renderStart: segment.renderStart, renderEnd: segment.renderEnd, decodeStart: segment.decodeStart, lead: segment.lead, tail: segment.tail }))).toEqual([
      { id: "v1", renderStart: 96, renderEnd: 100, decodeStart: 75, lead: 0, tail: 15 },
      { id: "v2", renderStart: 96, renderEnd: 100, decodeStart: 75, lead: 15, tail: 0 },
    ]);
    expect(plan.video.map((segment) => segment.sourceIn - segment.lead / plan.fps + (segment.decodeStart - (segment.start - segment.lead)) / plan.fps)).toEqual([3.5, 0.5]);
    expect(plan.audio).toEqual([{ item: music, start: 90, duration: 60, renderStart: 96, renderEnd: 100, decodeStart: 90 }]);
    expect(plan.video.map(audioTransitionFades)).toEqual([
      { incoming: undefined, outgoing: { start: 75, duration: 30 } },
      { incoming: 30, outgoing: undefined },
    ]);
  });

  it("ignores unsupported media and graphics outside the requested range", () => {
    const active = video("active", 0);
    const unrelated = { ...video("unrelated", 50_000), reverse: true, grade: { exposure: 2 } } as VideoItem;
    const p = project([active, unrelated], [
      { id: "audio", kind: "audio", items: [{ id: "bad-audio", assetId: "missing", start: 50_000, duration: 60, sourceIn: 0, audioFx: { pan: 1 } }] } as unknown as Track,
      { id: "overlay", kind: "overlay", items: [{ id: "custom", component: "Unknown", start: 50_000, duration: 60, props: {} }] } as unknown as Track,
    ]);
    expect(planLayeredExport(p, probes([active]), 0, 60).video.map((entry) => entry.item.id)).toEqual(["active"]);
  });

  it("still refuses an unsupported item that crosses into the requested range", () => {
    const active = { ...video("active", 0), reverse: true } as VideoItem;
    expect(() => planLayeredExport(project([active]), probes([active]), 30, 60)).toThrow("uses speed or reverse playback");
  });

  it("keeps graphic windows in original composition frame coordinates", () => {
    const items = [video("v1", 0), video("v2", 90)];
    const graphic = { id: "overlay", component: "Text", start: 120, duration: 30, props: { text: "global" } };
    const p = project(items, [{ id: "graphics", kind: "overlay", items: [graphic] } as unknown as Track]);
    expect(planLayeredExport(p, probes(items), 125, 140).windows).toEqual([[125, 140]]);
  });

  it("refuses default caption blur and accepts an overlay CaptionLayer explicitly set to none", () => {
    const items = [video("v1", 0)];
    const caption = { id: "c1", mode: "free", start: 10, duration: 20, text: "default" };
    const withCaption = project(items, [{ id: "captions", kind: "caption", items: [caption] } as unknown as Track]);
    expect(() => planLayeredExport(withCaption, probes(items))).toThrow("uses CaptionLayer's backdrop blur");

    const overlay = { id: "c2", component: "CaptionLayer", start: 10, duration: 20, props: { texts: ["safe"], css: { backdropFilter: "none" } } };
    const safe = project(items, [{ id: "overlay", kind: "overlay", items: [overlay] } as unknown as Track]);
    expect(planLayeredExport(safe, probes(items)).windows).toEqual([[10, 30]]);

    const glass = { id: "glass", component: "Text", start: 10, duration: 20, props: { text: "glass", style: { backdropFilter: "blur(4px)" } } };
    const withGlass = project(items, [{ id: "graphics", kind: "overlay", items: [glass] } as unknown as Track]);
    expect(() => planLayeredExport(withGlass, probes(items))).toThrow("backdrop-dependent");
    overlay.props.css = { backdropFilter: "none", mixBlendMode: "multiply" } as typeof overlay.props.css;
    expect(() => planLayeredExport(safe, probes(items))).toThrow("backdrop-dependent");
    overlay.props.css = { backdropFilter: "none" };
    Object.assign(overlay.props, { words: [[{ text: "safe", on: true }]], hiCss: { backdropFilter: "blur(4px)" } });
    expect(() => planLayeredExport(safe, probes(items))).toThrow("backdrop-dependent");
  });

  it("merges adjacent caption windows while preserving anchored caption timing", () => {
    const items = [video("v1", 0), video("v2", 90)];
    const caption = { id: "c1", component: "CaptionLayer", start: 10, duration: 20, props: { texts: ["first"], css: { backdropFilter: "none" } } };
    const caption2 = { id: "c2", component: "CaptionLayer", start: 90, duration: 30, props: { texts: ["second"], css: { backdropFilter: "none" } } };
    const p = project(items, [{ id: "captions", kind: "overlay", items: [caption, caption2] } as unknown as Track]);
    const plan = planLayeredExport(p, probes(items));
    expect(plan.windows).toEqual([[10, 30], [90, 120]]);
  });

  it("includes native audio clips with timeline trim metadata", () => {
    const items = [video("v1", 0)];
    const audio: AudioItem = { id: "a1", assetId: "music", start: 15, duration: 60, sourceIn: 2, volume: 0.25, fadeIn: 8 };
    const p = project(items, [{ id: "music", kind: "audio", items: [audio] } as unknown as Track]);
    const plan = planLayeredExport({ ...p, assets: { ...p.assets, music: { id: "music", kind: "audio", path: "raw/music.wav" } } }, {
      ...probes(items), music: { path: "raw/music.wav", fingerprint: "x", kind: "audio", duration: 10, audio: true },
    });
    expect(plan.audio).toEqual([{ item: audio, start: 15, duration: 60, renderStart: 15, renderEnd: 75, decodeStart: 15 }]);
  });

  it("refuses native audio trims that exceed the probed source duration", () => {
    const items = [video("v1", 0)];
    const audio: AudioItem = { id: "a1", assetId: "music", start: 15, duration: 60, sourceIn: 9, volume: 0.25 };
    const p = project(items, [{ id: "music", kind: "audio", items: [audio] } as unknown as Track]);
    expect(() => planLayeredExport({ ...p, assets: { ...p.assets, music: { id: "music", kind: "audio", path: "raw/music.wav" } } }, {
      ...probes(items), music: { path: "raw/music.wav", fingerprint: "x", kind: "audio", duration: 10, audio: true },
    })).toThrow("audio source range for a1 exceeds its probed duration");
  });

  it("keeps an existing output and removes staging files when native media preflight fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swr-layered-failure-"));
    try {
      mkdirSync(join(dir, "raw"));
      const source = join(dir, "raw/a_v1.mp4");
      writeFileSync(source, "not an encoded video");
      const outputDir = join(dir, "out");
      mkdirSync(outputDir);
      const output = join(outputDir, "final.mp4");
      writeFileSync(output, "previous output");
      const items = [video("v1", 0)];
      const p = project(items);
      const mediaProbe = { ...probes(items).a_v1, fingerprint: fingerprint(source)! };
      await expect(renderLayered({
        dir, output, preset: "master", project: p, probes: { a_v1: mediaProbe }, presetOptions: { crf: 18 },
        remotion: { composition: { durationInFrames: 90 }, inputProps: {} } as unknown as LayeredRenderArgs["remotion"],
      })).rejects.toThrow();
      expect(readFileSync(output, "utf8")).toBe("previous output");
      expect(readdirSync(outputDir)).toEqual(["final.mp4"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["multiple visible video tracks", (p: Project) => ({ ...p, tracks: [...p.tracks, { id: "video2", kind: "video", items: [video("v3", 0)] }] })],
    ["wipe transition", (p: Project) => ({ ...p, tracks: [{ ...p.tracks[0], items: [video("v1", 0, { kind: "wipe", duration: 30 }), video("v2", 90)] }] })],
    ["custom video look", (p: Project) => ({ ...p, tracks: [{ ...p.tracks[0], items: [{ ...p.tracks[0].items[0], grade: { exposure: 1 } }] }] })],
  ] as const)("refuses %s", (_name, mutate) => {
    const p = mutate(project()) as Project;
    expect(() => planLayeredExport(p, probes([video("v1", 0), video("v2", 90)]))).toThrow("layered export unsupported:");
  });
});
