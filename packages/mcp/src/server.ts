import { existsSync } from "node:fs";
import { createTtsJobs } from "./tts-jobs.ts";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { find, findFillers, getItem, getRange, getSummary, lint, LUT_PRESETS, ops, previewOps, type OpResult, type VideoItem } from "@splicewright/core";
import { applyEditReview, applyLutPreset, getEditReview, load, loadCtx, readAssets, sizesOf, redo, run, undo } from "@splicewright/core/node";
import { breezyVoiceStatus, deleteBreezyVoice, generateAndInsertBreezyVoice, listBreezyVoices, registerBreezyVoice, setupBreezyVoice, setupTTS, validateBreezyVoiceRequest, checkOutput, generateAndInsertTTS, ingest, scanMaterials, relinkMaterial, listMaterials, prepareMaterials, recordMaterialReview, materialPreview, peek, sourceFrame, STEPS, stamp, TRANSCRIPT_FORMAT, TTS_LANGUAGES, TTS_VOICES, ttsStatus } from "@splicewright/ingest";
import { pip, type PipPreset } from "@splicewright/render/geometry";
import { cancelRender, renderStatus, startRender, still, storyboard } from "@splicewright/render/node";

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

When asked to review materials or start a new edit, call list_materials, prepare only relevant unread/changed paths with prepare_materials, then inspect_asset/peek/material_preview. Record actual observations with record_material_review using the listed source version; preparation alone never means reviewed. For a local fix, inspect only relevant sources. New materials are candidates, never automatically added to the timeline. These tools run only when explicitly called; opening the UI does not trigger an agent review.

Look before cutting, cheapest first: find (transcripts, labels, notes) → inspect_asset (asset summary) / get_asset_transcript (cached source transcript with range/search/page; never runs STT) → peek (small frame grid of a source range) → source_frame (one bounded, higher-detail source frame only when a specific detail matters) → storyboard (grid of the edit) → still (one full composition frame). Avoid still in loops.

For a picture-in-picture corner/side placement, use apply_pip_preset so placement matches the editor's crop and aspect-ratio geometry. It refuses rotation or position/mask keyframes that would make a static preset misleading; preserve those edits and choose another placement path instead of deleting keyframes.

Keep context proportional to the next decision: select bounded ranges and fields, reuse valid schemas/results/artifacts, and request more detail only for a concrete uncertainty. Group independent reads; keep dependent edits revision-aware. Diagnose failures before retrying and use the host's supported completion mechanism for long jobs instead of repeated status-only calls.

Assets must be ingested before insertItem can default a duration and before detectBeats or addCaptionsFromTranscript; ingest is cached, so re-running is cheap.

For local narration, call tts_status to check Kokoro or BreezyVoice. Choose engine kokoro for fixed English/Mandarin voices or breezyvoice for Mandarin voice cloning. Use tts_voice_register once with a reference audio file and its exact transcript, then reuse the saved voiceId from tts_voice_list. tts_generate inserts narration at a timeline frame with one revision and undo step; pass the current baseRevision. Model installation is explicit through tts_setup or CLI tts setup --engine; selected setup downloads dependencies and models, while synthesis never downloads them. tts_setup and BreezyVoice tts_generate return a jobId immediately; use tts_job_status to read completion/result, and never submit the same generation again while its job is running. Jobs belong to the current MCP server session. BreezyVoice uses CPU LLM/HiFT and MPS flow where installed on Apple, CPU elsewhere.

Edit only through splicewright_* tools, never by writing project.json or directly modifying raw/. For agent-authored rounds intended for human review, use apply_edit_review: it atomically applies the whole ops array and records before/after snapshots as one revision and undo step. Get its bounded summary with get_edit_review; request snapshots only when needed. Otherwise use splicewright_batch for an ordinary atomic edit. Pass the baseRevision you last read; on a conflict error the human changed something, so re-read instead of retrying. Undo is shared with the human: only undo your own last step, and pass the revision that step returned as baseRevision so a newer human edit is never the one undone. Frame args also take { near } to snap to edges, markers or beats.

