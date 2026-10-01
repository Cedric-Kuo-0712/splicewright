import React from "react";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { apply, createProject, type Ctx, type OpResult, type Project } from "@splicewright/core";
import { load, run, undo } from "@splicewright/core/node";
import { describe, expect, it } from "vitest";
import { PanelSeparator } from "../src/PanelSeparator.tsx";
import { constrainLayout, DEFAULT_LAYOUT, numericLimit } from "../src/layout.ts";
import { captureStyle, effectiveTextValues, styleOperations } from "../src/style.ts";

const ctx: Ctx = { assetDurations: { a_clip: 10 } };
const ok = (result: OpResult): Project => {
  if ("error" in result) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.project;
};

function videoFixture() {
  let p = createProject({ title: "UI styles", fps: 30, width: 1920, height: 1080 });
  p = ok(apply(p, "importAsset", { path: "raw/clip.mp4" }, ctx));
  p = ok(apply(p, "insertItem", { assetId: "a_clip", at: 0, duration: 60 }, ctx));
  p = ok(apply(p, "insertItem", { assetId: "a_clip", at: 60, duration: 60 }, ctx));
  return p;
}

describe("UI intuition helpers", () => {
  it("clamps numeric edits and keeps panel dimensions finite and within viewport constraints", () => {
    expect(numericLimit("", 0, 1)).toBeNull();
    expect(numericLimit("nope", 0, 1)).toBeNull();
    expect(numericLimit("Infinity", 0, 1)).toBeNull();
    expect(numericLimit("-4", 0, 1)).toBe(0);
    expect(numericLimit("4", 0, 1)).toBe(1);
    expect(constrainLayout({ bin: 900, inspector: -1, timeline: NaN }, 1000, 800)).toEqual({ bin: 280, inspector: 200, timeline: DEFAULT_LAYOUT.timeline });
  });

  it("renders accessible, keyboard-focusable panel separators", () => {
    const html = renderToStaticMarkup(React.createElement(PanelSeparator, { label: "Resize inspector", orientation: "vertical", className: "inspector-split", value: 260, min: 200, max: 500, onPointerDown: () => {}, onKeyDown: () => {} }));
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-label="Resize inspector"');
    expect(html).toContain('aria-valuenow="260"');
    expect(html).toContain('tabindex="0"');
  });

  it("keeps side panels inside a narrow viewport", () => {
    const layout = constrainLayout(DEFAULT_LAYOUT, 480, 240);
    expect(layout.bin + layout.inspector + 12).toBeLessThan(480);
    expect(layout.timeline).toBeLessThanOrEqual(240 * 0.48 + 1);
  });

  it("copies and applies neutral video styles to clips without an effects property", () => {
    const p = videoFixture();
    const track = p.tracks.find((t) => t.kind === "video")!;
    const copied = captureStyle(track, track.items[0]);
    expect(copied).toEqual({ kind: "video", effects: null, grade: null, key: null });
    const plan = styleOperations(p, ["i_2"], { kind: "video", effects: { brightness: 0.7 } });
    expect(plan.operations).toHaveLength(1);
    const next = ok(apply(p, "batch", { ops: plan.operations }, ctx));
    expect(next.tracks.flatMap((t) => t.items).find((i) => i.id === "i_2")).toMatchObject({ effects: { brightness: 0.7 } });
  });

  it("pastes default text style by unsetting fields rather than passing invalid null props", () => {
    let p = createProject({ title: "Text defaults", fps: 30, width: 1920, height: 1080 });
    p = ok(apply(p, "insertItem", { component: "Text", props: { text: "keep", role: "subtitle", textStyle: { size: 42 }, style: { color: "red" } }, at: 0, duration: 30 }, ctx));
    const target = p.tracks.flatMap((t) => t.items).find((i) => "component" in i)!;
    const plan = styleOperations(p, [target.id], { kind: "text" });
    const next = ok(apply(p, "batch", { ops: plan.operations }, ctx));
    expect(next.tracks.flatMap((t) => t.items).find((i) => i.id === target.id)).toMatchObject({ props: { text: "keep", style: { color: "red" } } });
    const item = next.tracks.flatMap((t) => t.items).find((i) => i.id === target.id)!;
    if (!("props" in item)) throw new Error("missing Text overlay");
    expect(item.props).not.toHaveProperty("role");
    expect(item.props).not.toHaveProperty("textStyle");
  });

  it("allows first-time word highlight on anchored caption tracks before highlight timing is loaded", () => {
    const p = videoFixture();
    p.tracks.push({ id: "t_caption", kind: "caption", name: "Captions", items: [
      { id: "c_1", mode: "anchored", itemId: "i_1", sourceStart: 0, sourceEnd: 1, text: "words" },
    ] });
    const plan = styleOperations(p, ["c_1"], { kind: "caption", highlight: "word" });
    expect(plan.operations[0].args.patch).toMatchObject({ highlight: "word" });
    expect(plan.noWordTiming).toBe(0);
  });

  it("shows the exact rendered values after theme, text overrides, font clamping, CJK fallback, and raw CSS", () => {
    const p = createProject({ title: "Theme", fps: 30, width: 1920, height: 1080 });
    p.meta.theme = "zh-daily";
    const values = effectiveTextValues(p, "title", { font: "Inter", weight: 1200, size: 24 }, { fontSize: "2rem", color: "#f0a" }, "中文");
    expect(values.find((v) => v.label === "font")?.value).toContain("Noto Sans TC");
    expect(values.find((v) => v.label === "font")?.source).toBe("text override");
    expect(values.find((v) => v.label === "weight")?.value).toBe(900);
    expect(values.find((v) => v.label === "size")).toMatchObject({ value: "2rem", source: "raw CSS" });
    expect(values.find((v) => v.label === "color")).toMatchObject({ value: "#f0a", source: "raw CSS" });
  });

  it("applies copied video effects in one core batch while preserving target keys and unrelated properties", () => {
    let p = videoFixture();
    p = ok(apply(p, "setProps", { itemId: "i_1", patch: { effects: { brightness: 0.4, sepia: 0.2 } } }, ctx));
    p = ok(apply(p, "setProps", { itemId: "i_2", patch: { volume: 0.65, effects: { contrast: 1.2 } } }, ctx));
    p = ok(apply(p, "setKeyframe", { itemId: "i_2", prop: "brightness", at: 90, value: 0.8 }, ctx));
    const sourceTrack = p.tracks.find((t) => t.kind === "video")!;
    const sourceItem = sourceTrack.items.find((i) => i.id === "i_1")!;
    const style = captureStyle(sourceTrack, sourceItem)!;
    const plan = styleOperations(p, ["i_1", "i_2"], style);
    expect(plan.animated).toBe(1);
    const next = ok(apply(p, "batch", { ops: plan.operations }, ctx));
    const target = next.tracks.flatMap((t) => t.items).find((i) => i.id === "i_2")!;
    expect(next.revision).toBe(p.revision + 1);
    expect(target).toMatchObject({ volume: 0.65, effects: { brightness: 0.4, sepia: 0.2 } });
    expect(target.keyframes?.brightness).toEqual([{ t: 1, v: 0.8 }]);
  });

  it("records the multi-target style batch as one persistent undo step", () => {
    let p = videoFixture();
    p = ok(apply(p, "setProps", { itemId: "i_1", patch: { effects: { brightness: 0.4 } } }, ctx));
    const track = p.tracks.find((t) => t.kind === "video")!;
    const style = captureStyle(track, track.items.find((i) => i.id === "i_1")!)!;
    const plan = styleOperations(p, ["i_1", "i_2"], style);
    const dir = mkdtempSync(join(tmpdir(), "swr-ui-style-"));
    try {
      mkdirSync(join(dir, ".splicewright"));
      writeFileSync(join(dir, "project.json"), JSON.stringify(p));
      writeFileSync(join(dir, ".splicewright", "assets.json"), JSON.stringify({ a_clip: { path: "raw/clip.mp4", fingerprint: "test", kind: "video", duration: 10 } }));
      const result = run(dir, "batch", { ops: plan.operations }, p.revision);
      expect("error" in result).toBe(false);
      const after = "error" in result ? p : result.project;
      expect(after.revision).toBe(p.revision + 1);
      const undone = undo(dir, after.revision);
      expect("error" in undone).toBe(false);
      expect(load(dir).revision).toBe(after.revision + 1);
      expect(load(dir).tracks.flatMap((t) => t.items).find((i) => i.id === "i_2")).not.toHaveProperty("effects");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("copies text role/style without replacing target content or raw CSS", () => {
    const source = { kind: "text", role: "title", textStyle: { size: 44, color: "white" } } as const;
    const p = videoFixture();
    // The operation builder itself uses the same merge contract as the Inspector's props editor.
    const overlayProject = structuredClone(p);
    overlayProject.tracks.push({ id: "t_text", kind: "overlay", name: "Text", items: [
      { id: "o_1", start: 0, duration: 30, component: "Text", props: { text: "source", role: "subtitle", style: { fontWeight: 300 } } },
      { id: "o_2", start: 30, duration: 30, component: "Text", props: { text: "keep me", style: { color: "red", fontWeight: 100 } } },
    ] });
    const operations = styleOperations(overlayProject, ["o_2"], source);
    const props = operations.operations[0].args.patch as { props: Record<string, unknown> };
    expect(props.props).toMatchObject({ text: "keep me", role: "title", textStyle: { size: 44, color: "white" }, style: { color: "red", fontWeight: 100 } });
  });

  it("deduplicates caption track style application across selected captions and reports locked skips", () => {
    const p = videoFixture();
    p.tracks.push({ id: "t_caption", kind: "caption", name: "Captions", locked: true, items: [
      { id: "c_1", start: 0, duration: 20, mode: "free", text: "one" },
      { id: "c_2", start: 20, duration: 20, mode: "free", text: "two" },
    ] });
    const plan = styleOperations(p, ["c_1", "c_2"], { kind: "caption", textStyle: { size: 42 }, highlight: "word" });
    expect(plan.operations).toHaveLength(0);
    expect(plan.skipped).toBe(2);

    p.tracks.find((t) => t.id === "t_caption")!.locked = false;
    const unlocked = styleOperations(p, ["c_1", "c_2"], { kind: "caption", textStyle: { size: 42 }, highlight: "word" }, new Set(["c_1"]));
    expect(unlocked.operations).toHaveLength(1);
    expect(unlocked.operations[0].args).toMatchObject({ trackId: "t_caption", patch: { textStyle: { size: 42 }, highlight: "word" } });
    const untimed = styleOperations(p, ["c_1", "c_2"], { kind: "caption", textStyle: { size: 42 }, highlight: "word" });
    expect(untimed.noWordTiming).toBe(1);
    expect(untimed.operations[0].args.patch).not.toHaveProperty("highlight");
  });

  it("copies grade and key with effects and applies them in one batch, same project", () => {
    let p = videoFixture();
    // importAsset needs a project file reader to validate .cube; a registered LUT asset is all setProps checks.
    const lut = "a_warm";
    p.assets[lut] = { id: lut, path: "luts/warm.cube", kind: "lut" };
    const grade = { exposure: 0.5, temperature: 0.2, curves: { all: [[0, 0], [1, 1]] }, lut: { assetId: lut, strength: 0.6 } };
    const key = { kind: "chroma", color: "#00ff00", similarity: 0.3, smoothness: 0.1 };
    p = ok(apply(p, "setProps", { itemId: "i_1", patch: { effects: { sepia: 0.2 }, grade, key } }, ctx));
    const track = p.tracks.find((t) => t.kind === "video")!;
    const style = captureStyle(track, track.items.find((i) => i.id === "i_1")!)!;
    const plan = styleOperations(p, ["i_2"], style);
    const next = ok(apply(p, "batch", { ops: plan.operations }, ctx));
    expect(next.revision).toBe(p.revision + 1);
    expect(next.tracks.flatMap((t) => t.items).find((i) => i.id === "i_2")).toMatchObject({ effects: { sepia: 0.2 }, grade, key });
  });

  it("unsets the target's grade and key when the source has none", () => {
    let p = videoFixture();
    p = ok(apply(p, "setProps", { itemId: "i_2", patch: { grade: { exposure: 1 }, key: { kind: "chroma", color: "#00ff00", similarity: 0.3, smoothness: 0.1 } } }, ctx));
    const track = p.tracks.find((t) => t.kind === "video")!;
    const style = captureStyle(track, track.items.find((i) => i.id === "i_1")!)!;
    const next = ok(apply(p, "batch", { ops: styleOperations(p, ["i_2"], style).operations }, ctx));
    const target = next.tracks.flatMap((t) => t.items).find((i) => i.id === "i_2")!;
    expect(target).not.toHaveProperty("grade");
    expect(target).not.toHaveProperty("key");
  });
});
