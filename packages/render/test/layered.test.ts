import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "@splicewright/core/node";
import type { AudioItem, Project, Track, VideoItem } from "@splicewright/core";
import type { Probe } from "@splicewright/core/node";
import { audioTransitionFades, planLayeredExport } from "../src/layered.ts";
import { renderLayered, type LayeredRenderArgs } from "../src/layered-render.ts";

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

  it("merges adjacent caption windows while preserving anchored caption timing", () => {
    const items = [video("v1", 0), video("v2", 90)];
    const caption = { id: "c1", mode: "free", start: 10, duration: 20, text: "first" };
    const caption2 = { id: "c2", mode: "anchored", start: 0, duration: 1, itemId: "v2", sourceStart: 1, sourceEnd: 2, text: "second" };
    const p = project(items, [{ id: "captions", kind: "caption", items: [caption, caption2] } as unknown as Track]);
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
    expect(plan.audio).toEqual([{ item: audio, start: 15, duration: 60 }]);
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
