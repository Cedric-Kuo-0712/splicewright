import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, join, resolve, sep } from "node:path";
import { type Asset } from "@splicewright/core";
import { cacheDir, fingerprint, load, loadCtx, readAssets, run as runOp, writeAtomic } from "@splicewright/core/node";
import { ingest, probe, scratch } from "./index.ts";

const KINDS: Record<string, Asset["kind"]> = {
  mp4: "video", mov: "video", m4v: "video", mkv: "video", webm: "video", avi: "video",
  mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", flac: "audio", ogg: "audio",
  jpg: "image", jpeg: "image", png: "image", webp: "image", gif: "image",
  ttf: "font", otf: "font", woff: "font", woff2: "font", cube: "lut",
};
const PREPARE_STEPS = ["sourceHealth", "analysis", "thumbs", "transcript", "waveform", "loudness"] as const;
export type PrepareStep = (typeof PREPARE_STEPS)[number];
type Review = { version: string; reviewedAt: string; summary: string; segments?: { from: number; to: number; note: string }[]; decision?: "candidate" | "include" | "exclude"; reason?: string; planning?: MaterialReviewPlanning };
type Ledger = { schemaVersion: 1; reviews: Record<string, Review>; preparedVersions?: Record<string, string>; preparedAssets?: Record<string, string>; failures?: Record<string, { version: string; errors: string[] }>; chronology?: Record<string, { version: string; value: CaptureTime | null }> };
const ledgerPath = (dir: string) => cacheDir(dir, "material-reviews.json");

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function safePath(dir: string, path: string, rawOnly = false): string {
  if (!path || path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error(`invalid project-relative material path: ${path}`);
  if (rawOnly && path.split("/")[0] !== "raw") throw new Error(`material path must be under raw/: ${path}`);
  const root = realpathSync(dir);
  const candidate = resolve(root, path);
  if (!candidate.startsWith(root + sep)) throw new Error(`material path escapes project: ${path}`);
  if (!existsSync(candidate)) return candidate;
  const real = realpathSync(candidate);
  if (!real.startsWith(root + sep) || (rawOnly && !real.startsWith(resolve(root, "raw") + sep)))
    throw new Error(`material symlink escapes allowed directory: ${path}`);
  return real;
}

function readLedger(dir: string): Ledger {
  const file = ledgerPath(dir);
  if (!existsSync(file)) return { schemaVersion: 1, reviews: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch (error) { throw new Error(`invalid material review ledger JSON: ${(error as Error).message}`); }
  if (!parsed || typeof parsed !== "object" || (parsed as Ledger).schemaVersion !== 1 || !(parsed as Ledger).reviews || typeof (parsed as Ledger).reviews !== "object" || Array.isArray((parsed as Ledger).reviews))
    throw new Error("invalid material review ledger schema; expected schemaVersion 1 and a reviews object");
  for (const [path, review] of Object.entries((parsed as Ledger).reviews)) {
    if (!path || !review || typeof review.version !== "string" || !/^[a-f0-9]{64}$/.test(review.version) || typeof review.reviewedAt !== "string" || typeof review.summary !== "string")
      throw new Error(`invalid material review ledger entry: ${path}`);
    if (!review.summary.trim() || (review.decision !== undefined && !["candidate", "include", "exclude"].includes(review.decision)) ||
      (review.reason !== undefined && typeof review.reason !== "string") ||
      (review.segments !== undefined && (!Array.isArray(review.segments) || review.segments.some((segment) => !segment || !Number.isFinite(segment.from) || !Number.isFinite(segment.to) || segment.from < 0 || segment.to <= segment.from || typeof segment.note !== "string" || !segment.note.trim()))))
      throw new Error(`invalid material review metadata: ${path}`);
    validatePlanningInLedger(review, path);
  }
  for (const field of ["preparedVersions", "preparedAssets"] as const) {
    const versions = (parsed as Ledger)[field];
    if (versions !== undefined && (!versions || typeof versions !== "object" || Array.isArray(versions) || Object.values(versions).some((version) => typeof version !== "string" || !/^[a-f0-9]{64}$/.test(version))))
      throw new Error(`invalid material review ledger ${field}`);
  }
  const failures = (parsed as Ledger).failures;
  if (failures !== undefined && (!failures || typeof failures !== "object" || Array.isArray(failures) || Object.values(failures).some((entry) =>
    !entry || typeof entry.version !== "string" || !/^[a-f0-9]{64}$/.test(entry.version) || !Array.isArray(entry.errors) || entry.errors.some((error) => typeof error !== "string"))))
    throw new Error("invalid material review ledger failures");
  const chronology = (parsed as Ledger).chronology;
  if (chronology !== undefined && (!chronology || typeof chronology !== "object" || Array.isArray(chronology) || Object.values(chronology).some((entry) => {
    if (!entry || typeof entry.version !== "string" || !/^[a-f0-9]{64}$/.test(entry.version) || (entry.value !== null && (!entry.value || typeof entry.value !== "object" || Array.isArray(entry.value) || !ownKeysOnly(entry.value, ["selected", "candidates", "timezoneAmbiguous"]) || typeof entry.value.timezoneAmbiguous !== "boolean" || !Array.isArray(entry.value.candidates) || entry.value.candidates.length > 3))) return true;
    if (entry.value === null) return false;
    return entry.value.candidates.some((candidate) => !candidate || typeof candidate !== "object" || Array.isArray(candidate) || !ownKeysOnly(candidate, ["value", "source", "precision", "timezone", "certainty"]) || typeof candidate.value !== "string" || !timestampCandidate(candidate.value, candidate.source, candidate.certainty) || !["exif-original", "container-creation", "filename"].includes(candidate.source) || !["date", "second"].includes(candidate.precision) || !["explicit", "unknown-local"].includes(candidate.timezone) || !["explicit", "inferred"].includes(candidate.certainty)) || (entry.value.selected !== null && !entry.value.candidates.some((candidate) => candidate.value === entry.value?.selected?.value && candidate.source === entry.value.selected.source));
  }))) throw new Error("invalid material review ledger chronology");
  return parsed as Ledger;
}

function atomicLedger(dir: string, ledger: Ledger) {
  const file = ledgerPath(dir);
  mkdirSync(cacheDir(dir), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, { flag: "wx" });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

function updateLedger(dir: string, update: (ledger: Ledger) => void) {
  const lock = `${ledgerPath(dir)}.lock`;
  mkdirSync(cacheDir(dir), { recursive: true });
  let fd: number;
  try { fd = openSync(lock, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("material review ledger is busy; retry this tool call");
    throw error;
  }
  try {
    const ledger = readLedger(dir);
    update(ledger);
    atomicLedger(dir, ledger);
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

function kindFor(path: string): Asset["kind"] | undefined { return KINDS[extname(path).slice(1).toLowerCase()]; }

const STORY_ROLES = ["establishing", "process", "highlight", "detail", "ending", "hook"] as const;
const SUITABLE_USES = ["b-roll", "photo-montage", "live-audio"] as const;
const ownKeysOnly = (value: object, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
function validatePlanning(planning: MaterialReviewPlanning): void {
  if (!planning || typeof planning !== "object" || Array.isArray(planning) || !ownKeysOnly(planning, ["storyRoles", "tags", "coverage", "suitableUses", "cautions"])) throw new Error("invalid material planning fields");
  const enumList = (value: unknown, allowed: readonly string[], label: string, max: number) => {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || !allowed.includes(item)) || new Set(value).size !== value.length) throw new Error(`invalid material planning ${label}`);
  };
  enumList(planning.storyRoles, STORY_ROLES, "storyRoles", STORY_ROLES.length);
  enumList(planning.suitableUses, SUITABLE_USES, "suitableUses", SUITABLE_USES.length);
  const textList = (value: unknown, label: string, maxCount: number, maxLength: number) => {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length > maxCount || value.some((item) => typeof item !== "string" || !item.trim() || item.length > maxLength || item.trim() !== item)) throw new Error(`invalid material planning ${label}`);
  };
  textList(planning.tags, "tags", 20, 80);
  textList(planning.cautions, "cautions", 10, 300);
  if (planning.coverage !== undefined) {
    const coverage = planning.coverage;
    if (!coverage || typeof coverage !== "object" || Array.isArray(coverage) || !ownKeysOnly(coverage, ["method", "extent", "ranges"]) || typeof coverage.method !== "string" || !coverage.method.trim() || coverage.method.length > 80 || coverage.method.trim() !== coverage.method || !["partial", "full"].includes(coverage.extent)) throw new Error("invalid material planning coverage");
    if (coverage.ranges !== undefined && (!Array.isArray(coverage.ranges) || coverage.ranges.length > 50 || coverage.ranges.some((range) =>
      !range || typeof range !== "object" || Array.isArray(range) || !ownKeysOnly(range, ["from", "to"]) || !Number.isFinite(range.from) || !Number.isFinite(range.to) || range.from < 0 || range.to <= range.from))) throw new Error("invalid material planning coverage ranges");
  }
}

function validatePlanningInLedger(review: Review, path: string) {
  if (review.planning !== undefined) {
    try { validatePlanning(review.planning); } catch { throw new Error(`invalid material review planning: ${path}`); }
  }
}

function timestampCandidate(raw: string, source: CaptureCandidate["source"], certainty: CaptureCandidate["certainty"]): CaptureCandidate | undefined {
  const value = raw.trim();
  let match = /^(\d{4})[-:]?(\d{2})[-:]?(\d{2})[ T_](\d{2})[:]?([0-5]\d)[:]?([0-5]\d)(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(value);
  let precision: CaptureCandidate["precision"] = "second";
  if (!match) {
    match = /^(\d{4})[-:]?(\d{2})[-:]?(\d{2})$/.exec(value);
    precision = "date";
  }
  if (!match) return undefined;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day || year < 1) return undefined;
  let normalized = `${yearText}-${monthText}-${dayText}`;
  if (precision === "second") {
    const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
    if (hour > 23 || minute > 59 || second > 59) return undefined;
    normalized += `T${match[4]}:${match[5]}:${match[6]}`;
    const zone = match[7];
    if (zone) {
      if (zone.toUpperCase() !== "Z") {
        const digits = zone.slice(1).replace(":", "");
        if (Number(digits.slice(0, 2)) > 23 || Number(digits.slice(2, 4)) > 59) return undefined;
        normalized += `${zone[0]}${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
      } else normalized += "Z";
    }
  }
  return { value: normalized, source, precision, timezone: precision === "second" && (normalized.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(normalized)) ? "explicit" : "unknown-local", certainty };
}

function filenameCapture(path: string): CaptureCandidate | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  const patterns = [
    /(?:^|[^\d])(\d{4}[-_]\d{2}[-_]\d{2})[T _-](\d{2})[-:](\d{2})[-:](\d{2})(Z|[+-]\d{2}:?\d{2})?(?:$|[^\d])/i,
    /(?:^|[^\d])(\d{8})[_-](\d{6})(?:$|[^\d])/,
    /(?:^|[^\d])(\d{4}[-_]\d{2}[-_]\d{2})(?:$|[^\d])/,
    /(?:^|[^\d])(\d{8})(?:$|[^\d])/,
  ];
  const iso = patterns[0].exec(name);
  if (iso) return timestampCandidate(`${iso[1].replace(/_/g, "-")}T${iso[2]}:${iso[3]}:${iso[4]}${iso[5] ?? ""}`, "filename", "inferred");
  const compact = patterns[1].exec(name);
  if (compact) return timestampCandidate(`${compact[1]} ${compact[2].slice(0, 2)}:${compact[2].slice(2, 4)}:${compact[2].slice(4, 6)}`, "filename", "inferred");
  const date = patterns[2].exec(name) ?? patterns[3].exec(name);
  return date ? timestampCandidate(date[1].replace(/_/g, "-"), "filename", "inferred") : undefined;
}

function exifCapture(file: string): CaptureCandidate | undefined {
  // Inventory currently supports JPEG images; TIFF byte-order handling also covers embedded TIFF payloads.
  const fd = openSync(file, "r");
  let bytes: Buffer;
  try {
    bytes = Buffer.alloc(1024 * 1024);
    const read = readSync(fd, bytes, 0, bytes.length, 0);
    bytes = bytes.subarray(0, read);
  } finally { closeSync(fd); }
  let tiff = -1;
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) {
    for (let offset = 2; offset + 4 < bytes.length;) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const size = bytes.readUInt16BE(offset + 2);
      if (size < 2 || offset + 2 + size > bytes.length) break;
      const payload = offset + 4;
      if (marker === 0xe1 && bytes.subarray(payload, payload + 6).toString("binary") === "Exif\0\0") { tiff = payload + 6; break; }
      offset += 2 + size;
    }
  } else if (["II", "MM"].includes(bytes.subarray(0, 2).toString("ascii"))) tiff = 0;
  if (tiff < 0 || tiff + 8 > bytes.length) return undefined;
  const little = bytes.toString("ascii", tiff, tiff + 2) === "II";
  const u16 = (at: number) => at >= 0 && at + 2 <= bytes.length ? (little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at)) : 0;
  const u32 = (at: number) => at >= 0 && at + 4 <= bytes.length ? (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at)) : 0;
  if (u16(tiff + 2) !== 42) return undefined;
  const asciiTag = (ifd: number, tagId: number): string | undefined => {
    const count = Math.min(u16(ifd), 512);
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (u16(entry) !== tagId || u16(entry + 2) !== 2) continue;
      const length = Math.min(u32(entry + 4), 64);
      const start = length <= 4 ? entry + 8 : tiff + u32(entry + 8);
      if (start < tiff || start + length > bytes.length) return undefined;
      return bytes.toString("ascii", start, start + length).replace(/\0.*$/, "").trim();
    }
    return undefined;
  };
  const ifd0 = tiff + u32(tiff + 4);
  const count = Math.min(u16(ifd0), 512);
  let exifIfd = -1;
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (u16(entry) === 0x8769) { exifIfd = tiff + u32(entry + 8); break; }
  }
  const original = exifIfd >= tiff ? asciiTag(exifIfd, 0x9003) : undefined;
  if (!original) return undefined;
  const offset = exifIfd >= tiff ? asciiTag(exifIfd, 0x9011) : undefined;
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(original);
  if (!match) return undefined;
  const zone = offset && /^([+-])(\d{2}):(\d{2})$/.test(offset) ? offset : "";
  return timestampCandidate(`${match[1]}-${match[2]}-${match[3]}T${match[4]}${zone}`, "exif-original", "explicit");
}

function containerCaptures(file: string): CaptureCandidate[] {
  try {
    const raw = execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_entries", "format_tags=creation_time:stream_tags=creation_time", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024, timeout: 10_000, windowsHide: true });
    const info = JSON.parse(raw) as { format?: { tags?: Record<string, string> }; streams?: { tags?: Record<string, string> }[] };
    const values = [info.format?.tags, ...(info.streams ?? []).map((stream) => stream.tags)].flatMap((tags) => tags ? Object.entries(tags).filter(([key]) => key.toLowerCase() === "creation_time").map(([, value]) => value) : []);
    return values.map((value) => timestampCandidate(value, "container-creation", "explicit")).filter((candidate): candidate is CaptureCandidate => !!candidate);
  } catch { return []; }
}

function captureTime(file: string, path: string): CaptureTime | null {
  const candidates = [exifCapture(file), ...containerCaptures(file), filenameCapture(path)].filter((candidate): candidate is CaptureCandidate => !!candidate);
  const unique = candidates.filter((candidate, index) => candidates.findIndex((other) => other.source === candidate.source && other.value === candidate.value) === index);
  const selected = unique.find((candidate) => candidate.source === "exif-original") ?? unique.find((candidate) => candidate.source === "container-creation") ?? unique.find((candidate) => candidate.source === "filename") ?? null;
  return unique.length ? { selected, candidates: unique, timezoneAmbiguous: unique.some((candidate) => candidate.precision === "second" && candidate.timezone === "unknown-local") } : null;
}

export type MaterialStoryRole = "establishing" | "process" | "highlight" | "detail" | "ending" | "hook";
export type MaterialSuitableUse = "b-roll" | "photo-montage" | "live-audio";
export interface MaterialCoverage { method: string; extent: "partial" | "full"; ranges?: { from: number; to: number }[] }
export interface MaterialReviewPlanning { storyRoles?: MaterialStoryRole[]; tags?: string[]; coverage?: MaterialCoverage; suitableUses?: MaterialSuitableUse[]; cautions?: string[] }
export interface MaterialReview { version: string; reviewedAt: string; summary: string; segments?: { from: number; to: number; note: string }[]; decision?: "candidate" | "include" | "exclude"; reason?: string; planning?: MaterialReviewPlanning }
export interface CaptureCandidate { value: string; source: "exif-original" | "container-creation" | "filename"; precision: "date" | "second"; timezone: "explicit" | "unknown-local"; certainty: "explicit" | "inferred" }
export interface CaptureTime { selected: CaptureCandidate | null; candidates: CaptureCandidate[]; timezoneAmbiguous: boolean }
export interface ListedMaterial { path: string; assetId?: string; kind: Asset["kind"]; version?: string; status: "unreviewed" | "reviewed" | "changed" | "missing"; review?: MaterialReview; captureTime: CaptureTime | null }

/** Read-only inventory of supported raw files and registered project assets. */
export async function listMaterials(dir: string): Promise<{ materials: ListedMaterial[] }> {
  const project = load(dir);
  const ledger = readLedger(dir);
  const registered = new Map(Object.values(project.assets).map((asset) => [asset.path, asset]));
  const paths = new Set<string>(registered.keys());
  for (const path of Object.keys(ledger.reviews)) if (kindFor(path)) paths.add(path);
  const raw = join(dir, "raw");
  const root = realpathSync(dir);
  const rawRoot = existsSync(raw) ? realpathSync(raw) : undefined;
  if (rawRoot && rawRoot.startsWith(root + sep)) {
    const visited = new Set<string>();
    const walk = (folder: string, relFolder: string) => {
      let real: string;
      try { real = realpathSync(folder); } catch { return; }
      if (!real.startsWith(rawRoot + sep) && real !== rawRoot) return;
      if (visited.has(real)) return;
      visited.add(real);
      for (const name of readdirSync(folder).sort()) {
        const full = join(folder, name), relPath = join(relFolder, name).split(sep).join("/");
        try {
          const stat = lstatSync(full);
          if (stat.isSymbolicLink()) {
            const target = realpathSync(full);
            if (!target.startsWith(rawRoot + sep)) continue;
            if (lstatSync(target).isDirectory()) walk(target, relPath);
            else if (kindFor(relPath)) paths.add(relPath);
          } else if (stat.isDirectory()) walk(full, relPath);
          else if (stat.isFile() && kindFor(relPath)) paths.add(relPath);
        } catch { /* disappearing or dangling entries are reconciled as missing when registered */ }
      }
    };
    walk(raw, "raw");
  }
  const materials: ListedMaterial[] = [];
  for (const path of [...paths].sort()) {
    const asset = registered.get(path);
    const kind = asset?.kind ?? kindFor(path);
    if (!kind) continue;
    let version: string | undefined;
    try {
      const file = safePath(dir, path, path === "raw" || path.startsWith("raw/"));
      if (existsSync(file)) version = await sha256(file);
    } catch { /* unsafe paths are represented as missing and never read */ }
    const review = ledger.reviews[path];
    const preparedCapture = version && ledger.chronology?.[path]?.version === version ? ledger.chronology[path].value : null;
    materials.push({ path, ...(asset && { assetId: asset.id }), kind, ...(version && { version }), status: !version ? "missing" : !review ? "unreviewed" : review.version === version ? "reviewed" : "changed", ...(review && { review }), captureTime: preparedCapture });
  }
  return { materials };
}

export async function prepareMaterials(dir: string, opts: { paths?: string[]; steps?: PrepareStep[] } = {}) {
  if (opts.paths !== undefined && (!Array.isArray(opts.paths) || opts.paths.some((path) => typeof path !== "string"))) throw new Error("paths must be an array of project-relative paths");
  const steps: PrepareStep[] = opts.steps ?? ["analysis", "thumbs", "transcript"];
  if (steps.some((step) => !(PREPARE_STEPS as readonly string[]).includes(step))) throw new Error(`unsupported material preparation step: ${steps.find((step) => !(PREPARE_STEPS as readonly string[]).includes(step))}`);
  const listed = await listMaterials(dir);
  const ledger = readLedger(dir);
  const selected = opts.paths ? opts.paths.map((path) => {
    const found = listed.materials.find((item) => item.path === path);
    if (!found) throw new Error(`unsupported or unknown material path: ${path}`);
    return found;
  }) : listed.materials.filter((item) => item.status === "unreviewed" || item.status === "changed");
  if (selected.some((item) => item.status === "missing")) throw new Error(`cannot prepare missing material: ${selected.find((item) => item.status === "missing")!.path}`);
  const snapshots = new Map<string, string>();
  const chronology = new Map<string, CaptureTime | null>();
  const registered: { path: string; assetId: string }[] = [];
  for (const item of selected) {
    const file = safePath(dir, item.path, item.path.startsWith("raw/"));
    const version = await sha256(file);
    if (version !== item.version) throw new Error(`material changed while preparing: ${item.path}`);
    snapshots.set(item.path, version);
    const cachedChronology = ledger.chronology?.[item.path];
    chronology.set(item.path, cachedChronology?.version === version ? cachedChronology.value : captureTime(file, item.path));
    let assetId = item.assetId;
    if (!assetId) {
      const result = runOp(dir, "importAsset", { path: item.path });
      if ("error" in result) throw new Error(`could not register ${item.path}: ${result.error.message}`);
      const candidates = Object.values(load(dir).assets);
      const match = candidates.find((asset) => asset.path === item.path) ?? (await Promise.all(candidates.map(async (asset) => {
        const candidate = safePath(dir, asset.path);
        return existsSync(candidate) && await sha256(candidate) === version ? asset : undefined;
      }))).find(Boolean);
      if (!match) throw new Error(`registration did not produce an asset for ${item.path}`);
      assetId = match.id;
    }
    registered.push({ path: item.path, assetId });
  }
  // Ingest uses a size/mtime/edge fingerprint. The full SHA used by this workflow
  // is stronger, so invalidate cached outputs when either ledger says content changed.
  const invalidated = registered.filter(({ path, assetId }) =>
    ledger.preparedAssets?.[assetId] !== snapshots.get(path) ||
    (ledger.preparedVersions?.[path] !== undefined && ledger.preparedVersions[path] !== snapshots.get(path)) ||
    (ledger.reviews[path] !== undefined && ledger.reviews[path].version !== snapshots.get(path)),
  );
  if (invalidated.length) {
    const cache = readAssets(dir);
    for (const { assetId } of invalidated) delete cache[assetId];
    writeAtomic(cacheDir(dir, "assets.json"), cache);
  }
  const result = registered.length ? await ingest(dir, { assets: [...new Set(registered.map((item) => item.assetId))], only: steps }) : undefined;
  const errors = [...(result?.errors ?? [])];
  const probed = readAssets(dir);
  for (const { path, assetId } of registered) {
    const metadata = probed[assetId];
    const kind = probed[assetId]?.kind;
    if ((kind === "image" || kind === "video") && (!metadata?.width || !metadata.height))
      errors.push(`material has no readable visual stream: ${path}`);
    if (kind === "audio" && !metadata?.audio)
      errors.push(`material has no readable audio stream: ${path}`);
  }
  for (const [path, version] of snapshots) {
    if (await sha256(safePath(dir, path, path.startsWith("raw/"))) !== version) errors.push(`material changed during preparation: ${path}`);
  }
  updateLedger(dir, (latest) => {
    latest.failures ??= {};
    for (const [path, version] of snapshots) {
      const assetId = registered.find((item) => item.path === path)?.assetId;
      const sourceErrors = errors.filter((error) => error.includes(path) || (assetId && error.includes(` ${assetId}:`)) || error.includes(" skipped:"));
      if (sourceErrors.length) latest.failures[path] = { version, errors: sourceErrors };
      else delete latest.failures[path];
    }
    if (errors.length) return;
    latest.preparedVersions ??= {};
    latest.preparedAssets ??= {};
    latest.chronology ??= {};
    for (const [path, version] of snapshots) {
      latest.preparedVersions[path] = version;
      latest.chronology[path] = { version, value: chronology.get(path) ?? null };
    }
    for (const { path, assetId } of registered) latest.preparedAssets[assetId] = snapshots.get(path)!;
  });
  return { prepared: registered, steps: result?.steps, errors };
}

/** Explicit, read-only scan. It never imports or starts agent analysis. */
export async function scanMaterials(dir: string) {
  const listed = await listMaterials(dir), cache = readAssets(dir), ledger = readLedger(dir);
  const materials = listed.materials.map((item) => {
    const metadata = item.assetId ? cache[item.assetId] : undefined;
    const failure = ledger.failures?.[item.path];
    const current = !!item.version && metadata?.path === item.path && metadata.fingerprint === fingerprint(safePath(dir, item.path));
    const measurement = current && metadata?.sourceHealth?.path === item.path && metadata.sourceHealth.fingerprint === metadata.fingerprint ? metadata.sourceHealth : undefined;
    const measurementErrors = [measurement?.decode.status === "failed" ? measurement.decode.error : undefined, measurement?.audio.status === "failed" ? measurement.audio.error : undefined].filter((error): error is string => !!error);
    const errors = [...(failure && failure.version === item.version ? failure.errors : []), ...measurementErrors];
    const health = !item.version ? "missing" : !item.assetId ? "new" :
      failure?.version === item.version ? "failed" :
      (ledger.preparedAssets?.[item.assetId] !== undefined && ledger.preparedAssets[item.assetId] !== item.version) ||
      (metadata && (metadata.path !== item.path || metadata.fingerprint !== fingerprint(safePath(dir, item.path)))) ? "changed" :
      measurementErrors.length ? "failed" : !metadata ? "unmeasured" : "present";
    return { ...item, health, scope: "source" as const, ...(measurement && { measurement }), ...(errors.length && { errors }) };
  });
  return { scannedAt: new Date().toISOString(), materials };
}

/** Preflight and one undoable core edit; content identity is never based on the basename. */
export async function relinkMaterial(dir: string, input: { assetId: string; path: string; acceptChanged?: boolean }, baseRevision?: number) {
  const project = load(dir), asset = project.assets[input.assetId];
  if (!asset) return { error: { code: "not_found", message: `asset ${input.assetId} not found` } };
  try {
    const candidate = safePath(dir, input.path, true);
    const kind = kindFor(input.path);
    if (!kind || kind !== asset.kind) throw new Error(`replacement format kind ${kind ?? "unsupported"} differs from ${asset.kind}`);
    const version = await sha256(candidate), stamp = fingerprint(candidate)!;
    const ledger = readLedger(dir);
    let original = ledger.preparedAssets?.[asset.id];
    try { original = await sha256(safePath(dir, asset.path)); } catch { /* missing original: explicit change approval if identity unavailable */ }
    const context = loadCtx(dir);
    if (kind === "lut") context.validateLut!(input.path);
    const metadata = kind === "lut" ? undefined : await probe(candidate, kind);
    if ((kind === "video" || kind === "image") && (!metadata?.width || !metadata.height)) throw new Error("replacement has no readable visual stream");
    if (kind === "audio" && !metadata?.audio) throw new Error("replacement has no readable audio stream");
    if (await sha256(candidate) !== version || fingerprint(candidate) !== stamp) throw new Error("replacement changed during preflight");
    const result = runOp(dir, "relinkAsset", input, baseRevision ?? project.revision, {
      relinkCandidate: { ...input, kind, identical: original === version, duration: metadata?.duration, fingerprint: stamp },
      assetDurations: { ...context.assetDurations, ...(metadata?.duration !== undefined && { [asset.id]: metadata.duration }) },
    });
    if ("error" in result) return result;
    // All derived entries become stale, including when undo restores the old path.
    const cache = readAssets(dir);
    if (metadata) cache[asset.id] = { ...metadata, path: input.path, fingerprint: stamp };
    else delete cache[asset.id];
    writeAtomic(cacheDir(dir, "assets.json"), cache);
    for (const path of [
      `proxies/edit/${asset.id}.mp4`, `proxies/reverse/${asset.id}.mp4`, `proxies/analysis/${asset.id}.mp4`,
      `contact-sheets/${asset.id}.jpg`, `thumbs/${asset.id}`, `waveforms/${asset.id}.json`,
      `transcripts/${asset.id}.json`, `beats/${asset.id}.json`,
    ]) rmSync(cacheDir(dir, path), { recursive: true, force: true });
    updateLedger(dir, (latest) => {
      delete latest.preparedAssets?.[asset.id];
      delete latest.preparedVersions?.[asset.path];
      delete latest.preparedVersions?.[input.path];
      delete latest.reviews[asset.path];
      delete latest.reviews[input.path];
      delete latest.failures?.[asset.path];
      delete latest.failures?.[input.path];
    });
    return result;
  } catch (error) { return { error: { code: "invalid", message: error instanceof Error ? error.message : String(error) } }; }
}

export async function recordMaterialReview(dir: string, input: { path: string; version: string; summary: string; segments?: { from: number; to: number; note: string }[]; decision?: "candidate" | "include" | "exclude"; reason?: string; planning?: MaterialReviewPlanning }) {
  readLedger(dir); // Refuse a corrupt ledger before attempting a review update.
  if (!input || typeof input !== "object" || Array.isArray(input) || !ownKeysOnly(input, ["path", "version", "summary", "segments", "decision", "reason", "planning"])) throw new Error("invalid material review fields");
  if (typeof input.summary !== "string" || !input.summary.trim()) throw new Error("material review summary must be non-empty");
  if (input.reason !== undefined && typeof input.reason !== "string") throw new Error("material review reason must be a string");
  if (input.segments !== undefined && !Array.isArray(input.segments)) throw new Error("material review segments must be an array");
  if (!/^[a-f0-9]{64}$/.test(input.version)) throw new Error("material review version must be a SHA-256 hex digest");
  const path = input.path;
  const asset = Object.values(load(dir).assets).find((item) => item.path === path);
  if (!asset && (!path.startsWith("raw/") || !kindFor(path))) throw new Error(`material is not in the current inventory: ${path}`);
  const file = safePath(dir, path, path.startsWith("raw/"));
  if (!existsSync(file)) throw new Error(`material is missing: ${path}`);
  if (await sha256(file) !== input.version) throw new Error(`material changed since it was reviewed: ${path}`);
  const metadata = asset ? readAssets(dir)[asset.id] : undefined;
  if (input.planning !== undefined) validatePlanning(input.planning);
  for (const segment of input.segments ?? []) {
    if (!segment || !Number.isFinite(segment.from) || !Number.isFinite(segment.to) || segment.from < 0 || segment.to <= segment.from || typeof segment.note !== "string" || !segment.note.trim())
      throw new Error(`invalid reviewed segment for ${path}`);
    if (metadata?.duration !== undefined && segment.to > metadata.duration + 1e-6) throw new Error(`review segment exceeds ${metadata.duration.toFixed(2)} s material duration: ${path}`);
  }
  const ranges = input.planning?.coverage?.ranges;
  if (ranges?.length) {
    const kind = asset?.kind ?? kindFor(path);
    if (kind !== "video" && kind !== "audio") throw new Error(`planning coverage ranges require video or audio media: ${path}`);
    const duration = metadata?.duration ?? (await probe(file, kind)).duration;
    if (duration === undefined || !Number.isFinite(duration) || ranges.some((range) => range.to > duration + 1e-6)) throw new Error(`planning coverage range exceeds or cannot be checked against material duration: ${path}`);
  }
  // Recheck just before the atomic write to avoid acknowledging a replaced file.
  if (await sha256(safePath(dir, path, path.startsWith("raw/"))) !== input.version) throw new Error(`material changed before review could be saved: ${path}`);
  updateLedger(dir, (ledger) => {
    ledger.reviews[path] = { version: input.version, reviewedAt: new Date().toISOString(), summary: input.summary.trim(), ...(input.segments?.length && { segments: input.segments }), ...(input.decision && { decision: input.decision }), ...(input.reason && { reason: input.reason }), ...(input.planning && { planning: input.planning }) };
  });
  return { path, version: input.version, status: "reviewed" as const };
}

/** Return a first-frame JPEG preview with both dimensions capped at 960 pixels. */
export async function materialPreview(dir: string, input: { path: string; version?: string }) {
  const asset = Object.values(load(dir).assets).find((item) => item.path === input.path);
  const kind = asset?.kind ?? (input.path.startsWith("raw/") ? kindFor(input.path) : undefined);
  if (kind !== "image") throw new Error(`material preview supports images only: ${input.path}`);
  const file = safePath(dir, input.path, input.path.startsWith("raw/"));
  if (input.version && await sha256(file) !== input.version) throw new Error(`material changed since inventory: ${input.path}`);
  const image = await scratch(async (tmp) => {
    const output = join(tmp, "preview.jpg");
    const { execFileSync } = await import("node:child_process");
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", file, "-frames:v", "1", "-vf", "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease", "-q:v", "4", output], { stdio: ["ignore", "ignore", "pipe"] });
    return readFileSync(output);
  });
  if (input.version && await sha256(file) !== input.version) throw new Error(`material changed while previewing: ${input.path}`);
  return { image, mimeType: "image/jpeg" as const };
}
