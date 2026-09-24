import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { beatFrames, type AudioItem } from "@splicewright/core";
import { load, readAssets, run } from "@splicewright/core/node";
import { ingest, peek } from "../src/index.ts";

const example = join(import.meta.dirname, "../../../examples/basic");
const venv = join(import.meta.dirname, "../../../ingest/.venv/bin/python");
const hasLibrosa = spawnSync(process.env.SPLICEWRIGHT_PYTHON ?? (existsSync(venv) ? venv : "python3"), ["-c", "import librosa"]).status === 0;

function project() {
  const dir = join(mkdtempSync(join(tmpdir(), "swr-ingest-")), "p");
  cpSync(example, dir, { recursive: true, filter: (f) => !f.includes(".splicewright") && !f.includes("/out") });
  return dir;
}

describe("ingest", () => {
  it("probes, builds ffmpeg caches, and skips unchanged assets", async () => {
    const dir = project();
    const only = ["proxy", "thumbs", "waveform"] as const;
    const first = await ingest(dir, { only: [...only] });
    expect(first.errors).toBeUndefined();
    expect(first.steps.proxy).toMatchObject({ ran: 1 });
    const probe = readAssets(dir).a_clip;
    expect(probe).toMatchObject({ kind: "video", duration: 2, width: 320, height: 180, fps: 30 });
    for (const f of ["proxies/edit/a_clip.mp4", "thumbs/a_clip/1.jpg", "contact-sheets/a_clip.jpg"]) expect(existsSync(join(dir, ".splicewright", f))).toBe(true);

    const again = await ingest(dir, { only: [...only] });
    expect(again.steps).toMatchObject({ probe: { ran: 0, cached: 1 }, proxy: { ran: 0, cached: 1 }, thumbs: { cached: 1 } });
    // insertItem can now default the duration from the probe.
    expect(run(dir, "insertItem", { assetId: "a_clip", at: 500 })).toMatchObject({ changes: { summary: expect.stringContaining("(60f)") } });
  }, 60_000);

  it("peek reads the analysis proxy when spacing allows, else the source, and reports shown times", async () => {
    const dir = project();
    const before = await peek(dir, "a_clip", { n: 2 }); // no proxy yet
    expect(before).toMatchObject({ source: "source", times: [0.5, 1.5] });
    await ingest(dir, { only: ["analysis"] });
    expect(await peek(dir, "a_clip", { n: 2 })).toMatchObject({ source: "analysis proxy", times: [0, 1] }); // 1 fps frames
    expect(await peek(dir, "a_clip", { n: 4 })).toMatchObject({ source: "source", times: [0.25, 0.75, 1.25, 1.75] });
    expect(before.image.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG
    await expect(peek(dir, "a_clip", { from: 3 })).rejects.toThrow("empty range");
  }, 30_000);

  it("re-points a moved file by fingerprint instead of importing it twice", async () => {
    const dir = project();
    await ingest(dir, { only: [] });
    renameSync(join(dir, "clip.mp4"), join(dir, "moved.mp4"));
    expect(run(dir, "importAsset", { path: "moved.mp4" })).toMatchObject({ changes: { summary: "re-pointed a_clip from clip.mp4 (missing) to moved.mp4" } });
    expect(Object.keys(load(dir).assets)).toEqual(["a_clip"]);
  }, 30_000);

  // §15.5: 120 BPM clicks starting at 0.25 s, accent every 4th; beats within ±1 frame, downbeats on accents.
  it.skipIf(!hasLibrosa)("detects a synthetic click track within one frame", async () => {
    const dir = project();
    const expr =
      "gte(t,0.25)*exp(-mod(t-0.25,0.5)*60)*if(eq(mod(floor((t-0.25)/0.5),4),0),0.9*sin(2*PI*80*t)+0.3*sin(2*PI*2000*t),0.5*sin(2*PI*1500*t))";
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", `aevalsrc='${expr}':s=44100:d=20`, "-c:a", "aac", join(dir, "click.m4a")]);
    run(dir, "importAsset", { path: "click.m4a" });
    const r = await ingest(dir, { only: ["beats"] });
    expect(r.errors).toBeUndefined();
    const analysis = JSON.parse(readFileSync(join(dir, ".splicewright/beats/a_click.json"), "utf8"));
    const fps = load(dir).meta.fps;
    const truth = Array.from({ length: 40 }, (_, k) => 0.25 + k * 0.5);
    const beats: number[] = analysis.beats.map((b: { t: number }) => b.t);
    expect(beats.length).toBe(40);
    for (const t of beats) expect(Math.min(...truth.map((x) => Math.abs(x - t))) * fps).toBeLessThanOrEqual(1);
    for (const t of analysis.downbeats) expect(Math.round((t - 0.25) / 0.5) % 4).toBe(0);
    expect(analysis.tempo).toBeCloseTo(120, 0);

    // And through the ops: detectBeats puts them on the timeline.
    run(dir, "insertItem", { assetId: "a_click", at: 0, trackId: load(dir).tracks.find((t) => t.kind === "audio")!.id });
    const song = () => load(dir).tracks.find((t) => t.kind === "audio")!.items[0] as AudioItem;
    run(dir, "detectBeats", { itemId: song().id, density: "downbeat" });
    const item = song();
    expect(beatFrames(load(dir), item)).toEqual([8, 68, 128, 188, 248, 308, 368, 428, 488, 548]);
  }, 60_000);
});
