import { expect, it, vi } from "vitest";
import { createProject } from "@splicewright/core";

const meta = { title: "t", fps: 30, width: 1920, height: 1080 };

async function setup(assets: Record<string, { id: string; path: string; kind: string }>) {
  vi.stubGlobal("location", { hash: "" });
  const store = await import("../src/store.ts");
  const edit = await import("../src/edit.ts");
  const project = { ...createProject(meta), assets } as any;
  store.app.set({ project, durations: { a_clip: 2 } });
  const posted: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => ({
    status: 200,
    json: async () => {
      if (url.startsWith("/api/import")) return { assetId: new URL(url, "http://x").searchParams.get("name") === "look.cube" ? "a_look" : "a_clip", summary: "ok" };
      if (url === "/api/project") return { empty: false, recent: [], project, duck: {}, words: {}, proxies: [], durations: { a_clip: 2 }, sizes: {}, loudness: {}, lutVersions: {} };
      posted.push(JSON.parse(init.body));
      return { revision: 1, summary: "ok", project, duck: {}, words: {}, proxies: [], durations: {}, sizes: {}, loudness: {}, lutVersions: {} };
    },
  })));
  return { ...edit, store, posted };
}

const assets = {
  a_clip: { id: "a_clip", path: "raw/clip.mp4", kind: "video" },
  a_look: { id: "a_look", path: "raw/look.cube", kind: "lut" },
};

it("dropping a .cube with a clip places only the clip", async () => {
  const { dropFiles, posted } = await setup(assets);
  await dropFiles([new File(["x"], "clip.mp4"), new File(["x"], "look.cube")], 0);
  const sent = posted.flatMap((b) => (b.op === "batch" ? b.args.ops : [b]));
  const inserts = sent.filter((o) => o.op === "insertItem");
  expect(inserts.map((o) => o.args.assetId)).toEqual(["a_clip"]);
  vi.unstubAllGlobals();
});

it("dropping only a .cube sends no ops", async () => {
  const { dropFiles, posted } = await setup(assets);
  await dropFiles([new File(["x"], "look.cube")], 0);
  expect(posted).toEqual([]);
  vi.unstubAllGlobals();
});

it("replaceWith refuses a LUT with an explanation, not 'wait for ingest'", async () => {
  const { replaceWith, store, posted } = await setup(assets);
  const p = store.app.get().project!;
  p.tracks[0].items.push({ id: "i_1", assetId: "a_clip", start: 0, duration: 30, sourceIn: 0 } as any);
  store.app.set({ selection: ["i_1"] });
  replaceWith("a_look");
  expect(store.app.get().message?.text).toMatch(/LUT/);
  expect(posted).toEqual([]);
  vi.unstubAllGlobals();
});

it("gradeWith unsets a scalar reset to 0 and drops an emptied grade", async () => {
  vi.stubGlobal("location", { hash: "" });
  const { gradeWith } = await import("../src/edit.ts");
  expect(gradeWith(undefined, "exposure", 1)).toEqual({ exposure: 1 });
  expect(gradeWith({ exposure: 1, tint: 0.2 }, "exposure", 0)).toEqual({ tint: 0.2 });
  expect(gradeWith({ exposure: 1 }, "exposure", 0)).toBeNull();
  const lut = { assetId: "a_look" };
  expect(gradeWith({ exposure: 1, lut }, "exposure", 0)).toEqual({ lut });
  vi.unstubAllGlobals();
});

it("key menu presets set the ease of every key on that frame in one setProps", async () => {
  const { keyMenu, store, posted } = await setup({});
  const item = { id: "i_1", assetId: "a_clip", start: 0, duration: 60, sourceIn: 0, keyframes: { opacity: [{ t: 0, v: 0 }, { t: 1, v: 1 }], scale: [{ t: 0, v: 1 }] } } as any;
  store.app.set({ project: { ...createProject(meta), tracks: [{ id: "t_v1", kind: "video", items: [item] }] } as any });
  const menu = keyMenu(item, 0) as any[];
  expect(menu.map((m) => m.label)).toEqual(["Linear", "Ease", "Ease in", "Ease out", "Ease in-out", "Overshoot"]);
  await menu[4].run();
  const patch = posted.at(-1).args.patch.keyframes;
  expect(posted.at(-1).op).toBe("setProps");
  expect(patch.opacity).toEqual([{ t: 0, v: 0, ease: [0.42, 0, 0.58, 1] }, { t: 1, v: 1 }]);
  expect(patch.scale[0].ease).toEqual([0.42, 0, 0.58, 1]);
  vi.unstubAllGlobals();
});
