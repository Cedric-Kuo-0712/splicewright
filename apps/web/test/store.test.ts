import { expect, it, vi } from "vitest";
import { lookEffects } from "../../../packages/render/src/Composition.tsx";

const lut = { size: 2, data: [], domain: { min: [0, 0, 0], max: [1, 1, 1] } };
const payload = (lutVersions: Record<string, string>) => ({
  empty: false, recent: [], project: null, duck: {}, words: {}, proxies: [], durations: {}, sizes: {}, loudness: {}, lutVersions,
});
const useLook = (grade = { lut: { assetId: "a_lut", strength: 1 } }) => (luts: object) => lookEffects("item", grade as any, undefined, luts as any, false);

/** `/api/project` answers with the queued snapshots; `/api/lut` with `tables` (or 404 when absent). */
function server(snapshots: ReturnType<typeof payload>[], tables: Record<string, unknown> = { a_lut: lut }) {
  const queue = [...snapshots];
  const lutFetches: string[] = [];
  vi.stubGlobal("location", { hash: "" });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/lut")) {
      lutFetches.push(url);
      const id = new URL(url, "http://x").searchParams.get("asset")!;
      // a fresh object per response, as a real JSON parse gives
      return id in tables ? { ok: true, status: 200, json: async () => structuredClone(tables[id]) } : { ok: false, status: 404, json: async () => ({}) };
    }
    return { status: 200, json: async () => queue.shift() };
  }));
  return lutFetches;
}

it("refresh fetches a LUT table once per version, keeps its object when unchanged, and clears it when unused", async () => {
  const fetches = server([payload({ a_lut: "v1" }), payload({ a_lut: "v1" }), payload({ a_lut: "v2" }), payload({})]);
  const { app, refresh } = await import("../src/store.ts");
  const look = useLook();

  await refresh();
  const first = app.get().luts.a_lut;
  expect(first).toEqual(lut);
  expect(fetches).toHaveLength(1);
  expect(() => look(app.get().luts)).not.toThrow();

  await refresh(); // same version: no refetch, and the same object (so no new GPU upload)
  expect(fetches).toHaveLength(1);
  expect(app.get().luts.a_lut).toBe(first);

  await refresh(); // the file changed
  expect(fetches).toHaveLength(2);
  expect(app.get().luts.a_lut).not.toBe(first);

  await refresh(); // no item uses it any more
  expect(app.get().luts).toEqual({});
  expect(() => look(app.get().luts)).toThrow(/unavailable LUT asset a_lut/);
  vi.unstubAllGlobals();
});

it("a LUT the server can no longer serve is left out and reported, never kept under its new version", async () => {
  server([payload({ gone: "v1" })], {});
  const { app, refresh } = await import("../src/store.ts");
  await refresh();
  expect(app.get().luts).toEqual({});
  expect(app.get().message).toMatchObject({ error: true, text: expect.stringContaining("LUT gone") });
  vi.unstubAllGlobals();
});
