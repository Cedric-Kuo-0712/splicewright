import { Writable } from "node:stream";
import { expect, it } from "vitest";
import { graphicsFrameBatches, pipeGraphicsFrames, writePng } from "../src/graphics-stream.ts";

it("batches global frames with serial windows and grouped windows using bounded arrays", () => {
  const windows = [[2, 5], [10, 15]] as const;
  expect([...graphicsFrameBatches(windows, "serial", 4)]).toEqual([[2, 3, 4], [10, 11, 12, 13], [14]]);
  expect([...graphicsFrameBatches(windows, "grouped", 4)]).toEqual([[2, 3, 4, 10], [11, 12, 13, 14]]);
});

it("starts a long graphics range without traversing future windows", () => {
  const windows: [number, number][] = [[0, 216000], [216010, 216020]];
  Object.defineProperty(windows, 1, { get() { throw new Error("future window traversed eagerly"); } });
  const batches = graphicsFrameBatches(windows, "grouped");
  expect(batches.next().value).toEqual(Array.from({ length: 300 }, (_, frame) => frame));
  expect(batches.next().value).toEqual(Array.from({ length: 300 }, (_, frame) => 300 + frame));
  batches.return(undefined);
});

it("bounds outstanding frames while reordering workers and filling sparse gaps for a slow consumer", async () => {
  const written: Buffer[] = [];
  const input = new Writable({ highWaterMark: 1, write(buffer, _encoding, callback) { written.push(buffer); setImmediate(callback); } });
  const frames = [2, 3, 10, 11];
  let acknowledged = 0;
  await pipeGraphicsFrames({ input, from: 0, to: 20, width: 2, height: 2, batches: [frames], concurrency: 2, limitBytes: 32,
    signal: new AbortController().signal,
    render: async (batch, callback) => {
      for (let index = 0; index < batch.length; index += 2) {
        await Promise.all(batch.slice(index, index + 2).reverse().map(async frame => { await callback(Buffer.from(`frame-${frame}`), frame); acknowledged++; }));
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
  await expect(pipeGraphicsFrames({ input, from: 0, to: 3, width: 2, height: 2, batches: [[0, 1, 2]], concurrency: 1, limitBytes: 32,
    signal: new AbortController().signal,
    render: async (_batch, callback) => { await Promise.all([callback(Buffer.from("later"), 1), callback(Buffer.from("too-many"), 2)]); },
  })).rejects.toThrow("bounded in-flight queue");
});

it("releases batch state and keeps global frame order across successive batches", async () => {
  const written: string[] = [];
  const input = new Writable({ write(buffer, _encoding, callback) { written.push(buffer.toString()); callback(); } });
  const batches = [[3, 4], [12, 13]];
  await pipeGraphicsFrames({ input, from: 0, to: 15, width: 1, height: 1, batches, concurrency: 2, limitBytes: 64,
    signal: new AbortController().signal,
    render: async (batch, callback) => { await Promise.all([...batch].reverse().map(frame => callback(Buffer.from(`f${frame}`), frame))); },
  });
  expect(written[3]).toBe("f3"); expect(written[4]).toBe("f4");
  expect(written[12]).toBe("f12"); expect(written[13]).toBe("f13");
  expect(written).toHaveLength(15);
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

it("lists only a run's first frame and writes its PNG for the whole run, keeping the stream frame-aligned", async () => {
  const windows = [[2, 12], [20, 23]] as const;
  const repeats = new Map([[2, 5], [7, 5], [20, 3]]);
  expect([...graphicsFrameBatches(windows, "grouped", 10, repeats)]).toEqual([[2, 7, 20]]);
  const written: string[] = [];
  const input = new Writable({ write(buffer, _encoding, callback) { written.push(buffer.toString().startsWith("frame-") ? buffer.toString() : "gap"); callback(); } });
  await pipeGraphicsFrames({ input, from: 0, to: 25, width: 1, height: 1, batches: graphicsFrameBatches(windows, "grouped", 10, repeats), repeats, concurrency: 3, limitBytes: 64,
    signal: new AbortController().signal,
    render: async (frames, callback) => { await Promise.all(frames.slice().reverse().map(frame => callback(Buffer.from(`frame-${frame}`), frame))); },
  });
  expect(written).toEqual([
    "gap", "gap", ...Array(5).fill("frame-2"), ...Array(5).fill("frame-7"), ...Array(8).fill("gap"), ...Array(3).fill("frame-20"), "gap", "gap",
  ]);
});
