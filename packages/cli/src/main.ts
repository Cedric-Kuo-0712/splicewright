#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { ASPECTS, FONT_PAIRS, FONTS, getSummary, lint, LUT_PRESETS, previewOps, THEME_IDS } from "@splicewright/core";
import { applyEditReview, applyLutPreset, getEditReview, init, load, loadCtx, rawPath, redo, revertEditReview, setEditReviewStatus, run, undo } from "@splicewright/core/node";
import { breezyVoiceStatus, deleteBreezyVoice, generateAndInsertBreezyVoice, listBreezyVoices, registerBreezyVoice, setupBreezyVoice, checkOutput, generateAndInsertTTS, scanMaterials, relinkMaterial, displayable, ingest, setupTTS, STEPS, ttsStatus, validateTTSRequest, type Step, type TtsLanguage } from "@splicewright/ingest";
import { serve } from "@splicewright/mcp";
import { render, still } from "@splicewright/render/node";
import { provisionAgentSkills } from "./agent-skills.ts";
import { migrateVideoCut } from "./migrate.ts";

// Spec §7.1. Every command prints one JSON object on stdout; errors exit 1.

const USAGE = `usage: splicewright <command>
  init [--title T] [--fps 30] [--size 1920x1080 | --preset 16:9|9:16|1:1|4:5] [--refresh-agents]
  import <paths...> [--no-ingest]
  ingest [--only sourceHealth,proxy,reverse,analysis,thumbs,waveform,transcript,beats,loudness,audioFx] [--jobs N]
  tts status [--engine kokoro|breezyvoice]
  tts setup --engine kokoro|breezyvoice [--language en-us,zh]
  tts voices | voice-add --name NAME --audio FILE (--transcript TEXT | --transcript-file FILE) | voice-delete --voice-id ID
  tts generate [--engine kokoro|breezyvoice] (--text T | --text-file FILE) --at FRAME [--language en-us|en-gb|zh --voice ID | --voice-id ID] [--speed 0.5..2] [--track ID] [--base REVISION]
  status
  scan-materials
  check-output <project-relative-output>
  lint
  op <opName> '<json args>' [--base <revision>]
  lut-presets
  apply-lut-preset <itemId> <presetId> [--base <revision>] [--at <timelineFrame>]
  apply-edit-review '<json {ops,label?,summary?}>' [--base <revision>]
  preview-edit '<ops-json-array>' --base <revision>
  edit-review show [--snapshots] | edit-review keep|dismiss <id> | edit-review revert <id> [--base <revision>]
  undo | redo [--base <revision>]
  still --at <frame|[hh:]mm:ss[.s]> [-o out/still-<frame>.jpg]
  render [-o out/final.mp4] [--preset draft|master] [--range a-b]
  open [--port 5190]
  mcp
  migrate video-cut <path> [--out <dir>] [--force]`;

function out(o: unknown): never {
  const failed = typeof o === "object" && o !== null && "error" in o;
  console.log(JSON.stringify(o));
  process.exit(failed ? 1 : 0);
}

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: "string" },
    fps: { type: "string", default: "30" },
    size: { type: "string" },
    base: { type: "string" },
    out: { type: "string" },
    force: { type: "boolean" },
    at: { type: "string" },
    output: { type: "string", short: "o" },
    preset: { type: "string" }, // render: draft|master; init: an aspect
    range: { type: "string" },
    port: { type: "string", default: "5190" },
    only: { type: "string" },
    jobs: { type: "string" },
    "no-ingest": { type: "boolean" },
    "refresh-agents": { type: "boolean" },
    snapshots: { type: "boolean" },
    text: { type: "string" },
    "text-file": { type: "string" },
    language: { type: "string" },
    voice: { type: "string" },
    engine: { type: "string" },
    "voice-id": { type: "string" },
    name: { type: "string" },
    audio: { type: "string" },
    transcript: { type: "string" },
    "transcript-file": { type: "string" },
    speed: { type: "string" },
    track: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}
