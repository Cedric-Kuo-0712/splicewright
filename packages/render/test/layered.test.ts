import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "@splicewright/core/node";
import { valueAt, VideoItem, type AudioItem, type Project, type Track } from "@splicewright/core";
import type { Probe } from "@splicewright/core/node";
import { audioTransitionFades, LayeredUnsupportedError, planLayeredExport, staticRuns } from "../src/layered.ts";
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

describe("stacked video tracks", () => {
  const stacked = (top: Partial<VideoItem> = {}, more: Track[] = []) => {
    const base = video("base", 0), pip = { ...video("pip", 30), assetId: "a_pip", duration: 60, ...top };
    const p = project([base], more);
    p.assets.a_pip = { id: "a_pip", kind: "video", path: "raw/a_pip.mp4" } as any;
    p.tracks.splice(1, 0, { id: "video2", name: "V2", kind: "video", items: [pip] } as any);
    return { p, probes: probes([base, pip]) };
  };
  it("lists segments from the bottom track to the top so later overlays sit above earlier ones", () => {
    const { p, probes: probe } = stacked();
    expect(planLayeredExport(p, probe).video.map((segment) => segment.item.id)).toEqual(["base", "pip"]);
  });
  it("places a scaled item by its centre offset, scaling x and y with the draft scale", () => {
    const { p, probes: probe } = stacked({ transform: { x: 10, y: -4, scale: 0.5, opacity: 0.5 } });
    expect(planLayeredExport(p, probe).video[1].place).toEqual({ width: 32, height: 18, x: 10, y: -4, opacity: 0.5 });
    expect(planLayeredExport(p, probe, 0, 90, 0.5).video[1].place).toEqual({ width: 16, height: 9, x: 5, y: -2, opacity: 0.5 });
    expect(planLayeredExport(p, probe).video[0].place).toBeUndefined();
  });
  it("turns keyed x and y into an expression that agrees with the preview's valueAt on every frame", () => {
    const keys = [{ t: 1, v: -40, ease: "ease" as const }, { t: 2, v: 20, ease: [0.42, 0, 0.58, 1] as [number, number, number, number] }, { t: 3, v: 60 }];
    const { p, probes: probe } = stacked({ keyframes: { x: keys, y: [{ t: 1, v: 10 }, { t: 3, v: -30 }] } } as Partial<VideoItem>);
    const item = p.tracks[1].items[0] as VideoItem, place = planLayeredExport(p, probe).video[1].place!;
    const clip = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
    const evaluate = (expression: string, frame: number) => new Function("clip", "t", `return ${expression}`)(clip, frame / 30) as number;
    let worst = 0;
    for (let frame = 30; frame < 90; frame++) {
      worst = Math.max(worst, Math.abs(evaluate(place.xExpr!, frame) - valueAt(p, item, "x", frame)!), Math.abs(evaluate(place.yExpr!, frame) - valueAt(p, item, "y", frame)!));
    }
    expect(worst).toBeLessThan(0.5);
    expect(planLayeredExport(p, probe, 0, 90, 0.5).video[1].place!.xExpr).not.toBe(place.xExpr);
  });
  it("accepts a static mask but refuses a keyframed one", () => {
    const mask = { shape: "ellipse" as const, x: 0.2, y: 0, w: 0.6, h: 1 };
    expect(planLayeredExport(...Object.values(stacked({ mask })) as [Project, Record<string, Probe>]).video[1].item.mask).toEqual(mask);
    expect(() => planLayeredExport(...Object.values(stacked({ mask, keyframes: { maskX: [{ t: 1, v: 0 }, { t: 2, v: 0.2 }] } } as Partial<VideoItem>)) as [Project, Record<string, Probe>])).toThrow(/unsupported video look/);
  });
  it("refuses rotation, keyframed transforms and graphics below the top video track", () => {
    expect(() => planLayeredExport(...Object.values(stacked({ transform: { rotation: 10 } })) as [Project, Record<string, Probe>])).toThrow(/unsupported video look/);
    expect(() => planLayeredExport(...Object.values(stacked({ keyframes: { opacity: [{ t: 0, v: 1 }] } } as Partial<VideoItem>)) as [Project, Record<string, Probe>])).toThrow(/unsupported video look/);
    const below = { id: "o", kind: "overlay", name: "O", items: [{ id: "t", start: 0, duration: 30, component: "Text", props: { text: "x" } }] } as unknown as Track;
    const { p, probes: probe } = stacked();
    p.tracks.splice(1, 0, below);
    expect(() => planLayeredExport(p, probe)).toThrow(/below the video track/);
  });
});

/**
 * Every VideoItem field must say what the layered route does with it. The planner refuses by naming fields, so a field added to the
 * schema later would otherwise be silently dropped from layered exports while the preview and the Remotion route still apply it.
 * `handled`: a sample value the layered route renders; `refused`: a sample value that makes it fall back to Remotion. A field may
 * have both (a transform without rotation is handled, with rotation it is refused). Both samples are checked against the planner.
 */
