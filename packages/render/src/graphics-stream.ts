import { deflateSync } from "node:zlib";
import type { Writable } from "node:stream";

function pngChunk(type: string, data: Buffer) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); chunk.write(type, 4); data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

/** One reusable transparent frame supplies sparse timeline gaps without browser work. */
export function transparentPng(width: number, height: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height), { level: 1 })), pngChunk("IEND", Buffer.alloc(0))]);
}

export async function writePng(input: Writable, buffer: Buffer, signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      input.off("error", onError); input.off("close", onClose); signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve();
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("graphics encoder input closed"));
    const onAbort = () => finish(signal.reason);
    input.once("error", onError); input.once("close", onClose); signal.addEventListener("abort", onAbort, { once: true });
    // The write callback acknowledges consumption of this buffer, including the
    // case where write() returns true but a later asynchronous EPIPE occurs.
    input.write(buffer, error => finish(error));
  });
}

/**
 * Build small global-frame batches without materializing all active frames.
 * `repeats` maps a run's first frame to its length; only that frame is listed, the rest are skipped.
 */
export function* graphicsFrameBatches(windows: readonly (readonly [number, number])[], scheduling: "serial" | "grouped", batchSize = 300, repeats?: ReadonlyMap<number, number>): Generator<number[]> {
  let batch: number[] = [];
  for (const [start, end] of windows) {
    for (let frame = start; frame < end; frame += repeats?.get(frame) ?? 1) {
      batch.push(frame);
      if (batch.length === batchSize) {
        yield batch;
        batch = [];
      }
    }
    if (scheduling === "serial" && batch.length) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

/** `repeats` must match the one given to `graphicsFrameBatches`: a delivered frame's PNG is written for its whole run. */
export async function pipeGraphicsFrames({ input, from, to, width, height, batches, repeats, concurrency, limitBytes, signal, render }: {
  input: Writable; from: number; to: number; width: number; height: number; batches: Iterable<number[]>; repeats?: ReadonlyMap<number, number>;
  concurrency: number; limitBytes: number; signal: AbortSignal;
  render: (frames: number[], callback: (buffer: Buffer, frame: number) => Promise<void>) => Promise<unknown>;
}) {
  if (signal.aborted) throw signal.reason;
  let cursor = from, bytes = 0;
  let blank: Buffer | undefined;
  const fillGap = async (end: number) => {
    while (cursor < end) { blank ??= transparentPng(width, height); await writePng(input, blank, signal); cursor++; }
  };
  for (const frames of batches) {
    if (signal.aborted) throw signal.reason;
    let index = 0;
    const active = new Set(frames), inFlight = new Set<number>();
    const pending = new Map<number, { buffer: Buffer; resolve: () => void; reject: (error: unknown) => void }>();
    let pump = Promise.resolve();
    const failPending = (error: unknown) => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
    const onAbort = () => failPending(signal.reason);
    const deliver = (buffer: Buffer, frame: number) => {
      if (signal.aborted) return Promise.reject(signal.reason);
      if (!active.has(frame) || frame < cursor || inFlight.has(frame)) return Promise.reject(new Error(`layered graphics returned duplicate or out-of-range frame ${frame}`));
      if (inFlight.size >= concurrency || bytes + buffer.length > limitBytes) return Promise.reject(new Error("layered graphics exceeded bounded in-flight queue"));
      inFlight.add(frame); bytes += buffer.length;
      return new Promise<void>((resolve, reject) => {
        pending.set(frame, { buffer, resolve, reject });
        pump = pump.then(async () => {
          while (pending.has(frames[index])) {
            const nextFrame = frames[index], entry = pending.get(nextFrame)!;
            pending.delete(nextFrame);
            try {
              await fillGap(nextFrame);
              for (let copy = repeats?.get(nextFrame) ?? 1; copy > 0; copy--) { await writePng(input, entry.buffer, signal); cursor++; }
              index++; entry.resolve();
            }
            catch (error) { entry.reject(error); throw error; }
            finally { bytes -= entry.buffer.length; inFlight.delete(nextFrame); }
          }
        });
        void pump.catch(error => { reject(error); failPending(error); });
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await render(frames, deliver).catch(error => { failPending(error); throw error; });
      await pump;
      if (index !== frames.length) throw new Error("layered graphics ended before all requested frames were delivered");
    } finally {
      signal.removeEventListener("abort", onAbort);
      failPending(new Error("graphics batch closed"));
    }
  }
  await fillGap(to);
}
