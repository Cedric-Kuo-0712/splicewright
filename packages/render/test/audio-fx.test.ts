import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { init, load, run, undo } from "@splicewright/core/node";
import type { Project } from "@splicewright/core";
import { audioFxPath } from "@splicewright/ingest";
import { audioFxSources } from "../src/node.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

it("render preflight refuses a missing/stale bake and selects the current hashed artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-audiofx-render-"));
  dirs.push(dir);
  init(dir, { title: "audioFx", fps: 30, width: 320, height: 180 });
  writeFileSync(join(dir, "source.wav"), "source bytes");
  let result = run(dir, "importAsset", { path: "source.wav" });
  if ("error" in result) throw new Error(result.error.message);
  const asset = Object.values(result.project.assets)[0];
  result = run(dir, "insertItem", { assetId: asset.id, at: 0, duration: 30 });
  if ("error" in result) throw new Error(result.error.message);
  const item = (result.project as Project).tracks.flatMap((t) => t.items as { id: string }[]).find((x) => x.id === "i_1")!;
  result = run(dir, "setProps", { itemId: item.id, patch: { audioFx: { pan: -1 } } });
  if ("error" in result) throw new Error(result.error.message);
  expect(() => audioFxSources(dir, result.project)).toThrow(/missing or stale/);
  const path = audioFxPath(dir, asset.id, asset.path, { pan: -1 });
  mkdirSync(join(dir, ".splicewright", "audio"), { recursive: true });
  writeFileSync(join(dir, path), "baked bytes");
  expect(audioFxSources(dir, result.project)).toEqual({ [item.id]: path });
  expect(undo(dir)).not.toHaveProperty("error");
  expect((load(dir) as Project).tracks.flatMap((t) => t.items as { id: string }[]).find((x) => x.id === item.id)).not.toHaveProperty("audioFx");
});
