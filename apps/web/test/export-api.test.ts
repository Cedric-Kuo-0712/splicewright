import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { init } from "@splicewright/core/node";

const runtime = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("@splicewright/render/node", async (original) => ({
  ...await original<typeof import("@splicewright/render/node")>(),
  startRender: runtime.start,
}));
import { open } from "../server.ts";

const dir = mkdtempSync(join(tmpdir(), "swr-export-api-"));
let server: Awaited<ReturnType<typeof open>>;
beforeAll(async () => {
  init(dir, { title: "Export choices", width: 1920, height: 1080, fps: 30 });
  runtime.start.mockImplementation((_dir, options) => ({ id: options.preset, ...options, status: "running", progress: 0 }));
  server = await open(dir, { port: 0 });
});
afterAll(async () => { await server?.close(); rmSync(dir, { recursive: true, force: true }); });

it.each(["draft", "master", "h264-cpu", "h264-hardware", "h265-hardware"])("accepts %s at the HTTP boundary", async (preset) => {
  const response = await fetch(`${server.url}api/export`, { method: "POST", body: JSON.stringify({ preset }) });
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ preset, output: expect.stringMatching(new RegExp(`-${preset}-\\d+\\.mp4$`)) });
  expect(runtime.start).toHaveBeenLastCalledWith(dir, expect.objectContaining({ preset }));
});

it("treats auto as no preset, so the render picks the same default as the CLI and MCP", async () => {
  const response = await fetch(`${server.url}api/export`, { method: "POST", body: JSON.stringify({ preset: "auto" }) });
  expect(response.status).toBe(202);
  expect(runtime.start).toHaveBeenLastCalledWith(dir, expect.objectContaining({ preset: undefined, output: expect.stringMatching(/-auto-\d+\.mp4$/) }));
});

it.each(["h265-cpu", "unknown", null, {}])("rejects an unsupported choice %j", async (preset) => {
  runtime.start.mockClear();
  const response = await fetch(`${server.url}api/export`, { method: "POST", body: JSON.stringify({ preset }) });
  expect(response.status).toBe(400);
  expect(runtime.start).not.toHaveBeenCalled();
});
