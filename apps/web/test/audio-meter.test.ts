import { describe, expect, it } from "vitest";
import { measurePeak, measureStereoPeak } from "../src/audio-meter.ts";

describe("playback peak meter", () => {
  it("does not hide opposite-phase stereo clipping through mono downmixing", () => {
    expect(measureStereoPeak([new Float32Array([1, 0]), new Float32Array([-1, 0])])).toEqual({ peakDb: 0, clipping: true });
  });
  it("reports silence as a measured signal without calling it clipped", () => {
    expect(measurePeak(new Float32Array(8))).toEqual({ peakDb: -Infinity, clipping: false });
  });

  it("measures both polarities and flags full-scale sample peaks", () => {
    const half = measurePeak(new Float32Array([0, -0.5, 0.25]));
    expect(half?.peakDb).toBeCloseTo(-6.0206, 4);
    expect(half?.clipping).toBe(false);
    expect(measurePeak(new Float32Array([0.2, -1]))).toEqual({ peakDb: 0, clipping: true });
  });

  it("leaves missing samples unmeasured", () => {
    expect(measurePeak(new Float32Array())).toBeNull();
  });
});
