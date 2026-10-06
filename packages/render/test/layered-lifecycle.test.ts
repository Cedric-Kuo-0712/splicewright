import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "@splicewright/core/node";
import type { Project } from "@splicewright/core";
import { LayeredUnsupportedError } from "../src/layered.ts";
import { defaultGraphicsConcurrency,estimateGraphicsStagingBytes, LAYERED_GRAPHICS_STAGING_LIMIT_BYTES, renderLayered, type LayeredRenderArgs } from "../src/layered-render.ts";

const state = vi.hoisted(() => ({ fail: false, graphicsFail: false, graphicsFailAt: 0, graphicsFailAfterFrame: -1, reverse: false, commands: [] as string[][], graphics: [] as Record<string, any>[], written: [] as string[], probes: 0, probe: {} as Record<string, string>, browserOpens: 0, browserCloses: 0, onRender: undefined as ((options: Record<string, any>) => Promise<void>) | undefined }));
vi.mock("@remotion/renderer", () => ({
  openBrowser: async () => { state.browserOpens++; return { pages: async () => [], close: async () => { state.browserCloses++; } }; },
  renderFrames: async (options: Record<string, any>) => {
    state.graphics.push(options);
    expect(options.outputDir).toBeNull();
    const frames = options.frames as number[];
    await state.onRender?.(options);
    if (state.graphicsFail || state.graphicsFailAt === state.graphics.length) throw new Error("graphics producer failed");
    for (let index = 0; index < frames.length; index += options.concurrency) {
      const batch = frames.slice(index, index + options.concurrency);
      await Promise.all((state.reverse ? batch.reverse() : batch).map(frame => options.onFrameBuffer(Buffer.from(`png-${frame}`), frame)));
      if (batch.includes(state.graphicsFailAfterFrame)) throw new Error("graphics producer failed after frame delivery");
    }
    options.onFrameUpdate(frames.length);
    return {};
  },
}));
vi.mock("node:child_process", () => ({
  execFileSync: () => { state.probes++; return JSON.stringify({ streams: [{ pix_fmt: "yuv420p", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", sample_aspect_ratio: "1:1", ...state.probe }] }); },
  spawn: (_binary: string, args: string[]) => {
    state.commands.push(args);
    const child = new EventEmitter() as any;
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => child.stderr;
    child.stdin = new Writable({ write(chunk, _encoding, callback) { state.written.push(chunk.toString()); callback(); } });
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit("close", 1)); return true; });
    if (state.fail) queueMicrotask(() => child.emit("close", 1));
    else child.stdin.on("finish", () => { writeFileSync(args.at(-1)!, "new output"); child.emit("close", 0); });
    if (args.indexOf("pipe:0") < 0 && !state.fail) queueMicrotask(() => { writeFileSync(args.at(-1)!, "new output"); child.emit("close", 0); });
    return child;
  },
}));

// These cases assert frame-by-frame batching, ordering and cancellation on static captions; deduplication is covered in layered-dedup-native.test.ts.
process.env.SPLICEWRIGHT_GRAPHICS_DEDUP = "0";

let root: string | undefined;
afterEach(() => {
  state.onRender = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined; state.fail = false; state.graphicsFail = false; state.graphicsFailAt = 0; state.graphicsFailAfterFrame = -1; state.reverse = false; state.commands.length = 0; state.graphics.length = 0; state.written.length = 0; state.probes = 0; state.probe = {}; state.browserOpens = 0; state.browserCloses = 0;
});
function setup(): LayeredRenderArgs {
  root = mkdtempSync(join(tmpdir(), "swr-layered-lifecycle-"));
  mkdirSync(join(root, "raw")); writeFileSync(join(root, "raw/source.mp4"), "source fingerprint fixture");
  const output = join(root, "final.mp4"); writeFileSync(output, "previous output");
  const project: Project = {
    schemaVersion: 1, revision: 0, meta: { title: "lifecycle", fps: 30, width: 1280, height: 720 },
    assets: { a: { id: "a", kind: "video", path: "raw/source.mp4" } },
    tracks: [{ id: "v", name: "V1", kind: "video", items: [{ id: "clip", assetId: "a", start: 0, duration: 90, sourceIn: 2 }] },
      { id: "c", name: "Captions", kind: "overlay", items: [{ id: "caption", component: "CaptionLayer", start: 30, duration: 30, props: { texts: ["字幕"], css: { backdropFilter: "none" } } }] }], ids: {},
  };
  return { dir: root, output, preset: "h264-cpu", project,
    probes: { a: { path: "raw/source.mp4", fingerprint: fingerprint(join(root, "raw/source.mp4"))!, kind: "video", duration: 10, width: 1280, height: 720, fps: 30, audio: false } },
    presetOptions: { crf: 18, codec: "h264", hardwareAcceleration: "disable" },
    remotion: { composition: { durationInFrames: 90 }, inputProps: { project } } as unknown as LayeredRenderArgs["remotion"],
  };
}
describe("layered output lifecycle", () => {
  it("raises LayeredUnsupportedError before opening a browser or spawning ffmpeg", async () => {
    const args = setup();
    args.presetOptions = { codec: "h264", hardwareAcceleration: "required" };
    await expect(renderLayered(args)).rejects.toBeInstanceOf(LayeredUnsupportedError);
    expect(state.browserOpens).toBe(0);
    expect(state.commands).toHaveLength(0);
    expect(readFileSync(args.output, "utf8")).toBe("previous output");
  });
  it("renders each masked item's mask image once through Composition's maskOf mode and removes it afterwards", async () => {
    const args = setup();
    (args.project.tracks[0].items[0] as any).mask = { shape: "ellipse", x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    await renderLayered(args);
    const masks = state.graphics.filter(options => options.inputProps.maskOf);
    expect(masks).toHaveLength(1);
    expect(masks[0].inputProps.maskOf).toBe("clip");
    expect(masks[0].frames).toEqual([0]);
    expect(state.graphics.indexOf(masks[0])).toBe(0);
    expect(state.commands[0].join(" ")).toMatch(/-loop 1 -framerate 30 -t \S+ -i \S+\.masks-\S+\/0\.png/);
    expect(readdirSync(root!).filter(name => name.includes(".masks-"))).toEqual([]);
  });
  it("notifies every current-batch cancel listener and releases previous listeners", async () => {
    const args = setup(); const parentCallbacks: (() => void)[] = [];
    args.remotion.composition.durationInFrames = 700;
    args.project.tracks[0].items[0].duration = 700; args.probes.a.duration = 30;
    args.project.tracks[1].items[0].duration = 601; args.range = [0, 700];
    args.cancelSignal = callback => { parentCallbacks.push(callback); };
    const cancelled: number[][] = [];
    state.onRender = async options => {
      const seen = [0, 0]; cancelled.push(seen);
      options.cancelSignal(() => { seen[0]++; });
      options.cancelSignal(() => { seen[1]++; });
      if (cancelled.length === 2) parentCallbacks.at(-1)?.();
    };
    await expect(renderLayered(args)).rejects.toThrow("render cancelled");
    expect(cancelled).toEqual([[0, 0], [1, 1]]);
    expect(state.browserCloses).toBe(1);
    expect(readFileSync(args.output, "utf8")).toBe("previous output");
  });
  it("awaits batch page cleanup without closing a caller's existing page or browser", async () => {
    const args = setup(); const existing = { close: vi.fn() };
    const pages: any[] = [existing]; const closed: number[] = [];
    args.remotion.composition.durationInFrames = 700;
    args.project.tracks[0].items[0].duration = 700; args.probes.a.duration = 30;
    args.project.tracks[1].items[0].duration = 601; args.range = [0, 700];
    const browser = { pages: async () => [...pages], close: vi.fn() };
    args.remotion.puppeteerInstance = browser as any;
    state.onRender = async () => {
      expect(pages).toEqual([existing]);
      const index = closed.length;
      const page = { close: async () => { await new Promise<void>(resolve => setImmediate(resolve)); pages.splice(pages.indexOf(page), 1); closed.push(index); } };
      pages.push(page);
    };
    await renderLayered(args);
    expect(closed).toEqual([0, 1, 2]); expect(pages).toEqual([existing]);
    expect(existing.close).not.toHaveBeenCalled(); expect(browser.close).not.toHaveBeenCalled();
    expect(state.browserOpens).toBe(0);
  });
  it("composes lossless alpha frames at their actual start number and commits the output", async () => {
    const args = setup(); const result = await renderLayered(args);
    expect(result.pipelineUsed).toBe("layered");
    expect(state.graphics[0]).toMatchObject({ imageFormat: "png", muted: true, frames: Array.from({ length: 30 }, (_, i) => i + 30), inputProps: { graphicsOnly: true } });
    expect(state.graphics[0].composition.props.graphicsOnly).toBe(true);
    expect(state.commands[0]).toContain("image2pipe");
    expect(state.commands[0]).toContain("pipe:0");
    expect(state.commands[0].join(" ")).not.toContain("vp9");
    expect(readFileSync(args.output, "utf8")).toBe("new output");
    expect(readdirSync(root!).filter(name => name.includes("layered-"))).toEqual([]);
    expect(state.graphics[0].outputDir).toBeNull();
  });
  it("reorders concurrent PNG callbacks by global frame before writing to the single encoder", async () => {
    state.reverse = true;
    const args = setup();
    await renderLayered(args);
    expect(state.written).toHaveLength(90);
    expect(state.written.slice(30, 60)).toEqual(Array.from({ length: 30 }, (_, frame) => `png-${frame + 30}`));
  });
  it("preserves existing output and cleans both graphics and staging on encoder failure", async () => {
    state.fail = true; const args = setup();
    await expect(renderLayered(args)).rejects.toThrow(/ffmpeg exited/);
    expect(readFileSync(args.output, "utf8")).toBe("previous output");
    expect(readdirSync(root!).filter(name => name.includes("layered-"))).toEqual([]);
    expect(state.graphics).toHaveLength(0);
  });
  it("terminates the encoder and preserves output when the graphics producer fails", async () => {
    const args = setup(); state.graphicsFail = true;
    await expect(renderLayered(args)).rejects.toThrow("graphics producer failed");
    expect(readFileSync(args.output, "utf8")).toBe("previous output");
    expect(readdirSync(root!).filter(name => name.includes("layered-"))).toEqual([]);
    expect(state.browserCloses).toBe(1);
  });
  it("preserves output and closes the shared browser when a batch fails after frame delivery", async () => {
    const args = setup(); state.graphicsFailAfterFrame = 30;
    await expect(renderLayered(args)).rejects.toThrow("graphics producer failed after frame delivery");
    expect(readFileSync(args.output, "utf8")).toBe("previous output");
    expect(state.browserOpens).toBe(1); expect(state.browserCloses).toBe(1);
    expect(readdirSync(root!).filter(name => name.includes("layered-"))).toEqual([]);
  });
  it("preserves output when a later batch fails after earlier batches drained", async () => {
    const args = setup();
    args.remotion.composition.durationInFrames = 700;
    args.project.tracks[0].items[0].duration = 700; args.probes.a.duration = 30;
    args.project.tracks[1].items[0].duration = 601; args.range = [0, 700];
    state.graphicsFailAt = 2;
    await expect(renderLayered(args)).rejects.toThrow("graphics producer failed");
    expect(state.graphics.map(call => call.frames.length)).toEqual([300, 300]);
    expect(readFileSync(args.output, "utf8")).toBe("previous output");
    expect(state.browserOpens).toBe(1); expect(state.browserCloses).toBe(1);
  });
  it("derives the default graphics concurrency from machine size and the queue limit", () => {
    const GiB = 1024 ** 3, frame = (w: number, h: number) => estimateGraphicsStagingBytes(w, h, 1);
    expect(defaultGraphicsConcurrency(frame(1920, 1080), 10, 16 * GiB)).toBe(4);
    expect(defaultGraphicsConcurrency(frame(1920, 1080), 4, 16 * GiB)).toBe(2);
    expect(defaultGraphicsConcurrency(frame(1920, 1080), 10, 8 * GiB)).toBe(2);
    expect(defaultGraphicsConcurrency(frame(1920, 1080), 2, 2 * GiB)).toBe(1);
    // 5K admitted the old default of 2 but not 4; 8K never fits and is left to the admission check.
    expect(defaultGraphicsConcurrency(frame(5120, 2880), 10, 16 * GiB)).toBe(2);
    expect(defaultGraphicsConcurrency(frame(7680, 4320), 10, 16 * GiB)).toBe(2);
  });
  it("uses the derived default when the caller sets no concurrency", async () => {
    const args = setup();
    await renderLayered(args);
    expect(state.graphics[0].concurrency).toBe(defaultGraphicsConcurrency(estimateGraphicsStagingBytes(1280, 720, 1)));
  });
  it("schedules sparse caption windows once without renumbering their FFmpeg inputs", async () => {
    const args = setup();
    args.project.tracks[1].items.push({ id: "later", component: "CaptionLayer", start: 70, duration: 5, props: { texts: ["第二段"], css: { backdropFilter: "none" } } } as any);
    args.resources = { graphicsScheduling: "grouped", concurrency: 3, filterThreads: 4, encoderThreads: 2 };
    await renderLayered(args);
    expect(state.graphics).toHaveLength(1);
    expect(state.graphics[0].frameRange).toBeUndefined();
    expect(state.graphics[0].frames).toEqual([...Array.from({ length: 30 }, (_, i) => i + 30), 70, 71, 72, 73, 74]);
    expect(state.graphics[0].concurrency).toBe(3);
    const command = state.commands[0];
    expect(command).toContain("image2pipe");
    expect(command.filter((_, i) => command[i - 1] === "-filter_complex_threads")).toEqual(["4"]);
    // Decoder budgets stay at two; only the final software encoder changes.
    expect(command.filter((_, i) => command[i - 1] === "-threads")).toEqual(["2", "2", "2"]);
    expect(state.browserOpens).toBe(1); expect(state.browserCloses).toBe(1);
  });
  it("renders more than one bounded batch with one shared browser and monotonic progress", async () => {
    const args = setup();
    args.remotion.composition.durationInFrames = 700;
    args.project.tracks[0].items[0].duration = 700;
    args.probes.a.duration = 30;
    args.project.tracks[1].items[0].duration = 601;
    args.range = [0, 700];
    const progress: number[] = []; args.onProgress = value => progress.push(value);
    await renderLayered(args);
    expect(state.graphics.map(call => call.frames.length)).toEqual([300, 300, 1]);
    expect(state.graphics.flatMap(call => call.frames)).toEqual(Array.from({ length: 601 }, (_, i) => i + 30));
    expect(new Set(state.graphics.map(call => call.puppeteerInstance)).size).toBe(1);
    expect(state.browserOpens).toBe(1); expect(state.browserCloses).toBe(1);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true);
  });
  it("keeps serial windows in separate render calls", async () => {
    const serial = setup();
    serial.project.tracks[1].items[0].duration = 5;
    serial.project.tracks[1].items.push({ id: "later", component: "CaptionLayer", start: 70, duration: 5, props: { texts: ["later"], css: { backdropFilter: "none" } } } as any);
    await renderLayered(serial);
    expect(state.graphics.map(call => call.frames)).toEqual([[30, 31, 32, 33, 34], [70, 71, 72, 73, 74]]);
  });
  it("groups sparse windows into the same bounded batch when requested", async () => {
    const grouped = setup();
    grouped.project.tracks[1].items[0].duration = 5;
    grouped.project.tracks[1].items.push({ id: "later", component: "CaptionLayer", start: 70, duration: 5, props: { texts: ["later"], css: { backdropFilter: "none" } } } as any);
    grouped.resources = { graphicsScheduling: "grouped" };
    await renderLayered(grouped);
    expect(state.graphics.map(call => call.frames)).toEqual([[30, 31, 32, 33, 34, 70, 71, 72, 73, 74]]);
  });
  it("seeks native video to the requested range and keeps the output timeline range local", async () => {
    const args = setup(); args.range = [30, 50];
    await renderLayered(args);
    expect(state.graphics[0].frames).toEqual(Array.from({ length: 20 }, (_, i) => 30 + i));
    const command = state.commands[0];
    expect(command[command.indexOf("-ss") + 1]).toBe("3.000000000");
    expect(command.join(" ")).toContain("trim=duration=0.666666667");
    expect(command.join(" ")).not.toContain("trim=start=1.000000000");
    expect(command.join(" ")).toContain("setpts=PTS+0.000000000/TB");
    expect(command).toContain("-t");
    expect(command[command.indexOf("-t") + 1]).toBe("0.666666667");
  });
  it("refuses live graphics working sets beyond the fixed memory estimate before rendering", async () => {
    expect(estimateGraphicsStagingBytes(1280, 720, 30)).toBeLessThan(LAYERED_GRAPHICS_STAGING_LIMIT_BYTES);
    expect(estimateGraphicsStagingBytes(1920, 1080, 2)).toBeLessThan(LAYERED_GRAPHICS_STAGING_LIMIT_BYTES);
    expect(estimateGraphicsStagingBytes(20000, 20000, 3)).toBeGreaterThan(LAYERED_GRAPHICS_STAGING_LIMIT_BYTES);
    const args = setup(); args.project.meta.width = 30000; args.project.meta.height = 30000;
    await expect(renderLayered(args)).rejects.toThrow(/estimated live graphics working set .* exceeds .*byte limit/);
    expect(state.graphics).toHaveLength(0); expect(state.commands).toHaveLength(0);
    expect(readFileSync(args.output, "utf8")).toBe("previous output");
  });
  it("sets the software encoder budget separately from filter and decoder budgets", async () => {
    const args = setup(); args.resources = { encoderThreads: 4 };
    args.presetOptions.codec = "h265";
    await renderLayered(args);
    const command = state.commands[0];
    expect(command.filter((_, i) => command[i - 1] === "-threads")).toEqual(["2", "2", "4"]);
    expect(command[command.indexOf("-filter_complex_threads") + 1]).toBe("2");
    expect(command[command.indexOf("-x265-params") + 1]).toBe("pools=4:frame-threads=4");
  });
  it("probes a canonical source path once per render even when several clips use it", async () => {
    const args = setup();
    args.project.tracks[0].items = [
      { id: "first", assetId: "a", start: 0, duration: 30, sourceIn: 0 },
      { id: "second", assetId: "a", start: 30, duration: 30, sourceIn: 1 },
    ] as typeof args.project.tracks[0]["items"];
    args.range = [0, 60];
    await renderLayered(args);
    expect(state.probes).toBe(1);
  });
  it.each([0, 5, 1.5, NaN])("refuses unsafe thread count %s before rendering or replacing output", async count => {
    const args = setup(); args.resources = { filterThreads: count };
    await expect(renderLayered(args)).rejects.toThrow(/integer from 1 to 4/);
    expect(state.graphics).toHaveLength(0); expect(state.commands).toHaveLength(0);
    expect(readFileSync(args.output, "utf8")).toBe("previous output");
  });
  it("honors cancellation between graphics and encoding without replacing the existing output", async () => {
    const args = setup(); const callbacks: (() => void)[] = [];
    args.cancelSignal = callback => { callbacks.push(callback); };
    args.onEncoding = () => callbacks.forEach(callback => callback());
    await expect(renderLayered(args)).rejects.toThrow("render cancelled");
    expect(state.commands).toHaveLength(0);
    expect(readFileSync(args.output, "utf8")).toBe("previous output");
    expect(state.graphics).toHaveLength(0);
  });
  it("cancels after a drained graphics batch and preserves the existing output", async () => {
    const args = setup(); const callbacks: (() => void)[] = [];
    args.remotion.composition.durationInFrames = 700;
    args.project.tracks[0].items[0].duration = 700; args.probes.a.duration = 30;
    args.project.tracks[1].items[0].duration = 601; args.range = [0, 700];
    args.cancelSignal = callback => { callbacks.push(callback); };
    args.onProgress = value => { if (value > 0.35) callbacks.at(-1)?.(); };
    await expect(renderLayered(args)).rejects.toThrow("render cancelled");
    expect(state.graphics.map(call => call.frames.length)).toEqual([300]);
    expect(state.browserOpens).toBe(1); expect(state.browserCloses).toBe(1);
    expect(readFileSync(args.output, "utf8")).toBe("previous output");
  });
  it("accepts 10-bit SDR sources but refuses deeper bit depths and HDR colour tags", async () => {
    for (const probe of [{ pix_fmt: "yuv420p10le" }, { pix_fmt: "yuv422p10le" }, { pix_fmt: "p010le" }]) {
      state.probe = probe; await renderLayered(setup());
    }
    for (const [probe, reason] of [[{ pix_fmt: "yuv420p12le" }, /high bit depth/], [{ pix_fmt: "yuv420p10le", color_transfer: "smpte2084", color_primaries: "bt2020", color_space: "bt2020nc" }, /color space bt2020nc/]] as const) {
      state.probe = probe; await expect(renderLayered(setup())).rejects.toThrow(reason);
    }
  });
});
