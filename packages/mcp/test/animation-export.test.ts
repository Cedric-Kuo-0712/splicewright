import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { animate, animateOverlay } from "@splicewright/core";
import { init, load } from "@splicewright/core/node";

it("an agent keys overlay/grade/LUT, applies a keyed preset in one undo, checks output and cancels exports", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-animation-export-mcp-"));
  const client = new Client({ name: "feature-acceptance-agent", version: "1" });
  try {
    init(dir, { title: "MCP feature acceptance", fps: 30, width: 64, height: 36 }); mkdirSync(join(dir, "raw"));
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=gray:s=64x36", "-frames:v", "1", join(dir, "raw/source.png")]);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../../cli/src/main.ts"), "mcp"], cwd: dir, stderr: "ignore" }));
    const call = async (name: string, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { text: string }[])[0].text;
      return { result, body: text.startsWith("MCP error") ? { message: text } : JSON.parse(text) };
    };
    expect((await call("splicewright_importAsset", { path: "raw/source.png" })).result.isError).not.toBe(true);
    expect((await call("ingest", { only: ["sourceHealth"] })).result.isError).not.toBe(true);
    await call("splicewright_insertItem", { assetId: "a_source", at: 0, duration: 6 });
    await call("splicewright_insertItem", { component: "Text", props: { text: "KEYS", textStyle: { size: 8 } }, at: 0, duration: 6 });
    for (const [prop, itemId, value] of [["x", "i_2", 8], ["exposure", "i_1", 1]] as const)
      expect((await call("splicewright_setKeyframe", { itemId, prop, at: 3, value })).result.isError).not.toBe(true);
    const presets = (await call("list_lut_presets")).body.presets;
    expect((await call("apply_lut_preset", { itemId: "i_1", presetId: presets[0].id })).result.isError).not.toBe(true);
    const before = load(dir);
    expect((await call("apply_lut_preset", { itemId: "i_1", presetId: presets[1].id, at: 3, baseRevision: before.revision })).result.isError).not.toBe(true);
    const keyed = load(dir), video = keyed.tracks.find((track) => track.kind === "video")!;
    expect(keyed.revision).toBe(before.revision + 1);
    if (video.kind === "video") expect(animate(keyed, video.items[0], 3).grade?.lut?.assetId).toBe(video.items[0].lutKeyframes?.[0].assetId);
    const overlay = keyed.tracks.find((track) => track.kind === "overlay")!;
    if (overlay.kind === "overlay") expect(animateOverlay(keyed, overlay.items[0], 3).transform?.x).toBe(8);
    await call("splicewright_undo", { baseRevision: keyed.revision });
    expect(load(dir).tracks).toEqual(before.tracks);
    expect((await call("check_output", { path: "out/absent.mp4" })).result.isError).toBe(true);
    const cancelled = (await call("render", { output: "out/cancelled.mp4", preset: "draft" })).body;
    expect((await call("cancel_render", { jobId: cancelled.id })).body.cancelled).toBe(true);
    expect((await call("render_status", { jobId: cancelled.id })).body.status).toBe("cancelled");
    expect(existsSync(join(dir, "out/cancelled.mp4"))).toBe(false);
    const started = (await call("render", { output: "out/verified.mp4", preset: "draft" })).body;
    const deadline = Date.now() + 30_000;
    let job = started;
    while (job.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = (await call("render_status", { jobId: started.id })).body;
    }
    expect(job).toMatchObject({ status: "done", preset: "draft", finalMix: { status: "measured", decoded: true, audio: { status: "measured", integratedLufs: null, samplePeak: { dbfs: null }, truePeak: { dbfs: null } } } });
    expect((await call("check_output", { path: "out/verified.mp4" })).body).toMatchObject({ scope: "final-mix", decoded: true, fingerprint: expect.any(String) });
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});
