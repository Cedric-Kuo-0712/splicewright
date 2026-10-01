import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createProject } from "@splicewright/core";
import { lutsOf } from "../src/node.ts";

const identity2 = ["LUT_3D_SIZE 2", ...[0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${r} ${g} ${b}`)))].join("\n");

function project(dir: string, files: Record<string, string>, used: string[]) {
  mkdirSync(join(dir, "raw"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "raw", name), text);
  const p = createProject({ title: "t", fps: 30, width: 1920, height: 1080 }) as any;
  for (const name of [...Object.keys(files), "gone.cube"]) p.assets[name] = { id: name, path: `raw/${name}`, kind: "lut" };
  p.assets.clip = { id: "clip", path: "raw/clip.mp4", kind: "video" };
  p.tracks[0].items.push(...used.map((assetId, i) => ({ id: `i_${i}`, assetId: "clip", start: i * 30, duration: 30, sourceIn: 0, grade: { lut: { assetId } } })));
  return p;
}

it("lutsOf returns only used LUTs and skips missing or invalid ones instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "luts-"));
  try {
    const p = project(dir, { "ok.cube": identity2, "bad.cube": "nonsense", "unused.cube": identity2 }, ["ok.cube", "bad.cube", "gone.cube"]);
    const luts = lutsOf(dir, p);
    expect(Object.keys(luts)).toEqual(["ok.cube"]);
    expect(luts["ok.cube"].size).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("lutsOf stamps each LUT with the SHA-256 of its text, and a rewritten file gets a new one", () => {
  const dir = mkdtempSync(join(tmpdir(), "luts-digest-"));
  try {
    const p = project(dir, { "a.cube": identity2 }, ["a.cube"]);
    expect(lutsOf(dir, p)["a.cube"].digest).toBe(createHash("sha256").update(identity2).digest("hex"));
    const changed = identity2.replace("1 1 1", "1 1 0.999999"); // a difference far below any visible step
    writeFileSync(join(dir, "raw", "a.cube"), changed + " "); // new size, so the stat stamp moves too
    expect(lutsOf(dir, p)["a.cube"].digest).toBe(createHash("sha256").update(changed + " ").digest("hex"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
