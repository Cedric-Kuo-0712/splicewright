import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { init, loadCtx, readAssets, run } from "@splicewright/core/node";
import { ingest, measureFinalMix } from "../src/index.ts";

function project() {
  const dir = mkdtempSync(join(tmpdir(), "swr-source-health-"));
  init(dir, { title: "source health", fps: 30, width: 32, height: 18 });
  mkdirSync(join(dir, "raw"));
  return dir;
}

function media(dir: string, name: string, args: string[]) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, join(dir, "raw", name)]);
}

function importAsset(dir: string, path: string) {
  const result = run(dir, "importAsset", { path });
  if ("error" in result) throw new Error(result.error.message);
}

describe("source health ingest", () => {
  it("full-decodes video and audio, measures peaks, caches by source fingerprint, and measures final output", async () => {
    const dir = project();
    try {
      media(dir, "av.mkv", [
        "-f", "lavfi", "-i", "testsrc=size=32x18:rate=8:duration=1",
        "-f", "lavfi", "-i", "aevalsrc=0.5*sin(2*PI*440*t):s=48000:d=1",
        "-shortest", "-c:v", "mpeg4", "-c:a", "pcm_s16le",
      ]);
      importAsset(dir, "raw/av.mkv");
      const first = await ingest(dir, { only: ["sourceHealth"] });
      expect(first.errors).toBeUndefined();
      expect(first.steps.sourceHealth).toMatchObject({ ran: 1, failed: 0 });
      const stored = readAssets(dir).a_av.sourceHealth!;
      expect(stored).toMatchObject({ format: 1, method: "ffmpeg", path: "raw/av.mkv", fingerprint: readAssets(dir).a_av.fingerprint, decode: { status: "ok" }, audio: { status: "measured" } });
      if (stored.audio.status !== "measured") throw new Error("expected measured audio");
      expect(stored.audio.samplePeak.dbfs).toBeLessThan(-4);
      expect(stored.audio.truePeak.dbfs).toBeLessThan(-4);
      expect(stored.audio.truePeak.atSeconds).toEqual(expect.any(Number));
      expect((await ingest(dir, { only: ["sourceHealth"] })).steps.sourceHealth).toMatchObject({ cached: 1, ran: 0 });

      const final = await measureFinalMix(join(dir, "raw/av.mkv"));
      expect(final).toMatchObject({ decoded: true, audio: { status: "measured" } });
      media(dir, "av.mkv", [
        "-f", "lavfi", "-i", "testsrc=size=32x18:rate=8:duration=1",
        "-f", "lavfi", "-i", "aevalsrc=0.25*sin(2*PI*440*t):s=48000:d=1",
        "-shortest", "-c:v", "mpeg4", "-c:a", "pcm_s16le",
      ]);
      expect(loadCtx(dir).sourceHealth.a_av).toBeUndefined();
      expect((await ingest(dir, { only: ["sourceHealth"] })).steps.sourceHealth).toMatchObject({ ran: 1, cached: 0 });
      expect(readAssets(dir).a_av.sourceHealth?.fingerprint).toBe(readAssets(dir).a_av.fingerprint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("distinguishes silent audio from no audio and persists decode failures", async () => {
    const dir = project();
    try {
      media(dir, "silence.wav", ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=0.5", "-c:a", "pcm_s16le"]);
      media(dir, "video.mkv", ["-f", "lavfi", "-i", "testsrc=size=32x18:rate=8:duration=0.5", "-c:v", "mpeg4"]);
      writeFileSync(join(dir, "raw/broken.mkv"), "this is not a decodable media stream\n");
      for (const path of ["raw/silence.wav", "raw/video.mkv", "raw/broken.mkv"]) importAsset(dir, path);

      const result = await ingest(dir, { only: ["sourceHealth"] });
      expect(result.steps.sourceHealth).toMatchObject({ ran: 2, failed: 1 });
      const assets = readAssets(dir);
      expect(assets.a_silence.sourceHealth).toMatchObject({ decode: { status: "ok" }, audio: { status: "measured", integratedLufs: null, samplePeak: { dbfs: null }, truePeak: { dbfs: null } } });
      expect(assets.a_video.sourceHealth).toMatchObject({ decode: { status: "ok" }, audio: { status: "none" } });
      expect(assets.a_broken.sourceHealth).toMatchObject({ method: "ffprobe", decode: { status: "failed" }, audio: { status: "unmeasured" } });
      expect(loadCtx(dir).sourceHealth.a_broken).toBeDefined();
      const repeated = await ingest(dir, { only: ["sourceHealth"] });
      expect(repeated.errors).toEqual(expect.arrayContaining([expect.stringContaining("cached probe failure")]));
      expect(repeated.steps.probe.failed).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

it("measures a non-silent stream shorter than an ebur128 metadata block", async () => {
  const dir = project();
  try {
    media(dir, "short.wav", ["-f", "lavfi", "-i", "aevalsrc=1.1*sin(2*PI*440*t):s=48000:d=0.02", "-c:a", "pcm_f32le"]);
    const result = await measureFinalMix(join(dir, "raw/short.wav"));
    expect(result.audio.status).toBe("measured");
    if (result.audio.status === "measured") {
      expect(result.audio.samplePeak.dbfs).toBeGreaterThan(0);
      expect(result.audio.truePeak.dbfs).toBeGreaterThan(0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("refuses sources missing the stream required by their declared media kind", async () => {
  const dir = project();
  try {
    media(dir, "audio-only.mp4", ["-f", "lavfi", "-i", "sine=duration=0.1", "-c:a", "aac"]);
    media(dir, "video-only.wav", ["-f", "lavfi", "-i", "color=s=32x18:d=0.1", "-c:v", "ffv1", "-f", "matroska"]);
    importAsset(dir, "raw/audio-only.mp4"); importAsset(dir, "raw/video-only.wav");
    const result = await ingest(dir, { only: ["sourceHealth"] });
    expect(result.steps.probe.failed).toBe(2);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("no readable visual stream"), expect.stringContaining("no readable audio stream")]));
    for (const asset of Object.values(readAssets(dir))) expect(asset.sourceHealth?.decode.status).toBe("failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
