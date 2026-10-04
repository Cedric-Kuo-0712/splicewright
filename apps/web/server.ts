import { createReadStream, createWriteStream, type ReadStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, watch } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { handleTtsRequest } from "./tts-api.ts";
import { BackgroundIngestScheduler } from "./background-ingest.ts";
import { isExportPreset } from "./export-options.ts";
import type { AddressInfo } from "node:net";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { addRecent, applyEditReview, applyLutPreset, cacheDir, fingerprint, getEditReview, historyList, init, load, loadCtx, rawPath, readAssets, recentProjects, redo, revertEditReview, run, setEditReviewStatus, sizesOf, undo, writeAtomic } from "@splicewright/core/node";
import { ASPECTS, captionWords, FPS_CHOICES, previewOps, sourceAt, type Project } from "@splicewright/core";
import { scanMaterials, relinkMaterial, prepareMaterials, audioFxPath, displayable, ensureAudioFx, ffmpeg, ingest, limiter, loudness, probe, reverseAudioPath, reverseProjectAudio, thumb, waveform, type Step } from "@splicewright/ingest";
import { cancelRender, renderStatus, startRender, duckRanges, fontVersionsOf, lutsOf, lutVersion, reverseProxiesOf } from "@splicewright/render/node";

// Spec §7.3. `splicewright open` runs this: a Vite dev server for the UI (open question 5, the simple
// option) plus a small API. Every mutation goes through core ops with the client's baseRevision.

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<any> {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

/** pipe() doesn't forward read errors; unhandled, one would take the server down. */
const stream = (from: ReadStream, res: ServerResponse) => from.on("error", () => res.destroy()).pipe(res);

/** Streams a file with HTTP Range support, which <video> seeking needs. */
function sendFile(req: IncomingMessage, res: ServerResponse, file: string, type?: string) {
  const size = statSync(file).size;
  const headers: Record<string, string | number> = { "Accept-Ranges": "bytes", ...(type && { "Content-Type": type }) };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (!m) {
    res.writeHead(200, { ...headers, "Content-Length": size });
    return stream(createReadStream(file), res);
  }
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])); // a suffix longer than the file means all of it
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
  stream(createReadStream(file, { start, end }), res);
}

const TYPES: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", m4v: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", aac: "audio/aac", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", svg: "image/svg+xml", ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2" };

// ponytail: at most 4 lazy ffmpeg jobs at once, FIFO; thumbs of 4K footage cost ~0.2 s each.
const limited = limiter(4);

/** No Origin header (curl, scripts) or this server's own page. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false; // "null" from sandboxed frames and file:// pages
  }
}

interface Hooks {
  home: string;
  /** Writes the agent files after /api/init; lives in the cli, which imports this module. */
  onInit?: (dir: string, meta: Project["meta"]) => string[];
  /** Restarts the server on another folder once the response is out. */
  switchTo: (dir: string) => void;
}

