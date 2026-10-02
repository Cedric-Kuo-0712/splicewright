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

  it("reports unmeasured, failed, stale, and excessive-peak source health with source ranges", () => {
    const p = base();
    const videoTrack = p.tracks.find((track) => track.kind === "video");
    if (videoTrack?.kind === "video") videoTrack.items[0].sourceIn = 2;
    const media = p.assets.a_clip;
    const sourceHealth = {
      format: 1 as const,
      method: "ffmpeg" as const,
      path: media.path,
      fingerprint: "live",
      measuredAt: "2026-10-02T00:00:00.000Z",
      decode: { status: "ok" as const },
      audio: {
        status: "measured" as const,
        integratedLufs: -8,
        samplePeak: { dbfs: -0.7, atSeconds: 3.24 },
        truePeak: { dbfs: -0.4, atSeconds: 3.26 },
      },
    };
    const metadata = { sourceHealth: { a_clip: sourceHealth }, fingerprints: { a_clip: "live" }, fingerprint: () => "live" };

    expect(lint(p, { fingerprint: () => "live" })).toMatchObject([{ level: "warn", itemId: expect.any(String), what: expect.stringContaining("no current full-decode/peak measurement") }]);
    expect(lint(p, metadata)).toMatchObject([{ level: "warn", itemId: expect.any(String), what: expect.stringContaining("source [2.00, 5.00)s") }]);
    expect(lint(p, metadata)[0].what).toContain("near source 3.26s");
    if (videoTrack?.kind === "video") videoTrack.items[0].sourceIn = 0;
    expect(lint(p, metadata)[0].what).toContain("selected-range maximum is not separately measured");
    p.meta.limiter = true;
    expect(lint(p, metadata)[0].what).toContain("Source peaks are independent of the render limiter");
    expect(lint(p, { ...metadata, sourceHealth: { a_clip: { ...sourceHealth, fingerprint: "old" } } })).toMatchObject([{ level: "error", what: expect.stringContaining("stale source-health") }]);
    expect(lint(p, { ...metadata, sourceHealth: { a_clip: { ...sourceHealth, decode: { status: "failed", error: "corrupt packet" } } } })).toMatchObject([{ level: "error", what: expect.stringContaining("cannot be fully decoded") }]);
    expect(lint(p, { ...metadata, sourceHealth: { a_clip: { ...sourceHealth, audio: { status: "none" } } } })).toEqual([]);
  });
});
