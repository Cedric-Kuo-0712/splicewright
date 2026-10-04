import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createProject } from "@splicewright/core";
import { fingerprint } from "@splicewright/core/node";

vi.mock("@remotion/bundler", () => ({ bundle: () => { throw new Error("pure-cut export must not bundle"); } }));
vi.mock("@remotion/renderer", () => ({
  makeCancelSignal: vi.fn(), renderMedia: vi.fn(), renderStill: vi.fn(),
  selectComposition: () => { throw new Error("pure-cut export must not select a composition"); },
  renderFrames: () => { throw new Error("pure-cut export must not render graphics"); },
}));
import { render } from "../src/node.ts";

let available = false;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); available = true; } catch {}

it.skipIf(!available)("exports an actual pure-cut frame range without Remotion, ignoring unrelated reverse/LUT dependencies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-native-range-"));
  try {
    mkdirSync(join(dir, "raw")); mkdirSync(join(dir, ".splicewright"));
    const input = join(dir, "raw/clip.mp4"), output = join(dir, "out.mp4");
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=32x32:r=30", "-frames:v", "12", "-c:v", "libx264", "-threads", "1", input], { timeout: 10000 });
    const project = createProject({ title: "native", width: 32, height: 32, fps: 30 });
    project.assets = { clip: { id: "clip", kind: "video", path: "raw/clip.mp4" }, bad: { id: "bad", kind: "lut", path: "missing.cube" } };
    project.tracks = [{ id: "video", name: "Video", kind: "video", items: [
      { id: "active", assetId: "clip", start: 0, duration: 6, sourceIn: 0 },
      { id: "unrelated", assetId: "clip", start: 50_000, duration: 6, sourceIn: 0, reverse: true, grade: { lut: { assetId: "bad", strength: 1 } } },
    ] }];
    writeFileSync(join(dir, "project.json"), JSON.stringify(project));
    writeFileSync(join(dir, ".splicewright/assets.json"), JSON.stringify({ clip: { path: "raw/clip.mp4", fingerprint: fingerprint(input), kind: "video", width: 32, height: 32, fps: 30, duration: 0.4, audio: false } }));
    const result = await render(dir, { pipeline: "layered", preset: "h264-cpu", range: [2, 6], output });
    expect(result).toMatchObject({ pipelineUsed: "layered", frames: 4 });
    const metadata = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames,width,height", "-of", "json", output], { encoding: "utf8", timeout: 10000 }));
    expect(metadata.streams[0]).toMatchObject({ nb_frames: "4", width: 32, height: 32 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
