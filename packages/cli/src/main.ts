#!/usr/bin/env node
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getSummary } from "@splicewright/core";
import { init, load, redo, run, undo } from "@splicewright/core/node";
import { serve } from "@splicewright/mcp";
import { render, still } from "@splicewright/render/node";
import { migrateVideoCut } from "./migrate.ts";

// Spec §7.1. Every command prints one JSON object on stdout; errors exit 1.
// ingest arrives with M5.

const USAGE = `usage: splicewright <command>
  init [--title T] [--fps 30] [--size 1920x1080]
  import <paths...>
  status
  op <opName> '<json args>' [--base <revision>]
  undo | redo
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
    size: { type: "string", default: "1920x1080" },
    base: { type: "string" },
    out: { type: "string" },
    force: { type: "boolean" },
    at: { type: "string" },
    output: { type: "string", short: "o" },
    preset: { type: "string", default: "master" },
    range: { type: "string" },
    port: { type: "string", default: "5190" },
  },
});
const [cmd, ...args] = positionals;
const dir = process.cwd();
const fail = (e: Error): never => out({ error: { code: "render_failed", message: e.message } });

/** Frame number, or [hh:]mm:ss[.s] timecode, to a timeline frame. */
function toFrame(at: string, fps: number): number | undefined {
  if (/^\d+$/.test(at)) return Number(at);
  if (!/^(\d+:)?\d+:\d+(\.\d+)?$/.test(at)) return undefined;
  return Math.round(at.split(":").reduce((s, v) => s * 60 + Number(v), 0) * fps);
}

const opResult = (r: ReturnType<typeof run>) =>
  "error" in r ? r : { revision: r.project.revision, summary: r.changes.summary };

switch (cmd) {
  case "init": {
    const [width, height] = flags.size!.split("x").map(Number);
    const fps = Number(flags.fps);
    const title = flags.title ?? dir.split(/[/\\]/).pop()!;
    const r = init(dir, { title, fps, width, height });
    out("error" in r ? r : { created: "project.json", revision: r.revision });
  }
  case "import": {
    if (!args.length) out({ error: { code: "usage", message: "import <paths...>" } });
    out({ results: args.map((p) => opResult(run(dir, "importAsset", { path: relative(dir, resolve(p)) }))) });
  }
  case "status":
    out(getSummary(load(dir)));
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
    out(opResult(undo(dir)));
  case "redo":
    out(opResult(redo(dir)));
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
    const r = await render(dir, { output: resolve(flags.output ?? "out/final.mp4"), preset: flags.preset, range, onProgress }).catch(fail);
    out({ ...r, output: relative(dir, r.output) });
  }
  case "open": {
    // Long-running: prints the URL once listening, then serves until killed.
    const { open } = await import("@splicewright/web/server");
    console.log(JSON.stringify(await open(dir, { port: Number(flags.port) })));
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
