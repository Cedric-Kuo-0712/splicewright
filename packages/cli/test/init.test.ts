import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { provisionAgentSkills } from "../src/agent-skills.ts";

const CLI = join(import.meta.dirname, "../src/main.ts");
const init = (cwd: string) => JSON.parse(execFileSync(process.execPath, [CLI, "init", "--title", "Trip", "--fps", "25"], { cwd, encoding: "utf8" }));

it("init writes the agent files once and keeps other MCP servers", () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-init-"));
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  const created = init(dir).created as string[];
  expect(created).toEqual(expect.arrayContaining(["project.json", "AGENTS.md", "CLAUDE.md", ".mcp.json"]));
  expect(created).toEqual(expect.arrayContaining([
    ".agents/skills/splicewright-animation/SKILL.md",
    ".agents/skills/splicewright-animation/references/runtime.md",
    ".agents/skills/splicewright-animation/scripts/setup_engine.py",
    ".agents/skills/splicewright-animation-style/references/styles.md",
    ".agents/skills/splicewright-editing/SKILL.md",
    ".agents/skills/splicewright-editing/references/material-review.md",
    ".agents/skills/splicewright-editing/references/narrative-structures.md",
    ".agents/skills/splicewright-editing/references/transitions-motion.md",
    ".agents/skills/splicewright-editing/references/timeline-refinement.md",
    ".agents/skills/splicewright-editing/references/operation-mechanics.md",
  ]));
  expect(created).toContain(".splicewright/agent-skills.json");
  expect(readFileSync(join(dir, ".agents/skills/splicewright-animation/references/runtime.md"), "utf8"))
    .toBe(readFileSync(join(import.meta.dirname, "../src/skills/splicewright-animation/references/runtime.md"), "utf8"));
  expect(readFileSync(join(dir, ".agents/skills/splicewright-editing/SKILL.md"), "utf8"))
    .toBe(readFileSync(join(import.meta.dirname, "../src/skills/splicewright-editing/SKILL.md"), "utf8"));
  expect(readFileSync(join(dir, ".agents/skills/splicewright-editing/references/material-review.md"), "utf8"))
    .toBe(readFileSync(join(import.meta.dirname, "../src/skills/splicewright-editing/references/material-review.md"), "utf8"));
  expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("# Trip\n\nSplicewright video project, 1920×1080 at 25 fps.");
  expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain(".agents/skills/splicewright-editing/SKILL.md");
  const { mcpServers } = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
  expect(Object.keys(mcpServers)).toEqual(["other", "splicewright"]);
  expect(mcpServers.splicewright.args).toEqual([CLI, "mcp"]);
  writeFileSync(join(dir, "AGENTS.md"), "mine");
  expect(init(dir).created).toEqual([]);
  expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("mine");
});

it("provisions nested skills once, refreshes managed copies, and preserves local edits and other skills", () => {
  const root = mkdtempSync(join(tmpdir(), "swr-skills-"));
  const source = join(root, "source");
  const project = join(root, "project");
  mkdirSync(join(source, "splicewright-animation", "references"), { recursive: true });
  mkdirSync(project);
  writeFileSync(join(source, "splicewright-animation", "SKILL.md"), "version one");
  writeFileSync(join(source, "splicewright-animation", "references", "workflow.md"), "nested ref");
  const first = provisionAgentSkills(project, source);
  expect(first.created).toContain(".agents/skills/splicewright-animation/references/workflow.md");
  expect(readFileSync(join(project, ".agents/skills/splicewright-animation/references/workflow.md"), "utf8")).toBe("nested ref");
  expect(provisionAgentSkills(project, source).created).toEqual([]);

  writeFileSync(join(source, "splicewright-animation", "SKILL.md"), "version two");
  writeFileSync(join(source, "splicewright-animation", "references", "workflow.md"), "updated ref");
  writeFileSync(join(project, ".agents/skills/splicewright-animation/references/workflow.md"), "my local edit");
  mkdirSync(join(project, ".agents/skills/my-skill"), { recursive: true });
  writeFileSync(join(project, ".agents/skills/my-skill/SKILL.md"), "keep me");
  const refreshed = provisionAgentSkills(project, source, true);
  expect(readFileSync(join(project, ".agents/skills/splicewright-animation/SKILL.md"), "utf8")).toBe("version two");
  expect(readFileSync(join(project, ".agents/skills/splicewright-animation/references/workflow.md"), "utf8")).toBe("my local edit");
  expect(readFileSync(join(project, ".agents/skills/my-skill/SKILL.md"), "utf8")).toBe("keep me");
  expect(refreshed.warnings).toEqual([]);
});

it("skips destination skill and manifest symlinks without writing through them", () => {
  const root = mkdtempSync(join(tmpdir(), "swr-skill-links-"));
  const source = join(root, "source");
  const project = join(root, "project");
  mkdirSync(join(source, "linked"), { recursive: true });
  mkdirSync(project);
  writeFileSync(join(source, "linked/SKILL.md"), "shipped");
  mkdirSync(join(project, ".agents/skills/linked"), { recursive: true });
  writeFileSync(join(root, "outside.md"), "outside");
  symlinkSync(join(root, "outside.md"), join(project, ".agents/skills/linked/SKILL.md"));
  mkdirSync(join(project, ".splicewright"));
  writeFileSync(join(root, "manifest.json"), "{}");
  symlinkSync(join(root, "manifest.json"), join(project, ".splicewright/agent-skills.json"));
  const result = provisionAgentSkills(project, source, true);
  expect(result.warnings.join(" ")).toMatch(/agent-skills\.json is a symlink/);
  expect(readFileSync(join(root, "outside.md"), "utf8")).toBe("outside");
  expect(readFileSync(join(root, "manifest.json"), "utf8")).toBe("{}");
});

