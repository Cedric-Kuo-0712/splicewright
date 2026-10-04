import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createProject, type VideoItem } from "@splicewright/core";
import { planLayeredExport, type LayeredPlan } from "../src/layered.ts";
import { audioClipFilters, makeVideoChain } from "../src/layered-render.ts";

let available = false;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); available = true; } catch {}
const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-filter_complex_threads", "2", ...args], { timeout: 10000 });

describe.skipIf(!available)("layered FFmpeg numeric acceptance", () => {
  it.each(["dissolve", "dip"] as const)("matches full-export pixels when starting within a %s", (kind) => {
    const project = createProject({ title: "range phase", fps: 30, width: 4, height: 2 });
    const items: VideoItem[] = [
      { id: "first", assetId: "a", start: 0, duration: 18, sourceIn: 0.5, transition: { kind, duration: 6 } },
      { id: "second", assetId: "b", start: 18, duration: 18, sourceIn: 0.5 },
    ];
    project.assets = { a: { id: "a", kind: "video", path: "a.mp4" }, b: { id: "b", kind: "video", path: "b.mp4" } };
    project.tracks = [{ id: "video", kind: "video", name: "Video", items }];
    const probes = Object.fromEntries(["a", "b"].map(id => [id, { kind: "video" as const, path: `${id}.mp4`, fingerprint: "x", width: 4, height: 2, fps: 30, duration: 8, audio: false }]));
    const render = (from: number, to: number) => {
      const plan = planLayeredExport(project, probes, from, to), filters: string[] = [], inputs: string[] = [];
      for (const segment of plan.video) inputs.push("-f", "lavfi", "-i", `color=${segment.item.assetId === "a" ? "white" : "red"}:s=4x2:r=30:d=2`);
      const { videoLabel } = makeVideoChain(plan, filters, 0);
      return ffmpeg([...inputs, "-filter_complex", filters.join(";"), "-map", `[${videoLabel}]`, "-frames:v", String(to - from), "-threads", "2", "-pix_fmt", "rgba", "-f", "rawvideo", "-"]);
    };
    const full = render(0, 36), partial = render(19, 23);
    expect(partial.length).toBe(4 * 4 * 2 * 4);
    expect(partial.equals(full.subarray(19 * 32, 23 * 32))).toBe(true);
  });
  it("darkens a dip once and preserves transparent letterboxing", () => {
    const plan: LayeredPlan = {
      from: 0, to: 36, fps: 30, width: 4, height: 2, background: "#123456", audio: [], windows: [],
      video: [{ item: { id: "clip", assetId: "a", start: 0, duration: 36, sourceIn: 0, fit: "contain", fadeIn: 6 },
        start: 0, duration: 36, sourceIn: 0, lead: 0, tail: 0, renderStart: 0, renderEnd: 36, decodeStart: 0, videoAudio: false,
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

  it("preserves a global video fade phase when the requested range begins mid-fade", () => {
    const plan: LayeredPlan = {
      from: 6, to: 9, fps: 30, width: 4, height: 2, background: "#000", audio: [], windows: [],
      video: [{ item: { id: "clip", assetId: "a", start: 0, duration: 18, sourceIn: 0, fadeIn: 12 },
        start: 0, duration: 18, sourceIn: 0, lead: 0, tail: 0, renderStart: 6, renderEnd: 9, decodeStart: 0, videoAudio: false }],
    };
    const filters: string[] = [];
    makeVideoChain(plan, filters, 0);
    filters[1] = filters[1].replace("[vc0]", "[vc0a]");
    filters.splice(2, 0, "[vc0a]split[vc0][vcheck]");
    filters.push("[base0]nullsink");
    const pixels = ffmpeg(["-f", "lavfi", "-i", "color=white:s=2x2:r=30:d=0.3", "-filter_complex", filters.join(";"), "-map", "[vcheck]", "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "-"]);
    expect(pixels.length).toBe(4 * 2 * 4);
    const pixel = 4;
    expect(pixels[pixel]).toBeGreaterThan(250);
    expect(pixels[pixel + 3]).toBeCloseTo(127, -1);
  });

  it("applies an audio fade before trimming the requested range so its phase does not restart", () => {
    const samples = ffmpeg(["-f", "lavfi", "-i", "aevalsrc=1:s=48000:d=1",
      "-filter_complex", `[0:a]${audioClipFilters(30, 30)},afade=t=in:st=0:d=1,atrim=start=0.5:duration=0.1,asetpts=PTS-STARTPTS[a]`,
      "-map", "[a]", "-ac", "1", "-f", "f32le", "-"]);
    expect(samples.length).toBe(4800 * 4);
    expect(samples.readFloatLE(0)).toBeCloseTo(0.5, 2);
  });
});
