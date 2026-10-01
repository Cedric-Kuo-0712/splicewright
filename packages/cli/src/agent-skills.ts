import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MANIFEST = ".splicewright/agent-skills.json";
type Manifest = { version: 1; files: Record<string, string> };

const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const statIfPresent = (path: string) => {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

/** Copies shipped agent skills without following source or destination symlinks. */
export function provisionAgentSkills(projectDir: string, sourceDir: string, refresh = false): { created: string[]; warnings: string[] } {
  const created: string[] = [];
  const warnings: string[] = [];
  const destinationRoot = join(projectDir, ".agents", "skills");
  const manifestPath = join(projectDir, MANIFEST);

  const safeDirectory = (path: string, create: boolean) => {
    let stat = statIfPresent(path);
    if (!stat && create) {
      mkdirSync(path);
      stat = lstatSync(path);
    }
    return !!stat && stat.isDirectory() && !stat.isSymbolicLink();
  };

  const agentsRoot = join(projectDir, ".agents");
  if (!safeDirectory(agentsRoot, true)) {
    warnings.push("Skipped bundled skills: .agents is not a real directory (symlink or other file).");
    return { created, warnings };
  }
  if (!safeDirectory(destinationRoot, true)) {
    warnings.push("Skipped bundled skills: .agents/skills is not a real directory (symlink or other file).");
    return { created, warnings };
  }
  if (!safeDirectory(join(projectDir, ".splicewright"), true)) {
    warnings.push("Skipped bundled skills: .splicewright is not a real directory (symlink or other file).");
    return { created, warnings };
  }

  const manifestStat = statIfPresent(manifestPath);
  if (manifestStat?.isSymbolicLink() || (manifestStat && !manifestStat.isFile())) {
    warnings.push("Skipped bundled skills: .splicewright/agent-skills.json is a symlink or not a regular file.");
    return { created, warnings };
  }
  let manifest: Manifest = { version: 1, files: {} };
  let manifestUsable = !manifestStat;
  if (manifestStat) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (parsed?.version === 1 && parsed.files && typeof parsed.files === "object" && !Array.isArray(parsed.files) &&
          Object.values(parsed.files).every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) {
        manifest = parsed;
        manifestUsable = true;
      }
    } catch { /* A malformed manifest must never authorize replacing existing files. */ }
    if (!manifestUsable) warnings.push("Skipped refresh of existing skill files: managed skill manifest is missing valid tracking data.");
  }

  const files: string[] = [];
  const walk = (source: string, relDir = "") => {
    let entries;
    try { entries = readdirSync(source, { withFileTypes: true }); } catch (error) {
      warnings.push(`Could not read bundled skills at ${source}: ${(error as Error).message}`);
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const path = join(source, entry.name);
      if (entry.isDirectory()) walk(path, rel);
      else if (entry.isFile()) files.push(rel);
    }
  };
  const sourceStat = statIfPresent(sourceDir);
  if (!sourceStat || sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    warnings.push("Skipped bundled skills: shipped skill source is missing or not a real directory.");
    return { created, warnings };
  }
  walk(sourceDir);

  const ensureDestinationParents = (rel: string) => {
    let current = destinationRoot;
    const parts = rel.split(/[\\/]/).slice(0, -1);
    for (const part of parts) {
      current = join(current, part);
      const stat = statIfPresent(current);
      if (stat) {
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      } else mkdirSync(current);
    }
    return true;
  };

  let changed = false;
  const nextFiles = { ...manifest.files };
  for (const rel of files) {
    const source = join(sourceDir, rel);
    const destination = join(destinationRoot, rel);
    const sourceBytes = readFileSync(source);
    const sourceHash = hash(sourceBytes);
    if (!ensureDestinationParents(rel)) {
      warnings.push(`Skipped skill file ${rel}: destination parent is a symlink or not a directory.`);
      continue;
    }
    const existing = statIfPresent(destination);
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      warnings.push(`Skipped skill file ${rel}: destination is a symlink or not a regular file.`);
      continue;
    }
    if (!existing) {
      writeFileSync(destination, sourceBytes, { flag: "wx" });
      created.push(`.agents/skills/${rel}`);
      nextFiles[rel] = sourceHash;
      changed = true;
      continue;
    }
    if (!manifestUsable) continue;
    const previousHash = manifest.files[rel];
    const destinationHash = hash(readFileSync(destination));
    if (refresh && !previousHash) warnings.push(`Skipped existing skill file ${rel}: no managed hash is available.`);
    if (refresh && previousHash && destinationHash === previousHash && sourceHash !== destinationHash) {
      writeFileSync(destination, sourceBytes);
      created.push(`.agents/skills/${rel}`);
      nextFiles[rel] = sourceHash;
      changed = true;
    } else if (!previousHash && !refresh && destinationHash === sourceHash) {
      nextFiles[rel] = sourceHash;
      changed = true;
    }
  }

  if (manifestUsable && changed) {
    const next: Manifest = { version: 1, files: nextFiles };
    writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
    created.push(MANIFEST);
  }
  return { created, warnings };
}
