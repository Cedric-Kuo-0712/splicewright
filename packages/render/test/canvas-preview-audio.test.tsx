import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  isPlayer: true,
  video: vi.fn(),
  audio: vi.fn(),
}));

vi.mock("@remotion/media", () => ({
  Video: (props: unknown) => { state.video(props); return null; },
}));
vi.mock("remotion", async (original) => ({
  ...await original<typeof import("remotion")>(),
  useRemotionEnvironment: () => ({ isPlayer: state.isPlayer, isRendering: !state.isPlayer }),
  Audio: (props: unknown) => { state.audio(props); return null; },
}));

import { CanvasVideoPath } from "../src/Composition.tsx";

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
