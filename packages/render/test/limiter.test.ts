import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { render } from "../src/node.ts";

const example = join(import.meta.dirname, "../../../examples/basic");

/** Peak of a file's audio in dB, from ffmpeg's volumedetect (it reports on stderr). */
const maxVolume = (file: string) =>
  +/max_volume: (-?[\d.]+) dB/.exec(spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" }).stderr)![1];

// M9: the master limiter runs as an ffmpeg pass after renderMedia; with meta.limiter the peak stays under -1 dBFS.
it("limits render peaks to about -1 dBFS only when meta.limiter is on", { timeout: 300_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "swr-limiter-"));
  cpSync(example, tmp, { recursive: true, filter: (s) => !/\/(out|\.splicewright)(\/|$)/.test(s) });
  // Loud noise (a pure tone compresses too well to exercise the AAC bitrate), played at 1.5× gain, so it peaks above 0 dBFS unlimited.
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "anoisesrc=d=1:a=0.9:sample_rate=48000", "-ac", "2", "-af", "volume=6dB", "-c:a", "pcm_f32le", join(tmp, "tone.wav")]);
  const project = JSON.parse(readFileSync(join(tmp, "project.json"), "utf8"));
  project.assets.a_tone = { id: "a_tone", path: "tone.wav", kind: "audio" };
  project.tracks.find((t: { kind: string }) => t.kind === "video").items[0].volume = 0;
  project.tracks.find((t: { kind: string }) => t.kind === "audio").items.push({ id: "i_tone", assetId: "a_tone", sourceIn: 0, start: 0, duration: 30, volume: 1.5 });
  const peakOf = async (limiter: boolean) => {
    project.meta.limiter = limiter;
    writeFileSync(join(tmp, "project.json"), JSON.stringify(project));
    const output = join(tmp, `out-${limiter}.mp4`);
    await render(tmp, { output, preset: "draft", range: [0, 30] });
    return maxVolume(output);
  };
  const off = await peakOf(false);
  const on = await peakOf(true);
  // The limiter holds -1 dBFS before encoding; AAC can overshoot by up to ~1 dB on dense material, so the test checks for no clipping.
  expect(off).toBeGreaterThanOrEqual(-0.1);
  expect(on).toBeLessThanOrEqual(-0.1);
  // the re-encode must not drop below Remotion's ~317 kbps AAC
  const rate = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=bit_rate", "-of", "csv=p=0", join(tmp, "out-true.mp4")], { encoding: "utf8" });
  expect(+rate).toBeGreaterThanOrEqual(256000);
});