function api(dir: string, { home, onInit, switchTo }: Hooks): Plugin {
  const hasProject = () => existsSync(join(dir, "project.json"));
  const clients = new Set<ServerResponse>();
  const exportIds = new Set<string>();
  const broadcast = (m: unknown) => clients.forEach((c) => c.write(`data: ${JSON.stringify(m)}\n\n`));
  const audioFxPending = new Map<string, string>();
  const audioFxErrors = new Map<string, { path: string; message: string }>();
  const audioFxState = (project: Project) => {
    const sources: Record<string, string> = {};
    const reverseSources: Record<string, string> = {};
    const processing: string[] = [];
    const errors: Record<string, string> = {};
    for (const track of project.tracks) for (const item of track.items) {
      if (!("audioFx" in item) || !item.audioFx || !("assetId" in item)) continue;
      const itemFx = item.audioFx;
      const asset = project.assets[item.assetId];
      if (!asset) continue;
      let path: string;
      try { path = audioFxPath(dir, asset.id, asset.path, itemFx); }
      catch (error) { errors[item.id] = (error as Error).message; continue; }
      const reverse = "reverse" in item && !!item.reverse;
      const key = reverse ? reverseAudioPath(path) : path;
      const file = join(dir, key);
      if (existsSync(file) && existsSync(join(dir, path))) {
        sources[item.id] = `/media/${path.split("/").map(encodeURIComponent).join("/")}`;
        if (reverse) reverseSources[item.id] = `/media/${key.split("/").map(encodeURIComponent).join("/")}`;
        audioFxErrors.delete(item.id);
        continue;
      }
      const prior = audioFxErrors.get(item.id);
      if (prior?.path === key) errors[item.id] = prior.message;
      else if (audioFxPending.get(item.id) === key) processing.push(item.id);
      else {
        audioFxErrors.delete(item.id);
        audioFxPending.set(item.id, key);
        processing.push(item.id);
        void limited(() => ensureAudioFx(dir, asset.id, asset.path, itemFx)).then(async (output) => {
          if (reverse) await limited(() => reverseProjectAudio(dir, output));
          const lufs = await limited(() => loudness(join(dir, output)));
          if (lufs !== undefined) writeAtomic(join(dir, `${output}.json`), { lufs });
        }).catch((error) => {
          audioFxErrors.set(item.id, { path: key, message: (error as Error).message });
        }).finally(() => {
          if (audioFxPending.get(item.id) === key) audioFxPending.delete(item.id);
          broadcast({ revision: load(dir).revision });
        });
      }
    }
    return { sources, reverseSources, processing, errors };
  };
  // Expensive ingest stays serialized. Quick metadata saves merge synchronously in the route,
  // so the shared core context can use a new asset before unrelated background work finishes.
  let closed = false;
  const scheduler = new BackgroundIngestScheduler(async (id, steps) => {
    const readySteps: string[] = [];
    const result = await ingest(dir, { assets: [id], only: steps, log: (line) => {
      const step = line.split(" ")[0];
      if (["proxy", "thumbs", "waveform"].includes(step)) readySteps.push(step);
      else if (!closed) broadcast({ ingest: { id, step } });
    } });
    // These existing milestones now mean the cache is published, so a UI refresh can use it.
    for (const step of readySteps) if (!closed) broadcast({ ingest: { id, step } });
    if (result.errors?.length) throw new Error(result.errors.join("; "));
  }, (id, error) => broadcast({ ingest: { id, step: null, ...(error && { error }) } }));
  const background = (id: string, only?: Step[]) => only ? scheduler.enqueueOnly(id, only) : scheduler.enqueueFull(id);
  let timer: NodeJS.Timeout | undefined;
  // project.json is replaced by rename, so watch the folder, not the file.
  const watcher = watch(dir, (_, name) => {
    if (name !== "project.json") return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (hasProject()) broadcast({ revision: load(dir).revision });
    }, 30);
  });

  const snapshot = (project = load(dir)) => {
    const fx = audioFxState(project);
    const probes = Object.fromEntries(Object.entries(readAssets(dir)).filter(([id, probe]) => {
      const asset = project.assets[id];
      return asset && probe.path === asset.path && probe.fingerprint === fingerprint(join(dir, asset.path));
    }));
    const proxies = Object.keys(project.assets).filter((id) => {
      const probe = probes[id];
      return probe && probe.done?.proxy === probe.fingerprint
        && existsSync(join(dir, ".splicewright", "proxies", "edit", `${id}.mp4`));
    });
    const reverseProxies = reverseProxiesOf(dir, project);
    const durations = Object.fromEntries(Object.entries(probes).flatMap(([id, a]) => (a.duration ? [[id, a.duration]] : [])));
    const frameRates = Object.fromEntries(Object.entries(probes).flatMap(([id, a]) => (a.fps ? [[id, a.fps]] : [])));
    const ctx = loadCtx(dir, project);
    // A 65³ LUT is ~4 MB of JSON; the editor gets its version here and fetches the table from /api/lut when that changes.
    const lutVersions = Object.fromEntries(Object.entries(lutsOf(dir, project)).map(([id, lut]) => [id, lutVersion(lut)!]));
    const animated = Object.fromEntries(Object.entries(probes).flatMap(([id, probe]) => probe.animated ? [[id, true]] : []));
    return { project, duck: duckRanges(project, ctx), words: captionWords(project, ctx), proxies, reverseProxies, durations, frameRates, sizes: sizesOf(probes), animated, fontVersions: fontVersionsOf(dir, project), loudness: ctx.loudness ?? {}, audioFx: fx.sources, reverseAudioFx: fx.reverseSources, audioFxProcessing: fx.processing, audioFxErrors: fx.errors, audioFxLoudness: ctx.audioFxLoudness ?? {}, lutVersions };
  };
  const result = (res: ServerResponse, r: ReturnType<typeof run>) =>
    "error" in r ? send(res, r.error.code === "conflict" ? 409 : 400, r) : send(res, 200, { revision: r.project.revision, summary: r.changes.summary, ...snapshot() });

  const config = join(dir, "splicewright.config.ts");
  return {
    name: "splicewright",
    resolveId: (id) => (id === "virtual:swr-config" ? "\0swr-config" : undefined),
    load: (id) => (id === "\0swr-config" ? (existsSync(config) ? `export { default } from ${JSON.stringify(config)};` : "export default {};") : undefined),
    configureServer(server) {
      // A switch starts a new server on another folder; this one's watcher must not outlive it.
      server.httpServer?.on("close", () => { closed = true; scheduler.close(); clearTimeout(timer); watcher.close(); });
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://x");
        try {
          if (url.pathname.startsWith("/media/")) {
            // Project-relative path; resolve() collapses "..", then it must stay inside the project.
            const file = resolve(dir, decodeURIComponent(url.pathname.slice(7)));
            if (!file.startsWith(dir + sep) || !existsSync(file)) return send(res, 404, { error: "not found" });
            return sendFile(req, res, file, TYPES[file.split(".").pop()!.toLowerCase()]);
          }
          if (!url.pathname.startsWith("/api/")) return next();
          // Every POST writes: refuse cross-site requests, since any page can POST to localhost.
          // (Vite's host check, which runs first, already stops DNS rebinding.)
          if (req.method !== "GET" && !sameOrigin(req)) return send(res, 403, { error: { code: "forbidden", message: "cross-origin request refused" } });
          const route = `${req.method} ${url.pathname}`;
          const recent = () => recentProjects().filter((r) => resolve(r.path) !== dir);
          if (await handleTtsRequest(req, res, dir, snapshot)) return;
          if (route === "GET /api/project") return send(res, 200, hasProject() ? { dir, recent: recent(), ...snapshot() } : { dir, empty: true, recent: recent() });
          if (route === "POST /api/init") {
            if (hasProject()) return send(res, 409, { error: { code: "exists", message: "project.json already exists" } });
            const b = await body(req);
            const size = Object.hasOwn(ASPECTS, b.preset) ? ASPECTS[b.preset] : undefined;
            if (!size || !FPS_CHOICES.includes(b.fps)) return send(res, 400, { error: { code: "usage", message: "preset and fps must be one of the form's choices" } });
            const meta = { title: String(b.title ?? "").trim() || basename(dir), fps: b.fps, width: size[0], height: size[1] };
            const r = init(dir, meta);
            if ("error" in r) return send(res, 400, r);
            addRecent(dir, meta.title);
            return send(res, 200, { created: ["project.json", ...(onInit?.(dir, meta) ?? [])] });
          }
          if (route === "POST /api/switch") {
            // Only the startup folder or an entry of recent.json: the browser never names an arbitrary path.
            const path = resolve(String((await body(req)).path ?? ""));
            if (path !== home && !recentProjects().some((r) => resolve(r.path) === path)) return send(res, 403, { error: { code: "forbidden", message: "not a recent project" } });
            if (!existsSync(join(path, "project.json"))) return send(res, 404, { error: { code: "not_found", message: `no project.json in ${path}` } });
            send(res, 200, { dir: path });
            return path === dir ? undefined : switchTo(path);
          }
          if (!hasProject()) return send(res, 409, { error: { code: "no_project", message: "no project in this folder yet; create one with POST /api/init" } });
          if (route === "GET /api/export") {
            const jobs = [...exportIds].map((id) => renderStatus(id)).filter((job) => !!job).map((job) => ({ ...job, output: basename(job.output) }));
            return send(res, 200, jobs);
          }
          if (route === "POST /api/export") {
            const b = await body(req);
            const preset = b.preset;
            if (!isExportPreset(preset)) return send(res, 400, { error: { code: "invalid", message: "unknown export preset" } });
            const title = String(load(dir).meta.title).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "splicewright";
            const outputDir = join(dir, "exports");
            const output = join(outputDir, `${title}-${preset}-${Date.now()}.mp4`);
            mkdirSync(outputDir, { recursive: true });
            const job = startRender(dir, { output, preset });
            exportIds.add(job.id);
            return send(res, 202, { ...job, output: basename(job.output) });
          }
          const exportMatch = /^\/api\/export\/([^/]+)(?:\/(cancel|reveal))?$/.exec(url.pathname);
          if (exportMatch) {
            const [, id, action] = exportMatch;
            if (action && req.method !== "POST") return send(res, 405, { error: { code: "method_not_allowed", message: "export actions require POST" } });
            if (!action && req.method !== "GET") return send(res, 405, { error: { code: "method_not_allowed", message: "export status requires GET" } });
            if (!exportIds.has(id)) return send(res, 404, { error: { code: "not_found", message: "unknown export job" } });
            const job = renderStatus(id);
            if (!job) return send(res, 404, { error: { code: "not_found", message: "unknown export job" } });
            if (action === "cancel") {
              if (!cancelRender(id)) return send(res, 409, { error: { code: "not_running", message: "export is no longer running" } });
            } else if (action === "reveal") {
              if (job.status !== "done" || !existsSync(job.output)) return send(res, 409, { error: { code: "not_complete", message: "output is available after a successful export" } });
              try {
                if (process.platform === "darwin") await execFileAsync("open", ["-R", job.output]);
                else if (process.platform === "win32") await execFileAsync("explorer.exe", ["/select,", job.output]);
                else await execFileAsync("xdg-open", [dirname(job.output)]);
              } catch (e) { return send(res, 500, { error: { code: "open_failed", message: (e as Error).message } }); }
              return send(res, 200, { opened: true });
            }
            return send(res, 200, { ...job, output: basename(job.output) });
          }
          if (route === "GET /api/materials/scan") return send(res, 200, await scanMaterials(dir));
          if (route === "POST /api/materials/prepare") {
            const b = await body(req);
            return send(res, 200, await scheduler.runExclusive(() => prepareMaterials(dir, { paths: b.paths, steps: b.steps ?? ["sourceHealth", "thumbs", "waveform", "loudness"] })));
          }
          if (route === "POST /api/op/preview") {
            const b = await body(req);
            if (!Number.isSafeInteger(b.baseRevision) || b.baseRevision < 0 || !Array.isArray(b.ops) || !b.ops.length || b.ops.length > 200)
              return send(res, 400, { error: { code: "invalid_args", message: "a nonnegative baseRevision and 1–200 operations are required" } });
            const project = load(dir);
            if (project.revision !== b.baseRevision)
              return send(res, 409, { error: { code: "conflict", message: `project changed: expected revision ${b.baseRevision}, found ${project.revision}` } });
            const preview = previewOps(project, b.ops, loadCtx(dir, project));
            if ("error" in preview) return send(res, preview.error.code === "conflict" ? 409 : 400, preview);
            const MAX_MOVEMENTS = 100;
            const total = preview.movedTotal;
            return send(res, 200, { ...preview, summary: preview.summary.slice(0, 1000), summaryTruncated: preview.summaryTruncated || preview.summary.length > 1000, moved: preview.moved.slice(0, MAX_MOVEMENTS), movedTotal: total, limit: MAX_MOVEMENTS, truncated: preview.truncated || preview.moved.length > MAX_MOVEMENTS });
          }
          if (route === "POST /api/op") {
            const b = await body(req);
            return result(res, b.op === "relinkAsset" ? await relinkMaterial(dir, b.args, b.baseRevision) : run(dir, b.op, b.args, b.baseRevision));
          }
          if (route === "POST /api/edit-review/apply") {
            const b = await body(req);
            if (!Array.isArray(b.ops) || b.ops.length < 1) return send(res, 400, { error: { code: "invalid_args", message: "ops must be a non-empty array" } });
            const r = applyEditReview(dir, b.ops, { label: b.label, summary: b.summary, baseRevision: b.baseRevision });
            return "error" in r ? send(res, r.error.code === "conflict" ? 409 : 400, r) : send(res, 200, { revision: r.project.revision, summary: r.changes.summary, review: (r as any).review, ...snapshot() });
          }
          if (route === "GET /api/edit-review") {
            try {
              const review = getEditReview(dir, url.searchParams.get("id") ?? undefined, true);
              if (!review) return send(res, 404, { error: { code: "not_found", message: "edit review not found" } });
              const view = url.searchParams.get("view");
              if (view !== "before" && view !== "after") return send(res, 200, { ...review, before: undefined, after: undefined });
              const project = review[view];
              return send(res, 200, { ...snapshot(project), review: { id: review.id, label: review.label, summary: review.summary, status: review.status }, project });
            } catch (error) { return send(res, 400, { error: { code: "invalid_review", message: (error as Error).message } }); }
          }
          if (route === "POST /api/edit-review/status") {
            const b = await body(req);
            const r = setEditReviewStatus(dir, String(b.id ?? ""), b.status);
            return "error" in r && r.error ? send(res, r.error.code === "conflict" ? 409 : 400, r) : send(res, 200, r);
          }
          if (route === "POST /api/edit-review/revert") {
            const b = await body(req);
            const r = revertEditReview(dir, String(b.id ?? ""), b.baseRevision);
            return "error" in r ? send(res, r.error.code === "conflict" ? 409 : 400, r) : send(res, 200, { revision: r.project.revision, summary: r.changes.summary, ...snapshot() });
          }
          if (route === "POST /api/reverse-proxy") {
            const b = await body(req);
            const asset = load(dir).assets[b.assetId];
            if (!asset || asset.kind !== "video") return send(res, 400, { error: { code: "invalid", message: "reverse proxy requires a video asset" } });
            const path = join(dir, ".splicewright", "proxies", "reverse", `${asset.id}.mp4`);
            if (existsSync(path)) return send(res, 200, { ready: true, ...snapshot() });
            background(asset.id, ["reverse"]);
            return send(res, 202, { queued: true });
          }
          if (route === "POST /api/lut-presets/apply") {
            const b = await body(req);
            return result(res, applyLutPreset(dir, b.itemId, b.presetId, b.baseRevision, b.at));
          }
          if (route === "POST /api/import") {
            mkdirSync(join(dir, "raw"), { recursive: true });
            const tmp = join(dir, "raw", `.upload-${process.pid}-${Date.now()}`);
            await pipeline(req, createWriteStream(tmp));
            if (!statSync(tmp).size) return unlinkSync(tmp), send(res, 400, { error: "empty upload" });
            const path = await displayable(dir, rawPath(dir, url.searchParams.get("name") ?? "upload", tmp));
            const r = run(dir, "importAsset", { path });
            if ("error" in r) {
              if (!Object.values(load(dir).assets).some((a) => a.path === path)) unlinkSync(join(dir, path));
              return send(res, 400, r);
            }
            // "already imported as <id>" when another file in the project has the same content.
            const asset = Object.values(r.project.assets).find((a) => a.path === path) ?? r.project.assets[/as (\S+)/.exec(r.changes.summary)![1]];
            if (asset.path !== path) unlinkSync(join(dir, path));
            if (asset.kind !== "lut") {
              try {
                const before = fingerprint(join(dir, asset.path));
                const value = await limited(() => probe(join(dir, asset.path), asset.kind));
                const fp = fingerprint(join(dir, asset.path));
                if (!closed && fp && fp === before && load(dir).assets[asset.id]?.path === asset.path) {
                  // No await between read and write: same-process cache saves cannot interleave.
                  // Retain completed steps only when they still describe this exact source.
                  const disk = readAssets(dir);
                  const cached = disk[asset.id];
                  disk[asset.id] = { ...(cached?.path === asset.path && cached.fingerprint === fp ? cached : {}),
                    ...value, path: asset.path, fingerprint: fp };
                  mkdirSync(cacheDir(dir), { recursive: true });
                  writeAtomic(cacheDir(dir, "assets.json"), disk);
                }
              } catch { /* The serialized ingest reports probe failures through the existing event. */ }
              if (!closed && asset.kind !== "font") {
                background(asset.id);
              }
            }
            return send(res, 200, { assetId: asset.id, summary: r.changes.summary, ...snapshot() });
          }
          if (route === "POST /api/freeze") {
            // Grabs one source frame of a video item into raw/ as a still and imports it; the client places it.
            const { itemId, frame } = await body(req);
            const p = load(dir);
            const item = p.tracks.flatMap((t) => (t.kind === "video" ? t.items : [])).find((i) => i.id === itemId);
            const asset = item && "assetId" in item ? p.assets[item.assetId] : undefined;
            if (!item || !("sourceIn" in item) || asset?.kind !== "video") return send(res, 400, { error: { message: `${itemId} is not a video item` } });
            const f = Math.min(Math.max(Number(frame) || 0, item.start), item.start + item.duration - 1);
            const t = sourceAt(p, item, f);
            const tmp = join(dir, "raw", `.freeze-${process.pid}-${Date.now()}.png`);
            await ffmpeg(["-ss", t.toFixed(3), "-i", join(dir, asset.path), "-frames:v", "1", tmp]);
            const stem = basename(asset.path, extname(asset.path));
            const path = rawPath(dir, `${stem}-freeze-${Math.round(t * p.meta.fps)}.png`, tmp);
            const r = run(dir, "importAsset", { path });
            // Same content imported before: reuse that asset.
            const id = "error" in r ? undefined : (Object.values(r.project.assets).find((a) => a.path === path) ?? r.project.assets[/as (\S+)/.exec(r.changes.summary)?.[1] ?? ""])?.id;
            if (!id) return send(res, 400, "error" in r ? r : { error: { message: "freeze import failed" } });
            background(id);
            return send(res, 200, { assetId: id, ...snapshot() });
          }
          if (route === "POST /api/undo" || route === "POST /api/redo") {
            // `steps` > 1 jumps through the history panel; stops at the first failure but still returns
            // the steps that landed. `baseRevision` guards the first step: the client only undoes what it has on screen.
            const b = await body(req);
            const steps = Math.max(1, Math.min(1000, Number(b.steps) || 1));
            const fn = route.endsWith("undo") ? undo : redo;
            let r = fn(dir, typeof b.baseRevision === "number" ? b.baseRevision : undefined);
            for (let k = 1; k < steps && !("error" in r); k++) {
              const next = fn(dir);
              if ("error" in next) break;
              r = next;
            }
            return result(res, r);
          }
          if (route === "GET /api/history") return send(res, 200, historyList(dir));
          if (route === "GET /api/lut") {
            const id = url.searchParams.get("asset") ?? "";
            const view = url.searchParams.get("view");
            const review = view === "before" || view === "after" ? getEditReview(dir, url.searchParams.get("id") ?? undefined, true) : undefined;
            if (view && !review) return send(res, 404, { error: { code: "not_found", message: "Review snapshot is unavailable" } });
            const lut = lutsOf(dir, review && (view === "before" || view === "after") ? review[view] : load(dir))[id];
            return lut ? send(res, 200, lut) : send(res, 404, { error: { code: "not_found", message: `LUT ${id} is unused, missing or invalid` } });
          }
          if (route === "GET /api/events") {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
            res.write(": connected\n\n");
            clients.add(res);
            return req.on("close", () => clients.delete(res));
          }
          const view = url.searchParams.get("view");
          const review = view === "before" || view === "after" ? getEditReview(dir, url.searchParams.get("id") ?? undefined, true) : undefined;
          const previewProject = review && (view === "before" || view === "after") ? review[view] : load(dir);
          const asset = previewProject.assets[url.searchParams.get("asset") ?? ""];
          if (!asset) return send(res, 404, { error: "unknown asset" });
          if (route === "GET /api/thumb") {
            const t = Math.max(0, Math.round(Number(url.searchParams.get("t")) || 0));
            if (asset.kind === "image") return sendFile(req, res, join(dir, asset.path));
            return sendFile(req, res, await thumb(dir, view ? `${asset.id}-${fingerprint(join(dir, asset.path))}` : asset.id, asset.path, t, limited), "image/jpeg");
          }
          if (route === "GET /api/waveform") return res.end(readFileSync(await waveform(dir, asset.id, asset.path, limited)));
          send(res, 404, { error: `no route ${route}` });
        } catch (e) {
          // A failure after the headers went out (a stream error mid-file) can only end the response.
          if (res.headersSent) res.destroy();
          else send(res, 500, { error: (e as Error).message });
        }
      });
    },
  };
}

