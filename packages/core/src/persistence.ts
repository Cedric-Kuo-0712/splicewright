import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { apply, createProject, type OpResult } from "./ops.ts";
import type { Ctx, Project } from "./schema.ts";
import { validate } from "./validate.ts";

// Spec §6. The only Node-dependent part of core.

type Err = { error: { code: string; message: string } };
interface HistoryEntry { op: string; args: unknown; project: Project; summary?: string }

export const cacheDir = (dir: string, ...parts: string[]) => join(dir, ".splicewright", ...parts);

export function writeAtomic(file: string, data: unknown) {
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

export interface Recent { path: string; title: string; openedAt: string }
// SPLICEWRIGHT_HOME replaces the home dir, so tests never touch the real one.
const recentFile = () => join(process.env.SPLICEWRIGHT_HOME ?? homedir(), ".splicewright", "recent.json");

export function recentProjects(): Recent[] {
  try {
    const l = JSON.parse(readFileSync(recentFile(), "utf8"));
    return Array.isArray(l) ? l.filter((r) => typeof r?.path === "string" && typeof r.title === "string") : [];
  } catch {
    return [];
  }
}

/** Most recent first, one entry per absolute path, at most 20. A convenience list: failing to write it is not an error. */
export function addRecent(dir: string, title: string) {
  const path = resolve(dir);
  const list = [{ path, title, openedAt: new Date().toISOString() }, ...recentProjects().filter((r) => resolve(r.path) !== path)].slice(0, 20);
  try {
    mkdirSync(dirname(recentFile()), { recursive: true });
    writeAtomic(recentFile(), list);
  } catch {}
}

export function load(dir: string): Project {
  return JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
}

/** One entry of .splicewright/assets.json, keyed by asset id (§8 probe). */
export interface Probe {
  path: string;
  fingerprint: string;
  kind: "video" | "audio" | "image";
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  /** Display-matrix rotation as ffprobe reports it. */
  rotation?: number;
  audio?: boolean;
}

export function readAssets(dir: string): Record<string, Probe> {
  const f = cacheDir(dir, "assets.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
}

/** Coded [width, height] of each probed picture asset: the composition's `sizes` prop. */
export function sizesOf(probes: Record<string, Probe>): Record<string, [number, number]> {
  return Object.fromEntries(Object.entries(probes).flatMap(([id, a]) => (a.width && a.height ? [[id, [a.width, a.height]]] : [])));
}

/** size + mtime + first and last 64 KB, hashed (§3); undefined if the file is missing. */
export function fingerprint(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const { size, mtimeMs } = statSync(file);
  const h = createHash("sha256").update(`${size}_${mtimeMs}`);
  const buf = Buffer.alloc(Math.min(size, 65536));
  const fd = openSync(file, "r");
  try {
    h.update(buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)));
    if (size > 65536) h.update(buf.subarray(0, readSync(fd, buf, 0, buf.length, size - buf.length)));
  } finally {
    closeSync(fd);
  }
  return h.digest("hex").slice(0, 16);
}

const readJson = (f: string) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined);

