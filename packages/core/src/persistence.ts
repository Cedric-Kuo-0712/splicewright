import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apply, createProject, type OpResult } from "./ops.ts";
import type { Ctx, Project } from "./schema.ts";
import { validate } from "./validate.ts";

// Spec §6. The only Node-dependent part of core.

type Err = { error: { code: string; message: string } };
interface HistoryEntry { op: string; args: unknown; project: Project }

const cacheDir = (dir: string, ...parts: string[]) => join(dir, ".splicewright", ...parts);

function writeAtomic(file: string, data: unknown) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

export function init(dir: string, meta: Project["meta"]): Project | Err {
  if (existsSync(join(dir, "project.json"))) return { error: { code: "exists", message: `${dir}/project.json already exists` } };
  mkdirSync(dir, { recursive: true });
  const p = createProject(meta);
  writeAtomic(join(dir, "project.json"), p);
  return p;
}

export function load(dir: string): Project {
  return JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
}

/** Adapter context: probed durations and transcripts from the ingest cache. */
export function loadCtx(dir: string): Ctx {
  const assetsFile = cacheDir(dir, "assets.json");
  // ponytail: cache file formats are provisional until the M5 ingest port defines them.
  const probed: Record<string, { duration?: number }> = existsSync(assetsFile) ? JSON.parse(readFileSync(assetsFile, "utf8")) : {};
  const assetDurations: Record<string, number> = {};
  for (const [id, a] of Object.entries(probed)) if (typeof a.duration === "number") assetDurations[id] = a.duration;
  return {
    assetDurations,
    transcript: (assetId) => {
      const f = cacheDir(dir, "transcripts", `${assetId}.json`);
      return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).segments : undefined;
    },
  };
}

/**
 * Atomic, optimistic write: rejected unless the on-disk revision is `baseRevision`,
 * and never writes a project that fails validation.
 */
// ponytail: check-then-rename is not a cross-process lock; add a lockfile if two writers race in practice.
export function commit(dir: string, project: Project, baseRevision: number, ctx = loadCtx(dir)): { revision: number } | Err {
  const disk = load(dir);
  if (disk.revision !== baseRevision)
    return { error: { code: "conflict", message: `project is at revision ${disk.revision}; write was based on ${baseRevision}` } };
  const errs = validate(project, disk, ctx);
  if (errs.length) return { error: { code: "invalid", message: errs.join("; ") } };
  writeAtomic(join(dir, "project.json"), project);
  return { revision: project.revision };
}

/** Load, apply one op, commit, and record an undo step. What the CLI and MCP call. */
export function run(dir: string, op: string, args: unknown, baseRevision?: number): OpResult {
  const before = load(dir);
  if (baseRevision !== undefined && baseRevision !== before.revision)
    return { error: { code: "conflict", message: `project is at revision ${before.revision}; op was based on ${baseRevision}` } };
  const ctx = loadCtx(dir);
  const r = apply(before, op, args, ctx);
  if ("error" in r) return r;
  const c = commit(dir, r.project, before.revision, ctx);
  if ("error" in c) return c;
  push(dir, "undo", { op, args, project: before });
  rmSync(cacheDir(dir, "history", "redo"), { recursive: true, force: true });
  return r;
}

export const undo = (dir: string) => step(dir, "undo", "redo");
export const redo = (dir: string) => step(dir, "redo", "undo");

// History: one snapshot file per step, named by the revision it was pushed at (monotonic).
// ponytail: full snapshots, never pruned; store diffs or cap the stack if projects get large.
function step(dir: string, from: "undo" | "redo", to: "undo" | "redo"): OpResult {
  const stack = cacheDir(dir, "history", from);
  const top = existsSync(stack) ? readdirSync(stack).sort().at(-1) : undefined;
  if (!top) return { error: { code: `nothing_to_${from}`, message: `nothing to ${from}` } };
  const entry: HistoryEntry = JSON.parse(readFileSync(join(stack, top), "utf8"));
  const current = load(dir);
  const restored = { ...entry.project, revision: current.revision + 1 };
  const c = commit(dir, restored, current.revision);
  if ("error" in c) return c;
  rmSync(join(stack, top));
  push(dir, to, { op: entry.op, args: entry.args, project: current });
  return { project: restored, changes: { summary: `${from} ${entry.op}` } };
}

function push(dir: string, stack: "undo" | "redo", entry: HistoryEntry) {
  const d = cacheDir(dir, "history", stack);
  mkdirSync(d, { recursive: true });
  writeAtomic(join(d, `${String(load(dir).revision).padStart(9, "0")}.json`), entry);
}
