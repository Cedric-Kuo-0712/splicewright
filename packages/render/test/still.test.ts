import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { still } from "../src/node.ts";

// Spec §10: still-frame snapshot of examples/basic (video + config-registered component + caption).
// UPDATE_SNAPSHOTS=1 rewrites the expected frame; look at it before committing.
const dir = join(import.meta.dirname, "../../../examples/basic");
const expected = join(dir, "expected-30.png");

/** Frame downscaled to 32x18 RGB, so font antialiasing doesn't flake the comparison. */
const pixels = (png: string) =>
  execFileSync("ffmpeg", ["-loglevel", "error", "-i", png, "-vf", "scale=32:18:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);

it("renders examples/basic frame 30 like the snapshot", { timeout: 300_000 }, async () => {
  const out = join(mkdtempSync(join(tmpdir(), "swr-still-")), "30.png");
  await still(dir, 30, out);
  if (process.env.UPDATE_SNAPSHOTS || !existsSync(expected)) copyFileSync(out, expected);
  const [got, want] = [pixels(out), pixels(expected)];
  expect([...got.subarray(0, 3)]).toEqual([255, 0, 0]); // Box from splicewright.config.ts, top-left
  const diff = got.reduce((s, v, i) => s + Math.abs(v - want[i]), 0) / got.length;
  expect(diff).toBeLessThan(2);
});
