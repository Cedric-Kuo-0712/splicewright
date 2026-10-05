// Runs in a short-lived child of node.ts's bundleProject: webpack leaves ~500 MiB of native memory
// that GC can't reclaim, so it lives and dies here instead of in the long-lived export process.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { projectAliases } from "./aliases.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Writes the project's entry.tsx and bundles it; `root` is the node_modules folder Remotion keys its caches on. */
export async function bundleEntry(dir: string, root: string): Promise<string> {
  const config = join(dir, "splicewright.config.ts");
  const entry = join(dir, ".splicewright", "entry.tsx");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(
    entry,
    [
      `import { registerRoot } from "remotion";`,
      `import { makeRoot } from ${JSON.stringify(join(here, "Root.tsx"))};`,
      existsSync(config) ? `import config from ${JSON.stringify(config)};` : `const config = {};`,
      `registerRoot(makeRoot(config));`,
    ].join("\n"),
  );
  return bundle({
    entryPoint: entry,
    rootDir: root,
    publicDir: dir,
    symlinkPublicDir: true, // never copy raw footage into the bundle
    webpackOverride: (c) => ({
      ...c,
      resolve: { ...c.resolve, alias: projectAliases(here, c.resolve?.alias as Record<string, unknown> | undefined) },
    }),
  });
}

if (process.send) {
  process.once("message", async (m: { dir: string; root: string }) => {
    let reply: { serveUrl: string } | { error: string };
    try { reply = { serveUrl: await bundleEntry(m.dir, m.root) }; }
    catch (e) { reply = { error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) }; }
    process.send!(reply, () => process.exit(0));
  });
}
