import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apply, createProject, type Project, type VideoItem } from "@splicewright/core";
import type { State } from "../src/store.ts";

const runtime = vi.hoisted(() => ({ state: {} as Partial<State>, op: vi.fn() }));
vi.mock("../src/store.ts", () => ({
  app: { use: <T,>(select: (s: State) => T) => select(runtime.state as State), get: () => runtime.state, set: vi.fn() },
  playhead: { use: <T,>(select: (s: { frame: number }) => T) => select({ frame: 0 }), get: () => ({ frame: 0 }) },
  op: runtime.op, ioRange: () => null, player: { ref: null }, dnd: {}, refresh: vi.fn(),
  applyLutPreset: vi.fn(), prepareReverse: vi.fn(),
}));
vi.mock("../src/edit.ts", () => ({
  findItem: (p: Project, id: string) => { for (const track of p.tracks) { const item = track.items.find((i) => i.id === id); if (item) return { track, item }; } return null; },
  copyStyle: vi.fn(), pasteStyle: vi.fn(), openMenu: vi.fn(), lookEntries: vi.fn(), pipEntries: vi.fn(), gradeWith: vi.fn(),
  addText: vi.fn(), addSticker: vi.fn(), replaceWith: vi.fn(), upload: vi.fn(), KEYS: { import: "⌘I" },
}));
import { AudioVolume } from "../src/inspector/audio.tsx";
import { Inspector } from "../src/inspector/Inspector.tsx";
import { FeaturePanel } from "../src/FeaturePanel.tsx";
import { OperationSearch } from "../src/OperationSearch.tsx";
import { actionAvailability, searchActions, SEARCH_ACTIONS, WORKSPACE_CATEGORIES } from "../src/workspace-search.ts";
import { focusControl, searchContext, shortcutHint } from "../src/workspace-navigation.ts";

function fixture(kind: "video" | "image" | "audio" | "Text" | "Sticker" | "Custom" | "caption", locked = false) {
  const p = createProject({ title: "UI", fps: 30, width: 1920, height: 1080 });
  p.assets = { a_clip: { id: "a_clip", path: "raw/clip.mp4", kind: "video" }, a_image: { id: "a_image", path: "raw/image.png", kind: "image" }, a_audio: { id: "a_audio", path: "raw/audio.wav", kind: "audio" } };
  const base = { id: "i_1", start: 0, duration: 90 };
  const track = kind === "video" || kind === "image"
    ? { id: "t_1", name: "V1", kind: "video" as const, locked, items: [{ ...base, sourceIn: 0, assetId: kind === "image" ? "a_image" : "a_clip" }] }
    : kind === "audio"
      ? { id: "t_1", name: "A1", kind: "audio" as const, locked, items: [{ ...base, sourceIn: 0, assetId: "a_audio" }] }
      : kind === "caption"
        ? { id: "t_1", name: "C1", kind: "caption" as const, locked, items: [{ ...base, mode: "free" as const, text: "caption" }] }
        : { id: "t_1", name: "O1", kind: "overlay" as const, locked, items: [{ ...base, component: kind, props: kind === "Text" ? { text: "title" } : kind === "Sticker" ? { src: "raw/image.png" } : { amount: 2 } }] };
  p.tracks = [track];
  return p;
}
beforeEach(() => {
  runtime.state = { selection: ["i_1"], live: null, reverseProxies: [], ingesting: {}, loudness: {}, audioFxLoudness: {}, audioFxErrors: {}, audioFxProcessing: [], io: { in: null, out: null }, uploads: [], reveal: null };
  runtime.op.mockClear();
  vi.stubGlobal("navigator", { platform: "MacIntel" });
});
const renderInspector = (p: Project) => { runtime.state.project = p; return renderToStaticMarkup(<Inspector p={p} />); };

