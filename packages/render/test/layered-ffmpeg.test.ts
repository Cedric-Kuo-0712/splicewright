import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createProject, type VideoItem } from "@splicewright/core";
import { planLayeredExport, type LayeredPlan } from "../src/layered.ts";
import { audioClipFilters, filterBufferedFramesArgs, makeVideoChain } from "../src/layered-render.ts";

it("keeps the experimental filter buffer cap opt-in and capability checked", () => {
  expect(filterBufferedFramesArgs(undefined, false)).toEqual([]);
  expect(filterBufferedFramesArgs(64, true)).toEqual(["-filter_buffered_frames", "64"]);
  expect(filterBufferedFramesArgs(128, true)).toEqual(["-filter_buffered_frames", "128"]);
  expect(() => filterBufferedFramesArgs(64, false)).toThrow(/does not support/);
  expect(() => filterBufferedFramesArgs(256, true)).toThrow(/must be 64 or 128/);
});

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
  it("composites a scaled, offset and half-transparent upper track over the base", () => {
    // 8x4 canvas; the red upper clip is drawn at half size (4x2), centre moved right by 2, over a white base.
    const plan: LayeredPlan = {
      from: 0, to: 3, fps: 30, width: 8, height: 4, background: "#000000", audio: [], windows: [],
      video: [
        { item: { id: "base", assetId: "a", start: 0, duration: 3, sourceIn: 0 }, start: 0, duration: 3, sourceIn: 0, lead: 0, tail: 0, renderStart: 0, renderEnd: 3, decodeStart: 0, videoAudio: false },
        { item: { id: "pip", assetId: "b", start: 0, duration: 3, sourceIn: 0 }, start: 0, duration: 3, sourceIn: 0, lead: 0, tail: 0, renderStart: 0, renderEnd: 3, decodeStart: 0, videoAudio: false,
          place: { width: 4, height: 2, x: 2, y: 0, opacity: 0.5 } },
      ],
    };
    const filters: string[] = [];
    const { videoLabel } = makeVideoChain(plan, filters, 0);
    const pixels = ffmpeg(["-f", "lavfi", "-i", "color=white:s=8x4:r=30:d=1", "-f", "lavfi", "-i", "color=red:s=8x4:r=30:d=1", "-filter_complex", filters.join(";"), "-map", `[${videoLabel}]`, "-frames:v", "1", "-threads", "2", "-pix_fmt", "rgba", "-f", "rawvideo", "-"]);
    const at = (x: number, y: number) => [...pixels.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 3)];
    const white = (x: number, y: number) => at(x, y).forEach((value) => expect(Math.abs(value - 255)).toBeLessThanOrEqual(3));
    white(0, 0); white(7, 3);                            // outside the item: base only
    // item box is x 4..7, y 1..2 (centre 4+2 = 6 across, 2 down)
    for (const [x, y] of [[4, 1], [7, 2]]) { const [r, g, b] = at(x, y); expect(Math.abs(r - 255)).toBeLessThanOrEqual(3); expect(Math.abs(g - 128)).toBeLessThanOrEqual(2); expect(Math.abs(b - 128)).toBeLessThanOrEqual(2); }
    white(3, 1);                                         // just left of the box
    white(4, 0);                                         // just above the box
  });
  it("clips an upper track with a mask image's alpha and keeps its own transparency", () => {
    // 8x4 canvas, red upper clip over white; the mask image is opaque on its right half only.
    const plan: LayeredPlan = {
      from: 0, to: 3, fps: 30, width: 8, height: 4, background: "#000000", audio: [], windows: [],
      video: [
        { item: { id: "base", assetId: "a", start: 0, duration: 3, sourceIn: 0 }, start: 0, duration: 3, sourceIn: 0, lead: 0, tail: 0, renderStart: 0, renderEnd: 3, decodeStart: 0, videoAudio: false },
        { item: { id: "pip", assetId: "b", start: 0, duration: 3, sourceIn: 0, mask: { shape: "rect", x: 0.5, y: 0, w: 0.5, h: 1 } }, start: 0, duration: 3, sourceIn: 0, lead: 0, tail: 0, renderStart: 0, renderEnd: 3, decodeStart: 0, videoAudio: false },
      ],
    };
    const filters: string[] = [];
    const { videoLabel, nextInput } = makeVideoChain(plan, filters, 0, new Map([["pip", 2]]));
    expect(nextInput).toBe(3);
    const pixels = ffmpeg(["-f", "lavfi", "-i", "color=white:s=8x4:r=30:d=1", "-f", "lavfi", "-i", "color=red:s=8x4:r=30:d=1",
      "-f", "lavfi", "-i", "color=black@0:s=8x4:r=30:d=1,format=rgba,drawbox=x=4:y=0:w=4:h=4:color=white@1:t=fill:replace=1",
      "-filter_complex", filters.join(";"), "-map", `[${videoLabel}]`, "-frames:v", "1", "-threads", "2", "-pix_fmt", "rgba", "-f", "rawvideo", "-"]);
    const at = (x: number, y: number) => [...pixels.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 3)];
    for (const x of [0, 3]) expect(at(x, 1)[1]).toBeGreaterThan(240);   // masked out: white base shows through
    for (const x of [4, 7]) expect(at(x, 1)[1]).toBeLessThan(15);       // inside the mask: the red clip
  });
  describe("crop and rotation of the fitted picture", () => {
    // 16x8 canvas, red base, an upper clip whose source has a green left half and a blue right half. The plan comes from the planner,
    // so the planner's crop fractions and turn are what the filter graph is checked against.
    const halves = "color=green:s=16x8:r=30:d=1,format=rgba,drawbox=x=8:y=0:w=8:h=8:color=blue:t=fill:replace=1";
    const frame = (patch: Partial<VideoItem>, source = halves) => {
      const project = createProject({ title: "shape", fps: 30, width: 16, height: 8 });
      project.assets = { a: { id: "a", kind: "video", path: "a.mp4" }, b: { id: "b", kind: "video", path: "b.mp4" } };
      project.tracks = [
        { id: "v1", kind: "video", name: "V1", items: [{ id: "base", assetId: "a", start: 0, duration: 3, sourceIn: 0 }] },
        { id: "v2", kind: "video", name: "V2", items: [{ id: "top", assetId: "b", start: 0, duration: 3, sourceIn: 0, ...patch }] },
      ];
      const probes = Object.fromEntries(["a", "b"].map((id) => [id, { kind: "video" as const, path: `${id}.mp4`, fingerprint: "x", width: 16, height: 8, fps: 30, duration: 8, audio: false }]));
      const filters: string[] = [];
      const { videoLabel } = makeVideoChain(planLayeredExport(project, probes, 0, 3), filters, 0, patch.mask ? new Map([["top", 2]]) : undefined);
      // The mask image is drawn upright on the canvas (Composition.tsx maskOf): opaque on the right half only.
      const maskImage = patch.mask ? ["-f", "lavfi", "-i", "color=black@0:s=16x8:r=30:d=1,format=rgba,drawbox=x=8:y=0:w=8:h=8:color=white@1:t=fill:replace=1"] : [];
      const pixels = ffmpeg(["-f", "lavfi", "-i", "color=red:s=16x8:r=30:d=1", "-f", "lavfi", "-i", source, ...maskImage, "-filter_complex", filters.join(";"), "-map", `[${videoLabel}]`, "-frames:v", "1", "-threads", "2", "-pix_fmt", "rgba", "-f", "rawvideo", "-"]);
      return (x: number, y: number) => { const i = (y * 16 + x) * 4; const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]]; return r > 200 && g < 60 && b < 60 ? "red" : b > 150 && g < 100 ? "blue" : g > 100 && b < 100 ? "green" : "other"; };
    };
    it("clears the cropped strips to transparent and keeps the rest", () => {
      const at = frame({ crop: { left: 0.25, bottom: 0.5 } });
      expect(at(1, 1)).toBe("red");   // left strip, x 0..3
      expect(at(3, 2)).toBe("red");     // the strip is 4 px wide, not 2
      expect(at(4, 2)).toBe("green");
      expect(at(2, 6)).toBe("red");
      expect(at(5, 1)).toBe("green");   // inside the crop, left half of the picture
      expect(at(12, 2)).toBe("blue");
      expect(at(5, 6)).toBe("red");   // bottom half cleared, y 4..7
      expect(at(12, 5)).toBe("red");
    });
    it("turns a quarter clockwise after fitting to the swapped box", () => {
      // The picture fits 8x16 as an 8x4 strip, then turns into a 4x8 column centred at x 6..9, with green (was left) on top.
      const at = frame({ transform: { rotation: 90 } });
      expect(at(7, 1)).toBe("green");
      expect(at(7, 6)).toBe("blue");
      expect(at(2, 4)).toBe("red");
      expect(at(13, 4)).toBe("red");
      const back = frame({ transform: { rotation: -90 } });
      expect(back(7, 1)).toBe("blue");
      expect(back(7, 6)).toBe("green");
    });
    it("swaps the picture's sides on a half turn and leaves transparent corners on a free angle", () => {
      const half = frame({ transform: { rotation: 180 } });
      expect(half(2, 3)).toBe("blue");
      expect(half(13, 3)).toBe("green");
      // 45 degrees clockwise about the centre of a 16x8 box: the top-right and bottom-left corners leave the turned picture, the
      // top-left one stays inside it (a counter-clockwise turn would swap which corners are covered).
      const free = frame({ transform: { rotation: 45 } });
      expect(free(15, 0)).toBe("red");
      expect(free(0, 7)).toBe("red");
      expect(free(0, 0)).toBe("green");
      expect(free(7, 3)).toBe("green");
      expect(free(8, 4)).toBe("blue");
    });
    it("rotates the cropped picture, not the crop box", () => {
      // Crop the left (green) half away, then half-turn: what remains was the right half, now on the left.
      const at = frame({ crop: { left: 0.5 }, transform: { rotation: 180 } });
      expect(at(3, 3)).toBe("blue");
      expect(at(12, 3)).toBe("red");
    });
    it("flips a half turn vertically as well as horizontally", () => {
      // A source that is green on top and blue below (the halves source is symmetric top to bottom, so it cannot tell a missing vflip).
      const stacked = "color=green:s=16x8:r=30:d=1,format=rgba,drawbox=x=0:y=4:w=16:h=4:color=blue:t=fill:replace=1";
      const at = frame({ transform: { rotation: 180 } }, stacked);
      expect([at(8, 1), at(8, 6)]).toEqual(["blue", "green"]);
    });
    it("keeps the mask upright while the cropped picture turns under it", () => {
      // Crop 25% off the left, then half-turn: the cleared strip ends up on the right and the picture's own halves swap. The mask keeps
      // only the right half of the canvas. Mask turning with the picture would show blue on the left; crop applied after the turn would
      // leave green at x 12..15 instead of the cleared strip.
      const at = frame({ crop: { left: 0.25 }, transform: { rotation: 180 }, mask: { shape: "rect", x: 0.5, y: 0, w: 0.5, h: 1 } });
      expect(at(5, 3)).toBe("red");     // masked out: the base shows
      expect(at(9, 3)).toBe("green");   // inside the mask, the turned picture's cropped-left half
      expect(at(14, 3)).toBe("red");    // inside the mask, but the cropped strip is transparent
    });
  });
  it("moves an upper track along its keyed x position frame by frame", () => {
    // 16x8 canvas; the red clip is a 4x2 box (scale 0.25) whose centre travels from x=-4 to x=+4 over 30 frames.
    const project = createProject({ title: "keyed", fps: 30, width: 16, height: 8 });
    const items: VideoItem[] = [{ id: "base", assetId: "a", start: 0, duration: 30, sourceIn: 0 },
      { id: "pip", assetId: "b", start: 0, duration: 30, sourceIn: 0, transform: { scale: 0.25 }, keyframes: { x: [{ t: 0, v: -4 }, { t: 1, v: 4 }] } }];
    project.assets = { a: { id: "a", kind: "video", path: "a.mp4" }, b: { id: "b", kind: "video", path: "b.mp4" } };
    project.tracks = [{ id: "v1", kind: "video", name: "V1", items: [items[0]] }, { id: "v2", kind: "video", name: "V2", items: [items[1]] }];
    const probes = Object.fromEntries(["a", "b"].map(id => [id, { kind: "video" as const, path: `${id}.mp4`, fingerprint: "x", width: 16, height: 8, fps: 30, duration: 4, audio: false }]));
    const plan = planLayeredExport(project, probes), filters: string[] = [];
    const { videoLabel } = makeVideoChain(plan, filters, 0);
    const pixels = ffmpeg(["-f", "lavfi", "-i", "color=white:s=16x8:r=30:d=1.2", "-f", "lavfi", "-i", "color=red:s=16x8:r=30:d=1.2", "-filter_complex", filters.join(";"), "-map", `[${videoLabel}]`, "-frames:v", "30", "-threads", "2", "-pix_fmt", "rgba", "-f", "rawvideo", "-"]);
    const redColumns = (frame: number) => { const found: number[] = []; for (let x = 0; x < 16; x++) { const at = frame * 16 * 8 * 4 + (4 * 16 + x) * 4; if (pixels[at + 1] < 100) found.push(x); } return found; };
    // centre at 8 + x(frame); the box is 4 wide, so its left edge is centre - 2
    for (const frame of [0, 10, 20, 29]) {
      const left = Math.round(8 + (-4 + 8 * frame / 30) - 2), columns = redColumns(frame);
      expect(columns[0]).toBe(left); expect(columns.length).toBe(4);
    }
  });
  describe("wipe, slide, push and zoom transitions", () => {
    // 16x8 canvas, 30 fps. The first clip is white on top and blue below (so a shift shows), the second is red with a green left edge; the 12-frame
    // transition is centred on the cut at frame 30, so frame 30 is halfway.
    const render = (kind: "wipe" | "slide" | "push" | "zoom", direction: "left" | "right" | "up" | "down", incoming: Partial<VideoItem> = {}) => {
      const project = createProject({ title: "transition", fps: 30, width: 16, height: 8 });
      const items: VideoItem[] = [{ id: "first", assetId: "a", start: 0, duration: 30, sourceIn: 1, transition: { kind, duration: 12, direction } },
        { id: "second", assetId: "b", start: 30, duration: 30, sourceIn: 1, ...incoming }];
      project.assets = { a: { id: "a", kind: "video", path: "a.mp4" }, b: { id: "b", kind: "video", path: "b.mp4" } };
      project.tracks = [{ id: "video", kind: "video", name: "Video", items }];
      const probes = Object.fromEntries(["a", "b"].map(id => [id, { kind: "video" as const, path: `${id}.mp4`, fingerprint: "x", width: 16, height: 8, fps: 30, duration: 4, audio: false }]));
      const plan = planLayeredExport(project, probes), filters: string[] = [], inputs: string[] = [];
      for (const segment of plan.video) inputs.push("-f", "lavfi", "-i", segment.item.assetId === "a" ? "color=white:s=16x8:r=30:d=3,drawbox=y=4:w=16:h=4:color=blue:t=fill" : "color=red:s=16x8:r=30:d=3,drawbox=x=0:w=1:h=8:color=green:t=fill");
      const { videoLabel } = makeVideoChain(plan, filters, 0);
      const pixels = ffmpeg([...inputs, "-filter_complex", filters.join(";"), "-map", `[${videoLabel}]`, "-frames:v", "60", "-threads", "2", "-pix_fmt", "rgba", "-f", "rawvideo", "-"]);
      const raw = (frame: number, x: number, y: number) => { const at = frame * 16 * 8 * 4 + (y * 16 + x) * 4; return [pixels[at], pixels[at + 1], pixels[at + 2]]; };
      return Object.assign((frame: number, x: number, y: number) => {
        const [r, g, b] = raw(frame, x, y);
        return r < 100 && g > 100 && b < 100 ? "green" : r > 200 && g < 100 && b < 100 ? "red" : r > 200 && g > 200 && b > 200 ? "white" : r < 100 && g < 100 && b > 200 ? "blue" : `rgb(${r},${g},${b})`;
      }, { raw });
    };
    it("applies the incoming clip's own rotation and crop under a transition", () => {
      // Half turn: the red clip's green left stripe lands on the right edge once the wipe has finished, and the wipe still enters from the left.
      const wipe = render("wipe", "left", { transform: { rotation: 180 } });
      expect([wipe(40, 0, 1), wipe(40, 15, 1), wipe(40, 8, 1)]).toEqual(["red", "green", "red"]);
      expect([wipe(30, 3, 1), wipe(30, 12, 1), wipe(30, 12, 6)]).toEqual(["red", "white", "blue"]);   // revealed left half, outgoing right half untouched
      // Crop 25% off the left of the sliding clip: the strip is transparent (the black background shows once the outgoing clip is gone).
      const slide = render("slide", "left", { crop: { left: 0.25 } });
      expect([slide(40, 1, 1), slide(40, 5, 1), slide(40, 14, 1)]).toEqual(["rgb(0,0,0)", "red", "red"]);
      // Quarter turn under a zoom: after the zoom settles the turned 4x8 column is centred and the sides are background.
      const zoom = render("zoom", "left", { transform: { rotation: 90 } });
      expect([zoom(40, 8, 4), zoom(40, 1, 4), zoom(40, 14, 4)]).toEqual(["red", "rgb(0,0,0)", "rgb(0,0,0)"]);
    });
    it("slides the incoming clip in from the entry side while the outgoing one stays put", () => {
      const at = render("slide", "left");
      expect([at(20, 8, 1), at(20, 8, 6), at(40, 8, 1)]).toEqual(["white", "blue", "red"]);   // before, before, after the window
      // halfway the red clip covers the left half: it entered from the left; the right half still shows the unmoved outgoing clip
      expect([at(30, 3, 1), at(30, 3, 6), at(30, 12, 1), at(30, 12, 6)]).toEqual(["red", "red", "white", "blue"]);
    });
    it("wipes the incoming clip in from the entry side, leaving the outgoing clip untouched", () => {
      const left = render("wipe", "left"), down = render("wipe", "down");
      expect([left(20, 8, 1), left(40, 8, 1), left(40, 15, 6)]).toEqual(["white", "red", "red"]);
      // halfway the revealed part is the entry half of the frame and the outgoing clip is exactly where it was
      expect([left(30, 3, 1), left(30, 3, 6), left(30, 12, 1), left(30, 12, 6)]).toEqual(["red", "red", "white", "blue"]);
      expect([down(30, 8, 1), down(30, 8, 6), down(30, 15, 1), down(30, 15, 6)]).toEqual(["white", "red", "white", "red"]);
    });
    it("also pushes the outgoing clip away", () => {
      // entering from above: halfway the red clip fills the top half; below it a slide shows the outgoing clip's own bottom (blue),
      // while a push has moved the outgoing clip down by half a frame so its top (white) is showing there
      expect([render("slide", "up")(30, 8, 1), render("slide", "up")(30, 8, 6)]).toEqual(["red", "blue"]);
      expect([render("push", "up")(30, 8, 1), render("push", "up")(30, 8, 6)]).toEqual(["red", "white"]);
    });
    it("zooms the incoming clip down to full size while it fades in, and settles on it", () => {
      const at = render("zoom", "left");
      expect([at(20, 8, 1), at(40, 0, 1), at(40, 8, 1), at(40, 15, 7)]).toEqual(["white", "green", "red", "red"]);
      // halfway the picture is 1.125x and centred, so the left edge (the green stripe, two pixels wide after 4:2:0 chroma) is pushed one
      // pixel off the frame: column 0 is still stripe, column 1 is mostly red. Without the zoom the two columns would look the same.
      expect(at.raw(30, 1, 1)[0] - at.raw(30, 0, 1)[0]).toBeGreaterThan(50);
    });
  });
  it("darkens a dip once and preserves transparent letterboxing", () => {
    const plan: LayeredPlan = {
      from: 0, to: 36, fps: 30, width: 4, height: 2, background: "#123456", audio: [], windows: [],
      video: [{ item: { id: "clip", assetId: "a", start: 0, duration: 36, sourceIn: 0, fit: "contain", fadeIn: 6 },
        start: 0, duration: 36, sourceIn: 0, lead: 0, tail: 0, renderStart: 0, renderEnd: 36, decodeStart: 0, videoAudio: false,
        incoming: undefined, outgoing: { kind: "dip", before: 9, after: 9, direction: "left" } }],
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

  it("leaves audio with jittery packet timestamps continuous instead of inserting silence", () => {
    // DJI AAC wobbles up to ~21 ms around its 1024-sample grid; model it as a sawtooth on each 1024-sample frame.
    const samples = ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-filter_complex", `[0:a]asetpts=PTS+0.021*mod(N\\,40)/40/TB,${audioClipFilters(30, 30)}[a]`, "-map", "[a]", "-ac", "1", "-f", "f32le", "-"]);
    const pcm = new Float32Array(samples.buffer, samples.byteOffset, samples.length / 4);
    expect(pcm.length).toBe(48000);
    // A pure tone has a tiny second difference; an inserted-silence seam or dropped run is orders of magnitude larger.
    let worst = 0, zeroRun = 0, longestZeroRun = 0;
    for (let i = 2; i < pcm.length; i++) {
      worst = Math.max(worst, Math.abs(pcm[i] - 2 * pcm[i - 1] + pcm[i - 2]));
      zeroRun = Math.abs(pcm[i]) < 1e-6 ? zeroRun + 1 : 0;
      longestZeroRun = Math.max(longestZeroRun, zeroRun);
    }
    expect(worst).toBeLessThan(0.01);
    expect(longestZeroRun).toBeLessThan(100);
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
