import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { createProject } from "@splicewright/core";

const state = vi.hoisted(() => ({
  isPlayer: true,
  video: vi.fn(),
  audio: vi.fn(),
  offthread: vi.fn(),
}));

vi.mock("@remotion/media", () => ({
  Video: (props: unknown) => { state.video(props); return null; },
}));
vi.mock("remotion", async (original) => ({
  ...await original<typeof import("remotion")>(),
  useRemotionEnvironment: () => ({ isPlayer: state.isPlayer, isRendering: !state.isPlayer }),
  useCurrentFrame: () => 0,
  staticFile: (path: string) => `/media/${path}`,
  AbsoluteFill: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  Sequence: ({ children }: React.PropsWithChildren) => <>{children}</>,
  OffthreadVideo: (props: unknown) => { state.offthread(props); return null; },
  Audio: (props: unknown) => { state.audio(props); return null; },
}));

import { CanvasVideoPath, SplicewrightProject, lookEffects } from "../src/Composition.tsx";

const volume = (frame: number) => frame / 100;
const props = {
  itemName: "graded clip", itemId: "i_graded", src: "/media/edit.mp4",
  trimBefore: 17, speed: 1, volume, fit: "contain" as const, style: {}, luts: {}, sample: false,
  grade: { shadows: 1 },
};

beforeEach(() => {
  state.isPlayer = true;
  state.video.mockClear();
  state.audio.mockClear();
  state.offthread.mockClear();
});

it("uses timeline-driven video for plain Player clips and preserves the export decoder", () => {
  const project = createProject({ title: "plain preview", fps: 30, width: 1920, height: 1080 });
  project.assets.a_video = { id: "a_video", kind: "video", path: "raw/clip.mp4" };
  project.tracks = [{ id: "t_video", name: "Video", kind: "video", items: [{ id: "i_video", assetId: "a_video", start: 0, duration: 90, sourceIn: 2, speed: 0.5 }] }];
  renderToStaticMarkup(<SplicewrightProject project={project} />);
  expect(state.offthread).not.toHaveBeenCalled();
  expect(state.video).toHaveBeenCalledOnce();
  expect(state.video.mock.calls[0][0]).toMatchObject({
    src: "/media/raw/clip.mp4", trimBefore: 60, playbackRate: 0.5, muted: true,
    disallowFallbackToOffthreadVideo: false, onError: undefined, effects: [],
  });
  expect(state.audio.mock.calls[0][0]).toMatchObject({ trimBefore: 60, playbackRate: 0.5 });

  state.isPlayer = false;
  state.video.mockClear();
  state.audio.mockClear();
  renderToStaticMarkup(<SplicewrightProject project={project} />);
  expect(state.video).not.toHaveBeenCalled();
  expect(state.audio).not.toHaveBeenCalled();
  expect(state.offthread.mock.calls[0][0]).toMatchObject({
    src: "/media/raw/clip.mp4", trimBefore: 60, playbackRate: 0.5,
  });
});

it("fails visibly rather than dropping effects when decoding a graded preview fails", () => {
  renderToStaticMarkup(<CanvasVideoPath {...props} />);
  const error = new Error("unsupported codec");
  expect(state.video.mock.calls[0][0].onError(error)).toBe("fail");
  expect(error.message).toContain('item "graded clip"');
});

it("requires the canvas decoder for pixel sampling even without a grade", () => {
  renderToStaticMarkup(<CanvasVideoPath {...props} grade={undefined} sample />);
  expect(state.video.mock.calls[0][0].disallowFallbackToOffthreadVideo).toBe(true);
  expect(state.video.mock.calls[0][0].effects).toHaveLength(1);
});

it("previews canvas effects with native audio and bypasses WebCodecs audio buffering", () => {
  renderToStaticMarkup(<CanvasVideoPath {...props} />);
  expect(state.video).toHaveBeenCalledOnce();
  expect(state.video.mock.calls[0][0]).toMatchObject({
    src: props.src, trimBefore: 17, playbackRate: 1, muted: true,
    disallowFallbackToOffthreadVideo: true,
  });
  expect(state.video.mock.calls[0][0].effects).toHaveLength(1);
  expect(state.audio).toHaveBeenCalledOnce();
  expect(state.audio.mock.calls[0][0]).toMatchObject({
    src: props.src, trimBefore: 17, playbackRate: 1, volume,
  });
});

it("preserves mute and timing on separate preview audio without playing audio twice", () => {
  renderToStaticMarkup(<CanvasVideoPath {...props} speed={0.5} muted />);
  expect(state.video.mock.calls[0][0].muted).toBe(true);
  expect(state.audio).toHaveBeenCalledOnce();
  expect(state.audio.mock.calls[0][0]).toMatchObject({ muted: true, playbackRate: 0.5, trimBefore: 17, volume });
});

it("keeps normal-speed export audio on the existing canvas decoder", () => {
  state.isPlayer = false;
  renderToStaticMarkup(<CanvasVideoPath {...props} />);
  expect(state.video.mock.calls[0][0].muted).toBe(false);
  expect(state.audio).not.toHaveBeenCalled();
});

it("retains the existing native audio path for speed-adjusted exports", () => {
  state.isPlayer = false;
  renderToStaticMarkup(<CanvasVideoPath {...props} speed={2} />);
  expect(state.video.mock.calls[0][0].muted).toBe(true);
  expect(state.audio).toHaveBeenCalledOnce();
  expect(state.audio.mock.calls[0][0]).toMatchObject({ playbackRate: 2, trimBefore: 17, volume });
});

it("skips only exact identity-curve shaders and retains sampling and real grading", () => {
  const curves = { all: [[0, 0], [1, 1]] as [number, number][] };
  expect(lookEffects("clip", { curves }, undefined, {}, false)).toHaveLength(0);
  expect(lookEffects("clip", { curves, highlights: 1 }, undefined, {}, false)).toHaveLength(1);
  expect(lookEffects("clip", { curves }, undefined, {}, true)).toHaveLength(1);
  expect(lookEffects("clip", { curves: { all: [[0, 0], [1, 0.9]] } }, undefined, {}, false)).toHaveLength(1);
  expect(lookEffects("clip", { curves, levels: { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0.1, outWhite: 1 } }, undefined, {}, false)).toHaveLength(2);
});