describe("A1 discoverability and navigation", () => {
  it("finds purpose aliases and English names, requiring every query term", () => {
    const c = searchContext(fixture("video"), ["i_1"]);
    expect(searchActions("字體", searchContext(fixture("Text"), ["i_1"])).map((r) => r.action.control)).toEqual(["font"]);
    expect(searchActions("降噪", c).map((r) => r.action.control)).toEqual(["denoise"]);
    expect(searchActions("綠幕", c).map((r) => r.action.id)).toEqual(["key"]);
    expect(searchActions("放大", c).map((r) => r.action.id)).toEqual(["scale"]);
    expect(searchActions("  FaDe In  ", c).map((r) => r.action.id)).toEqual(["fade-in"]);
    expect(searchActions("fade nonexistent", c)).toEqual([]);
    expect(searchActions("卡點", c)[0].available).toBe(false);
    expect(searchActions("卡點", searchContext(fixture("audio"), ["i_1"]))[0].available).toBe(true);
  });
  it("keeps image transitions available and refuses inapplicable or locked edits", () => {
    const image = searchContext(fixture("image"), ["i_1"]);
    expect(searchActions("轉場", image)[0].available).toBe(true);
    expect(searchActions("音量", image)[0].available).toBe(false);
    expect(searchActions("裁切", searchContext(fixture("Text"), ["i_1"]))[0].available).toBe(false);
    const locked = searchContext(fixture("video", true), ["i_1"]);
    expect(searchActions("綠幕", locked)[0]).toMatchObject({ available: false, reason: "此軌道已鎖定，無法編輯。" });
    expect(searchActions("匯入", locked)[0].available).toBe(true);
    expect(searchActions("綠幕", { selectionCount: 2 })[0].available).toBe(false);
    expect(searchActions("主題", locked)[0].available).toBe(true);
  });
  it.each(["video", "image", "audio", "Text", "Sticker", "Custom", "caption"] as const)("binds every advertised Inspector result to a rendered control for %s", (kind) => {
    const p = fixture(kind);
    const html = renderInspector(p);
    const c = searchContext(p, ["i_1"]);
    for (const action of SEARCH_ACTIONS.filter((a) => !a.destination && a.id !== "project" && actionAvailability(a, c).available)) {
      expect(html, action.id).toContain(`data-ui-control="${action.control}"`);
    }
    if (kind === "Text") expect(html).toContain('name="text"'); // Existing addText selects this input after creation.
    expect(runtime.op).not.toHaveBeenCalled();
  });
  it("keeps section order stable and moves video volume to audio without duplicating it", () => {
    const html = renderInspector(fixture("video"));
    expect(html.indexOf('data-inspector-section="basic"')).toBeLessThan(html.indexOf('data-inspector-section="screen"'));
    expect(html.indexOf('data-inspector-section="screen"')).toBeLessThan(html.indexOf('data-inspector-section="audio"'));
    expect(html.match(/data-ui-control="volume"/g)).toHaveLength(1);
    expect(html.indexOf('data-ui-control="volume"')).toBeGreaterThan(html.indexOf('data-inspector-section="audio"'));
    expect(renderInspector(fixture("video", true))).toContain('disabled=""');
  });
  it("preserves keyed and unkeyed video volume patches after moving the control to audio", () => {
    const p = fixture("video");
    const item = p.tracks[0].items[0] as VideoItem;
    const slider = AudioVolume({ p, item });
    expect(slider.props.patch(1)).toEqual({ volume: null });
    expect(slider.props.patch(0.7)).toEqual({ volume: 0.7 });
    item.keyframes = { volume: [{ t: 0, v: 0.4 }] };
    const keyed = AudioVolume({ p, item });
    expect(keyed.props.value).toBe(0.4);
    const patch = keyed.props.patch(0.7);
    const result = apply(p, "setProps", { itemId: item.id, patch }, { assetDurations: { a_clip: 10 } });
    if ("error" in result) throw new Error(result.error.message);
    expect(result.project.tracks[0].items[0]).toMatchObject({ keyframes: { volume: [{ t: 0, v: 0.7 }] } });
    expect(item.keyframes.volume).toEqual([{ t: 0, v: 0.4 }]);
  });
  it("provides project settings while selected, and compatible actions or hints with no single selection", () => {
    const p = fixture("Text"); runtime.state.project = p;
    const html = renderToStaticMarkup(<Inspector p={p} location={{ section: "project", control: "project", serial: 1 }} />);
    expect(html).toContain('data-ui-control="project"');
    runtime.state.selection = [];
    expect(renderInspector(p)).toContain("目前沒有選取項目");
    runtime.state.selection = ["i_1", "i_2"];
    expect(renderInspector(p)).toContain("相容的樣式操作");
  });
  it("renders fixed categories and creation/import targets, showing unavailable reasons", () => {
    const p = fixture("Text"); runtime.state.project = p;
    for (const category of WORKSPACE_CATEGORIES) {
      const html = renderToStaticMarkup(<FeaturePanel p={p} category={category} onCategory={() => {}} onLocate={() => {}} />);
      for (const name of WORKSPACE_CATEGORIES) expect(html).toContain(`>${name}</button>`);
      if (category === "素材") expect(html).toContain('data-ui-control="import"');
      if (category === "文字") expect(html).toContain('data-ui-control="create-text"');
      if (category === "貼紙") expect(html).toContain('data-ui-control="create-sticker"');
      if (category === "音訊") { expect(html).toContain('data-ui-control="narration"'); expect(html).toContain("旁白"); }
      if (category === "轉場") expect(html).toContain("請先選取影片或圖片片段。");
    }
    expect(runtime.op).not.toHaveBeenCalled();
  });
  it("shows existing shortcut hints in search, including platform modifiers", () => {
    const html = renderToStaticMarkup(<OperationSearch context={searchContext(fixture("video"), ["i_1"])} onClose={() => {}} onLocate={() => {}} />);
    expect(html).toContain("Shift+C"); expect(html).toContain("⌘I");
    expect(shortcutHint(SEARCH_ACTIONS.find((a) => a.id === "import")!, false)).toBe("Ctrl+I");
    expect(shortcutHint(SEARCH_ACTIONS.find((a) => a.id === "mask")!, true, { selectionCount: 1, kind: "overlay" })).toBeUndefined();
    expect(runtime.op).not.toHaveBeenCalled();
  });
  it("opens nested collapsed details before scrolling and focusing an actual input", () => {
    const order: string[] = [];
    const root = { contains: () => true, querySelector: () => target };
    const outer = { tagName: "DETAILS", open: false, parentElement: root };
    const inner = { tagName: "DETAILS", open: false, parentElement: outer };
    const field = { focus: () => { expect(inner.open && outer.open).toBe(true); order.push("focus"); } };
    const target = { tagName: "DIV", parentElement: inner, matches: () => false, querySelector: () => field, scrollIntoView: () => { expect(inner.open && outer.open).toBe(true); order.push("scroll"); } };
    expect(focusControl(root as unknown as HTMLElement, "advanced")).toBe(true);
    expect(order).toEqual(["scroll", "focus"]);
    expect(focusControl({ querySelector: () => null } as unknown as HTMLElement, "absent")).toBe(false);
  });
});
