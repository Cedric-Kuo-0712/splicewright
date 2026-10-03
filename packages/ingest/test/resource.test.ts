import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpeg } from "../src/index.ts";
import { ffmpegThreadCount, withFfmpegResourceLimits } from "../src/resource.ts";

describe("FFmpeg resource budget", () => {
  it.each([[1, 1], [2, 2], [4, 2], [8, 4], [10, 4], [64, 4]])("selects %i thread(s) on a %i-core host", (cores, expected) => {
    expect(ffmpegThreadCount(cores, null)).toBe(expected);
  });

  it("accepts an explicit tuning override and rejects malformed values", () => {
    expect(ffmpegThreadCount(10, "3")).toBe(3);
    for (const value of ["0", "33", "1.5", "auto", ""]) expect(() => ffmpegThreadCount(10, value)).toThrow(/SPLICEWRIGHT_FFMPEG_THREADS/);
    expect(() => ffmpegThreadCount(0, null)).toThrow(/CPU count/);
  });

  it("places decode options before each input, filter pools globally, and encode options before output", () => {
    const args = withFfmpegResourceLimits(["-ss", "1", "-i", "first.mp4", "-i", "second.mp4", "-filter_complex", "[0:v][1:v]overlay", "out.mp4"], 3);
    expect(args).toEqual([
      "-filter_threads", "3", "-filter_complex_threads", "3",
      "-ss", "1", "-threads", "3", "-i", "first.mp4", "-threads", "3", "-i", "second.mp4",
      "-filter_complex", "[0:v][1:v]overlay", "-threads", "3", "out.mp4",
    ]);
  });

  it("preserves explicit per-input, output, and filter thread settings", () => {
    const args = withFfmpegResourceLimits(["-filter_threads", "1", "-threads", "2", "-i", "source.mp4", "-threads:v", "3", "out.mp4"], 4);
    expect(args).toEqual([
      "-filter_complex_threads", "4", "-filter_threads", "1", "-threads", "2", "-i", "source.mp4",
      "-threads:v", "3", "out.mp4",
    ]);
  });

  it("keeps FFmpeg-generated image output working with the resource options", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swr-ffmpeg-budget-"));
    try {
      const output = join(dir, "frame.jpg");
      await ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=32x32", "-frames:v", "1", output]);
      expect(existsSync(output)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
