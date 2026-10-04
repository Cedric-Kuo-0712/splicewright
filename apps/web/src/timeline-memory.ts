/** Horizontal overscan limits DOM and canvas work while keeping nearby items ready. */
export const TIMELINE_OVERSCAN_PX = 640;

export function intersectsTimelineWindow(itemLeft: number, itemWidth: number, windowLeft: number, windowRight: number): boolean {
  return itemLeft < windowRight && itemLeft + Math.max(2, itemWidth) > windowLeft;
}

export function shouldMountTimelineItem(
  itemLeft: number,
  itemWidth: number,
  windowLeft: number,
  windowRight: number,
  pinned: boolean,
): boolean {
  return pinned || intersectsTimelineWindow(itemLeft, itemWidth, windowLeft, windowRight);
}

/** Return the clip-local pixel interval to draw, retaining enough pixels for a smooth scroll edge. */
export function waveformCanvasWindow(viewLeft: number, viewWidth: number, clipWidth: number, overscan = 256): { left: number; width: number } {
  const left = Math.max(0, Math.floor(viewLeft - overscan));
  const right = Math.min(clipWidth, Math.ceil(viewLeft + viewWidth + overscan));
  return { left, width: Math.max(0, right - left) };
}

/** Convert a pixel in a windowed canvas back to source seconds for the full clip mapping. */
export function waveformSourceSeconds(sourceIn: number, clipPixel: number, ppf: number, fps: number): number {
  return sourceIn + clipPixel / (ppf * fps);
}

export function waveformCacheKey(projectTitle: string, assetId: string, assetPath: string, reviewContext: string): string {
  return JSON.stringify([projectTitle, assetId, assetPath, reviewContext]);
}

export function marqueeSelection(base: string[], hits: string[], toggle: boolean): string[] {
  return toggle
    ? [...base.filter((id) => !hits.includes(id)), ...hits.filter((id) => !base.includes(id))]
    : [...new Set([...base, ...hits])];
}

/** Small LRU for in-flight and resolved waveform requests. Failed loads are retryable. */
export class BoundedPromiseCache<T> {
  private readonly entries = new Map<string, Promise<T>>();
  private readonly limit: number;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("cache limit must be a positive integer");
    this.limit = limit;
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }

    const pending = Promise.resolve().then(load);
    this.entries.set(key, pending);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    pending.catch(() => {
      if (this.entries.get(key) === pending) this.entries.delete(key);
    });
    return pending;
  }

  get size() { return this.entries.size; }
}