const [cmd, ...args] = positionals;
const dir = process.cwd();
const fail = (e: Error): never => out({ error: { code: "render_failed", message: e.message } });

/** The built-in fonts and pairings as markdown, for AGENTS.md's Type section. */
const fontGuide = () =>
  [
    "| Font | `fontFamily` | Weights | Feel | Use for | Avoid |",
    "|---|---|---|---|---|---|",
    ...FONTS.map((f) => `| ${f.core ? "★ " : ""}${f.name} | \`${f.family}\` | ${f.weights.length === 2 && f.family.endsWith("Variable") ? f.weights.join("–") : f.weights.join(", ")} | ${f.feel} | ${f.use} | ${f.avoid} |`),
    "",
    "Pairings (title / supporting): " + FONT_PAIRS.map((p) => `${p.style}: ${p.title} / ${p.support}`).join("; ") + ".",
  ].join("\n");

/**
 * AGENTS.md (the brief), CLAUDE.md (points Claude Code at it) and .mcp.json (starts `splicewright mcp` here).
 * Existing files are kept; .mcp.json only gains a splicewright entry if it has none. Returns what was written.
 * `refresh` rewrites AGENTS.md from the current template and meta, keeping its Brief and Notes sections.
 */
let agentWarnings: string[] = [];
function agentFiles(dir: string, meta: { title: string; fps: number; width: number; height: number }, refresh = false): string[] {
  const written: string[] = [];
  const write = (name: string, text: string) => {
    if (existsSync(join(dir, name))) return;
    writeFileSync(join(dir, name), text);
    written.push(name);
  };
  const template = readFileSync(join(import.meta.dirname, "AGENTS.template.md"), "utf8");
  const vars = { ...meta, fonts: fontGuide(), themes: THEME_IDS.join(", ") };
  const agents = template.replace(/\{\{(\w+)\}\}/g, (_, k: keyof typeof vars) => String(vars[k]));
  const agentsPath = join(dir, "AGENTS.md");
  if (refresh && existsSync(agentsPath)) {
    const sections = (text: string) => text.split(/^(?=## )/m);
    const heading = (s: string) => s.slice(0, s.indexOf("\n"));
    const old = readFileSync(agentsPath, "utf8");
    const kept = new Map(sections(old).map((s) => [heading(s), s]));
    const next = sections(agents).map((s) => (["## Brief", "## Notes"].includes(heading(s)) && kept.get(heading(s))) || s).join("");
    if (next !== old) {
      writeFileSync(agentsPath, next);
      written.push("AGENTS.md");
    }
  }
  write("AGENTS.md", agents);
  write("CLAUDE.md", "@AGENTS.md\n");
  // The CLI by absolute path (it need not be on PATH); node by name, since process.execPath is a
  // versioned install path (e.g. Homebrew Cellar) that breaks on upgrade.
  const mcpPath = join(dir, ".mcp.json");
  const mcp = existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, "utf8")) : {};
  if (!mcp.mcpServers?.splicewright) {
    mcp.mcpServers = { ...mcp.mcpServers, splicewright: { type: "stdio", command: "node", args: [realpathSync(process.argv[1]), "mcp"], env: {} } };
    writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
    written.push(".mcp.json");
  }
  const skills = provisionAgentSkills(dir, join(import.meta.dirname, "skills"), refresh);
  agentWarnings = skills.warnings;
  return [...written, ...skills.created];
}

/** Frame number, or [hh:]mm:ss[.s] timecode, to a timeline frame. */
function toFrame(at: string, fps: number): number | undefined {
  if (/^\d+$/.test(at)) return Number(at);
  if (!/^(\d+:)?\d+:\d+(\.\d+)?$/.test(at)) return undefined;
  return Math.round(at.split(":").reduce((s, v) => s * 60 + Number(v), 0) * fps);
}

const log = (line: string) => console.error(line);
const jobs = flags.jobs ? Number(flags.jobs) : undefined;

