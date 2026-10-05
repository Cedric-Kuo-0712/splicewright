import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bundleProject } from "../src/node.ts";

const basic = join(import.meta.dirname, "../../../examples/basic");
const copies: string[] = [];
afterEach(() => { for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const copy = () => {
  const tmp = mkdtempSync(join(tmpdir(), "swr-bundle-"));
  copies.push(tmp);
  cpSync(basic, tmp, { recursive: true, filter: (s) => !/\/(out|\.splicewright)(\/|$)/.test(s) });
  return tmp;
};

it("bundles in a child, keeps the output after it exits, and memoises per dir", { timeout: 300_000 }, async () => {
  const dir = copy();
  const first = bundleProject(dir);
  expect(bundleProject(dir)).toBe(first);
  const url = await first;
  expect(existsSync(join(url, "index.html"))).toBe(true);
  expect(await bundleProject(dir)).toBe(url);
});

it("rejects with the bundler's message on a broken config, then retries", { timeout: 300_000 }, async () => {
  const dir = copy();
  const config = join(dir, "splicewright.config.ts");
  writeFileSync(config, "export default {{{ nope");
  await expect(bundleProject(dir)).rejects.toThrow(/bundling .* failed:[\s\S]*splicewright\.config\.ts/);
  writeFileSync(config, "export default {};");
  expect(existsSync(join(await bundleProject(dir), "index.html"))).toBe(true);
});

it("bundles when the parent runs with flags the child must not inherit", { timeout: 300_000 }, () => {
  const dir = copy();
  const node = join(import.meta.dirname, "../src/node.ts");
  const script = `import { bundleProject } from ${JSON.stringify(node)}; console.log(await bundleProject(${JSON.stringify(dir)}));`;
  const url = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).trim().split("\n").at(-1)!;
  expect(existsSync(join(url, "index.html"))).toBe(true);
});
