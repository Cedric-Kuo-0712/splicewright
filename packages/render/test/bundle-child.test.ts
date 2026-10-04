import { cpSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { bundleProject } from "../src/node.ts";

const basic = join(import.meta.dirname, "../../../examples/basic");
const copy = () => {
  const tmp = mkdtempSync(join(tmpdir(), "swr-bundle-"));
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
