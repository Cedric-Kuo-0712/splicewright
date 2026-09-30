import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const CLI = join(import.meta.dirname, "../src/main.ts");
const init = (cwd: string) => JSON.parse(execFileSync(process.execPath, [CLI, "init", "--title", "Trip", "--fps", "25"], { cwd, encoding: "utf8" }));

it("init writes the agent files once and keeps other MCP servers", () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-init-"));
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  expect(init(dir).created).toEqual(["project.json", "AGENTS.md", "CLAUDE.md", ".mcp.json"]);
  expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("# Trip\n\nSplicewright video project, 1920×1080 at 25 fps.");
  const { mcpServers } = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
  expect(Object.keys(mcpServers)).toEqual(["other", "splicewright"]);
  expect(mcpServers.splicewright.args).toEqual([CLI, "mcp"]);
  writeFileSync(join(dir, "AGENTS.md"), "mine");
  expect(init(dir).created).toEqual([]);
  expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("mine");
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
