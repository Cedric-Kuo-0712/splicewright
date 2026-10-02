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

it("blocks UI ops while a before/after snapshot is active", async () => {
  const fetches = vi.fn(); vi.stubGlobal("fetch", fetches);
  const { app, op } = await import("../src/store.ts");
  const snapshot = { schemaVersion: 1, revision: 8, meta: { title: "snapshot", fps: 30, width: 640, height: 360 }, assets: {}, tracks: [] } as any;
  app.set({ reviewProject: snapshot, message: null });
  expect(await op("addMarker", { label: "blocked", start: 0 })).toBe(false);
  expect(fetches).not.toHaveBeenCalled();
  expect(app.get().message).toMatchObject({ error: true, text: expect.stringContaining("read-only") });
  app.set({ reviewProject: null });
  vi.unstubAllGlobals();
});


it("ignores a pending snapshot response after switching back to Current", async () => {
  const { app, showEditReview } = await import("../src/store.ts");
  app.set({ review: { id: "round" } as any, reviewProject: null, reviewMedia: null });
  let resolve!: (value: any) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise((done) => { resolve = done; })));
  const pending = showEditReview("before");
  await showEditReview(null);
  resolve({ ok: true, status: 200, json: async () => ({ ...payload({}), project: { revision: 0 } }) });
  await pending;
  expect(app.get().reviewProject).toBeNull();
  expect(app.get().reviewMedia).toBeNull();
  vi.unstubAllGlobals();
});


it("keeps the selected snapshot when background refresh returns the same review", async () => {
  const { app, refreshEditReview } = await import("../src/store.ts");
  const snapshot = { revision: 0 } as any;
  app.set({ review: { id: "same-round" } as any, reviewProject: snapshot, reviewView: "before" });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ id: "same-round", status: "kept" }) })));
  await refreshEditReview();
  expect(app.get().reviewProject).toBe(snapshot);
  expect(app.get().reviewView).toBe("before");
  app.set({ review: null, reviewProject: null, reviewMedia: null, reviewView: null });
  vi.unstubAllGlobals();
});