/** Adapter context: probe results, transcripts and beats from the ingest cache. */
export function loadCtx(dir: string): Ctx {
  const probed = readAssets(dir);
  const assetDurations: Record<string, number> = {};
  const fingerprints: Record<string, string> = {};
  for (const [id, a] of Object.entries(probed)) {
    if (typeof a.duration === "number") assetDurations[id] = a.duration;
    fingerprints[id] = a.fingerprint;
  }
  return {
    assetDurations,
    fingerprints,
    fingerprint: (path) => fingerprint(join(dir, path)),
    transcript: (assetId) => readJson(cacheDir(dir, "transcripts", `${assetId}.json`))?.segments,
    beats: (assetId) => readJson(cacheDir(dir, "beats", `${assetId}.json`)),
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
  push(dir, "undo", { op, args, project: before, summary: r.changes.summary });
  rmSync(cacheDir(dir, "history", "redo"), { recursive: true, force: true });
  return r;
}

/** Undo the latest step. With `baseRevision`, rejected unless the project is still at it, so a writer
 * undoing its own last step can't undo someone else's newer one. */
export const undo = (dir: string, baseRevision?: number) => step(dir, "undo", "redo", baseRevision);
export const redo = (dir: string, baseRevision?: number) => step(dir, "redo", "undo", baseRevision);

// History: one snapshot file per step, named by the revision it was pushed at (monotonic).
// ponytail: full snapshots, never pruned; store diffs or cap the stack if projects get large.
function step(dir: string, from: "undo" | "redo", to: "undo" | "redo", baseRevision?: number): OpResult {
  const current = load(dir);
  if (baseRevision !== undefined && baseRevision !== current.revision)
    return { error: { code: "conflict", message: `project is at revision ${current.revision}; ${from} was based on ${baseRevision}` } };
  const stack = cacheDir(dir, "history", from);
  const top = existsSync(stack) ? readdirSync(stack).sort().at(-1) : undefined;
  if (!top) return { error: { code: `nothing_to_${from}`, message: `nothing to ${from}` } };
  const entry: HistoryEntry = JSON.parse(readFileSync(join(stack, top), "utf8"));
  // Id counters only move forward, so an undone item's id is never handed to a new one.
  const ids = { ...entry.project.ids };
  for (const [k, n] of Object.entries(current.ids ?? {})) ids[k] = Math.max(ids[k] ?? 0, n);
  const restored = { ...entry.project, revision: current.revision + 1, ...(Object.keys(ids).length && { ids }) };
  const c = commit(dir, restored, current.revision);
  if ("error" in c) return c;
  rmSync(join(stack, top));
  push(dir, to, { op: entry.op, args: entry.args, project: current, summary: entry.summary });
  return { project: restored, changes: { summary: `${from} ${entry.summary ?? entry.op}` } };
}

/**
 * The latest `limit` steps of each stack, newest first: what undo (or redo) would revert next comes first.
 * ponytail: parses whole snapshots to read one line each; keep an index file if stacks get long.
 */
export function historyList(dir: string, limit = 30) {
  const list = (stack: "undo" | "redo") => {
    const d = cacheDir(dir, "history", stack);
    if (!existsSync(d)) return [];
    return readdirSync(d).sort().reverse().slice(0, limit).map((f) => {
      const e: HistoryEntry = JSON.parse(readFileSync(join(d, f), "utf8"));
      return { summary: e.summary ?? e.op, revision: e.project.revision };
    });
  };
  return { undo: list("undo"), redo: list("redo") };
}

function push(dir: string, stack: "undo" | "redo", entry: HistoryEntry) {
  const d = cacheDir(dir, "history", stack);
  mkdirSync(d, { recursive: true });
  writeAtomic(join(d, `${String(load(dir).revision).padStart(9, "0")}.json`), entry);
}

/** Byte-for-byte equal. Not fingerprint(): that includes mtime, which a fresh upload never shares,
 * and a false match here would delete the upload. Hashes whole files, but only when sizes match. */
function sameContent(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false;
  const buf = Buffer.alloc(1 << 20);
  const hash = (f: string) => {
    // In chunks: readFileSync refuses files over 2 GiB, and phone footage gets there.
    const h = createHash("sha256");
    const fd = openSync(f, "r");
    try {
      for (let n; (n = readSync(fd, buf, 0, buf.length, null)); ) h.update(buf.subarray(0, n));
    } finally {
      closeSync(fd);
    }
    return h.digest("hex");
  };
  return hash(a) === hash(b);
}

/** Moves `tmp` into raw/ under a safe version of `name` and returns its project-relative path; if a
 * file there already has the same content, `tmp` is dropped and that file's path returned. */
export function rawPath(dir: string, name: string, tmp: string): string {
  const clean = basename(name).replace(/[^\w.\- ]/g, "_").replace(/^\.+/, "") || "upload";
  const ext = extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  for (let n = 1; ; n++) {
    const rel = join("raw", n === 1 ? clean : `${stem}-${n}${ext}`);
    const file = join(dir, rel);
    if (!existsSync(file)) return renameSync(tmp, file), rel;
    if (sameContent(file, tmp)) return unlinkSync(tmp), rel;
  }
}
