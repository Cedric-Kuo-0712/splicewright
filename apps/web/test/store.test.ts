import { expect, it, vi } from "vitest";
import { lookEffects } from "../../../packages/render/src/Composition.tsx";

const lut = { size: 2, data: [], domain: { min: [0, 0, 0], max: [1, 1, 1] } };
const payload = (lutVersions: Record<string, string>) => ({
  empty: false, recent: [], project: null, duck: {}, words: {}, proxies: [], durations: {}, sizes: {}, loudness: {}, lutVersions,
});
const useLook = (grade = { lut: { assetId: "a_lut", strength: 1 } }) => (luts: object) => lookEffects("item", grade as any, undefined, luts as any, false);

it.each(["proxy", "thumbs", "waveform"])("refreshes published %s while background ingest remains active", async (step) => {
  let source: { onmessage: ((event: { data: string }) => void) | null };
  vi.stubGlobal("EventSource", class {
    onmessage = null;
    constructor() { source = this; }
  });
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requests.push(url);
    if (url === "/api/project") return { status: 200, json: async () => ({ ...payload({}), proxies: ["a_clip"] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  }));
  vi.stubGlobal("location", { hash: "" });
  const { app, listen } = await import("../src/store.ts");
  app.set({ project: null, review: null, reviewProject: null, reviewMedia: null, proxies: [], ingesting: {} });
  listen();
  source!.onmessage!({ data: JSON.stringify({ ingest: { id: "a_clip", step } }) });
  await vi.waitFor(() => expect(app.get().proxies).toContain("a_clip"));
  expect(app.get().ingesting.a_clip).toBe(step);
  expect(requests.filter((url) => url === "/api/project")).toHaveLength(1);
});

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

it("reviews sync movement before committing and reuses the preview revision", async () => {
  vi.stubGlobal("location", { hash: "" });
  const { createProject } = await import("@splicewright/core");
  const { app, op } = await import("../src/store.ts");
  const project = { ...createProject({ title: "sync", fps: 30, width: 640, height: 360 }), revision: 8,
    tracks: [{ id: "t_primary", name: "Primary", kind: "video", magnetic: true, items: [] }, { id: "t_music", name: "Music", kind: "audio", magnetic: true, syncTo: "t_primary", items: [] }] } as any;
  app.set({ project, message: null });
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ url, body });
    const data = url === "/api/op/preview"
      ? { moved: [{ trackId: "t_music", itemId: "i_music", from: 3, to: 5, kind: "secondary" }], truncated: false }
      : { project: { ...project, revision: 9 }, revision: 9, summary: "moved", duck: {}, words: {}, proxies: [], reverseProxies: [], durations: {}, sizes: {}, loudness: {}, lutVersions: {} };
    return { status: 200, json: async () => data };
  }));
  expect(await op("move", { itemId: "i_primary", to: 5 })).toBe(true);
  expect(calls.map(({ url }) => url)).toEqual(["/api/op/preview", "/api/op"]);
  expect(calls.map(({ body }) => body.baseRevision)).toEqual([8, 8]);
  expect(calls[0].body.ops).toEqual([{ op: "move", args: { itemId: "i_primary", to: 5 } }]);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Music / i_music：3 → 5"));
  vi.unstubAllGlobals();
});

it("does not preflight style-only operations even when a track follows the primary", async () => {
  vi.stubGlobal("location", { hash: "" });
  const { createProject } = await import("@splicewright/core");
  const { app, op } = await import("../src/store.ts");
  const project = { ...createProject({ title: "sync", fps: 30, width: 640, height: 360 }), revision: 2,
    tracks: [{ id: "t_audio", kind: "audio", magnetic: true, syncTo: "t_video", items: [] }] } as any;
  app.set({ project });
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    return { status: 200, json: async () => ({ project: { ...project, revision: 3 }, revision: 3, summary: "styled", duck: {}, words: {}, proxies: [], durations: {}, sizes: {}, loudness: {}, lutVersions: {} }) };
  }));
  expect(await op("setProps", { itemId: "i_1", patch: { opacity: 0.5 } })).toBe(true);
  expect(urls).toEqual(["/api/op"]);
  vi.unstubAllGlobals();
});

