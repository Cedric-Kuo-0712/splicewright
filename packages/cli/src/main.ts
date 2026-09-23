#!/usr/bin/env node
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getSummary } from "@splicewright/core";
import { init, load, redo, run, undo } from "@splicewright/core/node";
import { serve } from "@splicewright/mcp";
import { migrateVideoCut } from "./migrate.ts";

// Spec §7.1. Every command prints one JSON object on stdout; errors exit 1.
// open / still / render / ingest arrive with M3–M5.

const USAGE = `usage: splicewright <command>
  init [--title T] [--fps 30] [--size 1920x1080]
  import <paths...>
  status
  op <opName> '<json args>' [--base <revision>]
  undo | redo
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
  },
});
const [cmd, ...args] = positionals;
const dir = process.cwd();
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
