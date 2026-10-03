import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { init, load, run } from "@splicewright/core/node";

const CLI = join(import.meta.dirname, "../../cli/src/main.ts");

it("previews linked track movement through MCP and CLI without writing, then applies one undoable edit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-sync-mcp-"));
  const client = new Client({ name: "sync-test", version: "0" });
  const fixture = (op: string, args: unknown) => {
    const result = run(dir, op, args, load(dir).revision);
    if ("error" in result) throw new Error(result.error.message);
    return result.project;
  };
  const state = () => Object.fromEntries((readdirSync(dir, { recursive: true }) as string[])
    .filter((p) => p === "project.json" || (p.startsWith(".splicewright/") && p.endsWith(".json")))
    .sort().map((p) => [p, readFileSync(join(dir, p), "utf8")]));
  try {
    init(dir, { title: "sync", fps: 30, width: 640, height: 360 });
    writeFileSync(join(dir, "photo.jpg"), "fixture");
    writeFileSync(join(dir, "song.wav"), "fixture");
    fixture("importAsset", { path: "photo.jpg" });
    fixture("importAsset", { path: "song.wav" });
    fixture("insertItem", { trackId: "t_1", assetId: "a_photo", at: 0, duration: 30 });
    fixture("insertItem", { trackId: "t_1", assetId: "a_photo", at: 30, duration: 30 });
    fixture("insertItem", { trackId: "t_2", assetId: "a_song", at: 30, duration: 30 });
    fixture("setTrack", { trackId: "t_2", patch: { syncTo: "t_1" } });
    const base = load(dir).revision;
    const operations = [{ op: "trim", args: { itemId: "i_1", edge: "end", to: 20 } }];
    const before = state();
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], cwd: dir, stderr: "ignore" }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { type: string; text?: string }[]).find((c) => c.type === "text")!.text!;
      return { result, body: JSON.parse(text) };
    };
    const preview = await call("preview_edit", { ops: operations, baseRevision: base });
    expect(preview.result.isError).not.toBe(true);
    expect(preview.body.moved).toContainEqual(expect.objectContaining({ trackId: "t_2", itemId: "i_3", from: 30, to: 20, delta: -10, kind: "secondary" }));
    expect(state()).toEqual(before);
    const cliPreview = JSON.parse(execFileSync(process.execPath, [CLI, "preview-edit", JSON.stringify(operations), "--base", String(base)], { cwd: dir, encoding: "utf8" }));
    expect(cliPreview.moved).toEqual(preview.body.moved);
    expect(state()).toEqual(before);
    const stale = await call("preview_edit", { ops: operations, baseRevision: base - 1 });
    expect(stale.result.isError).toBe(true);
    expect(stale.body.code).toBe("conflict");
    expect(state()).toEqual(before);
    const written = await call("splicewright_batch", { ops: operations, baseRevision: base });
    expect(written.result.isError).not.toBe(true);
    expect(load(dir).revision).toBe(base + 1);
    expect(load(dir).tracks.find((t) => t.id === "t_2")!.items[0].start).toBe(20);
    const undo = await call("splicewright_undo", { baseRevision: base + 1 });
    expect(undo.result.isError).not.toBe(true);
    expect(load(dir).tracks.find((t) => t.id === "t_2")!.items[0].start).toBe(30);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
