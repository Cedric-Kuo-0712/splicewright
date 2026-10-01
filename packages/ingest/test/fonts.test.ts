import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { init, run, readAssets } from "@splicewright/core/node";
import { ingest } from "../src/index.ts";

it("ingests a local WOFF2 font without sending it to ffprobe and rejects invalid font bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-font-ingest-"));
  init(dir, { title: "font fixture", fps: 30, width: 320, height: 180 });
  mkdirSync(join(dir, "raw"));
  const fixture = join(import.meta.dirname, "../../../node_modules/@fontsource/anton/files/anton-latin-400-normal.woff2");
  copyFileSync(fixture, join(dir, "raw", "anton.woff2"));
  expect(run(dir, "importAsset", { path: "raw/anton.woff2" })).not.toHaveProperty("error");
  expect((await ingest(dir, { assets: ["a_anton"], only: [] })).errors).toBeUndefined();
  expect(readAssets(dir).a_anton).toMatchObject({ kind: "font", path: "raw/anton.woff2" });

  writeFileSync(join(dir, "raw", "broken.ttf"), "not a font");
  expect(run(dir, "importAsset", { path: "raw/broken.ttf" })).not.toHaveProperty("error");
  const invalid = await ingest(dir, { assets: ["a_broken"], only: [] });
  expect(invalid.errors?.join(" ")).toContain("invalid font file");
});
