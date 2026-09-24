import { createReadStream, existsSync, readFileSync, statSync, watch } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer, type Plugin } from "vite";
import { load, loadCtx, readAssets, redo, run, undo } from "@splicewright/core/node";
import { limiter, thumb, waveform } from "@splicewright/ingest";
import { duckRanges } from "@splicewright/render/node";

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

/** Streams a file with HTTP Range support, which <video> seeking needs. */
function sendFile(req: IncomingMessage, res: ServerResponse, file: string, type?: string) {
  const size = statSync(file).size;
  const headers: Record<string, string | number> = { "Accept-Ranges": "bytes", ...(type && { "Content-Type": type }) };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (!m) {
    res.writeHead(200, { ...headers, "Content-Length": size });
    return createReadStream(file).pipe(res);
  }
  const start = m[1] ? Number(m[1]) : size - Number(m[2]);
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
  createReadStream(file, { start, end }).pipe(res);
}

const TYPES: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", m4v: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", aac: "audio/aac", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" };

// ponytail: at most 4 lazy ffmpeg jobs at once, FIFO; thumbs of 4K footage cost ~0.2 s each.
const limited = limiter(4);

function api(dir: string): Plugin {
  const clients = new Set<ServerResponse>();
  let timer: NodeJS.Timeout | undefined;
  // project.json is replaced by rename, so watch the folder, not the file.
  watch(dir, (_, name) => {
    if (name !== "project.json") return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const c of clients) c.write(`data: ${JSON.stringify({ revision: load(dir).revision })}\n\n`);
    }, 30);
  });

  const snapshot = () => {
    const project = load(dir);
    const proxies = Object.keys(project.assets).filter((id) => existsSync(join(dir, ".splicewright", "proxies", "edit", `${id}.mp4`)));
    const durations = Object.fromEntries(Object.entries(readAssets(dir)).flatMap(([id, a]) => (a.duration ? [[id, a.duration]] : [])));
    return { project, duck: duckRanges(project, loadCtx(dir)), proxies, durations };
  };
  const result = (res: ServerResponse, r: ReturnType<typeof run>) =>
    "error" in r ? send(res, r.error.code === "conflict" ? 409 : 400, r) : send(res, 200, { revision: r.project.revision, summary: r.changes.summary, ...snapshot() });

  const config = join(dir, "splicewright.config.ts");
  return {
    name: "splicewright",
    resolveId: (id) => (id === "virtual:swr-config" ? "\0swr-config" : undefined),
    load: (id) => (id === "\0swr-config" ? (existsSync(config) ? `export { default } from ${JSON.stringify(config)};` : "export default {};") : undefined),
    configureServer(server) {
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
          const route = `${req.method} ${url.pathname}`;
          if (route === "GET /api/project") return send(res, 200, { dir, ...snapshot() });
          if (route === "POST /api/op") {
            const b = await body(req);
            return result(res, run(dir, b.op, b.args, b.baseRevision));
          }
          if (route === "POST /api/undo") return result(res, undo(dir));
          if (route === "POST /api/redo") return result(res, redo(dir));
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
          send(res, 500, { error: (e as Error).message });
        }
      });
    },
  };
}

export async function open(dir: string, { port = 5190 } = {}) {
  dir = resolve(dir);
  if (!existsSync(join(dir, "project.json"))) throw new Error(`no project.json in ${dir}; run splicewright init`);
  const server = await createServer({
    configFile: false,
    root: here,
    logLevel: "warn",
    plugins: [react(), api(dir)],
    // Project components import react/remotion but the project folder has no node_modules.
    resolve: { dedupe: ["react", "react-dom", "remotion"], alias: { splicewright: join(here, "../../packages/render/src/config.ts") } },
    server: { host: "127.0.0.1", port, fs: { allow: [dir, join(here, "../..")] }, watch: { ignored: [join(dir, ".splicewright") + "/**"] } },
  });
  await server.listen();
  return { url: server.resolvedUrls!.local[0], dir: relative(process.cwd(), dir) || ".", close: () => server.close() };
}
