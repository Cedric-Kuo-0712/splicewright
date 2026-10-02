import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { init, load } from "@splicewright/core/node";

it("an agent scans and relinks explicitly through the actual MCP transport, then undoes one edit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-relink-mcp-"));
  const client = new Client({ name: "relink-agent", version: "1" });
  try {
    init(dir, { title: "MCP relink", fps: 30, width: 64, height: 36 }); mkdirSync(join(dir, "raw"));
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=1", join(dir, "raw/source.wav")]);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../../cli/src/main.ts"), "mcp"], cwd: dir, stderr: "ignore" }));
    const call = async (name: string, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return { result, body: JSON.parse((result.content as { text: string }[])[0].text) };
    };
    const initial = load(dir).revision;
    expect((await call("scan_materials")).body.materials[0].health).toBe("new");
    expect(load(dir).revision).toBe(initial);
    expect((await call("prepare_materials", { paths: ["raw/source.wav"], steps: ["loudness"] })).result.isError).not.toBe(true);
    expect((await call("splicewright_insertItem", { assetId: "a_source", at: 0, duration: 15 })).result.isError).not.toBe(true);
    const before = load(dir);
    copyFileSync(join(dir, "raw/source.wav"), join(dir, "raw/replacement.wav")); rmSync(join(dir, "raw/source.wav"));
    expect((await call("scan_materials")).body.materials.find((material: { assetId?: string }) => material.assetId === "a_source").health).toBe("missing");
    expect((await call("splicewright_relinkAsset", { assetId: "a_source", path: "raw/replacement.wav", baseRevision: before.revision - 1 })).result.isError).toBe(true);
    const relink = await call("splicewright_relinkAsset", { assetId: "a_source", path: "raw/replacement.wav", baseRevision: before.revision });
    expect(relink.result.isError).not.toBe(true);
    expect(load(dir).tracks).toEqual(before.tracks);
    expect((await call("splicewright_undo", { baseRevision: load(dir).revision })).result.isError).not.toBe(true);
    expect(load(dir).assets.a_source.path).toBe("raw/source.wav");
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});
