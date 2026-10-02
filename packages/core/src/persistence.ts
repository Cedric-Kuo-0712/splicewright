import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { apply, createProject, type OpResult } from "./ops.ts";
import { Project as ProjectSchema, type AudioFx, type Ctx, type Project } from "./schema.ts";
import { validate } from "./validate.ts";
import { parseCube } from "./lut.ts";
import { LUT_PRESETS } from "./lut-presets.ts";
import type { SourceHealth } from "./source-health.ts";

export type { AudioMeasurement, AudioPeak, FinalMixMeasurement, SourceHealth } from "./source-health.ts";

// Spec §6. The only Node-dependent part of core.

type Err = { error: { code: string; message: string } };
interface HistoryEntry { op: string; args: unknown; project: Project; summary?: string }

export const cacheDir = (dir: string, ...parts: string[]) => join(dir, ".splicewright", ...parts);

function isInside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Resolve a user-supplied RNNoise model without allowing traversal or symlinks out of raw/. */
export function audioFxModelFile(dir: string, modelPath: string): string {
  if (isAbsolute(modelPath) || modelPath.includes("\\") || normalize(modelPath) !== modelPath || !modelPath.startsWith(`raw${sep}`) || extname(modelPath).toLowerCase() !== ".rnnn")
    throw new Error("RNNoise model must be a project-relative .rnnn file under raw/");
  try {
    const root = realpathSync(dir);
    const raw = realpathSync(join(root, "raw"));
    const file = realpathSync(resolve(root, modelPath));
    if (!isInside(root, raw) || !isInside(raw, file) || !statSync(file).isFile()) throw new Error("RNNoise model path escapes raw/ or is not a file");
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`RNNoise model is missing: ${modelPath}`);
    throw error;
  }
}

