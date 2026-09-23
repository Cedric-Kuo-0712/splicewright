import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { open } from "../server.ts";

// Media serving is the UI's one path from a URL to the file system; ops must keep revision checks.
const parent = mkdtempSync(join(tmpdir(), "swr-web-"));
const dir = join(parent, "project");
writeFileSync(join(parent, "secret.txt"), "outside the project");
cpSync(join(import.meta.dirname, "../../../examples/basic"), dir, { recursive: true, filter: (f) => !f.includes(".splicewright") });
let server: Awaited<ReturnType<typeof open>>;
beforeAll(async () => void (server = await open(dir, { port: 5199 })));
afterAll(() => server.close());

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
  for (const path of ["/media/..%2fsecret.txt", "/media/%2e%2e%2fsecret.txt", "/media/..%5csecret.txt", "/media/%2fetc%2fhosts"])
    expect((await get(path)).status, path).toBe(404);
});

it("applies ops against the client's revision", async () => {
  const post = (body: unknown) =>
    fetch(`${server.url}api/op`, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const { project } = await (await fetch(`${server.url}api/project`)).json();
  const ok = await post({ op: "addMarker", args: { label: "x", start: 5 }, baseRevision: project.revision });
  expect(ok).toMatchObject({ status: 200, data: { revision: project.revision + 1 } });
  expect(await post({ op: "addMarker", args: { label: "y", start: 6 }, baseRevision: project.revision })).toMatchObject({ status: 409, data: { error: { code: "conflict" } } });
});
