import { describe, expect, it, vi } from "vitest";
import { BoundedPromiseCache, marqueeSelection, shouldMountTimelineItem, waveformCacheKey, waveformCanvasWindow, waveformSourceSeconds } from "../src/timeline-memory.ts";

describe("timeline horizontal memory helpers", () => {
  it("keeps clip overlap boundaries and pins live edits outside the viewport", () => {
    expect(shouldMountTimelineItem(90, 20, 100, 200, false)).toBe(true);
    expect(shouldMountTimelineItem(80, 20, 100, 200, false)).toBe(false);
    expect(shouldMountTimelineItem(900, 20, 100, 200, true)).toBe(true);
    expect(shouldMountTimelineItem(198, 10, 100, 200, false)).toBe(true);
  });

  it("maps a windowed waveform canvas to its original clip and source time", () => {
    const window = waveformCanvasWindow(1200, 500, 10_000, 100);
    expect(window).toEqual({ left: 1100, width: 700 });
    expect(waveformSourceSeconds(3, window.left, 2, 25)).toBe(25);
    expect(waveformSourceSeconds(3, window.left + 350, 2, 25)).toBe(32);
    expect(waveformCanvasWindow(-50, 100, 1000)).toEqual({ left: 0, width: 306 });
    expect(waveformCanvasWindow(1100, 100, 1000)).toEqual({ left: 844, width: 156 });
  });

  it("preserves add and toggle semantics for marquee hits omitted from the DOM", () => {
    expect(marqueeSelection(["kept"], ["offscreen", "kept"], false)).toEqual(["kept", "offscreen"]);
    expect(marqueeSelection(["kept", "removed"], ["kept", "added"], true)).toEqual(["removed", "added"]);
  });

  it("bounds entries, separates project/review contexts and retries rejected loads", async () => {
    const cache = new BoundedPromiseCache<string>(2);
    const load = vi.fn(async (value: string) => value);
    const normalKey = waveformCacheKey("A", "asset", "raw/a.wav", "");
    await cache.get(normalKey, () => load("a"));
    await cache.get(waveformCacheKey("A", "asset", "raw/a.wav", "&view=before&id=r1"), () => load("review"));
    await cache.get(waveformCacheKey("B", "asset", "raw/a.wav", ""), () => load("b"));
    expect(cache.size).toBe(2);
    expect(load).toHaveBeenCalledTimes(3);
    await cache.get(normalKey, () => load("a again"));
    expect(load).toHaveBeenCalledTimes(4);

    let attempts = 0;
    const key = waveformCacheKey("B", "retry", "raw/retry.wav", "");
    await expect(cache.get(key, async () => { attempts++; throw new Error("transient"); })).rejects.toThrow("transient");
    await expect(cache.get(key, async () => { attempts++; return "recovered"; })).resolves.toBe("recovered");
    expect(attempts).toBe(2);
    expect(cache.size).toBeLessThanOrEqual(2);
  });
});