it("skips writes through skill directory and file symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "swr-skill-destination-links-"));
  const source = join(root, "source");
  const project = join(root, "project");
  mkdirSync(join(source, "linked-dir"), { recursive: true });
  mkdirSync(join(source, "linked-file"), { recursive: true });
  mkdirSync(join(project, ".agents/skills"), { recursive: true });
  mkdirSync(join(root, "outside-dir"));
  writeFileSync(join(source, "linked-dir/SKILL.md"), "directory target");
  writeFileSync(join(source, "linked-file/SKILL.md"), "file target");
  writeFileSync(join(root, "outside.md"), "outside");
  symlinkSync(join(root, "outside-dir"), join(project, ".agents/skills/linked-dir"));
  mkdirSync(join(project, ".agents/skills/linked-file"));
  symlinkSync(join(root, "outside.md"), join(project, ".agents/skills/linked-file/SKILL.md"));

  const result = provisionAgentSkills(project, source);
  expect(result.warnings.join(" ")).toMatch(/destination parent is a symlink/);
  expect(result.warnings.join(" ")).toMatch(/destination is a symlink/);
  expect(readFileSync(join(root, "outside.md"), "utf8")).toBe("outside");
  expect(existsSync(join(root, "outside-dir/SKILL.md"))).toBe(false);
});

it("does not refresh existing skill files without valid managed hashes", () => {
  for (const manifestText of [undefined, "{broken json"]) {
    const root = mkdtempSync(join(tmpdir(), "swr-skill-untracked-"));
    const source = join(root, "source");
    const project = join(root, "project");
    mkdirSync(join(source, "demo"), { recursive: true });
    mkdirSync(join(project, ".agents/skills/demo"), { recursive: true });
    writeFileSync(join(source, "demo/SKILL.md"), "new shipped version");
    writeFileSync(join(project, ".agents/skills/demo/SKILL.md"), "keep existing version");
    if (manifestText !== undefined) {
      mkdirSync(join(project, ".splicewright"));
      writeFileSync(join(project, ".splicewright/agent-skills.json"), manifestText);
    }
    const result = provisionAgentSkills(project, source, true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(readFileSync(join(project, ".agents/skills/demo/SKILL.md"), "utf8")).toBe("keep existing version");
  }
});

it("init --refresh-agents rewrites AGENTS.md from meta and the template, keeping Brief and Notes", () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-refresh-"));
  init(dir);
  const fresh = readFileSync(join(dir, "AGENTS.md"), "utf8");
  const brief = "## Brief\n\n- Goal and audience: friends\n\n";
  const notes = "## Notes\n\n- Chose take 2 of the beach.\n";
  writeFileSync(join(dir, "AGENTS.md"), `# Old\n\nstale intro\n\n${brief}## Workflow\n\nstale\n\n${notes}`);
  execFileSync(process.execPath, [CLI, "op", "setMeta", JSON.stringify({ title: "Trip 2" })], { cwd: dir });
  const refresh = () => JSON.parse(execFileSync(process.execPath, [CLI, "init", "--refresh-agents"], { cwd: dir, encoding: "utf8" }));
  expect(refresh().created).toEqual(["AGENTS.md"]);
  const text = readFileSync(join(dir, "AGENTS.md"), "utf8");
  expect(text).toMatch(/^# Trip 2\n/);
  expect(text).toContain(brief);
  expect(text).toContain("## Editing reference");
  expect(text).toContain(".agents/skills/splicewright-editing/SKILL.md");
  expect(text).toContain(fresh.slice(fresh.indexOf("## Workflow"), fresh.indexOf("## Notes")));
  expect(text.endsWith(notes)).toBe(true);
  expect(refresh().created).toEqual([]);
});

it("init --preset sets the aspect, and refuses --size with it", () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-preset-"));
  const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, "init", ...args], { cwd: dir, encoding: "utf8" });
  expect(cli("--preset", "9:16", "--size", "640x480").status).toBe(1);
  expect(cli("--preset", "constructor").status).toBe(1);
  expect(cli("--preset", "4:5").status).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).meta).toMatchObject({ width: 1080, height: 1350 });
});

it("import copies files from outside the project into raw/, once", () => {
  const parent = mkdtempSync(join(tmpdir(), "swr-import-"));
  const dir = join(parent, "trip");
  mkdirSync(dir);
  init(dir);
  copyFileSync(join(import.meta.dirname, "../../../examples/basic/clip.mp4"), join(parent, "clip.mp4"));
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" }));
  cli("import", "../clip.mp4", "--no-ingest");
  cli("import", "../clip.mp4", "--no-ingest");
  expect(Object.values(JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).assets)).toEqual([{ id: "a_clip", path: "raw/clip.mp4", kind: "video" }]);
  expect(existsSync(join(dir, "raw", "clip-2.mp4"))).toBe(false);
});

it("import turns HEIC into a JPEG, once; the op alone refuses it", () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-heic-"));
  init(dir);
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" }));
  const photo = join(import.meta.dirname, "photo.heic"); // 320×180, from `sips -s format heic`
  cli("import", photo, "--no-ingest");
  cli("import", photo, "--no-ingest");
  expect(Object.values(JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).assets)).toEqual([{ id: "a_photo", path: "raw/photo.jpg", kind: "image" }]);
  expect(readFileSync(join(dir, "raw", "photo.jpg")).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  const op = spawnSync(process.execPath, [CLI, "op", "importAsset", JSON.stringify({ path: "raw/photo.heic" })], { cwd: dir, encoding: "utf8" });
  expect(JSON.parse(op.stdout).error.code).toBe("invalid");
});
