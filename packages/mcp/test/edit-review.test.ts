import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { init, load } from "@splicewright/core/node";

const CLI = join(import.meta.dirname, "../../cli/src/main.ts");
const bodyOf = (result: any) => JSON.parse((result.content[0] as { text: string }).text);

it("exposes reviewable atomic edit rounds and keeps snapshots out of default MCP context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-review-mcp-"));
  const client = new Client({ name: "review-tools-test", version: "0" });
  try {
    init(dir, { title: "review tools", fps: 30, width: 640, height: 360 });
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], cwd: dir, stderr: "inherit" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("apply_edit_review");
    expect(tools.tools.map((tool) => tool.name)).toContain("get_edit_review");
    const applied = await client.callTool({ name: "apply_edit_review", arguments: { label: "MCP review", baseRevision: 0, ops: [{ op: "addMarker", args: { label: "agent", start: 10 } }] } });
    const result = bodyOf(applied);
    expect(result).toMatchObject({ revision: 1, review: { status: "pending", beforeRevision: 0, afterRevision: 1 } });
    const compact = await client.callTool({ name: "get_edit_review", arguments: {} });
    const summary = bodyOf(compact);
    expect(summary).toMatchObject({ label: "MCP review", status: "pending" });
    expect(summary).not.toHaveProperty("before");
    expect(summary).not.toHaveProperty("after");
    const full = await client.callTool({ name: "get_edit_review", arguments: { recordId: result.review.id, includeSnapshots: true } });
    expect(bodyOf(full)).toMatchObject({ before: { revision: 0 }, after: { revision: 1 } });
    expect(load(dir).revision).toBe(1);
  } finally {
    await client.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
