import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { still } from "../src/node.ts";
import { canvasVideoErrorHandler } from "../src/Composition.tsx";

const fixture = join(import.meta.dirname, "../../../examples/look-l0");

it("reports canvas decode failures to Player state and names the item for render failures", () => {
  let failure: Error | undefined;
  const error = new Error("unsupported codec");
  const action = canvasVideoErrorHandler("interview-shot", (next) => { failure = next; })(error);
  expect(action).toBe("fail");
  expect(failure).toBe(error);
  expect(error.message).toContain('item "interview-shot"');
});

it("keys synthetic green on the canvas path and reveals the blue track below", { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-canvas-key-"));
  cpSync(fixture, dir, { recursive: true });
  const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  delete project.tracks[1].items[0].key;
  writeFileSync(join(dir, "project.json"), JSON.stringify(project));

  const readPixels = async (name: string) => {
    const png = join(dir, name);
    await still(dir, 30, png);
    const rgb = execFileSync("ffmpeg", ["-loglevel", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    return (x: number, y: number) => [...rgb.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
  };
  const beforeKey = await readPixels("before.png");
  expect(beforeKey(20, 20)[1]).toBeGreaterThan(100);
  expect(beforeKey(160, 90)[0]).toBeGreaterThan(220);

  project.tracks[1].items[0].key = { kind: "chroma", color: "#00ff00", similarity: 0.45, smoothness: 0.08 };
  writeFileSync(join(dir, "project.json"), JSON.stringify(project));
  const pixel = await readPixels("keyed.png");
  const [keyedGreen, survivingSubject] = [pixel(20, 20), pixel(160, 90)];
  expect(keyedGreen[2]).toBeGreaterThan(220);
  expect(keyedGreen[0]).toBeLessThan(40);
  expect(survivingSubject[0]).toBeGreaterThan(220);
  expect(survivingSubject[1]).toBeLessThan(40);
});
