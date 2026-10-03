import { availableParallelism } from "node:os";

/**
 * Per-FFmpeg-process codec/filter pool ceiling; concurrent pools may coexist, so this is not a
 * process-wide CPU percentage or an aggregate thread cap. It leaves room for the editor and jobs.
 * The single-core floor follows the host; machines with more capacity retain at least two threads.
 */
export function ffmpegThreadCount(cores = availableParallelism(), override: string | null | undefined = process.env.SPLICEWRIGHT_FFMPEG_THREADS): number {
  if (!Number.isSafeInteger(cores) || cores < 1) throw new RangeError("CPU count must be a positive integer");
  if (override !== undefined && override !== null) {
    if (!/^\d+$/.test(override)) throw new RangeError("SPLICEWRIGHT_FFMPEG_THREADS must be an integer from 1 to 32");
    const value = Number(override);
    if (!Number.isSafeInteger(value) || value < 1 || value > 32) throw new RangeError("SPLICEWRIGHT_FFMPEG_THREADS must be an integer from 1 to 32");
    return value;
  }
  return cores === 1 ? 1 : Math.min(4, Math.max(2, Math.floor(cores / 2)));
}

/** Add thread limits at FFmpeg's per-input and per-output option boundaries. */
export function withFfmpegResourceLimits(args: string[], threads = ffmpegThreadCount()): string[] {
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 32) throw new RangeError("FFmpeg thread count must be an integer from 1 to 32");
  const has = (tokens: string[], option: string) => tokens.some((token) => token === option || token.startsWith(`${option}:`));
  const bounded: string[] = [];
  if (!has(args, "-filter_threads")) bounded.push("-filter_threads", String(threads));
  if (!has(args, "-filter_complex_threads")) bounded.push("-filter_complex_threads", String(threads));

  const inputArgs: string[] = [];
  let segmentStart = 0;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "-i") continue;
    const options = args.slice(segmentStart, i);
    // Respect an explicit caller codec thread choice for this input.
    inputArgs.push(...options);
    if (!has(options, "-threads")) inputArgs.push("-threads", String(threads));
    inputArgs.push("-i", args[i + 1]);
    i++;
    segmentStart = i + 1;
  }
  const trailingOptions = args.slice(segmentStart, -1);
  const output = args.at(-1);
  if (output === undefined) throw new Error("FFmpeg output path is required");
  inputArgs.push(...trailingOptions);
  if (!has(trailingOptions, "-threads")) {
    // Output codec options must precede the output they configure.
    inputArgs.push("-threads", String(threads));
  }
  // All ingest FFmpeg invocations write one output, held by the final argument.
  return [...bounded, ...inputArgs, output];
}

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

/** Use up to cores − 2 concurrent jobs, with a default ceiling of two. */
export function createIngestLimiter(jobs?: number, cores = availableParallelism()) {
  return limiter(jobs ?? Math.max(1, Math.min(2, cores - 2)));
}
