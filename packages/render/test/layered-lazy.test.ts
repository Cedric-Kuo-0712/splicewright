import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@splicewright/core";

const state = vi.hoisted(() => ({ project: undefined as Project | undefined, probes: {} as Record<string, any>, bundle: vi.fn(), select: vi.fn(), layered: vi.fn() }));
// bundleProject forks bundle-child.ts; stand in for the child and count its bundle requests.
vi.mock("node:child_process", async (orig) => {
  const { EventEmitter } = await import("node:events");
  return {
    ...(await orig<typeof import("node:child_process")>()),
    fork: () => {
      const child = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(), kill: vi.fn(),
        send: (msg: unknown) => { Promise.resolve(state.bundle(msg)).then((serveUrl) => child.emit("message", { serveUrl })); },
      });
      return child;
    },
  };
});
vi.mock("@remotion/renderer", () => ({ makeCancelSignal: vi.fn(), renderMedia: vi.fn(), renderStill: vi.fn(), selectComposition: state.select }));
vi.mock("@splicewright/core/node", () => ({
  fingerprint: () => "fingerprint", load: () => state.project, loadCtx: () => ({}), readAssets: () => state.probes, sizesOf: () => ({}),
}));
vi.mock("@splicewright/ingest", () => ({ audioFxPath: vi.fn(), ffmpeg: vi.fn(), grid: vi.fn(), measureFinalMix: vi.fn(), reverseAudioPath: vi.fn(), scratch: vi.fn(), spread: vi.fn() }));
vi.mock("../src/layered-render.ts", () => ({ renderLayered: state.layered, setExportMemoryPhase: vi.fn(), validateLayeredMedia: vi.fn(), estimateGraphicsStagingBytes: () => 0, LAYERED_GRAPHICS_QUEUE_LIMIT_BYTES: 2 * 1024 * 1024 * 1024, LAYERED_GRAPHICS_STAGING_LIMIT_BYTES: 4 * 1024 * 1024 * 1024 }));

import { render } from "../src/node.ts";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; vi.clearAllMocks(); });

describe("layered render preparation", () => {
  it("sends a graphics-free range to FFmpeg without bundling or selecting a Remotion composition", async () => {
    root = mkdtempSync(join(tmpdir(), "swr-layered-lazy-"));
    state.project = {
      schemaVersion: 1, revision: 0, meta: { title: "cuts", fps: 30, width: 1280, height: 720 },
      assets: { clip: { id: "clip", kind: "video", path: "clip.mp4" } },
      tracks: [{ id: "video", name: "V1", kind: "video", items: [{ id: "v", assetId: "clip", start: 0, duration: 90, sourceIn: 0 }] }], ids: {},
    } as Project;
    state.probes = { clip: { path: "clip.mp4", fingerprint: "fingerprint", kind: "video", width: 1280, height: 720, duration: 5, audio: false } };
    state.bundle.mockResolvedValue("bundle-url");
    state.layered.mockResolvedValue({ pipelineUsed: "layered" });

    await expect(render(root, { output: join(root, "out.mp4"), pipeline: "layered", preset: "h264-cpu" })).resolves.toMatchObject({ pipelineUsed: "layered" });
    expect(state.bundle).not.toHaveBeenCalled();
    expect(state.select).not.toHaveBeenCalled();
    expect(state.layered).toHaveBeenCalledWith(expect.objectContaining({ remotion: expect.objectContaining({ inputProps: {} }) }));
  });

  it("prepares only active graphics while retaining their original global timing", async () => {
    root = mkdtempSync(join(tmpdir(), "swr-layered-graphics-range-"));
    state.project = {
      schemaVersion: 1, revision: 0, meta: { title: "graphics", fps: 30, width: 1280, height: 720 },
      assets: { clip: { id: "clip", kind: "video", path: "clip.mp4" } },
      tracks: [
        { id: "video", name: "V1", kind: "video", items: [{ id: "v", assetId: "clip", start: 0, duration: 90, sourceIn: 0 }] },
        { id: "overlay", name: "Overlay", kind: "overlay", items: [
          { id: "active", component: "Text", start: 30, duration: 20, props: { text: "global", textStyle: { font: "used_font" } } },
          { id: "unrelated", component: "Unknown", start: 50_000, duration: 20, props: {} },
        ] },
      ], ids: {},
    } as Project;
    Object.assign(state.project.assets, {
      used_font: { id: "used_font", kind: "font", path: "used.woff2" },
      unused_font: { id: "unused_font", kind: "font", path: "unused.woff2" },
      picture: { id: "picture", kind: "image", path: "picture.png" },
    });
    state.probes = { clip: { path: "clip.mp4", fingerprint: "fingerprint", kind: "video", width: 1280, height: 720, duration: 5, audio: false } };
    state.select.mockResolvedValue({ durationInFrames: 90, width: 1280, height: 720, fps: 30, props: {} });
    state.layered.mockResolvedValue({ pipelineUsed: "layered" });

    await render(root, { output: join(root, "out.mp4"), pipeline: "layered", preset: "h264-cpu", range: [35, 45] });
    expect(state.bundle).toHaveBeenCalledOnce();
    expect(state.select).toHaveBeenCalledOnce();
    const call = state.layered.mock.calls[0][0];
    expect(call.remotion.inputProps.project.tracks[1].items).toEqual([
      expect.objectContaining({ id: "active", start: 30, duration: 20 }),
    ]);
    expect(call.range).toEqual([35, 45]);
    expect(call.remotion.inputProps.project.assets).toHaveProperty("clip");
    expect(call.remotion.inputProps.project.assets).toHaveProperty("picture");
    expect(call.remotion.inputProps.project.assets).toHaveProperty("used_font");
    expect(call.remotion.inputProps.project.assets).not.toHaveProperty("unused_font");
  });
});
