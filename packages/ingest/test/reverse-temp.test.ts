import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  failAt: -1,
  scratch: "",
  sourcePaths: [] as string[],
  observations: [] as Array<{ currentExists: boolean; previousExists: boolean | null }>,
  concatSourcesExist: [] as boolean[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { dirname, join } = await import("node:path");
  const { existsSync, writeFileSync } = await import("node:fs");
  return {
    ...original,
    spawn: vi.fn((command: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        let code = 0;
        if (command === "ffprobe") {
          child.stdout.end(JSON.stringify({ format: { duration: "21" }, streams: [{ codec_type: "video", duration: "21" }, { codec_type: "audio" }] }));
        } else {
          const segmentPattern = args.find((arg) => arg.includes("source-%06d."));
          if (segmentPattern) {
            fake.scratch = dirname(segmentPattern);
            fake.sourcePaths = Array.from({ length: 3 }, (_, i) => segmentPattern.replace("%06d", String(i).padStart(6, "0")));
            fake.sourcePaths.forEach((path) => writeFileSync(path, "source"));
          } else if (args.includes("reverse") || args.includes("areverse")) {
            const input = args[args.indexOf("-i") + 1];
            const index = fake.sourcePaths.indexOf(input);
            const previous = index > 0 ? fake.sourcePaths[index - 1] : null;
            fake.observations.push({ currentExists: existsSync(input), previousExists: previous ? existsSync(previous) : null });
            if (index === fake.failAt) {
              child.stderr.end("simulated reverse failure");
              code = 1;
            } else {
              writeFileSync(args.at(-1)!, "reversed");
            }
          } else if (args.includes("concat")) {
            const list = readFileSync(args[args.indexOf("-i") + 1], "utf8");
            fake.concatSourcesExist = fake.sourcePaths.map((path) => list.includes(path) && existsSync(path));
            writeFileSync(args.at(-1)!, "output");
          }
        }
        child.emit("close", code);
      });
      return child;
    }),
  };
});

import { reverseFile } from "../src/index.ts";

describe("reverseFile temporary source chunks", () => {
  const reset = () => {
    fake.failAt = -1;
    fake.scratch = "";
    fake.sourcePaths = [];
    fake.observations = [];
    fake.concatSourcesExist = [];
  };
  afterEach(reset);

  it("deletes each source chunk after its reverse succeeds and before concat", async () => {
    const root = join(tmpdir(), `swr-reverse-temp-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const source = join(root, "source.mkv");
    const output = join(root, "reversed.mp4");
    writeFileSync(source, "original");
    try {
      await reverseFile(source, output);
      expect(fake.observations).toEqual([
        { currentExists: true, previousExists: null },
        { currentExists: true, previousExists: false },
        { currentExists: true, previousExists: false },
      ]);
      expect(fake.concatSourcesExist).toEqual([false, false, false]);
      expect(readFileSync(source, "utf8")).toBe("original");
      expect(readFileSync(output, "utf8")).toBe("output");
      expect(existsSync(fake.scratch)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a source chunk until its reverse succeeds and cleans scratch on failure", async () => {
    const root = join(tmpdir(), `swr-reverse-temp-fail-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const source = join(root, "source.mkv");
    writeFileSync(source, "original");
    fake.failAt = 1;
    try {
      await expect(reverseFile(source, join(root, "reversed.mp4"))).rejects.toThrow("simulated reverse failure");
      expect(fake.observations).toEqual([
        { currentExists: true, previousExists: null },
        { currentExists: true, previousExists: false },
      ]);
      expect(existsSync(fake.scratch)).toBe(false);
      expect(readFileSync(source, "utf8")).toBe("original");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
