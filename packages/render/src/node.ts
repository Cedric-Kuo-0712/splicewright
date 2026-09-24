import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { load, loadCtx } from "@splicewright/core/node";
import { grid, scratch, spread } from "@splicewright/ingest";
import type { Preset } from "./config.ts";
import { duckRanges } from "./duck.ts";

export { duckRanges };

const here = dirname(fileURLToPath(import.meta.url));
/** Folder holding the node_modules Remotion is installed in. Remotion keys its Chrome download and
 * webpack cache on cwd; pinning both here keeps ~100 MB of cache out of every project folder. */
const root = join(dirname(createRequire(import.meta.url).resolve("@remotion/renderer/package.json")), "../../..");
let browser: string | undefined;
function browserExecutable(): string {
  const script = `import("@remotion/renderer").then((r) => r.ensureBrowser()).then((s) => console.log(JSON.stringify(s)))`;
  browser ??= JSON.parse(execFileSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").pop()!).path;
  return browser!;
}
const ID = "SplicewrightProject"; // Root.tsx's COMPOSITION_ID; not imported, Node can't load .tsx
const BUILTIN: Record<string, Preset> = { draft: { scale: 0.5, crf: 28 }, master: { crf: 18 } };

// ponytail: one bundle per project per process; restart `splicewright mcp` after editing
// components/ or splicewright.config.ts. Key on their mtimes if that gets annoying.
const bundles = new Map<string, Promise<string>>();

/** Bundles the composition plus the project's splicewright.config.ts; the project dir is symlinked as public/. */
export function bundleProject(dir: string): Promise<string> {
  if (!bundles.has(dir)) {
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
    const promise = bundle({
      entryPoint: entry,
      rootDir: root,
      publicDir: dir,
      symlinkPublicDir: true, // never copy raw footage into the bundle
      webpackOverride: (c) => ({
        ...c,
        resolve: { ...c.resolve, alias: { ...(c.resolve?.alias as object), splicewright: join(here, "config.ts") } },
      }),
    });
    promise.catch(() => bundles.delete(dir));
    bundles.set(dir, promise);
  }
  return bundles.get(dir)!;
}

async function prepare(dir: string) {
  const project = load(dir);
  const inputProps = { project, duck: duckRanges(project, loadCtx(dir)) };
  const serveUrl = await bundleProject(dir);
  const opts = { serveUrl, inputProps, browserExecutable: browserExecutable() };
  const composition = await selectComposition({ ...opts, id: ID });
  return { ...opts, composition };
}

/** Renders one frame. `output` null returns the image buffer; `maxWidth` scales down (MCP uses 960). */
export async function still(dir: string, frame: number, output: string | null, maxWidth?: number) {
  const { composition, ...opts } = await prepare(dir);
  if (!Number.isInteger(frame) || frame < 0 || frame >= composition.durationInFrames)
    throw new Error(`frame ${frame} outside 0..${composition.durationInFrames - 1}`);
  if (output) mkdirSync(dirname(output), { recursive: true });
  const { buffer } = await renderStill({
    ...opts,
    composition,
    frame,
    output,
    imageFormat: output?.endsWith(".png") ? "png" : "jpeg",
    scale: maxWidth ? Math.min(1, maxWidth / composition.width) : 1,
  });
  return { frame, output, buffer };
}

/**
 * `n` composition frames from timeline frames [from, to) as one grid, 320 px on the long side per tile:
 * the edit as a viewer sees it, at a fraction of the tokens of `n` stills.
 * ponytail: stills render one after another (~0.3 s each); render them concurrently if n grows.
 */
export async function storyboard(dir: string, { from = 0, to, n = 12 }: { from?: number; to?: number; n?: number } = {}) {
  const { composition, ...opts } = await prepare(dir);
  to = Math.min(to ?? composition.durationInFrames, composition.durationInFrames);
  if (!(to > from)) throw new Error(`empty range [${from}, ${to}) of 0..${composition.durationInFrames}`);
  n = Math.max(1, Math.min(24, Math.round(n), to - from));
  const frames = [...new Set(spread(from, to, n).map(Math.floor))];
  const scale = 320 / Math.max(composition.width, composition.height);
  const image = await scratch(async (tmp) => {
    for (const [k, frame] of frames.entries()) await renderStill({ ...opts, composition, frame, output: join(tmp, `${k}.jpg`), imageFormat: "jpeg", scale });
    return grid(tmp, frames.length);
  });
  return { image, frames };
}

export interface RenderOptions {
  output: string;
  preset?: string;
  /** Timeline frames [from, to). */
  range?: [number, number];
  onProgress?: (progress: number) => void;
}

export async function render(dir: string, { output, preset = "master", range, onProgress }: RenderOptions) {
  const { composition, ...opts } = await prepare(dir);
  const presets = { ...BUILTIN, ...(composition.props.presets as Record<string, Preset> | undefined) };
  if (!presets[preset]) throw new Error(`unknown preset "${preset}"; have ${Object.keys(presets).join(", ")}`);
  mkdirSync(dirname(output), { recursive: true });
  await renderMedia({
    ...opts,
    composition,
    codec: "h264",
    outputLocation: output,
    frameRange: range ? [range[0], range[1] - 1] : null,
    onProgress: ({ progress }) => onProgress?.(progress),
    ...presets[preset],
  });
  return { output, frames: range ? range[1] - range[0] : composition.durationInFrames, preset };
}

export interface Job {
  id: string;
  status: "running" | "done" | "error";
  progress: number;
  output: string;
  error?: string;
}

const jobs = new Map<string, Job>();

/** Starts render() in the background; poll with renderStatus(). In-process only. */
export function startRender(dir: string, opts: RenderOptions): Job {
  const job: Job = { id: `r_${(jobs.size + 1).toString(36)}`, status: "running", progress: 0, output: opts.output };
  jobs.set(job.id, job);
  render(dir, { ...opts, onProgress: (p) => (job.progress = +p.toFixed(3)) }).then(
    () => Object.assign(job, { status: "done", progress: 1 }),
    (e: Error) => Object.assign(job, { status: "error", error: e.message }),
  );
  return job;
}

export const renderStatus = (id: string) => jobs.get(id);
