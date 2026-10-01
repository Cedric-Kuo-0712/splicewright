import { expect, it, vi } from "vitest";
import { lookEffects } from "../../../packages/render/src/Composition.tsx";

it("refresh applies the server LUT snapshot and clears LUTs when the next snapshot is empty", async () => {
  vi.stubGlobal("location", { hash: "" });
  const { app, refresh } = await import("../src/store.ts");
  const lut = { size: 2, data: [], domain: { min: [0, 0, 0], max: [1, 1, 1] } };
  const payload = (luts: Record<string, unknown>) => ({
    empty: false, recent: [], project: null, duck: {}, words: {}, proxies: [], durations: {}, sizes: {}, loudness: {}, luts,
  });
  const json = vi.fn()
    .mockResolvedValueOnce(payload({ a_lut: lut }))
    .mockResolvedValueOnce(payload({}));
  vi.stubGlobal("fetch", vi.fn(async () => ({ json })));

  await refresh();
  expect(app.get().luts).toEqual({ a_lut: lut });
  expect(() => lookEffects("item", { lut: { assetId: "a_lut", strength: 1 } } as any, undefined, app.get().luts, false)).not.toThrow();

  await refresh();
  expect(app.get().luts).toEqual({});
  expect(() => lookEffects("item", { lut: { assetId: "a_lut", strength: 1 } } as any, undefined, app.get().luts, false)).toThrow(/unavailable LUT asset a_lut/);
  vi.unstubAllGlobals();
});
