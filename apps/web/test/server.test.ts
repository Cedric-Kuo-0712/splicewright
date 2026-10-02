import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { addRecent, init, recentProjects } from "@splicewright/core/node";
import { open } from "../server.ts";

// Media serving is the UI's one path from a URL to the file system; ops must keep revision checks.
const parent = mkdtempSync(join(tmpdir(), "swr-web-"));
process.env.SPLICEWRIGHT_HOME = join(parent, "home");
const dir = join(parent, "project");
writeFileSync(join(parent, "secret.txt"), "outside the project");
cpSync(join(import.meta.dirname, "../../../examples/basic"), dir, { recursive: true, filter: (f) => !f.includes(".splicewright") });
let server: Awaited<ReturnType<typeof open>>;
beforeAll(async () => void (server = await open(dir, { port: 5199 })));
afterAll(() => server.close());

it("resolves agent animation helpers in an external project's preview", async () => {
  const file = join(dir, "components", "AnimationProbe.tsx");
  writeFileSync(file, [
    'import { SketchPath, MorphPath, Lottie, Arrow } from "splicewright/animation";',
    'export const AnimationProbe = () => <svg><SketchPath d="M0 0 L10 10" /></svg>;',
    'export const helpers = [SketchPath, MorphPath, Lottie, Arrow];',
  ].join("\n"));
  const response = await fetch(`http://127.0.0.1:5199/@fs/${file}`);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("packages/render/src/animation.tsx");
});

/** Raw request, so the path reaches the server without client-side dot-segment normalisation. */
const get = (path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; headers: Record<string, unknown>; length: number }>((ok, fail) =>
    request({ host: "127.0.0.1", port: 5199, path, headers }, (res) => {
      let length = 0;
      res.on("data", (d) => (length += d.length));
      res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, length }));
    })
      .on("error", fail)
      .end(),
  );

it("serves media byte ranges and nothing outside the project", async () => {
  const r = await get("/media/clip.mp4", { Range: "bytes=10-19" });
  expect([r.status, r.length, r.headers["content-type"]]).toEqual([206, 10, "video/mp4"]);
  const all = await get("/media/clip.mp4");
  expect(await get("/media/clip.mp4", { Range: "bytes=-999999999" })).toMatchObject({ status: 206, length: all.length });
  for (const path of ["/media/..%2fsecret.txt", "/media/%2e%2e%2fsecret.txt", "/media/..%5csecret.txt", "/media/%2fetc%2fhosts"])
    expect((await get(path)).status, path).toBe(404);
});

it("applies a built-in LUT preset through the route and rejects bad ids", async () => {
  const projectDir = join(parent, "lut-project");
  cpSync(join(import.meta.dirname, "../../../examples/basic"), projectDir, { recursive: true, filter: (f) => !f.includes(".splicewright") });
  const lutServer = await open(projectDir, { port: 0 });
  try {
    const post = (body: unknown) => fetch(`${lutServer.url}api/lut-presets/apply`, { method: "POST", body: JSON.stringify(body) });
    expect(existsSync(join(projectDir, "raw", "luts"))).toBe(false);
    expect((await post({ itemId: "i_1", presetId: "stripedpurple-1920s" })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(projectDir, "raw", "luts", "licenses", "stripedpurple-1920s-attribution.json"), "utf8")).license).toBe("MIT");
    expect((await post({ itemId: "i_1", presetId: "nope" })).status).toBe(400);
    expect((await post({ itemId: "nope", presetId: "stripedpurple-1920s" })).status).toBe(400);
  } finally {
    await lutServer.close();
  }
});

