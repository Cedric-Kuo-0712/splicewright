import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createProject } from "@splicewright/core";
import { fingerprint } from "@splicewright/core/node";

// The fake browser draws what the project really shows at a frame: one colour per set of visible items,
// plus the frame itself while the keyframed item "m" is up, so only a correct run detection reproduces it.
const fake = vi.hoisted(() => ({ rendered: [] as number[], pngFor: ((_signature: string) => Buffer.alloc(0)) as (signature: string) => Buffer, shows: (_frame: number): string => "" }));
vi.mock("@remotion/renderer", () => ({ openBrowser: async () => ({ pages: async () => [], close: async () => {} }), renderFrames: async (options: any) => {
  for (const frame of options.frames as number[]) fake.rendered.push(frame);
  for (let index = 0; index < options.frames.length; index += options.concurrency)
    await Promise.all(options.frames.slice(index, index + options.concurrency).reverse().map((frame: number) => options.onFrameBuffer(fake.pngFor(fake.shows(frame)), frame)));
  options.onFrameUpdate(options.frames.length);
} }));
import { renderLayered, type LayeredRenderArgs } from "../src/layered-render.ts";

let available = false;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); available = true; } catch {}
const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", ...args], { timeout: 10000 });

it.skipIf(!available)("decodes to identical pixels with static-run deduplication on and off, rendering far fewer frames", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-dedup-native-"));
  const previous = process.env.SPLICEWRIGHT_GRAPHICS_DEDUP;
  try {
    mkdirSync(join(dir, "raw"));
    const source = join(dir, "raw/source.mp4");
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=32x32:r=30", "-frames:v", "60", "-c:v", "libx264", "-threads", "1", source]);
    const project = createProject({ title: "dedup", width: 32, height: 32, fps: 30 });
    project.assets = { a: { id: "a", kind: "video", path: "raw/source.mp4" } };
    const caption = (id: string, start: number, duration: number) => ({ id, component: "CaptionLayer", start, duration, props: { texts: [id], css: { backdropFilter: "none" } } });
    const moving = { id: "m", component: "Text", start: 40, duration: 12, props: { text: "m" }, keyframes: { opacity: [{ t: 0, v: 0 }, { t: 0.4, v: 1 }] } };
    project.tracks = [
      { id: "v", name: "Video", kind: "video", items: [{ id: "clip", assetId: "a", start: 0, duration: 60, sourceIn: 0 }] },
      { id: "g", name: "Graphics", kind: "overlay", items: [caption("s1", 0, 20), { ...caption("s2", 10, 30), component: "Text", props: { text: "s2" } }, moving, caption("s3", 55, 5)] },
    ] as typeof project.tracks;
    const items = project.tracks[1].items as { id: string; start: number; duration: number }[];
    fake.shows = frame => items.filter(item => frame >= item.start && frame < item.start + item.duration).map(item => item.id === "m" ? `m${frame}` : item.id).join("+");
    const colours = new Map<string, Buffer>();
    fake.pngFor = signature => {
      if (!colours.has(signature)) {
        const rgb = createHash("sha256").update(signature).digest("hex").slice(0, 6);
        colours.set(signature, ffmpeg(["-f", "lavfi", "-i", `color=c=0x${rgb}@0.5:s=32x32,format=rgba`, "-frames:v", "1", "-threads", "1", "-c:v", "png", "-f", "image2pipe", "-"]));
      }
      return colours.get(signature)!;
    };
    const probes = { a: { kind: "video" as const, path: "raw/source.mp4", fingerprint: fingerprint(source)!, width: 32, height: 32, fps: 30, duration: 2, audio: false } };
    const run = async (mode: "0" | "1", name: string) => {
      process.env.SPLICEWRIGHT_GRAPHICS_DEDUP = mode;
      fake.rendered = [];
      const progress: number[] = [];
      const output = join(dir, name);
      await renderLayered({ dir, output, preset: "h264-cpu", project, probes, presetOptions: { codec: "h264", crf: 18 }, onProgress: value => progress.push(value),
        remotion: { composition: { durationInFrames: 60 }, inputProps: { project } } as unknown as LayeredRenderArgs["remotion"] });
      const hash = createHash("sha256").update(ffmpeg(["-threads", "2", "-i", output, "-map", "0:v:0", "-pix_fmt", "rgb24", "-f", "hash", "-hash", "sha256", "-"])).digest("hex");
      return { hash, rendered: fake.rendered.length, progress };
    };
    const off = await run("0", "off.mp4"), on = await run("1", "on.mp4");
    expect(on.hash).toBe(off.hash);
    expect(off.rendered).toBe(52 + 5); // every active frame: 0..52 and 55..60
    expect(on.rendered).toBeLessThan(off.rendered / 2);
    for (const { progress } of [off, on]) expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.SPLICEWRIGHT_GRAPHICS_DEDUP; else process.env.SPLICEWRIGHT_GRAPHICS_DEDUP = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
