import { describe, expect, it } from "vitest";
import { apply, createProject, lint, type OpResult, type Project } from "../src/index.ts";

const ok = (r: OpResult): Project => {
  if ("error" in r) throw new Error(r.error.message);
  return r.project;
};
const ctx = { assetDurations: { a_clip: 10 } };
const base = () => {
  let p = createProject({ title: "t", fps: 30, width: 1920, height: 1080 });
  p = ok(apply(p, "importAsset", { path: "raw/clip.mp4" }));
  return ok(apply(p, "insertItem", { assetId: "a_clip", at: 0, duration: 90 }, ctx));
};

describe("lint", () => {
  it("clean project has no issues and does not touch the revision", () => {
    const p = base();
    const rev = p.revision;
    expect(lint(p)).toEqual([]);
    expect(p.revision).toBe(rev);
  });

  it("flags gaps on a magnetic track, including at frame 0", () => {
    const p = base();
    p.tracks[0].items[0].start = 10;
    p.tracks[0].items.push({ ...p.tracks[0].items[0], id: "i_x", start: 150 } as never);
    expect(lint(p).map((i) => [i.level, i.at])).toEqual([["error", 0], ["error", 100]]);
  });

  it("flags CJK text in a font without CJK glyphs", () => {
    const p = base();
    const c = p.tracks[2] as Extract<Project["tracks"][number], { kind: "caption" }>;
    c.textStyle = { font: "Inter" };
    c.items.push({ id: "c_1", start: 0, duration: 30, mode: "free", text: "你好" });
    expect(lint(p)).toMatchObject([{ level: "warn", itemId: "c_1" }]);
    c.textStyle = { font: "Noto Sans TC" };
    expect(lint(p)).toEqual([]);
  });

  it("flags Text overlays inset into the title-safe margin, and default captions on tall frames", () => {
    const p = base();
    p.tracks.push({ id: "t_9", name: "O1", kind: "overlay", items: [{ id: "o_1", start: 5, duration: 30, component: "Text", props: { text: "hi", style: { left: 20 } } }] });
    expect(lint(p)).toMatchObject([{ itemId: "o_1", at: 5 }]);
    const tall = { ...p, meta: { ...p.meta, height: 2160 } };
    tall.tracks = [...p.tracks.slice(0, 2), { id: "t_3", name: "C1", kind: "caption", items: [{ id: "c_1", start: 0, duration: 30, mode: "free", text: "hi" }] }];
    expect(lint(tall)).toMatchObject([{ level: "warn", itemId: "c_1" }]);
  });
});
