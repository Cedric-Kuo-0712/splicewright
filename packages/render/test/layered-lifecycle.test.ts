import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "@splicewright/core/node";
import type { Project } from "@splicewright/core";
import { renderLayered, type LayeredRenderArgs } from "../src/layered-render.ts";

const state = vi.hoisted(() => ({ fail: false, commands: [] as string[][], graphics: [] as Record<string, any>[] }));
vi.mock("@remotion/renderer", () => ({
  renderFrames: async (options: Record<string, any>) => {
    state.graphics.push(options);
    mkdirSync(options.outputDir, { recursive: true });
    writeFileSync(join(options.outputDir, "frame-030.png"), "stub frame");
    options.onFrameUpdate(1);
    return { assetsInfo: { imageSequenceName: join(options.outputDir, "frame-%03d.png"), firstFrameIndex: 30 } };
  },
}));
vi.mock("node:child_process", () => ({
  execFileSync: () => JSON.stringify({ streams: [{ pix_fmt: "yuv420p", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", sample_aspect_ratio: "1:1" }] }),
  spawn: (_binary: string, args: string[]) => {
    state.commands.push(args);
    const child = new EventEmitter() as any;
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => child.stderr;
    child.kill = vi.fn();
    queueMicrotask(() => { writeFileSync(args.at(-1)!, "new output"); child.emit("close", state.fail ? 1 : 0); });
    return child;
  },
}));

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined; state.fail = false; state.commands.length = 0; state.graphics.length = 0;
});
function setup(): LayeredRenderArgs {
  root = mkdtempSync(join(tmpdir(), "swr-layered-lifecycle-"));
  mkdirSync(join(root, "raw")); writeFileSync(join(root, "raw/source.mp4"), "source fingerprint fixture");
  const output = join(root, "final.mp4"); writeFileSync(output, "previous output");
  const project: Project = {
    schemaVersion: 1, revision: 0, meta: { title: "lifecycle", fps: 30, width: 1280, height: 720 },
    assets: { a: { id: "a", kind: "video", path: "raw/source.mp4" } },
    tracks: [{ id: "v", name: "V1", kind: "video", items: [{ id: "clip", assetId: "a", start: 0, duration: 90, sourceIn: 2 }] },
      { id: "c", name: "Captions", kind: "caption", items: [{ id: "caption", mode: "free", start: 30, duration: 30, text: "字幕" }] }], ids: {},
  };
  return { dir: root, output, preset: "h264-cpu", project,
    probes: { a: { path: "raw/source.mp4", fingerprint: fingerprint(join(root, "raw/source.mp4"))!, kind: "video", duration: 10, width: 1280, height: 720, fps: 30, audio: false } },
    presetOptions: { crf: 18, codec: "h264", hardwareAcceleration: "disable" },
    remotion: { composition: { durationInFrames: 90 }, inputProps: { project } } as unknown as LayeredRenderArgs["remotion"],
  };
}
describe("layered output lifecycle", () => {
  it("composes lossless alpha frames at their actual start number and commits the output", async () => {
    const args = setup(); const result = await renderLayered(args);
    expect(result.pipelineUsed).toBe("layered");
    expect(state.graphics[0]).toMatchObject({ imageFormat: "png", muted: true, frameRange: [30, 59], inputProps: { graphicsOnly: true } });
    expect(state.graphics[0].composition.props.graphicsOnly).toBe(true);
    expect(state.commands[0]).toContain("-start_number");
    expect(state.commands[0][state.commands[0].indexOf("-start_number") + 1]).toBe("30");
    expect(state.commands[0].join(" ")).not.toContain("vp9");
    expect(readFileSync(args.output, "utf8")).toBe("new output");
    expect(readdirSync(root!).filter(name => name.includes("layered-"))).toEqual([]);
    expect(() => readFileSync(join(state.graphics[0].outputDir, "frame-030.png"))).toThrow();
  });
  it("preserves existing output and cleans both graphics and staging on encoder failure", async () => {
    state.fail = true; const args = setup();
    await expect(renderLayered(args)).rejects.toThrow(/ffmpeg exited/);
    expect(readFileSync(args.output, "utf8")).toBe("previous output");
    expect(readdirSync(root!).filter(name => name.includes("layered-"))).toEqual([]);
    expect(() => readFileSync(join(state.graphics[0].outputDir, "frame-030.png"))).toThrow();
  });
  it("honors cancellation between graphics and encoding without replacing the existing output", async () => {
    const args = setup(); const callbacks: (() => void)[] = [];
    args.cancelSignal = callback => { callbacks.push(callback); };
    args.onEncoding = () => callbacks.forEach(callback => callback());
    await expect(renderLayered(args)).rejects.toThrow("render cancelled");
    expect(state.commands).toHaveLength(0);
    expect(readFileSync(args.output, "utf8")).toBe("previous output");
    expect(() => readFileSync(join(state.graphics[0].outputDir, "frame-030.png"))).toThrow();
  });
});
