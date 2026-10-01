import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { init, run } from "@splicewright/core/node";
import { ingest } from "@splicewright/ingest";
import type { Project, VideoItem } from "@splicewright/core";
import { reverseTrimBefore } from "../src/Composition.tsx";
import { still } from "../src/node.ts";

const project = { meta: { fps: 1 } } as Project;

it("maps forward source selections and trimmed reverse items into the reversed proxy", () => {
  const full = { id: "i_1", start: 30, duration: 4, sourceIn: 5, reverse: true } as VideoItem;
  expect(reverseTrimBefore(project, full, 22, 30)).toBe(13); // source frames 5..8 begin at reversed frame 13
  expect(reverseTrimBefore(project, full, 22, 31)).toBe(14);

  const startTrimmed = { ...full, start: 32, duration: 2 };
  expect(reverseTrimBefore(project, startTrimmed, 22, 32)).toBe(15); // forward frames 5..6 remain
  const endTrimmed = { ...full, duration: 2, sourceIn: 7 };
  expect(reverseTrimBefore(project, endTrimmed, 22, 30)).toBe(13); // forward frames 7..8 remain

  const project24 = { meta: { fps: 24 } } as Project;
  const source30 = { id: "i_1", start: 0, duration: 96, sourceIn: 5, reverse: true } as VideoItem;
  expect(reverseTrimBefore(project24, source30, 22, 0, 30)).toBe(312);
  expect(reverseTrimBefore(project24, source30, 22, 30, 30)).toBe(342); // 30 project frames later, converted to composition frames
});

it("renders a trimmed reverse selection from its forward-source range and refuses a missing proxy", { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-reverse-render-"));
  init(dir, { title: "reverse", fps: 24, width: 320, height: 180 });
  const source = join(dir, "numbered.mkv");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=black:s=320x180:r=24:d=22,format=rgb24,geq=r='mod(N*47,256)':g='mod(N*89,256)':b='mod(N*151,256)'", "-frames:v", "528", "-c:v", "ffv1", source]);
  expect(run(dir, "importAsset", { path: "numbered.mkv" })).not.toHaveProperty("error");
  expect(run(dir, "insertItem", { assetId: "a_numbered", at: 0, sourceIn: 5, duration: 96 })).not.toHaveProperty("error");
  expect(run(dir, "setProps", { itemId: "i_1", patch: { reverse: true } })).not.toHaveProperty("error");
  await expect(still(dir, 0, null)).rejects.toThrow("reverse proxy missing");
  const generated = await ingest(dir, { only: ["reverse"] });
  expect(generated.errors).toBeUndefined();
  const proxy = join(dir, ".splicewright/proxies/reverse/a_numbered.mp4");
  expect(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", proxy], { encoding: "utf8" }).trim()).toBe("h264");
  const pixel = (buffer: Buffer) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", "crop=1:1:160:90,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { input: buffer });
  for (const [timelineFrame, sourceFrame] of [[0, 215], [1, 214]]) {
    const renderedPath = join(dir, `reverse-${timelineFrame}.png`);
    await still(dir, timelineFrame, renderedPath);
    const actual = pixel(readFileSync(renderedPath));
    const expected = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", source, "-vf", `select=eq(n\\,${sourceFrame}),crop=1:1:160:90,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    expect(actual).toHaveLength(3);
    for (let channel = 0; channel < 3; channel++) expect(Math.abs(actual[channel] - expected[channel]), `frame ${timelineFrame}, channel ${channel}`).toBeLessThan(28);
  }
});
