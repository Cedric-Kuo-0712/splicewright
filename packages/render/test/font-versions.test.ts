import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createProject } from "@splicewright/core";
import { fontVersionsOf } from "../src/node.ts";

it("invalidates a font with the same asset id and path across projects and file replacements", () => {
  const parent = mkdtempSync(join(tmpdir(), "swr-font-versions-"));
  try {
    const first = join(parent, "first"), second = join(parent, "second");
    for (const dir of [first, second]) mkdirSync(join(dir, "raw"), { recursive: true });
    const modules = join(import.meta.dirname, "../../../node_modules/@fontsource");
    const anton = join(modules, "anton/files/anton-latin-400-normal.woff2");
    const bebas = join(modules, "bebas-neue/files/bebas-neue-latin-400-normal.woff2");
    copyFileSync(anton, join(first, "raw/brand.woff2"));
    copyFileSync(bebas, join(second, "raw/brand.woff2"));
    const project = createProject({ title: "same", fps: 30, width: 320, height: 180 });
    project.assets.a_brand = { id: "a_brand", path: "raw/brand.woff2", kind: "font" };
    const original = fontVersionsOf(first, project).a_brand;
    expect(fontVersionsOf(second, project).a_brand).not.toBe(original);
    copyFileSync(bebas, join(first, "raw/brand.woff2"));
    expect(fontVersionsOf(first, project).a_brand).not.toBe(original);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
