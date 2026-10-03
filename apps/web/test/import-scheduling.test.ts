import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheDir, fingerprint, init, load, readAssets, writeAtomic } from "@splicewright/core/node";

const control = vi.hoisted(() => ({ blockNext: false, started: undefined as (() => void) | undefined, release: undefined as (() => void) | undefined, onProbe: undefined as ((path: string) => void) | undefined }));
vi.mock("@splicewright/ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@splicewright/ingest")>();
  return {
    ...actual,
    probe: vi.fn(async (path: string, kind: "video" | "audio" | "image" | "font") => {
      if (kind === "font") return actual.probe(path, kind);
      control.onProbe?.(path);
      return { kind, duration: path.includes("second") ? 2 : 1, fps: 30, audio: false };
    }),
    ingest: vi.fn(async () => {
      if (!control.blockNext) return { errors: [] };
      control.blockNext = false;
      control.started?.();
      await new Promise<void>((resolve) => { control.release = resolve; });
      return { errors: [] };
    }),
  };
});

describe("web import scheduling", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    control.blockNext = false;
    control.started = undefined;
    control.release?.();
    control.release = undefined;
    control.onProbe = undefined;
  });

  it("returns a new import probe while an earlier serialized ingest is blocked", async () => {
    const { open } = await import("../server.ts");
    const dir = mkdtempSync(join(tmpdir(), "swr-import-scheduling-"));
    dirs.push(dir);
    init(dir, { title: "schedule", fps: 30, width: 640, height: 360 });
    const server = await open(dir, { port: 0 });
    let release!: () => void;
    try {
      const started = new Promise<void>((resolve) => { control.started = resolve; });
      control.blockNext = true;
      const upload = (name: string) => fetch(`${server.url}api/import?name=${name}.mp4`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from("synthetic-media"),
      }).then(async (response) => ({ status: response.status, body: await response.json() }));
      const first = await upload("first");
      expect(first.status).toBe(200);
      await started;
      release = control.release!;
      const second = await Promise.race([
        upload("second"),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("second import waited for background ingest")), 500)),
      ]);
      expect(second.status).toBe(200);
      expect(second.body.durations).toMatchObject({ [second.body.assetId]: 2 });
      expect(readAssets(dir)[second.body.assetId]?.duration).toBe(2);
      const inserted = await fetch(`${server.url}api/op`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "insertItem", args: { assetId: second.body.assetId, at: 0 } }),
      });
      expect(inserted.status).toBe(200);
    } finally {
      release?.();
      await server.close();
    }
  });

  it("still validates and publishes font metadata without queuing media analysis", async () => {
    const { open } = await import("../server.ts");
    const { ingest, probe } = await import("@splicewright/ingest");
    vi.mocked(ingest).mockClear();
    const dir = mkdtempSync(join(tmpdir(), "swr-font-probe-"));
    dirs.push(dir);
    init(dir, { title: "font probe", fps: 30, width: 640, height: 360 });
    const server = await open(dir, { port: 0 });
    try {
      const response = await fetch(`${server.url}api/import?name=font.woff`, { method: "POST", body: Buffer.from("wOFFsynthetic-font") });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(readAssets(dir)[body.assetId]?.kind).toBe("font");
      expect(probe).toHaveBeenCalledWith(join(dir, load(dir).assets[body.assetId].path), "font");
      expect(ingest).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it("preserves matching completed steps without falsely announcing a proxy", async () => {
    const { open } = await import("../server.ts");
    const dir = mkdtempSync(join(tmpdir(), "swr-probe-merge-"));
    dirs.push(dir);
    init(dir, { title: "probe merge", fps: 30, width: 640, height: 360 });
    const server = await open(dir, { port: 0 });
    control.onProbe = (path) => {
      const asset = Object.values(load(dir).assets).find((asset) => join(dir, asset.path) === path)!;
      const stamp = fingerprint(path)!;
      writeAtomic(cacheDir(dir, "assets.json"), { [asset.id]: {
        kind: asset.kind, path: asset.path, fingerprint: stamp, duration: 1, done: { proxy: stamp },
      } });
    };
    try {
      const response = await fetch(`${server.url}api/import?name=first.mp4`, { method: "POST", body: Buffer.from("synthetic") });
      const body = await response.json();
      expect(response.status).toBe(200);
      const entry = readAssets(dir)[body.assetId];
      expect(entry.done?.proxy).toBe(entry.fingerprint);
      expect(body.proxies).not.toContain(body.assetId);
    } finally { await server.close(); }
  });

  it("does not publish metadata measured across a source change", async () => {
    const { open } = await import("../server.ts");
    const dir = mkdtempSync(join(tmpdir(), "swr-probe-changed-"));
    dirs.push(dir);
    init(dir, { title: "changed probe", fps: 30, width: 640, height: 360 });
    const server = await open(dir, { port: 0 });
    control.onProbe = (path) => appendFileSync(path, "changed");
    try {
      const response = await fetch(`${server.url}api/import?name=first.mp4`, { method: "POST", body: Buffer.from("synthetic") });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(readAssets(dir)[body.assetId]).toBeUndefined();
      expect(body.durations[body.assetId]).toBeUndefined();
    } finally { await server.close(); }
  });
});