it("stops the final write when sync preview refuses the proposed timing edit", async () => {
  vi.stubGlobal("location", { hash: "" });
  const { createProject } = await import("@splicewright/core");
  const { app, op } = await import("../src/store.ts");
  const project = { ...createProject({ title: "sync", fps: 30, width: 640, height: 360 }), revision: 4,
    tracks: [{ id: "t_audio", kind: "audio", magnetic: true, syncTo: "t_video", items: [] }] } as any;
  app.set({ project, message: null });
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    return { status: 400, json: async () => ({ error: { code: "collision", message: "linked item would overlap" } }) };
  }));
  expect(await op("move", { itemId: "i_1", to: 10 })).toBe(false);
  expect(urls).toEqual(["/api/op/preview"]);
  expect(app.get().message).toMatchObject({ error: true, text: expect.stringContaining("linked item would overlap") });
  vi.unstubAllGlobals();
});


it("previews nested cutRanges batches and lets the user cancel the linked movement", async () => {
  vi.stubGlobal("location", { hash: "" });
  const { createProject } = await import("@splicewright/core");
  const { app, op } = await import("../src/store.ts");
  const project = createProject({ title: "sync", fps: 30, width: 640, height: 360 });
  project.tracks[1].syncTo = project.tracks[0].id;
  app.set({ project, reviewProject: null, message: null });
  const calls: string[] = [];
  vi.stubGlobal("confirm", vi.fn(() => false));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    return { status: 200, json: async () => ({ moved: [{ trackId: "t_2", itemId: "i_2", from: 30, to: 20, kind: "secondary" }], movedTotal: 1, secondaryTotal: 1 }) };
  }));
  expect(await op("batch", { ops: [{ op: "batch", args: { ops: [{ op: "cutRanges", args: { itemId: "i_1", ranges: [[0, 1]] } }] } }] })).toBe(false);
  expect(calls).toEqual(["/api/op/preview"]);
  expect(app.get().project).toBe(project);
  vi.unstubAllGlobals();
});

it("shows the sync conflict reason after refreshing instead of silently discarding the edit", async () => {
  vi.stubGlobal("location", { hash: "" });
  const { createProject } = await import("@splicewright/core");
  const { app, op } = await import("../src/store.ts");
  const project = createProject({ title: "sync", fps: 30, width: 640, height: 360 });
  project.tracks[1].syncTo = project.tracks[0].id;
  app.set({ project, reviewProject: null, message: null });
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    return url === "/api/op/preview"
      ? { status: 409, json: async () => ({ error: { code: "conflict", message: "music straddles the edit boundary" } }) }
      : { status: 200, json: async () => ({ empty: true }) };
  }));
  expect(await op("trim", { itemId: "i_1", edge: "end", to: 20 })).toBe(false);
  expect(calls).toEqual(["/api/op/preview", "/api/project"]);
  expect(app.get().message?.text).toContain("music straddles the edit boundary");
  vi.unstubAllGlobals();
});

it("does not commit a sync edit if the project revision changes while preview is pending", async () => {
  vi.stubGlobal("location", { hash: "" });
  const { createProject } = await import("@splicewright/core");
  const { app, op } = await import("../src/store.ts");
  const project = createProject({ title: "sync", fps: 30, width: 640, height: 360 });
  project.tracks[1].syncTo = project.tracks[0].id;
  app.set({ project, reviewProject: null, message: null });
  const calls: string[] = [];
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    app.set({ project: { ...project, revision: project.revision + 1 } });
    return { status: 200, json: async () => ({ moved: [], movedTotal: 0, secondaryTotal: 0 }) };
  }));
  expect(await op("trim", { itemId: "i_1", edge: "end", to: 20 })).toBe(false);
  expect(calls).toEqual(["/api/op/preview"]);
  expect(app.get().message?.text).toContain("revision changed during preview");
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