const opResult = (r: ReturnType<typeof run>) =>
  "error" in r ? r : { revision: r.project.revision, summary: r.changes.summary };

switch (cmd) {
  case "init": {
    const aspect = flags.preset && Object.hasOwn(ASPECTS, flags.preset) && ASPECTS[flags.preset];
    if (flags.preset && flags.size) out({ error: { code: "usage", message: "init takes --preset or --size, not both" } });
    if (flags.preset && !aspect) out({ error: { code: "usage", message: `unknown preset ${flags.preset}; one of ${Object.keys(ASPECTS).join(", ")}` } });
    const [width, height] = aspect || (flags.size ?? "1920x1080").split("x").map(Number);
    const fps = Number(flags.fps);
    const title = flags.title ?? dir.split(/[/\\]/).pop()!;
    const r = init(dir, { title, fps, width, height });
    if ("error" in r && r.error.code !== "exists") out(r);
    const meta = load(dir).meta;
    const provisioned = agentFiles(dir, meta, flags["refresh-agents"]);
    const created = [...("error" in r ? [] : ["project.json"]), ...provisioned];
    out({ created, ...(agentWarnings.length ? { warnings: agentWarnings } : {}), revision: load(dir).revision });
  }
  case "import": {
    if (!args.length) out({ error: { code: "usage", message: "import <paths...>" } });
    const copied = args.map((p) => {
      const abs = resolve(p);
      const rel = relative(dir, abs);
      if (!isAbsolute(rel) && rel.split(sep)[0] !== "..") return rel;
      // Outside the project: render and the editor only read files inside it, so copy into raw/.
      if (!existsSync(abs)) out({ error: { code: "not_found", message: `${p} not found` } });
      mkdirSync(join(dir, "raw"), { recursive: true });
      const tmp = join(dir, "raw", `.import-${process.pid}`);
      cpSync(abs, tmp);
      return rawPath(dir, basename(abs), tmp);
    });
    const paths = await Promise.all(copied.map((p) => displayable(dir, p).catch(fail)));
    const results = paths.map((path) => opResult(run(dir, "importAsset", { path })));
    const ids = Object.values(load(dir).assets).filter((a) => paths.includes(a.path) && a.kind !== "lut").map((a) => a.id);
    out({ results, ...(!flags["no-ingest"] && ids.length && { ingest: await ingest(dir, { assets: ids, jobs, log }) }) });
  }
  case "ingest": {
    const only = flags.only?.split(",") as Step[] | undefined;
    const bad = only?.filter((s) => !STEPS.includes(s));
    if (bad?.length) out({ error: { code: "usage", message: `unknown step ${bad.join(", ")}; one of ${STEPS.join(", ")}` } });
    out(await ingest(dir, { only, jobs, log }));
  }
  case "tts": {
    const action = args[0];
    const engine = flags.engine ?? "kokoro";
    if (engine !== "kokoro" && engine !== "breezyvoice") out({ error: { code: "invalid_args", message: "engine must be kokoro or breezyvoice" } });
    try {
      if (action === "status") {
        if (flags.engine) out(await (engine === "breezyvoice" ? breezyVoiceStatus() : ttsStatus()));
        const [kokoro, breezyvoice] = await Promise.all([ttsStatus(), breezyVoiceStatus()]);
        out({ ...kokoro, engines: { kokoro, breezyvoice } });
      }
      if (action === "setup") {
        const progress = (line: string) => process.stderr.write(line);
        if (engine === "breezyvoice") out(await setupBreezyVoice(progress));
        out(await setupTTS((flags.language ?? "en-us").split(",") as TtsLanguage[], progress));
      }
      if (action === "voices") out({ voices: await listBreezyVoices() });
      if (action === "voice-add") {
        if (!flags.name || !flags.audio || (!flags.transcript && !flags["transcript-file"])) out({ error: { code: "usage", message: "tts voice-add requires --name, --audio, and --transcript or --transcript-file" } });
        const transcript = flags["transcript-file"] ? readFileSync(resolve(flags["transcript-file"]), "utf8") : flags.transcript!;
        out(await registerBreezyVoice({ name: flags.name!, audioPath: resolve(flags.audio!), transcript }));
      }
      if (action === "voice-delete") {
        if (!flags["voice-id"]) out({ error: { code: "usage", message: "tts voice-delete requires --voice-id" } });
        out(await deleteBreezyVoice(flags["voice-id"]!));
      }
      if (action === "generate") {
        if ((flags.text === undefined && flags["text-file"] === undefined) || flags.at === undefined) out({ error: { code: "usage", message: "tts generate requires --text or --text-file, and --at <frame>" } });
        const text = flags["text-file"] ? readFileSync(resolve(flags["text-file"]), "utf8") : flags.text!;
        const placement = { text, at: Number(flags.at), trackId: flags.track, base: flags.base === undefined ? load(dir).revision : Number(flags.base) };
        if (engine === "breezyvoice" && flags.speed !== undefined) out({ error: { code: "invalid_args", message: "BreezyVoice does not support --speed" } });
        const result = engine === "breezyvoice"
          ? await generateAndInsertBreezyVoice(dir, { ...placement, voiceId: flags["voice-id"]! })
          : await generateAndInsertTTS(dir, validateTTSRequest({ ...placement, language: flags.language, voice: flags.voice, speed: flags.speed === undefined ? 1 : Number(flags.speed) }));
        out({ revision: result.revision, summary: result.summary, assetId: result.assetId, itemId: result.itemId, duration: result.duration, undoSteps: result.undoSteps, ...(result.warnings && { warnings: result.warnings }) });
      }
    } catch (error) {
      out({ error: { code: (error as Error & { code?: string }).code ?? (action === "setup" ? "tts_setup_failed" : "tts_failed"), message: (error as Error).message } });
    }
    out({ error: { code: "usage", message: "tts status | setup --engine kokoro|breezyvoice | voices | voice-add | voice-delete | generate" } });
  }
  case "status":
    out(getSummary(load(dir)));
  case "lint":
    out(lint(load(dir), loadCtx(dir)));
  case "lut-presets":
    out({ presets: LUT_PRESETS });
  case "apply-lut-preset": {
    const [itemId, presetId] = args;
    if (!itemId || !presetId) out({ error: { code: "usage", message: "apply-lut-preset <itemId> <presetId> [--base <revision>]" } });
    out(opResult(applyLutPreset(dir, itemId, presetId, flags.base === undefined ? undefined : Number(flags.base), flags.at === undefined ? undefined : Number(flags.at))));
  }
  case "preview-edit": {
    const revision = flags.base === undefined ? NaN : Number(flags.base);
    if (!Number.isSafeInteger(revision) || revision < 0) out({ error: { code: "usage", message: "preview-edit requires --base <nonnegative revision>" } });
    let proposed: unknown;
    try { proposed = JSON.parse(args[0] ?? ""); }
    catch { out({ error: { code: "invalid", message: "preview-edit expects a JSON array of {op,args}" } }); }
    if (!Array.isArray(proposed) || !proposed.length || proposed.length > 200 || proposed.some((op) => !op || typeof op !== "object" || typeof op.op !== "string" || !op.op.trim() || !("args" in op)))
      out({ error: { code: "invalid", message: "preview-edit expects 1–200 operations with op and args" } });
    const project = load(dir);
    if (project.revision !== revision) out({ error: { code: "conflict", message: `preview base revision ${revision} differs from current ${project.revision}` } });
    out(previewOps(project, proposed, loadCtx(dir)));
  }
  case "apply-edit-review": {
    let parsed: any;
    try { parsed = JSON.parse(args[0] ?? ""); } catch { out({ error: { code: "usage", message: "apply-edit-review expects one JSON object with ops" } }); }
    if (!Array.isArray(parsed?.ops)) out({ error: { code: "usage", message: "review JSON must include an ops array" } });
    const r = applyEditReview(dir, parsed.ops, { label: parsed.label, summary: parsed.summary, baseRevision: flags.base === undefined ? undefined : Number(flags.base) });
    out("error" in r ? r : { revision: r.project.revision, summary: r.changes.summary, review: (r as any).review });
  }
  case "edit-review": {
    const [action, id] = args;
    if (action === "show") {
      try { out(getEditReview(dir, undefined, !!flags.snapshots) ?? { error: { code: "not_found", message: "edit review not found" } }); }
      catch (error) { out({ error: { code: "invalid_review", message: (error as Error).message } }); }
    }
    if ((action === "keep" || action === "dismiss") && id) out(setEditReviewStatus(dir, id, action === "keep" ? "kept" : "dismissed"));
    if (action === "revert" && id) out(opResult(revertEditReview(dir, id, flags.base === undefined ? undefined : Number(flags.base))));
    out({ error: { code: "usage", message: "edit-review show [--snapshots] | edit-review keep|dismiss <id> | edit-review revert <id> [--base <revision>]" } });
  }
  case "check-output": {
    if (!args[0]) out({ error: { code: "usage", message: "check-output <project-relative-output>" } });
    try { out(await checkOutput(dir, args[0])); } catch (error) { out({ error: { code: "measurement_failed", message: String(error) } }); }
  }
  case "scan-materials":
    out(await scanMaterials(dir));
  case "op": {
    const [name, raw = "{}"] = args;
    if (!name) out({ error: { code: "usage", message: "op <opName> '<json args>'" } });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      out({ error: { code: "invalid_args", message: `args are not JSON: ${(e as Error).message}` } });
    }
    out(opResult(name === "relinkAsset" ? await relinkMaterial(dir, parsed as { assetId: string; path: string; acceptChanged?: boolean }, flags.base === undefined ? undefined : Number(flags.base)) : run(dir, name, parsed, flags.base === undefined ? undefined : Number(flags.base))));
  }
  case "undo":
    out(opResult(undo(dir, flags.base === undefined ? undefined : Number(flags.base))));
  case "redo":
    out(opResult(redo(dir, flags.base === undefined ? undefined : Number(flags.base))));
  case "still": {
    const frame = toFrame(flags.at ?? "", load(dir).meta.fps);
    if (frame === undefined) out({ error: { code: "usage", message: "still --at <frame|[hh:]mm:ss[.s]>" } });
    const r = await still(dir, frame, resolve(flags.output ?? `out/still-${frame}.jpg`)).catch(fail);
    out({ still: relative(dir, r.output!), frame });
  }
  case "render": {
    const range = flags.range?.split("-").map(Number) as [number, number] | undefined;
    if (range && !(range.length === 2 && range.every(Number.isInteger) && range[0] < range[1]))
      out({ error: { code: "usage", message: "--range <from>-<to> in frames, to exclusive" } });
    let shown = -1;
    const onProgress = (p: number) => {
      if (Math.floor(p * 10) > shown) console.error(`render ${Math.round(p * 100)}%`), (shown = Math.floor(p * 10));
    };
    const r = await render(dir, { output: resolve(flags.output ?? "out/final.mp4"), preset: flags.preset ?? "master", range, onProgress }).catch(fail);
    out({ ...r, output: relative(dir, r.output) });
  }
  case "open": {
    // Long-running: prints the URL once listening, then serves until killed.
    const { open } = await import("@splicewright/web/server");
    console.log(JSON.stringify(await open(dir, { port: Number(flags.port), onInit: agentFiles })));
    break;
  }
  case "mcp":
    await serve(dir);
    break;
  case "migrate": {
    const [from, path] = args;
    if (from !== "video-cut" || !path) out({ error: { code: "usage", message: "migrate video-cut <path> [--out <dir>]" } });
    out(migrateVideoCut(resolve(path), resolve(flags.out ?? path), { force: flags.force }));
  }
  default:
    console.error(USAGE);
    out({ error: { code: "usage", message: cmd ? `unknown command ${cmd}` : "no command" } });
}
