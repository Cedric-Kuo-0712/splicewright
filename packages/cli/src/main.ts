#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { ASPECTS, FONT_PAIRS, FONTS, getSummary, lint, LUT_PRESETS, THEME_IDS } from "@splicewright/core";
import { applyLutPreset, init, load, rawPath, redo, run, undo } from "@splicewright/core/node";
import { displayable, ingest, STEPS, type Step } from "@splicewright/ingest";
import { serve } from "@splicewright/mcp";
import { render, still } from "@splicewright/render/node";
import { provisionAgentSkills } from "./agent-skills.ts";
import { migrateVideoCut } from "./migrate.ts";

// Spec §7.1. Every command prints one JSON object on stdout; errors exit 1.

const USAGE = `usage: splicewright <command>
  init [--title T] [--fps 30] [--size 1920x1080 | --preset 16:9|9:16|1:1|4:5] [--refresh-agents]
  import <paths...> [--no-ingest]
  ingest [--only proxy,reverse,analysis,thumbs,waveform,transcript,beats] [--jobs N]
  status
  lint
  op <opName> '<json args>' [--base <revision>]
  lut-presets
  apply-lut-preset <itemId> <presetId> [--base <revision>]
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
  },
});
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
  case "status":
    out(getSummary(load(dir)));
  case "lint":
    out(lint(load(dir)));
  case "lut-presets":
    out({ presets: LUT_PRESETS });
  case "apply-lut-preset": {
    const [itemId, presetId] = args;
    if (!itemId || !presetId) out({ error: { code: "usage", message: "apply-lut-preset <itemId> <presetId> [--base <revision>]" } });
    out(opResult(applyLutPreset(dir, itemId, presetId, flags.base === undefined ? undefined : Number(flags.base))));
  }
  case "op": {
    const [name, raw = "{}"] = args;
    if (!name) out({ error: { code: "usage", message: "op <opName> '<json args>'" } });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      out({ error: { code: "invalid_args", message: `args are not JSON: ${(e as Error).message}` } });
    }
    out(opResult(run(dir, name, parsed, flags.base === undefined ? undefined : Number(flags.base))));
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
