import { Writable } from "node:stream";
import { expect, it } from "vitest";
import { pipeGraphicsFrames, writePng } from "../src/graphics-stream.ts";

it("bounds outstanding frames while reordering workers and filling sparse gaps for a slow consumer", async () => {
  const written: Buffer[] = [];
  const input = new Writable({ highWaterMark: 1, write(buffer, _encoding, callback) { written.push(buffer); setImmediate(callback); } });
  const frames = [2, 3, 10, 11];
  let acknowledged = 0;
  await pipeGraphicsFrames({ input, from: 0, to: 20, width: 2, height: 2, frames, concurrency: 2, limitBytes: 32,
    signal: new AbortController().signal,
    render: async callback => {
      for (let index = 0; index < frames.length; index += 2) {
        await Promise.all(frames.slice(index, index + 2).reverse().map(async frame => { await callback(Buffer.from(`frame-${frame}`), frame); acknowledged++; }));
        expect(acknowledged).toBe(index + 2);
      }
    },
  });
  expect(written).toHaveLength(20);
  for (const frame of frames) expect(written[frame].toString()).toBe(`frame-${frame}`);
  expect(written[0]).toEqual(written[19]);
});

it("rejects a producer exceeding the in-flight bound instead of accumulating the timeline", async () => {
  const input = new Writable({ write(_buffer, _encoding, callback) { callback(); } });
  await expect(pipeGraphicsFrames({ input, from: 0, to: 3, width: 2, height: 2, frames: [0, 1, 2], concurrency: 1, limitBytes: 32,
    signal: new AbortController().signal,
    render: async callback => { await Promise.all([callback(Buffer.from("later"), 1), callback(Buffer.from("too-many"), 2)]); },
  })).rejects.toThrow("bounded in-flight queue");
});

it("settles blocked writes when the encoder closes or cancellation arrives", async () => {
  const input = new Writable({ write() {} });
  const controller = new AbortController();
  const writing = writePng(input, Buffer.alloc(8), controller.signal);
  input.destroy();
  await expect(writing).rejects.toThrow("input closed");
  const other = new Writable({ write() {} });
  const cancelled = writePng(other, Buffer.alloc(8), controller.signal);
  controller.abort(new Error("cancelled"));
  await expect(cancelled).rejects.toThrow("cancelled");
});

it("propagates asynchronous pipe errors even for a write below the high-water mark", async () => {
  const input = new Writable({ write(_buffer, _encoding, callback) { setImmediate(() => callback(new Error("EPIPE"))); } });
  // Production keeps an error handler for the entire lifetime of the input.
  input.on("error", () => {});
  await expect(writePng(input, Buffer.alloc(8), new AbortController().signal)).rejects.toThrow("EPIPE");
});