Before a master render, run lint and fix its errors (gaps, text outside the title-safe area, CJK in a font without glyphs, stale/unmeasured source decode or peak checks; run ingest with sourceHealth explicitly for source measurements). Check the result with storyboard over the changed range; render with preset draft for a quick full check. Record decisions worth keeping across sessions in AGENTS.md under Notes.`;

export function createServer(dir: string): McpServer {
  const server = new McpServer({ name: "splicewright", version: "0.0.0" }, { instructions: INSTRUCTIONS });
  const ttsJobs = createTtsJobs();
  const baseRevision = z.number().int().optional().describe("Revision this edit is based on; stale writes are rejected. Omit for latest.");

  server.registerTool("apply_edit_review", {
    description: "Apply an agent edit round atomically as one revision and one undo step, preserving validated before/after snapshots for human review.",
    inputSchema: {
      ops: z.array(z.object({ op: z.string().min(1), args: z.unknown() })).min(1),
      label: z.string().trim().min(1).max(160).optional(), summary: z.string().trim().min(1).max(2000).optional(), baseRevision,
    },
  }, async ({ ops: reviewOps, label, summary, baseRevision: revision }) => {
    const r = applyEditReview(dir, reviewOps, { label, summary, baseRevision: revision });
    if ("error" in r) return { ...json(r.error), isError: true };
    return json({ revision: r.project.revision, summary: r.changes.summary, review: (r as any).review });
  });
  server.registerTool("preview_edit", {
    description: "Dry-run an atomic edit without writing project, history, or review snapshots. Returns bounded item movements including secondary track sync. Apply approved operations with the same baseRevision; preview does not reserve the timeline.",
    inputSchema: { ops: z.array(z.object({ op: z.string().min(1), args: z.unknown() })).min(1).max(200), baseRevision },
  }, async ({ ops: proposed, baseRevision: revision }) => {
    try {
      const project = load(dir);
      if (project.revision !== revision) return { ...json({ code: "conflict", message: `preview base revision ${revision} differs from current ${project.revision}` }), isError: true };
      const result = previewOps(project, proposed, loadCtx(dir));
      if ("error" in result) return { ...json(result.error), isError: true };
      return json({ ...result, moved: result.moved.slice(0, 50), truncated: result.truncated || result.moved.length > 50, limit: 50 });
    } catch (error) { return failed("preview_failed", error); }
  });
  server.registerTool("get_edit_review", {
    description: "Read the latest agent edit review metadata and concise summary. Full project snapshots are returned only when includeSnapshots is explicitly true.",
    inputSchema: { recordId: z.string().uuid().optional(), includeSnapshots: z.boolean().optional().default(false) },
  }, async ({ recordId, includeSnapshots }) => {
    try { const review = getEditReview(dir, recordId, includeSnapshots); return review ? json(review) : { ...json({ code: "not_found", message: "edit review not found" }), isError: true }; }
    catch (error) { return failed("invalid_review", error); }
  });

  server.registerTool(
    "list_lut_presets",
    { description: "List shipped creative SDR LUT presets. Input profile is unspecified; presets copy into the project only when applied." },
    async () => json({ presets: LUT_PRESETS }),
  );
  server.registerTool(
    "apply_lut_preset",
    {
      description: "Copy one built-in LUT into this project's raw/ and assign it to a video item in one undoable step.",
      inputSchema: { itemId: z.string().min(1), presetId: z.string().min(1), baseRevision, at: z.number().int().min(0).optional().describe("Timeline frame: set a discrete LUT key instead of changing the base LUT.") },
    },
    async ({ itemId, presetId, baseRevision: revision, at }) => writeResult(applyLutPreset(dir, itemId, presetId, revision, at)),
  );

  server.registerTool("check_output", { description: "Full decode and audio sample/true peak measurement of a completed project-local output. Separate final-mix scope; never treats missing measurement as passing.", inputSchema: { path: z.string().min(1) } }, async ({ path }) => {
    try { return json(await checkOutput(dir, path)); } catch (error) { return failed("measurement_failed", error); }
  });

  server.registerTool("scan_materials", { description: "Explicit read-only source scan: new, changed, missing and ingest failures. Never starts analysis." }, async () => json(await scanMaterials(dir)));

  for (const [name, op] of Object.entries(ops)) {
    // The shape only; core re-validates the full schema (including refinements) on every call.
    const shape = (op.args as z.ZodObject).shape;
    server.registerTool(
      `splicewright_${name}`,
      { description: op.doc, inputSchema: { ...shape, baseRevision } },
      async ({ baseRevision, ...args }: Record<string, unknown>) => writeResult(name === "relinkAsset" ? await relinkMaterial(dir, args as { assetId: string; path: string; acceptChanged?: boolean }, baseRevision as number | undefined) : run(dir, name, args, baseRevision as number | undefined)),
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
    "list_materials",
    {
      description: "Read-only inventory with exact source versions and review states. Use compact for an overview, then paths + full for chosen sources; compact omits segment/coverage ranges and bounds summaries. Filtering reduces returned context, not source hashing. No STT, import or review writes.",
      inputSchema: { paths: z.array(z.string().min(1)).max(200).optional(), view: z.enum(["compact", "full"]).optional() },
    },
    async ({ paths, view }) => {
      try {
        const inventory = await listMaterials(dir);
        const selected = paths ? new Set(paths) : undefined;
        const materials = inventory.materials.filter((m) => !selected || selected.has(m.path)).map((m) => {
          if (view !== "compact" || !m.review) return m;
          const { segments, planning, ...review } = m.review;
          return {
            ...m,
            review: {
              ...review, summary: review.summary.slice(0, 600),
              ...(review.summary.length > 600 && { summaryTruncated: true }),
              ...(segments?.length || planning?.coverage?.ranges?.length ? { detailsOmitted: true } : {}),
              ...(planning && { planning: {
                ...planning,
                ...(planning.coverage && { coverage: { method: planning.coverage.method, extent: planning.coverage.extent } }),
              } }),
            },
          };
        });
        return json({ materials });
      } catch (e) { return failed("materials_failed", e); }
    },
  );
  server.registerTool(
    "prepare_materials",
    {
      description: "Explicitly register and prepare selected raw/ materials. Defaults to pending materials and analysis/thumbs/transcript. Returns preparation results; never marks a material reviewed. Use paths to limit cost.",
      inputSchema: { paths: z.array(z.string().min(1)).optional(), steps: z.array(z.enum(["sourceHealth", "analysis", "thumbs", "transcript", "waveform", "loudness"])).optional() },
    },
    async (args) => {
      try {
        const result = await prepareMaterials(dir, args);
        return { ...json(result), ...(result.errors.length > 0 && { isError: true }) };
      } catch (e) { return failed("materials_failed", e); }
    },
  );
  server.registerTool(
    "record_material_review",
    {
      description: "After actually inspecting a source, persist bounded observations and optional story-planning evidence for its exact listed version. Stale versions are refused. Review status is separate from candidate/include/exclude decisions; this does not edit the timeline. Source-second coverage records what was inspected, not proof that the whole source was watched.",
      inputSchema: {
        path: z.string().min(1), version: z.string().min(1), summary: z.string().trim().min(1),
        segments: z.array(z.object({ from: z.number().min(0), to: z.number().positive(), note: z.string().trim().min(1) })).optional(),
        decision: z.enum(["candidate", "include", "exclude"]).optional(), reason: z.string().trim().min(1).optional(),
        planning: z.object({
          storyRoles: z.array(z.enum(["establishing", "process", "highlight", "detail", "ending", "hook"])).max(6).optional(),
          tags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
          coverage: z.object({
            method: z.string().trim().min(1).max(80),
            extent: z.enum(["partial", "full"]),
            ranges: z.array(z.object({ from: z.number().min(0), to: z.number().positive() }).strict()).max(50).optional(),
          }).strict().optional(),
          suitableUses: z.array(z.enum(["b-roll", "photo-montage", "live-audio"])).max(3).optional(),
          cautions: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
        }).strict().optional(),
      },
    },
    async (args) => { try { return json(await recordMaterialReview(dir, args)); } catch (e) { return failed("review_failed", e); } },
  );
  server.registerTool(
    "material_preview",
    { description: "Read a still-image material as a bounded JPEG preview (up to 960 px). For video use peek; for speech use inspect_asset after transcript preparation.", inputSchema: { path: z.string().min(1), version: z.string().min(1).optional() } },
    async (args) => {
      try { const { image, mimeType } = await materialPreview(dir, args); return { content: [{ type: "image" as const, data: image.toString("base64"), mimeType }] }; }
      catch (e) { return failed("preview_failed", e); }
    },
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
    "tts_status",
    { description: "Check installed Kokoro/BreezyVoice engines, languages, saved voices, and setup instructions.", inputSchema: { engine: z.enum(["kokoro", "breezyvoice"]).optional() } },
    async ({ engine }) => {
      if (engine) return json(await (engine === "breezyvoice" ? breezyVoiceStatus() : ttsStatus()));
      const [kokoro, breezyvoice] = await Promise.all([ttsStatus(), breezyVoiceStatus()]);
      return json({ ...kokoro, engines: { kokoro, breezyvoice } });
    },
  );
  server.registerTool(
    "tts_setup",
    { description: "Explicitly install selected TTS dependencies/models. Returns a jobId immediately; check tts_job_status. May download several GB. Does not edit the project.", inputSchema: { engine: z.enum(["kokoro", "breezyvoice"]), languages: z.array(z.enum(TTS_LANGUAGES)).min(1).optional() } },
    async ({ engine, languages }) => {
      try { return json(ttsJobs.start("setup", engine, async (progress) => {
        const result = await (engine === "breezyvoice" ? setupBreezyVoice(progress) : setupTTS(languages ?? ["en-us"], progress));
        if (!result.ready) throw new Error(result.detail || "TTS setup did not complete");
        return result;
      })); }
      catch (error) { return failed((error as Error & { code?: string }).code ?? "tts_setup_failed", error); }
    },
  );
  server.registerTool(
    "tts_job_status",
    { description: "Read a setup or BreezyVoice generation job from this MCP server session. ready includes result; failed includes refusal/error. Do not duplicate a running job.", inputSchema: { jobId: z.string().min(1) } },
    async ({ jobId }) => { try { return json(ttsJobs.get(jobId)); } catch (error) { return failed("not_found", error); } },
  );
  server.registerTool(
    "tts_voice_list",
    { description: "List saved local BreezyVoice reference profiles. Reuse a voiceId for subsequent narration without uploading again.", inputSchema: {} },
    async () => { try { return json({ voices: await listBreezyVoices() }); } catch (error) { return failed("tts_failed", error); } },
  );
  server.registerTool(
    "tts_voice_register",
    { description: "Save a BreezyVoice reference profile from a local audio file and exact transcript. Audio must be 3–30 seconds (15–20 recommended). Stores a copy; does not train model weights or edit the project.", inputSchema: { name: z.string().trim().min(1).max(100), audioPath: z.string().min(1), transcript: z.string().trim().min(1).max(2000) } },
    async ({ name, audioPath, transcript }) => {
      try { return json(await registerBreezyVoice({ name, audioPath: resolve(dir, audioPath), transcript })); }
      catch (error) { return failed((error as Error & { code?: string }).code ?? "tts_failed", error); }
    },
  );
  server.registerTool(
    "tts_voice_delete",
    { description: "Delete a saved local BreezyVoice reference profile. Existing timeline audio is retained.", inputSchema: { voiceId: z.string().min(1) } },
    async ({ voiceId }) => { try { return json(await deleteBreezyVoice(voiceId)); } catch (error) { return failed((error as Error & { code?: string }).code ?? "tts_failed", error); } },
  );
  server.registerTool(
    "tts_generate",
    {
      description: "Generate offline narration and insert it on an unlocked audio track in one revision and one undo step. Kokoro (default): language + voice, optional speed. BreezyVoice: engine breezyvoice + saved voiceId, Mandarin text up to 300 characters, no speed. Pass current baseRevision; concurrent project edits refuse insertion. BreezyVoice returns a jobId immediately; tts_job_status returns its insertion result. Synthesis never installs or downloads models.",
      inputSchema: {
        engine: z.enum(["kokoro", "breezyvoice"]).optional(), text: z.string().trim().min(1).max(2000),
        language: z.enum(TTS_LANGUAGES).optional(), voice: z.enum(TTS_VOICES.map((v) => v.id)).optional(), voiceId: z.string().min(1).optional(),
        speed: z.number().min(0.5).max(2).optional(), at: z.number().int().min(0), trackId: z.string().min(1).optional(),
        baseRevision: z.number().int().nonnegative(),
      },
    },
    async ({ engine, text, language, voice, voiceId, speed, at, trackId, baseRevision }) => {
      try {
        if (engine === "breezyvoice" && speed !== undefined) return failed("invalid_args", new Error("BreezyVoice does not support speed"));
        const placement = { text, at, trackId, base: baseRevision };
        if (engine === "breezyvoice") {
          const request = validateBreezyVoiceRequest({ ...placement, voiceId });
          return json(ttsJobs.start("generate", "breezyvoice", async () => {
            const result = await generateAndInsertBreezyVoice(dir, request);
            return { revision: result.revision, summary: result.summary, assetId: result.assetId, itemId: result.itemId, duration: result.duration, undoSteps: result.undoSteps, ...(result.warnings && { warnings: result.warnings }) };
          }));
        }
        const result = await generateAndInsertTTS(dir, { ...placement, language, voice, speed });
        return json({ revision: result.revision, summary: result.summary, assetId: result.assetId, itemId: result.itemId, duration: result.duration, undoSteps: result.undoSteps, ...(result.warnings && { warnings: result.warnings }) });
      } catch (error) {
        return failed((error as Error & { code?: string }).code ?? "tts_failed", error);
      }
    },
  );
  server.registerTool(
    "get_summary",
    { description: "Tracks, item counts, total duration, markers, revision. No per-item detail." },
    async () => json(getSummary(load(dir))),
  );
  server.registerTool(
    "lint",
    { description: "Read-only checks before a master render: gaps on magnetic tracks, captions/text outside the title-safe area, CJK text in a font without CJK glyphs → [{ level, what, at, itemId? }]. No revision change." },
    async () => json(lint(load(dir), loadCtx(dir))),
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
    "get_asset_transcript",
    {
      description: "Read cached transcript segments for any registered audio/video source, including assets not on the timeline. Filter by overlapping source seconds or case-insensitive text and page results. Does not run STT; ingest transcript first if needed.",
      inputSchema: {
        assetId: z.string(), from: z.number().min(0).optional(), to: z.number().min(0).optional(),
        query: z.string().trim().min(1).optional(), limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).default(0),
      },
    },
    async ({ assetId, from, to, query, limit, offset }) => {
      try {
        const project = load(dir);
        const asset = project.assets[assetId];
        if (!asset) return { ...json({ code: "not_found", message: `asset ${assetId} not found` }), isError: true };
        if (asset.kind !== "audio" && asset.kind !== "video") return { ...json({ code: "invalid_asset_kind", message: `asset ${assetId} is ${asset.kind}; transcripts require audio or video` }), isError: true };
        if (from !== undefined && to !== undefined && from >= to) return { ...json({ code: "invalid_range", message: "from must be less than to" }), isError: true };
        const probe = readAssets(dir)[assetId];
        const ctx = loadCtx(dir);
        const expected = !!probe?.fingerprint && probe.done?.transcript === stamp(probe.fingerprint, "transcript") && ctx.fingerprint?.(asset.path) === probe.fingerprint;
        if (!expected) return json({ assetId, available: false, reason: "missing_or_stale", segments: [], total: 0, offset, limit, hasMore: false });
        const segments = ctx.transcript?.(assetId);
        if (!Array.isArray(segments)) return json({ assetId, available: false, reason: "missing_or_stale", segments: [], total: 0, offset, limit, hasMore: false });
        const q = query?.toLocaleLowerCase();
        const matched = segments.filter((segment) =>
          (from === undefined || segment.end > from) && (to === undefined || segment.start < to) &&
          (!q || segment.text.toLocaleLowerCase().includes(q))
        );
        const page = matched.slice(offset, offset + limit);
        return json({ assetId, available: true, format: TRANSCRIPT_FORMAT, segments: page, total: matched.length, offset, limit, hasMore: offset + page.length < matched.length });
      } catch (e) { return failed("transcript_failed", e); }
    },
  );
  server.registerTool(
    "source_frame",
    {
      description: "Decode one requested frame directly from a registered video source and return a bounded JPEG (default max side 640 px, max 1280). Use only for details that low-resolution peek cannot resolve; no full source media is returned.",
      inputSchema: { assetId: z.string(), at: z.number().min(0), maxSize: z.number().int().min(1).max(1280).default(640) },
    },
    async ({ assetId, at, maxSize }) => {
      try {
        const { image, seconds } = await sourceFrame(dir, assetId, at, maxSize);
        return { content: [{ type: "image" as const, data: image.toString("base64"), mimeType: "image/jpeg" }, { type: "text" as const, text: JSON.stringify({ assetId, seconds, maxSize }) }] };
      } catch (e) { return failed("source_frame_failed", e); }
    },
  );
  server.registerTool(
    "apply_pip_preset",
    {
      description: "Apply the shared picture-in-picture geometry preset to an existing video timeline item as one undoable setProps op. Refuses positioning keyframes and rotated geometry that the preset cannot place reliably; circle mask preserves current position.",
      inputSchema: { itemId: z.string(), preset: z.enum(["tl", "tr", "bl", "br", "left", "right", "circle"]), baseRevision },
    },
    async ({ itemId, preset, baseRevision }) => {
      try {
        const project = load(dir);
        const track = project.tracks.find((candidate) => candidate.items.some((item) => item.id === itemId));
        const item = track?.items.find((candidate) => candidate.id === itemId);
        if (!item || !track) return { ...json({ code: "not_found", message: `item ${itemId} not found` }), isError: true };
        if (track.kind !== "video" || !("assetId" in item)) return { ...json({ code: "invalid_item_kind", message: `item ${itemId} is not a video item` }), isError: true };
        {
          const video = item as VideoItem;
          const overridden = preset === "circle" ? ["maskX", "maskY", "maskW", "maskH", "maskFeather"] : ["x", "y", "scale", "maskX", "maskY", "maskW", "maskH", "maskFeather"];
          if (video.keyframes && overridden.some((key) => video.keyframes?.[key as keyof typeof video.keyframes]?.length))
            return { ...json({ code: "position_keyframes", message: `${itemId} has keyframes that override the ${preset} preset; remove or retime them first` }), isError: true };
          if (preset !== "circle") {
            const rotation = (project.assets[item.assetId]?.rotation ?? 0) + (video.transform?.rotation ?? 0);
            if (rotation % 360 !== 0) return { ...json({ code: "rotated_geometry", message: `${itemId} is rotated ${rotation}°; corner/side presets cannot place its visible bounds reliably` }), isError: true };
          }
        }
        const patch = pip(project, item as VideoItem, sizesOf(readAssets(dir))[item.assetId], preset as PipPreset);
        return writeResult(run(dir, "setProps", { itemId, patch }, baseRevision));
      } catch (e) { return failed("pip_failed", e); }
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
      description: "Start rendering to an mp4 in the background → job id; poll render_status. Range is timeline frames [from, to). The job reports `pipelineUsed` (layered is the fast route, remotion about 3x slower) and, when the fast route was refused, `fallbackReason` while it is still running.",
      inputSchema: {
        output: z.string().default("out/final.mp4").describe("Path relative to the project folder."),
        preset: z.string().optional().describe("draft, master, h264-cpu, h264-hardware, h265-hardware, or one from splicewright.config.ts. Omit for h264-hardware on macOS with VideoToolbox when the native route applies, otherwise master. Hardware modes require an available encoder."),
        range: z.tuple([z.number().int().min(0), z.number().int().min(1)]).optional(),
      },
    },
    async ({ output, preset, range }) => json(startRender(dir, { output: resolve(dir, output), preset, range })),
  );
  server.registerTool("cancel_render", { description: "Cancel a running render job. Cancelled or failed staging files are never successful outputs.", inputSchema: { jobId: z.string() } }, async ({ jobId }) => {
    const job = renderStatus(jobId);
    if (!job) return failed("not_found", new Error(`job ${jobId} not found`));
    return json({ cancelled: cancelRender(jobId), job: renderStatus(jobId) });
  });
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
