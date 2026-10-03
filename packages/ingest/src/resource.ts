import { availableParallelism } from "node:os";

/** FIFO limit on concurrent jobs. Invalid limits are rejected before any work starts. */
export function limiter(n: number) {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("concurrency limit must be a positive integer");

  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    let acquired = false;
    if (running >= n) {
      await new Promise<void>((resolve) => waiting.push(() => { acquired = true; resolve(); }));
    }
    if (!acquired) running++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

/** Preserve two CPUs for other work while limiting default ingest fan-out to two jobs. */
export function createIngestLimiter(jobs?: number, cores = availableParallelism()) {
  return limiter(jobs ?? Math.max(1, Math.min(2, cores - 2)));
}
