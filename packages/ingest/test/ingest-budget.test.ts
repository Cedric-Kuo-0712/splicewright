import { describe, expect, it } from "vitest";
import { createIngestLimiter, limiter } from "../src/resource.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function peakConcurrency(run: <T>(fn: () => Promise<T>) => Promise<T>, count: number) {
  let active = 0;
  let peak = 0;
  const gates = Array.from({ length: count }, deferred);
  const tasks = gates.map((gate) => run(async () => {
    active++;
    peak = Math.max(peak, active);
    await gate.promise;
    active--;
  }));
  for (const gate of gates) gate.resolve();
  await Promise.all(tasks);
  return peak;
}

describe("ingest resource budget", () => {
  it("uses one default job on machines with at most three CPUs and caps larger machines at two", async () => {
    for (const [cores, expected] of [[1, 1], [2, 1], [3, 1], [4, 2], [16, 2]] as const) {
      const peak = await peakConcurrency(createIngestLimiter(undefined, cores), 4);
      expect(peak, `${cores} CPUs`).toBe(expected);
    }
  });

  it("honors explicit positive integer overrides on deferred jobs", async () => {
    expect(await peakConcurrency(createIngestLimiter(3, 16), 5)).toBe(3);
  });

  it("releases the next queued job after a task rejects", async () => {
    const run = limiter(1);
    const first = deferred();
    let secondStarted = false;
    const rejected = run(async () => {
      await first.promise;
      throw new Error("expected failure");
    });
    const second = run(async () => { secondStarted = true; });
    first.resolve();
    await expect(rejected).rejects.toThrow("expected failure");
    await second;
    expect(secondStarted).toBe(true);
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])("rejects invalid concurrency limit %s immediately", (n) => {
    expect(() => limiter(n)).toThrow(RangeError);
  });
});
