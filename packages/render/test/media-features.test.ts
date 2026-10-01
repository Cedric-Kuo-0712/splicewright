import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { init, load, run } from "@splicewright/core/node";
import { audioFxPath, ingest, reverseAudioPath } from "@splicewright/ingest";
import { render, reverseProxiesOf, still } from "../src/node.ts";

const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args]);
const pixel = (file: string, frame: number, x: number, y: number) => ffmpeg(["-i", file, "-vf", `select=eq(n\\,${frame}),format=rgb24,crop=1:1:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);

it("renders stickers and custom fonts with reversed processed audio, refusing missing and stale artifacts", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-all-media-"));
  try {
    init(dir, { title: "all media", fps: 30, width: 64, height: 36 });
    mkdirSync(join(dir, "raw"));
    const source = join(dir, "raw/source.mp4");
    ffmpeg(["-f", "lavfi", "-i", "color=black:s=64x36:r=30:d=1,format=gbrp,geq=r='N*7':g='0':b='0'", "-f", "lavfi", "-i", "aevalsrc=(0.1+0.4*t)*sin(2*PI*440*t)|(0.1+0.4*t)*sin(2*PI*440*t):s=48000:d=1:c=stereo", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
    ffmpeg(["-f", "lavfi", "-i", "color=red:s=32x18:r=10:d=0.5", "-f", "lavfi", "-i", "color=blue:s=32x18:r=10:d=0.5", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,split[v][p];[p]palettegen[pal];[v][pal]paletteuse", "-loop", "0", join(dir, "raw/sticker.gif")]);
    copyFileSync(join(import.meta.dirname, "../../../node_modules/@fontsource/anton/files/anton-latin-400-normal.woff2"), join(dir, "raw/brand.woff2"));
    for (const path of ["raw/source.mp4", "raw/sticker.gif", "raw/brand.woff2"])
      expect(run(dir, "importAsset", { path })).not.toHaveProperty("error");
    expect(run(dir, "insertItem", { assetId: "a_source", at: 0, duration: 30 })).not.toHaveProperty("error");
    expect(run(dir, "setProps", { itemId: "i_1", patch: { reverse: true, audioFx: { pan: -1 } } })).not.toHaveProperty("error");
    expect(run(dir, "insertItem", { component: "Sticker", props: { src: "raw/sticker.gif" }, at: 0, duration: 30 })).not.toHaveProperty("error");
    expect(run(dir, "setProps", { itemId: "i_2", patch: { mask: { shape: "rect", x: 0.75, y: 0.75, w: 0.25, h: 0.25 } } })).not.toHaveProperty("error");
    expect(run(dir, "insertItem", { component: "Text", props: { text: "BRAND", textStyle: { font: "a_brand", size: 8, weight: 400 } }, at: 0, duration: 30 })).not.toHaveProperty("error");
    expect((await ingest(dir, { only: ["reverse", "audioFx"] })).errors).toBeUndefined();
    const baked = audioFxPath(dir, "a_source", "raw/source.mp4", { pan: -1 });
    rmSync(join(dir, reverseAudioPath(baked)));
    const output = join(dir, "out/combined.mp4");
    await expect(render(dir, { output, preset: "draft" })).rejects.toThrow("reversed audioFx artifact");
    expect((await ingest(dir, { only: ["audioFx"] })).errors).toBeUndefined();
    await render(dir, { output, preset: "draft" });
    for (const frame of [0, 20]) {
      const actual = pixel(output, frame, 2, 2), expected = pixel(source, 29 - frame, 4, 4);
      expect(actual.length).toBe(3);
      expect(Math.max(...actual.map((value, i) => Math.abs(value - expected[i])))).toBeLessThan(8);
    }
    expect(pixel(output, 0, 28, 16)[0]).toBeGreaterThan(220);
    expect(pixel(output, 20, 28, 16)[2]).toBeGreaterThan(220);
    const raw = ffmpeg(["-i", output, "-vn", "-ar", "48000", "-ac", "2", "-f", "f32le", "pipe:1"]);
    const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    const rms = (channel: number, from: number, to: number) => {
      let sum = 0, count = 0;
      for (let i = Math.round(from * 48000); i < Math.round(to * 48000); i++) { sum += samples[2 * i + channel] ** 2; count++; }
      return Math.sqrt(sum / count);
    };
    expect(rms(1, 0.15, 0.85)).toBeLessThan(0.0003);
    expect(rms(0, 0.15, 0.3)).toBeGreaterThan(1.5 * rms(0, 0.7, 0.85));
    appendFileSync(source, Buffer.from([0]));
    expect(reverseProxiesOf(dir, load(dir))).toEqual([]);
    await expect(still(dir, 0, null)).rejects.toThrow("reverse proxy missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
