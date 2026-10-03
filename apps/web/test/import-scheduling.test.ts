import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { init } from "@splicewright/core/node";

const control = vi.hoisted(() => ({ blockNext: false, started: undefined as (() => void) | undefined, release: undefined as (() => void) | undefined }));
vi.mock("@splicewright/ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@splicewright/ingest")>();
  return {
    ...actual,
    probe: vi.fn(async (path: string, kind: "video" | "audio" | "image") => ({ kind, duration: path.includes("second") ? 2 : 1, fps: 30, audio: false })),
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
      const second = await Promise.race([
        upload("second"),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("second import waited for background ingest")), 500)),
      ]);
      expect(second.status).toBe(200);
      expect(second.body.durations).toMatchObject({ [second.body.assetId]: 2 });
      release = control.release!;
    } finally {
      release?.();
      await server.close();
    }
  });
});
