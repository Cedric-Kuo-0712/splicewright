import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { init, load } from "@splicewright/core/node";

const CLI = join(import.meta.dirname, "../../cli/src/main.ts");
it("an agent prepares and reviews only explicitly requested materials through MCP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-materials-mcp-"));
  init(dir, { title: "materials", fps: 30, width: 640, height: 360 });
  mkdirSync(join(dir, "raw"), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=32x32", "-frames:v", "1", join(dir, "raw", "photo.png")]);
  const client = new Client({ name: "materials-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], cwd: dir, stderr: "ignore" }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const contents = result.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    return { result, body: contents[0].type === "text" ? JSON.parse(contents[0].text!) : contents[0] };
  };
  try {
    expect(client.getInstructions()).toContain("preparation alone never means reviewed");
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_materials", "prepare_materials", "record_material_review", "material_preview"]));
    const first = (await call("list_materials")).body.materials.find((m: { path: string }) => m.path === "raw/photo.png");
    expect(first.status).toBe("unreviewed");
    expect(Object.keys(load(dir).assets)).toHaveLength(0);
    expect(existsSync(join(dir, ".splicewright/material-reviews.json"))).toBe(false);
    const prepared = await call("prepare_materials", { paths: [first.path], steps: [] });
    expect(prepared.result.isError).not.toBe(true);
    expect(Object.keys(load(dir).assets)).toHaveLength(1);
    expect((await call("list_materials")).body.materials[0].status).toBe("unreviewed");
    const preview = await call("material_preview", { path: first.path, version: first.version });
    expect(preview.body).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    const revision = load(dir).revision;
    expect((await call("record_material_review", { path: first.path, version: first.version, summary: "Red image", decision: "candidate" })).result.isError).not.toBe(true);
    expect((await call("list_materials")).body.materials[0].status).toBe("reviewed");
    expect(load(dir).revision).toBe(revision);
    copyFileSync(join(dir, first.path), join(dir, "raw/z_photo.png"));
    const added = (await call("list_materials")).body.materials.find((m: { path: string }) => m.path === "raw/z_photo.png");
    expect(added.status).toBe("unreviewed");
    await Promise.all([
      call("record_material_review", { path: first.path, version: first.version, summary: "Updated red image observation" }),
      call("record_material_review", { path: added.path, version: added.version, summary: "Second red image" }),
    ]);
    expect((await call("list_materials")).body.materials.map((m: { status: string }) => m.status)).toEqual(["reviewed", "reviewed"]);
    writeFileSync(join(dir, first.path), "modified image source");
    expect((await call("list_materials")).body.materials[0].status).toBe("changed");
    expect((await call("record_material_review", { path: first.path, version: first.version, summary: "Stale observation" })).result.isError).toBe(true);
    expect((await call("prepare_materials", { paths: [first.path], steps: [] })).result.isError).toBe(true);
    rmSync(join(dir, first.path));
    expect((await call("list_materials")).body.materials[0].status).toBe("missing");
    rmSync(join(dir, added.path));
    expect((await call("list_materials")).body.materials.find((m: { path: string }) => m.path === added.path).status).toBe("missing");
    expect((await call("prepare_materials", { paths: ["../outside.png"] })).result.isError).toBe(true);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