export async function open(dir: string, { port = 5190, onInit }: { port?: number; onInit?: Hooks["onInit"] } = {}) {
  const home = resolve(dir);
  let server!: ViteDevServer;
  let current = home;
  let bound = port;
  // The folder is baked into the Vite config (fs.allow, the project's config import), so a switch is a restart.
  const start = async (dir: string, port: number, strictPort: boolean) => {
    if (existsSync(join(dir, "project.json"))) {
      const title = (() => {
        try {
          return String(load(dir).meta.title);
        } catch {
          return basename(dir); // a corrupt project.json still opens; /api/project shows the error
        }
      })();
      addRecent(dir, title);
    }
    server = await createServer({
      configFile: false,
      root: here,
      logLevel: "warn",
      plugins: [react(), api(dir, { home, onInit, switchTo })],
      // Project components import react/remotion but the project folder has no node_modules.
      resolve: { dedupe: ["react", "react-dom", "remotion"], alias: {
        "splicewright/animation": join(here, "../../packages/render/src/animation.tsx"),
        splicewright: join(here, "../../packages/render/src/config.ts"),
      } },
      server: { host: "127.0.0.1", port, strictPort, fs: { allow: [dir, join(here, "../..")] }, watch: { ignored: [join(dir, ".splicewright") + "/**"] } },
    });
    await server.listen();
    current = dir;
  };
  // Switches run one at a time, each after a delay so its /api/switch response gets out before the
  // old server drops its connections. A failed start falls back to the previous folder: never no server.
  let queue = Promise.resolve();
  const switchTo = (next: string) =>
    (queue = queue.then(async () => {
      await new Promise((ok) => setTimeout(ok, 50));
      const prev = current;
      await server.close();
      for (const dir of [next, prev]) {
        try {
          return await start(dir, bound, true);
        } catch (e) {
          console.error(`could not serve ${dir}: ${(e as Error).message}`);
          await server.close().catch(() => {});
        }
      }
    }));
  await start(home, port, false);
  bound = (server.httpServer!.address() as AddressInfo).port;
  return { url: server.resolvedUrls!.local[0], dir: relative(process.cwd(), home) || ".", close: () => server.close() };
}
