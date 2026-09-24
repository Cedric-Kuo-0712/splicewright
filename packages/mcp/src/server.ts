import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { find, getItem, getRange, getSummary, ops, type OpResult } from "@splicewright/core";
import { load, loadCtx, redo, run, undo } from "@splicewright/core/node";
import { ingest, peek, STEPS } from "@splicewright/ingest";
import { renderStatus, startRender, still, storyboard } from "@splicewright/render/node";

// Spec §7.2. Write tools map 1:1 to core ops; read tools return compact JSON.

const json = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });
const failed = (code: string, e: unknown) => ({ ...json({ code, message: (e as Error).message }), isError: true });
/** A grid image plus what each tile shows; the tiles carry no labels. */
const tiles = (image: Buffer, info: Record<string, unknown>) => ({
  content: [{ type: "image" as const, data: image.toString("base64"), mimeType: "image/jpeg" }, { type: "text" as const, text: JSON.stringify({ layout: "row-major, 4 per row", ...info }) }],
});

function writeResult(r: OpResult) {
  if ("error" in r) return { ...json(r.error), isError: true };
  return json({ revision: r.project.revision, summary: r.changes.summary });
}

export function createServer(dir: string): McpServer {
  const server = new McpServer({ name: "splicewright", version: "0.0.0" });
  const baseRevision = z.number().int().optional().describe("Revision this edit is based on; stale writes are rejected. Omit for latest.");

  for (const [name, op] of Object.entries(ops)) {
    // The shape only; core re-validates the full schema (including refinements) on every call.
    const shape = (op.args as z.ZodObject).shape;
    server.registerTool(
      `splicewright_${name}`,
      { description: op.doc, inputSchema: { ...shape, baseRevision } },
      async ({ baseRevision, ...args }: Record<string, unknown>) => writeResult(run(dir, name, args, baseRevision as number | undefined)),
    );
  }
  server.registerTool("splicewright_undo", { description: "Undo the last op (one op = one step)." }, async () => writeResult(undo(dir)));
  server.registerTool("splicewright_redo", { description: "Redo the last undone op." }, async () => writeResult(redo(dir)));

  server.registerTool(
    "ingest",
    {
      description: "Probe assets and build caches (proxies, thumbs, contact sheets, waveforms, transcripts, beats). Cached by content fingerprint, so re-running is cheap. Needed before insertItem can default a duration, and before detectBeats / addCaptionsFromTranscript.",
      inputSchema: { only: z.array(z.enum(STEPS)).optional(), assets: z.array(z.string()).optional().describe("Asset ids; default all.") },
    },
    async ({ only, assets }) => json(await ingest(dir, { only, assets })),
  );
  server.registerTool(
    "get_summary",
    { description: "Tracks, item counts, total duration, markers, revision. No per-item detail." },
    async () => json(getSummary(load(dir))),
  );
  server.registerTool(
    "get_range",
    {
      description: "Visible items and captions intersecting timeline frames [from, to), with ids, timings, labels, notes.",
      inputSchema: { from: z.number().int().min(0), to: z.number().int().min(1) },
    },
    async ({ from, to }) => json(getRange(load(dir), from, to)),
  );
  server.registerTool(
    "get_item",
    { description: "One item, its asset metadata, and transcript text in its visible source range.", inputSchema: { itemId: z.string() } },
    async ({ itemId }) => {
      const r = getItem(load(dir), itemId, loadCtx(dir));
      return r ? json(r) : { ...json({ code: "not_found", message: `item ${itemId} not found` }), isError: true };
    },
  );
  server.registerTool(
    "find",
    { description: "Search transcripts, labels, notes, caption text, overlay props → matching items with timeline frames.", inputSchema: { query: z.string().min(1) } },
    async ({ query }) => json(find(load(dir), query, loadCtx(dir))),
  );
  server.registerTool(
    "inspect_asset",
    { description: "Asset metadata, full transcript text, and contact-sheet image path if ingested. No video; use peek to see frames.", inputSchema: { assetId: z.string() } },
    async ({ assetId }) => {
      const asset = load(dir).assets[assetId];
      if (!asset) return { ...json({ code: "not_found", message: `asset ${assetId} not found` }), isError: true };
      const ctx = loadCtx(dir);
      const sheet = join(".splicewright", "contact-sheets", `${assetId}.jpg`);
      return json({
        ...asset,
        duration: ctx.assetDurations?.[assetId],
        transcript: ctx.transcript?.(assetId)?.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text.trim()}`),
        contactSheet: existsSync(join(dir, sheet)) ? sheet : undefined,
      });
    },
  );
  server.registerTool(
    "still",
    { description: "JPEG (≤ 960 px wide) of what the composition shows at a timeline frame.", inputSchema: { frame: z.number().int().min(0) } },
    async ({ frame }) => {
      try {
        const { buffer } = await still(dir, frame, null, 960);
        return { content: [{ type: "image" as const, data: buffer!.toString("base64"), mimeType: "image/jpeg" }] };
      } catch (e) {
        return failed("render_failed", e);
      }
    },
  );
  server.registerTool(
    "peek",
    {
      description: "Look at a video asset before using it: n frames from source seconds [from, to) in one grid image (~320 px tiles), plus the time of each tile. Much cheaper than stills; reads the low-fps analysis proxy when the spacing allows.",
      inputSchema: { assetId: z.string(), from: z.number().min(0).optional(), to: z.number().optional().describe("Default: end of the asset."), n: z.number().int().min(1).max(24).default(12) },
    },
    async ({ assetId, ...range }) => {
      try {
        const { image, times, source } = await peek(dir, assetId, range);
        return tiles(image, { assetId, seconds: times, from: source });
      } catch (e) {
        return failed("peek_failed", e);
      }
    },
  );
  server.registerTool(
    "storyboard",
    {
      description: "Check the edit: n composition frames from timeline frames [from, to) in one grid image (~320 px tiles), plus the frame of each tile. Use still for one frame at full detail.",
      inputSchema: { from: z.number().int().min(0).optional(), to: z.number().int().min(1).optional().describe("Default: end of the timeline."), n: z.number().int().min(1).max(24).default(12) },
    },
    async (range) => {
      try {
        const { image, frames } = await storyboard(dir, range);
        return tiles(image, { frames });
      } catch (e) {
        return failed("render_failed", e);
      }
    },
  );
  server.registerTool(
    "render",
    {
      description: "Start rendering to an mp4 in the background → job id; poll render_status. Range is timeline frames [from, to).",
      inputSchema: {
        output: z.string().default("out/final.mp4").describe("Path relative to the project folder."),
        preset: z.string().default("master").describe("draft, master, or one from splicewright.config.ts"),
        range: z.tuple([z.number().int().min(0), z.number().int().min(1)]).optional(),
      },
    },
    async ({ output, preset, range }) => json(startRender(dir, { output: resolve(dir, output), preset, range })),
  );
  server.registerTool(
    "render_status",
    { description: "Status and progress (0..1) of a render job.", inputSchema: { jobId: z.string() } },
    async ({ jobId }) => {
      const job = renderStatus(jobId);
      return job ? json(job) : { ...json({ code: "not_found", message: `job ${jobId} not found` }), isError: true };
    },
  );
  return server;
}

export async function serve(dir: string) {
  console.log = console.error; // stdout is the MCP transport; keep Remotion's logs off it
  await createServer(dir).connect(new StdioServerTransport());
}