const LAYERED_FIELDS: Record<keyof VideoItem, { handled?: unknown; refused?: unknown }> = {
  id: { handled: "v1" }, start: { handled: 0 }, duration: { handled: 90 }, label: { handled: "x" }, note: { handled: "x" },
  assetId: { handled: "a_v1" }, sourceIn: { handled: 1 }, role: { handled: "x" },
  volume: { handled: 0.5 }, fit: { handled: "cover" }, fadeIn: { handled: 6 }, fadeOut: { handled: 6 },
  transform: { handled: { x: 5, y: -5, scale: 0.5, opacity: 0.5 }, refused: { rotation: 10 } },
  mask: { handled: { shape: "ellipse", x: 0.1, y: 0.1, w: 0.8, h: 0.8 } },
  keyframes: { handled: { x: [{ t: 1, v: 0 }, { t: 2, v: 5 }] }, refused: { opacity: [{ t: 1, v: 1 }] } },
  blend: { handled: "normal", refused: "multiply" },
  speed: { handled: 1, refused: 2 }, reverse: { handled: false, refused: true },
  transition: { refused: { kind: "wipe", duration: 6 } },
  audioFx: { refused: {} }, effects: { refused: {} }, grade: { refused: {} }, key: { refused: {} },
  crop: { refused: { left: 0.1 } }, lutKeyframes: { refused: [{ t: 0, assetId: "lut" }] },
};
describe("layered route covers every VideoItem field", () => {
  const plan = (patch: Record<string, unknown>) => {
    const items = [{ ...video("v1", 0), ...patch } as VideoItem, video("v2", 90)];
    return () => planLayeredExport(project(items), probes(items));
  };
  it("classifies each schema field, and nothing the schema no longer has", () => {
    expect(Object.keys(LAYERED_FIELDS).sort()).toEqual(Object.keys(VideoItem.shape).sort());
    for (const [field, entry] of Object.entries(LAYERED_FIELDS)) expect(entry.handled !== undefined || entry.refused !== undefined, field).toBe(true);
  });
  it.each(Object.entries(LAYERED_FIELDS).filter(([, entry]) => entry.handled !== undefined))("renders %s", (field, entry) => {
    expect(plan({ [field]: entry.handled })).not.toThrow();
  });
  it.each(Object.entries(LAYERED_FIELDS).filter(([, entry]) => entry.refused !== undefined))("falls back to Remotion for %s", (field, entry) => {
    expect(plan({ [field]: entry.refused })).toThrow(LayeredUnsupportedError);
  });
});

describe("static overlay runs", () => {
  const item = (id: string, start: number, duration: number, extra: Record<string, unknown> = {}) => ({ id, component: "Text", start, duration, props: { text: id }, ...extra });
  const runs = (items: unknown[], windows: [number, number][], kind = "overlay") =>
    [...staticRuns(project([video("v1", 0)], [{ id: "o", kind, items } as unknown as Track]), windows)];
  it.each([
    ["one still item is a single run", [item("a", 10, 30)], [[10, 40]], [[10, 30]]],
    ["a one-frame item is not listed", [item("a", 10, 1)], [[10, 11]], []],
    ["items changing the showing set split the run", [item("a", 0, 20), item("b", 10, 20)], [[0, 30]], [[0, 10], [10, 10], [20, 10]]],
    ["touching items are separate runs", [item("a", 0, 10), item("b", 10, 10)], [[0, 20]], [[0, 10], [10, 10]]],
    ["a window clips the run on both sides", [item("a", 0, 100)], [[20, 50]], [[20, 30]]],
    ["each window is its own run", [item("a", 0, 100)], [[10, 20], [30, 45]], [[10, 10], [30, 15]]],
    ["CaptionLayer is still", [item("a", 0, 5, { component: "CaptionLayer" })], [[0, 5]], [[0, 5]]],
    ["empty keyframes stay still", [item("a", 0, 5, { keyframes: {} })], [[0, 5]], [[0, 5]]],
    ["keyframes render every frame", [item("a", 0, 5, { keyframes: { opacity: [{ t: 0, v: 1 }] } })], [[0, 5]], []],
    ["Sticker renders every frame", [item("a", 0, 5, { component: "Sticker" })], [[0, 5]], []],
    ["Image renders every frame", [item("a", 0, 5, { component: "Image" })], [[0, 5]], []],
    ["a moving item makes only its own frames per-frame",
      [item("a", 0, 30), item("m", 10, 5, { keyframes: { x: [{ t: 0, v: 1 }] } })], [[0, 30]], [[0, 10], [15, 15]]],
  ] as [string, unknown[], [number, number][], number[][]][])("%s", (_name, items, windows, expected) => {
    expect(runs(items, windows)).toEqual(expected);
  });
  it("hidden tracks do not count", () => {
    const hidden = { id: "h", kind: "overlay", hidden: true, items: [item("m", 0, 5, { keyframes: { x: [{ t: 0, v: 1 }] } })] } as unknown as Track;
    const shown = { id: "o", kind: "overlay", items: [item("a", 0, 5)] } as unknown as Track;
    expect([...staticRuns(project([video("v1", 0)], [hidden, shown]), [[0, 5]])]).toEqual([[0, 5]]);
  });
});
