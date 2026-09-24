import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