/** Full content hash so replacing a model at the same path invalidates its derived audio. */
export function audioFxModelFingerprint(dir: string, modelPath: string): string {
  return createHash("sha256").update(readFileSync(audioFxModelFile(dir, modelPath))).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Same hashed project-relative path used by ingest for an item's full-source baked audio. */
export function audioFxCachePath(dir: string, assetId: string, sourcePath: string, audioFx: AudioFx, modelStamp?: string): string {
  const source = fingerprint(join(dir, sourcePath));
  if (!source) throw new Error(`audioFx source missing for ${assetId}: ${sourcePath}`);
  const model = modelStamp ?? (audioFx.denoise?.kind === "rnnoise" ? audioFxModelFingerprint(dir, audioFx.denoise.model ?? "") : "");
  const hash = createHash("sha256").update(`${source}\n${model}\n${stableJson(audioFx)}`).digest("hex").slice(0, 20);
  return `.splicewright/audio/${assetId.replace(/[^A-Za-z0-9._-]/g, "_")}-${hash}.m4a`;
}

function projectLutPath(dir: string, path: string) {
  const root = realpathSync(dir), file = realpathSync(resolve(dir, path));
  if (!file.startsWith(root + sep)) throw new Error(`LUT asset path escapes project directory: ${path}`);
  return file;
}

export function writeAtomic(file: string, data: unknown) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

/** Synchronous, short-held project mutation lock shared by every project writer. */
function withProjectLock<T>(dir: string, work: () => T): T | Err {
  const lock = cacheDir(dir, "project.lock");
  mkdirSync(dirname(lock), { recursive: true });
  let fd: number;
  try { fd = openSync(lock, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const recovery = `${lock}.recovery`;
    let recoveryFd: number;
    try { recoveryFd = openSync(recovery, "wx"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return { error: { code: "busy", message: "project lock recovery is busy" } }; throw e; }
    try {
      const pid = Number(readFileSync(lock, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) return { error: { code: "busy", message: "project mutation lock is busy" } };
      try { process.kill(pid, 0); return { error: { code: "busy", message: "project mutation lock is busy" } }; }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ESRCH") return { error: { code: "busy", message: "project mutation lock is busy" } }; }
      unlinkSync(lock);
      fd = openSync(lock, "wx");
    } catch (retry) {
      if (["EEXIST", "ENOENT"].includes((retry as NodeJS.ErrnoException).code ?? "")) return { error: { code: "busy", message: "project mutation lock is busy" } };
      throw retry;
    } finally { closeSync(recoveryFd); unlinkSync(recovery); }
  }
  try { writeFileSync(fd, String(process.pid)); return work(); }
  finally { closeSync(fd); unlinkSync(lock); }
}

export function init(dir: string, meta: Project["meta"]): Project | Err {
  if (existsSync(join(dir, "project.json"))) return { error: { code: "exists", message: `${dir}/project.json already exists` } };
  mkdirSync(dir, { recursive: true });
  const p = createProject({ ...meta, limiter: true });
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
  /** Content stamp of each completed ingest step. */
  done?: Partial<Record<string, string>>;
  kind: "video" | "audio" | "image" | "font";
  duration?: number;
  width?: number;
  height?: number;
  /** True when ffprobe found multiple decoded image frames (GIF/animated WebP/PNG). */
  animated?: boolean;
  /** Image probe format version; older entries need animated-frame detection. */
  imageProbeVersion?: number;
  fps?: number;
  /** Display-matrix rotation as ffprobe reports it. */
  rotation?: number;
  audio?: boolean;
  /** Integrated loudness in LUFS (ebur128); absent for silent assets. */
  loudness?: number;
  /** Full source decode and audio peak measurement; valid only for this path and fingerprint. */
  sourceHealth?: SourceHealth;
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
export function loadCtx(dir: string, project = load(dir)): Ctx & { sourceHealth: Record<string, SourceHealth> } {
  const probed = readAssets(dir);
  const assetDurations: Record<string, number> = {};
  const fingerprints: Record<string, string> = {};
  const loudness: Record<string, number> = {};
  const audioFxLoudness: Record<string, number> = {};
  const sourceHealth: Record<string, SourceHealth> = {};
  for (const [id, a] of Object.entries(probed)) {
    // Keep historical fingerprints for importAsset identity/relink matching; measurement data must match the live asset.
    fingerprints[id] = a.fingerprint;
    const asset = project.assets[id];
    if (!asset || asset.path !== a.path || fingerprint(join(dir, asset.path)) !== a.fingerprint) continue;
    if (typeof a.duration === "number") assetDurations[id] = a.duration;
    if (typeof a.loudness === "number") loudness[id] = a.loudness;
    if (a.sourceHealth?.path === a.path && a.sourceHealth.fingerprint === a.fingerprint) sourceHealth[id] = a.sourceHealth;
  }
  for (const track of project.tracks) for (const item of track.items) {
    if (!("audioFx" in item) || !item.audioFx || !("assetId" in item)) continue;
    const asset = project.assets[item.assetId];
    if (!asset) continue;
    try {
      const cache = readJson(join(dir, `${audioFxCachePath(dir, asset.id, asset.path, item.audioFx)}.json`));
      if (typeof cache?.lufs === "number") audioFxLoudness[item.id] = cache.lufs;
    } catch { /* missing or stale bake remains unavailable to normalization */ }
  }
  return {
    assetDurations,
    fingerprints,
    loudness,
    sourceHealth,
    audioFxLoudness,
    validateLut: (path) => parseCube(readFileSync(projectLutPath(dir, path), "utf8")),
    fingerprint: (path) => fingerprint(join(dir, path)),
    transcript: (assetId) => readJson(cacheDir(dir, "transcripts", `${assetId}.json`))?.segments,
    beats: (assetId) => readJson(cacheDir(dir, "beats", `${assetId}.json`)),
  };
}

/**
 * Atomic, optimistic write: rejected unless the on-disk revision is `baseRevision`,
 * and never writes a project that fails validation.
 */
function commitUnlocked(dir: string, project: Project, baseRevision: number, ctx = loadCtx(dir)): { revision: number } | Err {
  const disk = load(dir);
  if (disk.revision !== baseRevision)
    return { error: { code: "conflict", message: `project is at revision ${disk.revision}; write was based on ${baseRevision}` } };
  const errs = validate(project, disk, ctx);
  if (errs.length) return { error: { code: "invalid", message: errs.join("; ") } };
  writeAtomic(join(dir, "project.json"), project);
  return { revision: project.revision };
}

export function commit(dir: string, project: Project, baseRevision: number, ctx = loadCtx(dir)): { revision: number } | Err {
  return withProjectLock(dir, () => commitUnlocked(dir, project, baseRevision, ctx));
}

/** Load, apply one op, commit, and record an undo step. What the CLI and MCP call. */
export function run(dir: string, op: string, args: unknown, baseRevision?: number, context?: Partial<Ctx>): OpResult {
  return withProjectLock(dir, () => runUnlocked(dir, op, args, baseRevision, context));
}
function runUnlocked(dir: string, op: string, args: unknown, baseRevision?: number, context?: Partial<Ctx>): OpResult {
  const before = load(dir);
  if (baseRevision !== undefined && baseRevision !== before.revision)
    return { error: { code: "conflict", message: `project is at revision ${before.revision}; op was based on ${baseRevision}` } };
  const ctx = { ...loadCtx(dir), ...context };
  const r = apply(before, op, args, ctx);
  if ("error" in r) return r;
  const c = commitUnlocked(dir, r.project, before.revision, ctx);
  if ("error" in c) return c;
  push(dir, "undo", { op, args, project: before, summary: r.changes.summary });
  rmSync(cacheDir(dir, "history", "redo"), { recursive: true, force: true });
  return r;
}

type EditReview = {
  version: 1; id: string; label: string; summary: string; createdAt: string;
  beforeRevision: number; afterRevision: number; status: "pending" | "kept" | "dismissed" | "reverted";
  before: Project; after: Project; revertedAtRevision?: number;
};
const editReviewFile = (dir: string) => cacheDir(dir, "edit-review.json");
const reviewSchema = z.object({
  version: z.literal(1), id: z.string().uuid(),
  label: z.string().min(1).max(160), summary: z.string().min(1).max(2000),
  createdAt: z.string().datetime(), beforeRevision: z.number().int().min(0),
  afterRevision: z.number().int().min(1),
  status: z.enum(["pending", "kept", "dismissed", "reverted"]),
  before: ProjectSchema, after: ProjectSchema, revertedAtRevision: z.number().int().min(1).optional(),
});
function readEditReview(dir: string): EditReview | undefined {
  const file = editReviewFile(dir);
  if (!existsSync(file)) return undefined;
  if (statSync(file).size > 128 * 1024 * 1024) throw new Error("edit review record exceeds 128 MiB limit");
  const parsed = reviewSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`invalid edit review record: ${parsed.error.message}`);
  const r = parsed.data as EditReview;
  if (r.before.revision !== r.beforeRevision || r.after.revision !== r.afterRevision || r.afterRevision !== r.beforeRevision + 1)
    throw new Error("invalid edit review record revisions");
  return r;
}
function reviewSummary(before: Project, after: Project, supplied?: string) {
  if (supplied?.trim()) return supplied.trim().slice(0, 2000);
  const clips = (p: Project) => new Map(p.tracks.flatMap((t) => t.items.map((i) => [i.id, { track: t.id, item: i } as const])));
  const a = clips(before), b = clips(after);
  const added = [...b.keys()].filter((id) => !a.has(id)).length;
  const removed = [...a.keys()].filter((id) => !b.has(id)).length;
  const changed = [...a.keys()].filter((id) => b.has(id) && stableJson(a.get(id)) !== stableJson(b.get(id))).length;
  const trackIds = new Set([...before.tracks, ...after.tracks].map((t) => t.id));
  const tracksChanged = [...trackIds].filter((id) => JSON.stringify(before.tracks.find((t) => t.id === id)) !== JSON.stringify(after.tracks.find((t) => t.id === id))).length;
  const metaChanged = JSON.stringify(before.meta) !== JSON.stringify(after.meta);
  const assetsChanged = stableJson(before.assets) !== stableJson(after.assets);
  const markersChanged = stableJson(before.markers) !== stableJson(after.markers);
  return `${added} clips added, ${removed} removed, ${changed} changed; ${tracksChanged} tracks changed${metaChanged ? "; project settings changed" : ""}${assetsChanged ? "; assets changed" : ""}${markersChanged ? "; markers changed" : ""}`;
}

/** Apply one agent round atomically and preserve bounded before/after snapshots for review. */
export function applyEditReview(dir: string, ops: Array<{ op: string; args: unknown }>, options: { label?: string; summary?: string; baseRevision?: number } = {}): OpResult | { error: { code: string; message: string }; review?: never } {
  const input = z.object({ ops: z.array(z.object({ op: z.string().min(1), args: z.unknown() })).min(1), options: z.object({ label: z.string().trim().min(1).max(160).optional(), summary: z.string().trim().min(1).max(2000).optional(), baseRevision: z.number().int().min(0).optional() }) }).safeParse({ ops, options });
  if (!input.success) return { error: { code: "invalid_args", message: z.prettifyError(input.error) } };
  options = input.data.options;
  return withProjectLock(dir, () => {
    const before = load(dir);
    try { readEditReview(dir); } catch (error) { return { error: { code: "invalid_review", message: (error as Error).message } }; }
    if (options.baseRevision !== undefined && options.baseRevision !== before.revision)
      return { error: { code: "conflict", message: `project is at revision ${before.revision}; review was based on ${options.baseRevision}` } };
    const ctx = loadCtx(dir);
    const r = apply(before, "batch", { ops }, ctx);
    if ("error" in r) return r;
    const record: EditReview = {
      version: 1, id: randomUUID(), label: (options.label?.trim() || "Agent edit review").slice(0, 160),
      summary: reviewSummary(before, r.project, options.summary), createdAt: new Date().toISOString(),
      beforeRevision: before.revision, afterRevision: r.project.revision, status: "pending",
      before, after: r.project,
    };
    const historyFile = join(cacheDir(dir, "history", "undo"), `${String(r.project.revision).padStart(9, "0")}.json`);
    const ledgerFile = editReviewFile(dir);
    const priorLedger = existsSync(ledgerFile) ? readFileSync(ledgerFile) : undefined;
    let historyWritten = false, committed = false;
    const redo = cacheDir(dir, "history", "redo"), retiredRedo = cacheDir(dir, "history", `redo-retired-${record.id}`);
    let retired = false;
    try {
      mkdirSync(dirname(historyFile), { recursive: true });
      writeAtomic(historyFile, { op: "apply_edit_review", args: { id: record.id }, project: before, summary: options.summary ?? `agent review: ${record.label}` });
      historyWritten = true;
      writeAtomic(ledgerFile, record);
      if (existsSync(redo)) { renameSync(redo, retiredRedo); retired = true; }
      const c = commitUnlocked(dir, r.project, before.revision, ctx);
      if ("error" in c) throw Object.assign(new Error(c.error.message), { result: c });
      committed = true;
      if (retired) rmSync(retiredRedo, { recursive: true, force: true });
      return { project: r.project, changes: { summary: record.summary }, review: { id: record.id, label: record.label, summary: record.summary, beforeRevision: record.beforeRevision, afterRevision: record.afterRevision, status: record.status } } as any;
    } catch (error) {
      if (committed) return { project: r.project, changes: { summary: `${record.summary} (redo cache cleanup failed)` }, review: { id: record.id, label: record.label, summary: record.summary, beforeRevision: record.beforeRevision, afterRevision: record.afterRevision, status: record.status } } as OpResult;
      if (retired) renameSync(retiredRedo, redo);
      if (historyWritten) rmSync(historyFile, { force: true });
      if (priorLedger) writeFileSync(ledgerFile, priorLedger); else rmSync(ledgerFile, { force: true });
      const result = (error as { result?: OpResult }).result;
      return result ?? { error: { code: "persistence_failed", message: `review transaction was not committed: ${(error as Error).message}` } };
    }
  }) as OpResult;
}

export function getEditReview(dir: string, id?: string, includeSnapshots?: false): Omit<EditReview, "before" | "after"> | undefined;
export function getEditReview(dir: string, id: string | undefined, includeSnapshots: true): EditReview | undefined;
export function getEditReview(dir: string, id: string | undefined, includeSnapshots: boolean): EditReview | Omit<EditReview, "before" | "after"> | undefined;
export function getEditReview(dir: string, id?: string, includeSnapshots = false): EditReview | Omit<EditReview, "before" | "after"> | undefined {
  const record = readEditReview(dir);
  if (!record || (id && record.id !== id)) return undefined;
  const { before, after, ...summary } = record;
  return includeSnapshots ? { ...summary, before, after } : summary;
}

export function setEditReviewStatus(dir: string, id: string, status: "kept" | "dismissed") {
  return withProjectLock(dir, () => {
    if (status !== "kept" && status !== "dismissed") return { error: { code: "invalid_args", message: "status must be kept or dismissed" } };
    const record = readEditReview(dir);
    if (!record || record.id !== id) return { error: { code: "not_found", message: "edit review not found" } };
    if (load(dir).revision !== record.afterRevision || record.status === "reverted") return { error: { code: "conflict", message: "review is no longer the current project revision" } };
    record.status = status; writeAtomic(editReviewFile(dir), record); return { id, status };
  });
}

/** Restore the before snapshot at a new revision, as one ordinary undoable step. */
export function revertEditReview(dir: string, id: string, baseRevision?: number): OpResult {
  return withProjectLock(dir, () => {
    const current = load(dir), record = readEditReview(dir);
    if (baseRevision !== undefined && current.revision !== baseRevision) return { error: { code: "conflict", message: `project is at revision ${current.revision}; revert was based on ${baseRevision}` } };
    if (!record || record.id !== id) return { error: { code: "not_found", message: "edit review not found" } };
    if (record.status === "reverted") return { error: { code: "conflict", message: "review was already reverted" } };
    if (current.revision !== record.afterRevision || stableJson(current) !== stableJson(record.after)) return { error: { code: "conflict", message: "project changed after this review; refusing to overwrite later edits" } };
    const ids = { ...record.before.ids };
    for (const [k, n] of Object.entries(current.ids ?? {})) ids[k] = Math.max(ids[k] ?? 0, n);
    const restored = { ...record.before, revision: current.revision + 1, ...(Object.keys(ids).length && { ids }) };
    record.status = "reverted"; record.revertedAtRevision = restored.revision;
    const historyFile = join(cacheDir(dir, "history", "undo"), `${String(restored.revision).padStart(9, "0")}.json`);
    const priorLedger = readFileSync(editReviewFile(dir)); let wroteHistory = false, committed = false;
    const redo = cacheDir(dir, "history", "redo"), retiredRedo = cacheDir(dir, "history", `redo-retired-${randomUUID()}`);
    let retired = false;
    try {
      mkdirSync(dirname(historyFile), { recursive: true });
      writeAtomic(historyFile, { op: "revert_edit_review", args: { id }, project: current, summary: `revert agent review: ${record.label}` }); wroteHistory = true;
      writeAtomic(editReviewFile(dir), record);
      if (existsSync(redo)) { renameSync(redo, retiredRedo); retired = true; }
      const c = commitUnlocked(dir, restored, current.revision);
      if ("error" in c) throw Object.assign(new Error(c.error.message), { result: c });
      committed = true;
      if (retired) rmSync(retiredRedo, { recursive: true, force: true });
      return { project: restored, changes: { summary: `reverted review: ${record.label}` } };
    } catch (error) {
      if (committed) return { project: restored, changes: { summary: `reverted review: ${record.label} (redo cache cleanup failed)` } };
      if (retired) renameSync(retiredRedo, redo);
      if (wroteHistory) rmSync(historyFile, { force: true }); writeFileSync(editReviewFile(dir), priorLedger);
      return (error as { result?: OpResult }).result ?? { error: { code: "persistence_failed", message: `review revert was not committed: ${(error as Error).message}` } };
    }
  }) as OpResult;
}

/** Copy one registry-owned built-in LUT into raw/ and assign it in one project history step. */
export function applyLutPreset(dir: string, itemId: string, presetId: string, baseRevision?: number, at?: number): OpResult {
  const locked = withProjectLock(dir, () => applyLutPresetUnlocked(dir, itemId, presetId, baseRevision, at));
  return locked;
}
function applyLutPresetUnlocked(dir: string, itemId: string, presetId: string, baseRevision?: number, at?: number): OpResult {
  const before = load(dir);
  if (baseRevision !== undefined && baseRevision !== before.revision)
    return { error: { code: "conflict", message: `project is at revision ${before.revision}; preset was based on ${baseRevision}` } };
  const preset = LUT_PRESETS.find((entry) => entry.id === presetId);
  if (!preset) return { error: { code: "invalid", message: `unknown LUT preset: ${presetId}` } };
  const track = before.tracks.find((t) => t.kind === "video" && t.items.some((i) => i.id === itemId));
  const item = track?.kind === "video" ? track.items.find((i) => i.id === itemId) : undefined;
  if (!item) return { error: { code: "not_found", message: `video item ${itemId} not found` } };

  const createdFiles: string[] = [];
  const rollback = () => createdFiles.forEach((file) => rmSync(file, { force: true }));
  let committedProject: Project | undefined;
  const libraryRoot = dirname(fileURLToPath(import.meta.url));
  const source = resolve(libraryRoot, "../assets", preset.file);
  try {
    if (!existsSync(source)) return { error: { code: "not_found", message: `built-in LUT file missing: ${presetId}` } };
    const bundled = readFileSync(source);
    const bytes = preset.file.endsWith(".gz") ? gunzipSync(bundled) : bundled;
    const sourceBlob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const assetId = `a_lut_${sha}`;
    const relativePath = `raw/luts/${preset.id}-${sha.slice(0, 16)}.cube`;
    const destination = resolve(dir, relativePath);
    if (!destination.startsWith(resolve(dir) + sep)) return { error: { code: "invalid", message: "built-in LUT destination escapes project root" } };
    if (sourceBlob !== preset.sourceGitBlobSha1 && preset.format === "cube")
      return { error: { code: "invalid", message: `built-in LUT source checksum mismatch: ${presetId}` } };
    if (preset.format === "hald-rgb8-to-cube-gzip65") {
      const recordPath = resolve(libraryRoot, "../assets/luts/film/build-record.json");
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as { results: { source_git_blob_sha1: string; compressed_sha256: string; cube_sha256: string }[] };
      const entry = record.results.find((candidate) => candidate.source_git_blob_sha1 === preset.sourceGitBlobSha1);
      if (!entry || createHash("sha256").update(bundled).digest("hex") !== entry.compressed_sha256 || sha !== entry.cube_sha256)
        return { error: { code: "invalid", message: `built-in LUT provenance checksum mismatch: ${presetId}` } };
    }
    parseCube(bytes.toString("utf8"));
    const existingAsset = before.assets[assetId];
    if (existingAsset && (existingAsset.path !== relativePath || existingAsset.kind !== "lut"))
      return { error: { code: "conflict", message: `LUT asset id collision: ${assetId}` } };
    const root = realpathSync(dir);
    const rawDirectory = resolve(dir, "raw"), lutDirectory = dirname(destination);
    for (const directory of [rawDirectory, lutDirectory]) {
      if (!existsSync(directory)) mkdirSync(directory);
      else if (lstatSync(directory).isSymbolicLink() || !realpathSync(directory).startsWith(root + sep))
        return { error: { code: "invalid", message: "project raw directory escapes project root" } };
    }
    const parent = realpathSync(lutDirectory);
    if (!parent.startsWith(root + sep)) return { error: { code: "invalid", message: "project raw directory escapes project root" } };
    const targetExists = existsSync(destination);
    if (targetExists) {
      if (lstatSync(destination).isSymbolicLink() || !realpathSync(destination).startsWith(root + sep))
        return { error: { code: "invalid", message: `project LUT destination escapes project root: ${relativePath}` } };
      if (createHash("sha256").update(readFileSync(destination)).digest("hex") !== sha)
        return { error: { code: "conflict", message: `project LUT path contains different data: ${relativePath}` } };
    }
    if (existingAsset && !targetExists)
      return { error: { code: "not_found", message: `project LUT asset is missing: ${relativePath}` } };

    if (!targetExists) {
      const temp = `${destination}.tmp-${process.pid}`;
      try {
        writeFileSync(temp, bytes, { flag: "wx" });
        renameSync(temp, destination);
        createdFiles.push(destination);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    }
    const licenseSource = resolve(libraryRoot, "../assets", preset.licenseFile);
    const licenseName = preset.format === "cube" ? "stripedpurple-MIT.txt" : "t3mujinpack-MIT.txt";
    const licensePath = `raw/luts/licenses/${licenseName}`;
    const licenseDestination = resolve(dir, licensePath);
    mkdirSync(dirname(licenseDestination), { recursive: true });
    const licenseParent = realpathSync(dirname(licenseDestination));
    if (!licenseParent.startsWith(root + sep)) {
      rollback();
      return { error: { code: "invalid", message: "project LUT license directory escapes project root" } };
    }
    const licenseBytes = readFileSync(licenseSource);
    if (existsSync(licenseDestination)) {
      if (lstatSync(licenseDestination).isSymbolicLink() || !realpathSync(licenseDestination).startsWith(root + sep) || !readFileSync(licenseDestination).equals(licenseBytes)) {
        rollback();
        return { error: { code: "conflict", message: `project LUT license file is different: ${licensePath}` } };
      }
    } else {
      const temp = `${licenseDestination}.tmp-${process.pid}`;
      try {
        writeFileSync(temp, licenseBytes, { flag: "wx" });
        renameSync(temp, licenseDestination);
        createdFiles.push(licenseDestination);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    }
    const attributionPath = `raw/luts/licenses/${preset.id}-attribution.json`;
    const attributionDestination = resolve(dir, attributionPath);
    const attribution = Buffer.from(`${JSON.stringify({
      presetId: preset.id,
      name: preset.name,
      credit: preset.credit,
      license: preset.license,
      source: preset.source,
      sourcePath: preset.sourcePath,
      sourceCommit: preset.commit,
      sourceGitBlobSha1: preset.sourceGitBlobSha1,
      bundledCubeSha256: sha,
      inputProfile: preset.inputProfile,
      sourceImageProfile: "sourceImageProfile" in preset ? preset.sourceImageProfile : undefined,
      format: preset.format,
      licenseFile: licenseName,
    }, null, 2)}\n`);
    if (existsSync(attributionDestination)) {
      if (lstatSync(attributionDestination).isSymbolicLink() || !realpathSync(attributionDestination).startsWith(root + sep) || !readFileSync(attributionDestination).equals(attribution)) {
        rollback();
        return { error: { code: "conflict", message: `project LUT attribution file is different: ${attributionPath}` } };
      }
    } else {
      const temp = `${attributionDestination}.tmp-${process.pid}`;
      try {
        writeFileSync(temp, attribution, { flag: "wx" });
        renameSync(temp, attributionDestination);
        createdFiles.push(attributionDestination);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    }
    const currentGradeLut = item.grade?.lut;
    if (existingAsset && currentGradeLut?.assetId === assetId && (currentGradeLut.strength ?? 1) === 1)
      return { project: before, changes: { summary: `LUT preset ${preset.name} is already applied to ${itemId}` } };
    const project: Project = structuredClone(before);
    if (!existingAsset) project.assets[assetId] = { id: assetId, path: relativePath, kind: "lut" };
    const edited = project.tracks.find((t) => t.kind === "video" && t.items.some((i) => i.id === itemId));
    const editedItem = edited?.kind === "video" ? edited.items.find((i) => i.id === itemId) : undefined;
    if (!editedItem) {
      rollback();
      return { error: { code: "not_found", message: `video item ${itemId} not found` } };
    }
    if (at === undefined) editedItem.grade = { ...editedItem.grade, lut: { assetId, strength: 1 } };
    else {
      const keyed = apply(project, "setLutKeyframe", { itemId, at, assetId }, loadCtx(dir));
      if ("error" in keyed) { rollback(); return keyed; }
      Object.assign(project, keyed.project);
    }
    project.revision = before.revision + 1;
    const ctx = loadCtx(dir);
    const errors = validate(project, before, ctx);
    if (errors.length) {
      rollback();
      return { error: { code: "invalid", message: errors.join("; ") } };
    }
    const committed = commitUnlocked(dir, project, before.revision, ctx);
    if ("error" in committed) {
      rollback();
      return committed;
    }
    committedProject = project;
    const summary = `applied LUT preset ${preset.name} to ${itemId}`;
    push(dir, "undo", { op: "applyLutPreset", args: { itemId, presetId }, project: before, summary });
    rmSync(cacheDir(dir, "history", "redo"), { recursive: true, force: true });
    return { project, changes: { summary } };
  } catch (error) {
    if (committedProject) return { project: committedProject, changes: { summary: `applied LUT preset ${preset.name} to ${itemId}; undo history failed: ${error instanceof Error ? error.message : String(error)}` } };
    rollback();
    return { error: { code: "invalid", message: error instanceof Error ? error.message : String(error) } };
  }
}

/** Undo the latest step. With `baseRevision`, rejected unless the project is still at it, so a writer
 * undoing its own last step can't undo someone else's newer one. */
export const undo = (dir: string, baseRevision?: number) => step(dir, "undo", "redo", baseRevision);
export const redo = (dir: string, baseRevision?: number) => step(dir, "redo", "undo", baseRevision);

// History: one snapshot file per step, named by the revision it was pushed at (monotonic).
// ponytail: full snapshots, never pruned; store diffs or cap the stack if projects get large.
function step(dir: string, from: "undo" | "redo", to: "undo" | "redo", baseRevision?: number): OpResult {
  const locked = withProjectLock(dir, () => stepUnlocked(dir, from, to, baseRevision));
  return locked;
}
function stepUnlocked(dir: string, from: "undo" | "redo", to: "undo" | "redo", baseRevision?: number): OpResult {
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
  const c = commitUnlocked(dir, restored, current.revision);
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
