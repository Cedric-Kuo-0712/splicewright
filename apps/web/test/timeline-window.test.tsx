import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { createProject, type Project } from "@splicewright/core";
import type { State } from "../src/store.ts";

const runtime = vi.hoisted(() => ({ state: {} as Partial<State> }));
vi.mock("../src/store.ts", () => ({
  app: { use: <T,>(select: (state: State) => T) => select(runtime.state as State), get: () => runtime.state, set: vi.fn() },
  playhead: { use: <T,>(select: (state: { frame: number }) => T) => select({ frame: 0 }), get: () => ({ frame: 0 }) },
  op: vi.fn(), ioRange: () => null, dnd: {}, say: vi.fn(), seek: vi.fn(),
}));
vi.mock("../src/edit.ts", () => ({
  dropFiles: vi.fn(), findItem: vi.fn(), insertOnNewTrack: vi.fn(), laneMenu: vi.fn(), markerMenu: vi.fn(), openMenu: vi.fn(),
  itemMenu: vi.fn(), keyMenu: vi.fn(), rulerMenu: vi.fn(), trackMenu: vi.fn(), videoUnder: vi.fn(),
}));
import { Timeline } from "../src/Timeline.tsx";

function markup(project: Project) {
  runtime.state = { project, selection: [], gap: null, editing: null, pxPerFrame: 1, io: { in: null, out: null }, review: null, reviewView: null, live: null, slip: null, ingesting: {} };
  return renderToStaticMarkup(<Timeline project={project} />);
}

it("mounts a bounded horizontal window even when every clip is selected", () => {
  const p = createProject({ title: "dense", width: 1920, height: 1080, fps: 30 });
  p.tracks = [{ id: "t_1", kind: "caption", name: "Captions", items: Array.from({ length: 10_000 }, (_, index) => ({
    id: `i_${index + 1}`, start: index * 100, duration: 90, mode: "free" as const, text: String(index),
  })) }];
  markup(p);
  runtime.state.selection = p.tracks[0].items.map((item) => item.id);
  const html = renderToStaticMarkup(<Timeline project={p} />);
  expect((html.match(/data-id=/g) ?? []).length).toBe(17);
  expect(p.tracks[0].items).toHaveLength(10_000);
  expect(html).toContain('data-row="t_1"');
  expect(html).not.toContain('data-id="i_10000"');
});

it("keeps the caption editor mounted outside the viewport", () => {
  const p = createProject({ title: "editing", width: 1920, height: 1080, fps: 30 });
  p.tracks = [{ id: "t_1", kind: "caption", name: "Captions", items: [{ id: "i_1", start: 100_000, duration: 90, mode: "free", text: "editing" }] }];
  markup(p);
  runtime.state.editing = { kind: "caption", id: "i_1" };
  const html = renderToStaticMarkup(<Timeline project={p} />);
  expect(html).toContain('data-id="i_1"');
  expect(html).toContain("caption-edit");
});

it("bounds a long audio canvas to viewport plus overscan", () => {
  const p = createProject({ title: "long audio", width: 1920, height: 1080, fps: 30 });
  p.assets = { a_audio: { id: "a_audio", kind: "audio", path: "raw/long.wav" } };
  p.tracks = [{ id: "t_1", kind: "audio", name: "Audio", items: [{ id: "i_1", assetId: "a_audio", sourceIn: 0, start: 0, duration: 30 * 60 * 60 }] }];
  const html = markup(p);
  expect(html).toMatch(/<canvas[^>]*width="1256"/);
  expect(html).not.toContain('width="8000"');
});

it("windows beat ticks and guides inside a selected long audio clip", () => {
  const p = createProject({ title: "beats", width: 1920, height: 1080, fps: 30 });
  p.assets = { a_audio: { id: "a_audio", kind: "audio", path: "raw/long.wav" } };
  p.tracks = [{ id: "t_1", kind: "audio", name: "Audio", items: [{ id: "i_1", assetId: "a_audio", sourceIn: 0, start: 0, duration: 30 * 60 * 60, beats: Array.from({ length: 3600 }, (_, i) => i) }] }];
  markup(p);
  runtime.state.selection = ["i_1"];
  const html = renderToStaticMarkup(<Timeline project={p} />);
  expect((html.match(/class="beat /g) ?? []).length).toBe(55);
  expect((html.match(/class="beat-guide"/g) ?? []).length).toBe(55);
});
