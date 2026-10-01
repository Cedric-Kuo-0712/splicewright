import { createReadStream, createWriteStream, type ReadStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, watch } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { AddressInfo } from "node:net";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { addRecent, applyLutPreset, historyList, init, load, loadCtx, rawPath, readAssets, recentProjects, redo, run, sizesOf, undo } from "@splicewright/core/node";
import { ASPECTS, captionWords, FPS_CHOICES, sourceAt, type Project } from "@splicewright/core";
import { displayable, ffmpeg, ingest, limiter, thumb, waveform } from "@splicewright/ingest";
import { duckRanges, lutsOf, lutVersion } from "@splicewright/render/node";

// Spec §7.3. `splicewright open` runs this: a Vite dev server for the UI (open question 5, the simple
// option) plus a small API. Every mutation goes through core ops with the client's baseRevision.

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

const TYPES: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", m4v: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", aac: "audio/aac", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" };

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
  const broadcast = (m: unknown) => clients.forEach((c) => c.write(`data: ${JSON.stringify(m)}\n\n`));
  // One ingest at a time: concurrent runs would each rewrite assets.json from their own snapshot.
  let queue = Promise.resolve();
  const background = (id: string) =>
    (queue = queue.then(async () => {
      await ingest(dir, { assets: [id], log: (line) => broadcast({ ingest: { id, step: line.split(" ")[0] } }) }).catch(() => {});
      broadcast({ ingest: { id, step: null } });
    }));
  let timer: NodeJS.Timeout | undefined;
  // project.json is replaced by rename, so watch the folder, not the file.
  const watcher = watch(dir, (_, name) => {
    if (name !== "project.json") return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (hasProject()) broadcast({ revision: load(dir).revision });
    }, 30);
  });

  const snapshot = () => {
    const project = load(dir);
    const proxies = Object.keys(project.assets).filter((id) => existsSync(join(dir, ".splicewright", "proxies", "edit", `${id}.mp4`)));
    const probes = readAssets(dir);
    const durations = Object.fromEntries(Object.entries(probes).flatMap(([id, a]) => (a.duration ? [[id, a.duration]] : [])));
    const ctx = loadCtx(dir);
    // A 65³ LUT is ~4 MB of JSON; the editor gets its version here and fetches the table from /api/lut when that changes.
    const lutVersions = Object.fromEntries(Object.entries(lutsOf(dir, project)).map(([id, lut]) => [id, lutVersion(lut)!]));
    return { project, duck: duckRanges(project, ctx), words: captionWords(project, ctx), proxies, durations, sizes: sizesOf(probes), loudness: ctx.loudness ?? {}, lutVersions };
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
      server.httpServer?.on("close", () => (clearTimeout(timer), watcher.close()));
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
          if (route === "POST /api/op") {
            const b = await body(req);
            return result(res, run(dir, b.op, b.args, b.baseRevision));
          }
          if (route === "POST /api/lut-presets/apply") {
            const b = await body(req);
            return result(res, applyLutPreset(dir, b.itemId, b.presetId, b.baseRevision));
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
            await queue;
            if (asset.kind !== "lut") {
              await ingest(dir, { assets: [asset.id], only: [] }); // probe now, so the answer carries the duration
              background(asset.id);
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
            const lut = lutsOf(dir, load(dir))[id];
            return lut ? send(res, 200, lut) : send(res, 404, { error: { code: "not_found", message: `LUT ${id} is unused, missing or invalid` } });
          }
          if (route === "GET /api/events") {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
            res.write(": connected\n\n");
            clients.add(res);
            return req.on("close", () => clients.delete(res));
          }
          const asset = load(dir).assets[url.searchParams.get("asset") ?? ""];
          if (!asset) return send(res, 404, { error: "unknown asset" });
          if (route === "GET /api/thumb") {
            const t = Math.max(0, Math.round(Number(url.searchParams.get("t")) || 0));
            if (asset.kind === "image") return sendFile(req, res, join(dir, asset.path));
            return sendFile(req, res, await thumb(dir, asset.id, asset.path, t, limited), "image/jpeg");
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
