import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { init } from "@splicewright/core/node";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn((command: string, args: readonly string[], options: unknown) => {
      if (command === "ffprobe" && args.includes("format_tags=creation_time:stream_tags=creation_time")) {
        return JSON.stringify({
          format: { tags: { creation_time: "2020-01-02T03:04:05Z" } },
          streams: [
            { tags: { creation_time: "2021-01-02T03:04:05Z" } },
            { tags: { creation_time: "2022-01-02T03:04:05Z" } },
            { tags: { creation_time: "2020-01-02T03:04:05Z" } },
          ],
        });
      }
      return actual.execFileSync(command, args, options as Parameters<typeof actual.execFileSync>[2]);
    }),
  };
});

import { listMaterials, prepareMaterials, recordMaterialReview } from "../src/materials.ts";

it("round-trips a prepared ledger with format, stream and filename timestamps beyond its candidate limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-material-chronology-"));
  const path = "raw/20240305_060708.wav";
  try {
    init(dir, { title: "chronology", fps: 30, width: 320, height: 180 });
    mkdirSync(join(dir, "raw"), { recursive: true });
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", join(dir, path)]);
    const prepared = await prepareMaterials(dir, { paths: [path], steps: [] });
    expect(prepared.errors).toEqual([]);

    const material = (await listMaterials(dir)).materials[0];
    expect(material.captureTime?.candidates.map((candidate) => candidate.value)).toEqual([
      "2020-01-02T03:04:05Z", "2021-01-02T03:04:05Z", "2022-01-02T03:04:05Z",
    ]);
    expect(material.captureTime?.selected).toEqual(material.captureTime?.candidates[0]);
    expect(material.captureTime?.timezoneAmbiguous).toBe(true);

    await recordMaterialReview(dir, { path, version: material.version!, summary: "Capture metadata reviewed." });
    expect((await listMaterials(dir)).materials[0]).toMatchObject({ status: "reviewed", captureTime: material.captureTime });
    expect((await prepareMaterials(dir, { paths: [path], steps: [] })).errors).toEqual([]);
    const ledger = JSON.parse(readFileSync(join(dir, ".splicewright/material-reviews.json"), "utf8"));
    expect(ledger.chronology[path].value.candidates).toHaveLength(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
