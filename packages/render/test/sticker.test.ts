import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { init, run } from "@splicewright/core/node";
import { ingest } from "@splicewright/ingest";
import { still } from "../src/node.ts";

const pixel = (png: string) => execFileSync("ffmpeg", ["-loglevel", "error", "-i", png, "-vf", "crop=1:1:8:8", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);

it("plays an animated Sticker from its item start, loops, and stops at its item end", { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-sticker-"));
  init(dir, { title: "sticker", fps: 30, width: 32, height: 18 });
  const gif = join(dir, "two-color.gif");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=32x18:r=10:d=0.5", "-f", "lavfi", "-i", "color=c=blue:s=32x18:r=10:d=0.5", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,split[v][p];[p]palettegen[pal];[v][pal]paletteuse", "-loop", "0", gif]);
  expect(run(dir, "importAsset", { path: "two-color.gif" })).not.toHaveProperty("error");
  expect((await ingest(dir, { only: [] })).errors).toBeUndefined();
  expect(run(dir, "insertItem", { component: "Sticker", props: { src: "two-color.gif", fit: "contain" }, at: 10, duration: 54 })).not.toHaveProperty("error");
  expect(run(dir, "insertItem", { component: "Text", props: { text: "later" }, at: 80, duration: 1 })).not.toHaveProperty("error"); // keep the composition alive past the Sticker's end

  const render = async (frame: number) => {
    const out = join(dir, `f${frame}.png`);
    await still(dir, frame, out);
    return [...pixel(out)];
  };
  const [first, next, wrapped, after] = await Promise.all([render(10), render(25), render(40), render(64)]);
  expect(first[0]).toBeGreaterThan(220); // red at item start
  expect(first[2]).toBeLessThan(40);
  expect(next[2]).toBeGreaterThan(220); // blue half of animation
  expect(next[0]).toBeLessThan(40);
  expect(wrapped[0]).toBeGreaterThan(220); // one-second GIF loop returns to red
  expect(wrapped[2]).toBeLessThan(40);
  expect(after).toEqual([0, 0, 0]); // item duration is 54f: frame 64 is outside it
});
