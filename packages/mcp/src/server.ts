import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { find, findFillers, getItem, getRange, getSummary, lint, LUT_PRESETS, ops, type OpResult } from "@splicewright/core";
import { applyLutPreset, load, loadCtx, redo, run, undo } from "@splicewright/core/node";
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

/** Sent to the client on connect; agents such as Claude Code put it in their context. The per-project brief lives in AGENTS.md. */
export const INSTRUCTIONS = `Splicewright edits a video project in the current folder (project.json); a human may be watching or editing it live in the web UI (splicewright open).

Start: get_summary, then read AGENTS.md for the brief. Timeline positions and durations are frames at meta.fps; sourceIn and peek ranges are source seconds.

Look before cutting, cheapest first: find (transcripts, labels, notes) → inspect_asset (transcript + contact sheet) → peek (frame grid of a source range) → storyboard (grid of the edit) → still (one full frame). Avoid still in loops.

Assets must be ingested before insertItem can default a duration and before detectBeats or addCaptionsFromTranscript; ingest is cached, so re-running is cheap.

Edit only through splicewright_* tools, never by writing project.json or directly modifying raw/. Select built-in looks with list_lut_presets and apply_lut_preset; that tool copies only the selected LUT and its notices into the project. Put multi-step changes in splicewright_batch: atomic, one revision, one undo step. Pass the baseRevision you last read; on a conflict error the human changed something, so re-read instead of retrying. Undo is shared with the human: only undo your own last step, and pass the revision that step returned as baseRevision so a newer human edit is never the one undone. Frame args also take { near } to snap to edges, markers or beats.

Before a master render, run lint and fix its errors (gaps, text outside the title-safe area, CJK in a font without glyphs). Check the result with storyboard over the changed range; render with preset draft for a quick full check. Record decisions worth keeping across sessions in AGENTS.md under Notes.`;

export function createServer(dir: string): McpServer {
  const server = new McpServer({ name: "splicewright", version: "0.0.0" }, { instructions: INSTRUCTIONS });
  const baseRevision = z.number().int().optional().describe("Revision this edit is based on; stale writes are rejected. Omit for latest.");

  server.registerTool(
    "list_lut_presets",
    { description: "List shipped creative SDR LUT presets. Input profile is unspecified; presets copy into the project only when applied." },
    async () => json({ presets: LUT_PRESETS }),
  );
  server.registerTool(
    "apply_lut_preset",
    {
      description: "Copy one built-in LUT into this project's raw/ and assign it to a video item in one undoable step.",
      inputSchema: { itemId: z.string().min(1), presetId: z.string().min(1), baseRevision },
    },
    async ({ itemId, presetId, baseRevision: revision }) => writeResult(applyLutPreset(dir, itemId, presetId, revision)),
  );

  for (const [name, op] of Object.entries(ops)) {
    // The shape only; core re-validates the full schema (including refinements) on every call.
    const shape = (op.args as z.ZodObject).shape;
    server.registerTool(
      `splicewright_${name}`,
      { description: op.doc, inputSchema: { ...shape, baseRevision } },
      async ({ baseRevision, ...args }: Record<string, unknown>) => writeResult(run(dir, name, args, baseRevision as number | undefined)),
    );
  }
  const stepBase = z.number().int().optional().describe("The revision your last write returned. If anyone has written since, this is rejected as a conflict instead of undoing their step.");
  server.registerTool(
    "splicewright_undo",
    { description: "Undo the last op (one op = one step). Pass baseRevision so you only ever undo your own step.", inputSchema: { baseRevision: stepBase } },
    async ({ baseRevision }) => writeResult(undo(dir, baseRevision)),
  );
  server.registerTool(
    "splicewright_redo",
    { description: "Redo the last undone op. Pass baseRevision (the revision your undo returned).", inputSchema: { baseRevision: stepBase } },
    async ({ baseRevision }) => writeResult(redo(dir, baseRevision)),
  );

  server.registerTool(
    "ingest",
    {
      description: "Probe assets and build caches (edit/reverse/analysis proxies, thumbs, contact sheets, waveforms, transcripts, beats). Cached by content fingerprint, so re-running is cheap. Needed before insertItem can default a duration, and before detectBeats / addCaptionsFromTranscript.",
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
    "lint",
    { description: "Read-only checks before a master render: gaps on magnetic tracks, captions/text outside the title-safe area, CJK text in a font without CJK glyphs → [{ level, what, at, itemId? }]. No revision change." },
    async () => json(lint(load(dir))),
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
    "find_fillers",
    {
      description: "Filler words and long silences in the transcript → per item, source ranges in asset seconds (padded 2 frames, clamped to what the item shows, merged) with what each is. Show them to the user, then cut with cutRanges. `hints` lists assets that need re-transcribing for word timestamps.",
      inputSchema: {
        itemId: z.string().optional().describe("Default: every item whose asset has word timestamps."),
        words: z.array(z.string()).optional().describe('Default: ["um","uh","嗯","那個","那个","就是"]; case-insensitive, punctuation ignored. Whisper writes Chinese in simplified characters, so list both forms.'),
        minSilence: z.number().min(0).optional().describe("Seconds of gap between words that counts as a silence; default 0.6."),
      },
    },
    async (args) => json(findFillers(load(dir), loadCtx(dir), args)),
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
