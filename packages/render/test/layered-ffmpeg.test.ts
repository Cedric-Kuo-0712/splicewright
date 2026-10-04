import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { LayeredPlan } from "../src/layered.ts";
import { audioClipFilters, makeVideoChain } from "../src/layered-render.ts";

let available = false;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); available = true; } catch {}
const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-filter_complex_threads", "2", ...args], { timeout: 10000 });

describe.skipIf(!available)("layered FFmpeg numeric acceptance", () => {
  it("darkens a dip once and preserves transparent letterboxing", () => {
    const plan: LayeredPlan = {
      from: 0, to: 36, fps: 30, width: 4, height: 2, background: "#123456", audio: [], windows: [],
      video: [{ item: { id: "clip", assetId: "a", start: 0, duration: 36, sourceIn: 0, fit: "contain", fadeIn: 6 },
        start: 0, duration: 36, sourceIn: 0, lead: 0, tail: 0, videoAudio: false,
        incoming: undefined, outgoing: { kind: "dip", before: 9, after: 9 } }],
    };
    const filters: string[] = [];
    const { videoLabel } = makeVideoChain(plan, filters, 0);
    const pixels = ffmpeg(["-f", "lavfi", "-i", "color=white:s=2x2:r=30:d=1.2", "-filter_complex", filters.join(";"), "-map", `[${videoLabel}]`, "-frames:v", "36", "-threads", "2", "-pix_fmt", "rgba", "-f", "rawvideo", "-"]);
    expect(pixels.length).toBe(36 * 4 * 2 * 4);
    for (const frame of [27, 31, 35]) {
      const expected = 255 * (36 - frame) / 9;
      const index = frame * 32 + 4; // white center, not the transparent pad
      for (let channel = 0; channel < 3; channel++) expect(Math.abs(pixels[index + channel] - expected)).toBeLessThanOrEqual(2);
      expect(pixels[index + 3]).toBe(255);
      expect([...pixels.subarray(frame * 32, frame * 32 + 4)]).toEqual([...pixels.subarray(27 * 32, 27 * 32 + 4)]);
    }
  });

  it("keeps a timestamp gap instead of advancing the following audio and pads the exact clip length", () => {
    const samples = ffmpeg(["-f", "lavfi", "-i", "aevalsrc=if(eq(n\\,6000)\\,1\\,0):s=48000:d=0.2",
      "-filter_complex", `[0:a]asetpts=PTS+gte(N\\,4800)*0.1/TB,${audioClipFilters(9, 30)}[a]`, "-map", "[a]", "-ac", "1", "-f", "f32le", "-"]);
    expect(samples.length).toBe(14400 * 4);
    let peak = 0;
    for (let i = 0; i < samples.length / 4; i++) if (Math.abs(samples.readFloatLE(i * 4)) > Math.abs(samples.readFloatLE(peak * 4))) peak = i;
    expect(peak).toBe(10800); // source sample 6000 plus the 4800-sample gap
    expect(samples.readFloatLE(peak * 4)).toBeCloseTo(1, 6);
  });
});
