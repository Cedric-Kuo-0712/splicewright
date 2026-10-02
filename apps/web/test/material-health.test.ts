import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { init, load } from "@splicewright/core/node";
import { open } from "../server.ts";

it("opening the UI does not analyze sources; explicit prepare and relink use shared operations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-material-web-"));
  init(dir, { title: "sources", fps: 30, width: 64, height: 36 }); mkdirSync(join(dir, "raw"));
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=1", join(dir, "raw/source.wav")]);
  const server = await open(dir, { port: 0 });
  try {
    await fetch(`${server.url}api/project`);
    expect(Object.keys(load(dir).assets)).toHaveLength(0);
    expect(existsSync(join(dir, ".splicewright/assets.json"))).toBe(false);
    const scanned = await (await fetch(`${server.url}api/materials/scan`)).json();
    expect(scanned.materials[0].health).toBe("new");
    expect(Object.keys(load(dir).assets)).toHaveLength(0);
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${server.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    expect((await post("api/materials/prepare", { paths: ["raw/source.wav"], steps: ["loudness"] })).data.errors).toEqual([]);
    copyFileSync(join(dir, "raw/source.wav"), join(dir, "raw/replacement.wav")); rmSync(join(dir, "raw/source.wav"));
    const before = load(dir);
    const linked = await post("api/op", { op: "relinkAsset", args: { assetId: "a_source", path: "raw/replacement.wav" }, baseRevision: before.revision });
    expect(linked.status).toBe(200);
    expect(linked.data.project.assets.a_source.path).toBe("raw/replacement.wav");
    expect(linked.data.project.revision).toBe(before.revision + 1);
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
