import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { still } from "../src/node.ts";

const basic = join(import.meta.dirname, "../../../examples/basic");

it("renders an imported local WOFF2 font instead of CSS fallback", { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-font-still-"));
  cpSync(basic, dir, { recursive: true, filter: (f) => !/\/(out|\.splicewright)(\/|$)/.test(f) });
  mkdirSync(join(dir, "raw"), { recursive: true });
  const fontPath = join(dir, "raw", "anton.woff2");
  copyFileSync(join(import.meta.dirname, "../../../node_modules/@fontsource/anton/files/anton-latin-400-normal.woff2"), fontPath);
  writeFileSync(join(dir, "raw", "broken.ttf"), "invalid font file");
  const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  project.assets.a_anton = { id: "a_anton", path: "raw/anton.woff2", kind: "font" };
  project.assets.a_broken = { id: "a_broken", path: "raw/broken.ttf", kind: "font" };
  project.themes = { inactive: { name: "inactive", roles: { title: { font: "a_broken" } } } };
  project.tracks.find((t: { kind: string }) => t.kind === "overlay").items = [{ id: "i_font", start: 0, duration: 60, component: "Text", props: { text: "HAMBURG", textStyle: { font: "a_anton", size: 48, weight: 400 }, style: { color: "#fff" } } }];
  writeFileSync(join(dir, "project.json"), JSON.stringify(project));

  const out = join(dir, "font.png");
  await still(dir, 10, out);
  expect(existsSync(out)).toBe(true);
  const custom = execFileSync("ffmpeg", ["-loglevel", "error", "-i", out, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);

  project.tracks.find((t: { kind: string }) => t.kind === "overlay").items[0].props.textStyle.font = "monospace";
  writeFileSync(join(dir, "project.json"), JSON.stringify(project));
  const fallback = join(dir, "fallback.png");
  await still(dir, 10, fallback);
  const plain = execFileSync("ffmpeg", ["-loglevel", "error", "-i", fallback, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  let diff = 0;
  for (let i = 0; i < custom.length; i++) diff += Math.abs(custom[i] - plain[i]);
  expect(diff).toBeGreaterThan(10_000);

  project.tracks.find((t: { kind: string }) => t.kind === "overlay").items[0].props.textStyle.font = "a_broken";
  writeFileSync(join(dir, "project.json"), JSON.stringify(project));
  await expect(still(dir, 10, join(dir, "bad-font.png"))).rejects.toThrow(/Could not load imported font a_broken/);
});
