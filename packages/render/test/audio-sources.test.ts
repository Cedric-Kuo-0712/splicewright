import { expect, it } from "vitest";
import type { AudioItem, VideoItem } from "@splicewright/core";
import { audioSourceFor } from "../src/Composition.tsx";

it("keeps pending processed audio silent and requires a reversed companion for reverse clips", () => {
  const item: AudioItem = { id: "i_1", assetId: "a_clip", start: 0, duration: 30, sourceIn: 0, audioFx: { pan: -1 } };
  const baked = { i_1: "processed.m4a" };
  expect(audioSourceFor(item, "original.wav")).toBeUndefined();
  expect(audioSourceFor(item, "original.wav", baked)).toBe("processed.m4a");
  const reverse = { ...item, reverse: true } as VideoItem;
  expect(audioSourceFor(reverse, "original.wav", baked)).toBeUndefined();
  expect(audioSourceFor(reverse, "original.wav", baked, { i_1: "processed-reverse.m4a" })).toBe("processed-reverse.m4a");
  expect(audioSourceFor({ ...item, audioFx: undefined }, "original.wav", baked)).toBe("original.wav");
});
