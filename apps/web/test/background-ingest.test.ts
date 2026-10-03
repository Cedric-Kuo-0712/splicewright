import { describe, expect, it } from "vitest";
import type { Step } from "@splicewright/ingest";
import { BackgroundIngestScheduler } from "../background-ingest.ts";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
};

describe("background ingest scheduling", () => {
  it("puts editing preparation ahead of queued analysis work", async () => {
    const first = deferred();
    const entered = deferred();
    const calls: Array<[string, Step[]]> = [];
    const finalized: string[] = [];
    const scheduler = new BackgroundIngestScheduler(async (id, steps) => {
      calls.push([id, steps]);
      if (id === "old") { entered.resolve(); await first.promise; }
    }, (id) => finalized.push(id));
    scheduler.enqueueOnly("old", ["transcript"]);
    await entered.promise;
    scheduler.enqueueOnly("backlog", ["beats"]);
    scheduler.enqueueFull("new");
    first.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.map(([id, steps]) => [id, steps])).toEqual([
      ["old", ["transcript"]],
      ["new", ["proxy", "thumbs", "waveform"]],
      ["backlog", ["beats"]],
      ["new", ["sourceHealth", "reverse", "analysis", "transcript", "beats", "loudness", "audioFx"]],
    ]);
    expect(finalized.filter((id) => id === "new")).toHaveLength(1);
    scheduler.close();
  });

  it("recovers after a failed task and serializes repeated work for one asset", async () => {
    const first = deferred();
    const entered = deferred();
    let active = 0;
    let maxActive = 0;
    const finished: string[] = [];
    const errors: string[] = [];
    const calls: Array<[string, Step[]]> = [];
    const scheduler = new BackgroundIngestScheduler(async (id, steps) => {
      calls.push([id, steps]);
      active++;
      maxActive = Math.max(maxActive, active);
      if (id === "same" && !finished.length) { entered.resolve(); await first.promise; }
      active--;
      if (id === "failed") throw new Error("expected failure");
      finished.push(id);
    }, (_id, error) => { if (error) errors.push(error); });
    scheduler.enqueueOnly("same", ["proxy"]);
    await entered.promise;
    scheduler.enqueueFull("same");
    scheduler.enqueueOnly("failed", ["analysis"]);
    scheduler.enqueueOnly("later", ["analysis"]);
    first.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(maxActive).toBe(1);
    expect(calls.filter(([id]) => id === "same").flatMap(([, steps]) => steps).filter((step) => step === "proxy")).toHaveLength(1);
    expect(finished).toContain("later");
    expect(errors).toEqual(["expected failure"]);
    scheduler.close();
  });

  it("drops queued work when its project server closes", async () => {
    const first = deferred();
    const entered = deferred();
    const calls: string[] = [];
    const scheduler = new BackgroundIngestScheduler(async (id) => {
      calls.push(id);
      if (id === "active") { entered.resolve(); await first.promise; }
    });
    scheduler.enqueueOnly("active", ["proxy"]);
    await entered.promise;
    scheduler.enqueueOnly("queued", ["proxy"]);
    scheduler.close();
    first.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["active"]);
  });
});
