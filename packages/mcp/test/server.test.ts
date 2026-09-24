import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { init, load, run } from "@splicewright/core/node";

const CLI = join(import.meta.dirname, "../../cli/src/main.ts");

it("an agent can read and edit a project over stdio MCP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-mcp-"));
  init(dir, { title: "t", fps: 30, width: 640, height: 360 });
  run(dir, "importAsset", { path: "raw/clip.mp4" });
  run(dir, "insertItem", { assetId: "a_clip", at: 0, duration: 90 });

  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], cwd: dir, stderr: "ignore" }));
  try {
    expect(client.getInstructions()).toContain("splicewright_batch");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["splicewright_split", "splicewright_trim", "splicewright_batch", "get_summary", "get_range", "find"]));

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      const text = r.content[0].text;
      // The SDK rejects schema-invalid input itself, with a plain-text message.
      const body = text.startsWith("MCP error") ? { message: text } : JSON.parse(text);
      return Array.isArray(body) ? body : { ...body, isError: r.isError ?? false };
    };
    expect(await call("splicewright_split", { itemId: "i_1", at: 30, baseRevision: 2 })).toMatchObject({ revision: 3, isError: false });
    expect(await call("splicewright_trim", { itemId: "i_2", edge: "end", to: 60, baseRevision: 2 })).toMatchObject({ code: "conflict", isError: true });
    expect(await call("splicewright_trim", { itemId: "i_2", edge: "end", to: 60 })).toMatchObject({ revision: 4 });
    expect(await call("splicewright_split", { itemId: "i_1", at: "x" })).toMatchObject({ isError: true });
    expect(await call("get_range", { from: 0, to: 1000 })).toHaveLength(2);
    expect(await call("splicewright_undo")).toMatchObject({ revision: 5 });
    expect((await call("get_summary")).durationFrames).toBe(90);
    const trim = (await client.listTools()).tools.find((t) => t.name === "splicewright_trim")!;
    expect(JSON.stringify(trim.inputSchema.properties!.to)).toContain("near");
    await call("splicewright_addMarker", { label: "m", start: 45 });
    expect(await call("splicewright_split", { itemId: "i_2", at: { near: 50 } })).toMatchObject({ revision: 7, summary: expect.stringContaining("at 45") });
  } finally {
    await client.close();
  }
  expect(load(dir).revision).toBe(7);
});

it("still returns an image and render runs as a polled job", { timeout: 300_000 }, async () => {
  const dir = join(import.meta.dirname, "../../../examples/basic");
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], cwd: dir, stderr: "ignore" }));
  try {
    const img = (await client.callTool({ name: "still", arguments: { frame: 30 } })) as { content: { type: string; data: string }[] };
    expect(img.content[0].type).toBe("image");
    expect(Buffer.from(img.content[0].data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG
    const text = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text);
    const out = join(mkdtempSync(join(tmpdir(), "swr-render-")), "r.mp4");
    const job = await text("render", { output: out, preset: "draft", range: [0, 10] });
    let status = job;
    while (status.status === "running") {
      await new Promise((r) => setTimeout(r, 200));
      status = await text("render_status", { jobId: job.id });
    }
    expect(status).toMatchObject({ status: "done", progress: 1 });
    expect(existsSync(out)).toBe(true);
  } finally {
    await client.close();
  }
});