it("applies ops against the client's revision", async () => {
  const post = (body: unknown) =>
    fetch(`${server.url}api/op`, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const { project } = await (await fetch(`${server.url}api/project`)).json();
  const ok = await post({ op: "addMarker", args: { label: "x", start: 5 }, baseRevision: project.revision });
  expect(ok).toMatchObject({ status: 200, data: { revision: project.revision + 1 } });
  expect(await post({ op: "addMarker", args: { label: "y", start: 6 }, baseRevision: project.revision })).toMatchObject({ status: 409, data: { error: { code: "conflict" } } });
});

it("manages export jobs and refuses to reveal an incomplete output", async () => {
  const post = (path: string, body: unknown) => fetch(`${server.url}${path}`, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  expect(await post("api/export", { preset: "unknown" })).toMatchObject({ status: 400, data: { error: { code: "invalid" } } });
  const started = await post("api/export", { preset: "draft" });
  expect(started).toMatchObject({ status: 202, data: { status: "running", preset: "draft", output: expect.stringMatching(/\.mp4$/) } });
  const id = started.data.id as string;
  expect(await post(`api/export/${id}/reveal`, {})).toMatchObject({ status: 409, data: { error: { code: "not_complete" } } });
  expect(await post(`api/export/${id}/cancel`, {})).toMatchObject({ status: 200, data: { status: "cancelled" } });
  expect(await (await fetch(`${server.url}api/export`)).json()).toMatchObject([{ id, status: "cancelled" }]);
});

it("undo past the oldest step lands the steps that exist", async () => {
  const post = (path: string, body: unknown) => fetch(`${server.url}${path}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  const { project } = await (await fetch(`${server.url}api/project`)).json();
  const { revision } = await post("api/op", { op: "addMarker", args: { label: "z", start: 7 }, baseRevision: project.revision });
  const r = await post("api/undo", { steps: 1000, baseRevision: revision });
  expect(r.error).toBeUndefined();
  expect(r.project.markers?.some((m: { label: string }) => m.label === "z")).toBeFalsy();
  expect((await (await fetch(`${server.url}api/history`)).json()).undo).toEqual([]);
});

it("refuses writes from other sites", async () => {
  const { project } = await (await fetch(`${server.url}api/project`)).json();
  const evil = { Origin: "https://evil.example", "Content-Type": "text/plain" };
  for (const path of ["api/op", "api/undo", "api/import?name=x.mp4"]) {
    const r = await fetch(`${server.url}${path}`, { method: "POST", headers: evil, body: JSON.stringify({ op: "addMarker", args: { label: "x", start: 0 }, steps: 5 }) });
    expect(r.status, path).toBe(403);
  }
  expect((await (await fetch(`${server.url}api/project`)).json()).project.revision).toBe(project.revision);
});

const postJson = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));

it("an empty folder serves the form: only /api/project and /api/init work, and init creates the project", async () => {
  const empty = join(parent, "empty");
  mkdirSync(empty);
  const s = await open(empty, { port: 5198, onInit: () => ["AGENTS.md"] });
  try {
    expect(await (await fetch(`${s.url}api/project`)).json()).toMatchObject({ dir: empty, empty: true });
    expect(await postJson(s.url, "api/op", { op: "addMarker", args: { label: "x", start: 0 } })).toMatchObject({ status: 409, data: { error: { code: "no_project" } } });
    expect((await fetch(`${s.url}api/history`)).status).toBe(409);
    expect((await postJson(s.url, "api/init", { title: "T", preset: "9:16", fps: 25 }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await postJson(s.url, "api/init", { title: "T", preset: "constructor", fps: 25 })).status).toBe(400);
    expect(existsSync(join(empty, "project.json"))).toBe(false);
    expect(await postJson(s.url, "api/init", { title: "T", preset: "9:16", fps: 25 })).toMatchObject({ status: 200, data: { created: ["project.json", "AGENTS.md"] } });
    expect(JSON.parse(readFileSync(join(empty, "project.json"), "utf8")).meta).toMatchObject({ title: "T", fps: 25, width: 1080, height: 1920 });
    expect(recentProjects()[0]).toMatchObject({ path: empty, title: "T" });
    expect((await (await fetch(`${s.url}api/project`)).json()).project.revision).toBe(0);
    expect((await postJson(s.url, "api/init", { title: "T", preset: "1:1", fps: 30 })).status).toBe(409);
  } finally {
    await s.close();
  }
});

it("switches only to the startup folder or a recent project, never a foreign origin or an arbitrary path", async () => {
  const other = join(parent, "other");
  init(other, { title: "Other", fps: 30, width: 1920, height: 1080 });
  const unlisted = join(parent, "unlisted");
  init(unlisted, { title: "Unlisted", fps: 30, width: 1920, height: 1080 });
  const sw = (path: string, headers?: Record<string, string>) => postJson(server.url, "api/switch", { path }, headers);
  expect((await sw(unlisted)).status).toBe(403);
  expect((await sw(join(parent, "project", "..", "unlisted"))).status).toBe(403);
  expect((await sw("/etc")).status).toBe(403);
  addRecent(other, "Other");
  expect((await sw(other, { Origin: "https://evil.example" })).status).toBe(403);
  rmSync(join(other, "project.json"));
  expect((await sw(other)).status).toBe(404);
  init(other, { title: "Other", fps: 30, width: 1920, height: 1080 });
  expect((await sw(other)).status).toBe(200);
  // The server restarts on the same port, now serving `other`.
  let now: { dir?: string } | null = null;
  for (let k = 0; k < 50 && now?.dir !== other; k++) {
    await new Promise((ok) => setTimeout(ok, 100));
    now = await fetch(`${server.url}api/project`).then((r) => r.json(), () => null);
  }
  expect(now?.dir).toBe(other);
  expect((await (await fetch(`${server.url}api/project`)).json()).recent.map((r: { path: string }) => r.path)).not.toContain(other);
});

it("survives two concurrent switches", async () => {
  const [b, c] = ["b", "c"].map((n) => {
    const d = join(parent, n);
    init(d, { title: n, fps: 30, width: 1920, height: 1080 });
    addRecent(d, n);
    return d;
  });
  const rs = await Promise.all([b, c].map((path) => postJson(server.url, "api/switch", { path })));
  expect(rs.map((r) => r.status)).toEqual([200, 200]);
  let now: { dir?: string } | null = null;
  for (let k = 0; k < 80 && ![b, c].includes(now?.dir ?? ""); k++) {
    await new Promise((ok) => setTimeout(ok, 100));
    now = await fetch(`${server.url}api/project`).then((r) => r.json(), () => null);
  }
  expect([b, c]).toContain(now?.dir);
  await new Promise((ok) => setTimeout(ok, 300)); // the second switch lands last; it must leave a live server too
  expect([b, c]).toContain((await (await fetch(`${server.url}api/project`)).json()).dir);
});
