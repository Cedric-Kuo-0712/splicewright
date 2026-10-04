import { describe, expect, it } from "vitest";
import { BUILTIN_PRESETS, resolveExportPreset, withExportContainerTag } from "../src/export-preset.ts";

const fullHd30 = { width: 1920, height: 1080, fps: 30 };

describe("export preset resolution", () => {
  it("tags only HEVC MP4 output before the output argument without re-encoding", () => {
    const args = ["-c:v", "copy", "output.mp4"];
    expect(withExportContainerTag(args, "h265", "output.mp4")).toEqual(["-c:v", "copy", "-tag:v", "hvc1", "output.mp4"]);
    expect(withExportContainerTag(args, "h265", "output.mov")).toEqual(args);
    expect(withExportContainerTag(args, "h264", "output.mp4")).toBe(args);
    expect(withExportContainerTag(args, "h265", "output.mkv")).toBe(args);
  });
  it("preserves replacement semantics for legacy and custom presets", () => {
    expect(resolveExportPreset("draft", { draft: { crf: 20 } }, fullHd30)).toEqual({ crf: 20 });
    expect(resolveExportPreset("master", { master: { videoBitrate: "8M" } }, fullHd30)).toEqual({ videoBitrate: "8M" });
    // Legacy if-possible + CRF keeps Remotion's existing software-fallback behavior.
    expect(resolveExportPreset("master", { master: { crf: 18, hardwareAcceleration: "if-possible" } }, fullHd30)).toEqual({ crf: 18, hardwareAcceleration: "if-possible" });
    expect(resolveExportPreset("custom", { custom: { codec: "h265", videoBitrate: "10M" } }, fullHd30)).toEqual({ codec: "h265", videoBitrate: "10M" });
  });

  it("keeps explicit modes when optional override fields are undefined", () => {
    expect(resolveExportPreset("h265-hardware", { "h265-hardware": { codec: undefined, hardwareAcceleration: undefined, videoBitrate: undefined } }, fullHd30)).toEqual({ codec: "h265", hardwareAcceleration: "required", videoBitrate: "12M" });
  });

  it("accepts explicit CPU bitrate without inheriting CRF and rejects contradictory quality settings", () => {
    expect(resolveExportPreset("h264-cpu", { "h264-cpu": { videoBitrate: "8M" } }, fullHd30)).toEqual({ codec: "h264", hardwareAcceleration: "disable", videoBitrate: "8M" });
    expect(() => resolveExportPreset("custom", { custom: { crf: 18, videoBitrate: "8M" } }, fullHd30)).toThrow(/cannot combine crf with videoBitrate/);
  });
  it("keeps draft and master compatible and exposes the three explicit modes", () => {
    expect(BUILTIN_PRESETS.draft).toMatchObject({ scale: 0.5, crf: 28 });
    expect(BUILTIN_PRESETS.master).toMatchObject({ crf: 18 });
    expect(resolveExportPreset("h264-cpu", undefined, fullHd30)).toMatchObject({
      codec: "h264",
      hardwareAcceleration: "disable",
      crf: 18,
    });
    const h264 = resolveExportPreset("h264-hardware", undefined, fullHd30);
    expect(h264).toMatchObject({
      codec: "h264",
      hardwareAcceleration: "required",
      videoBitrate: "20M",
    });
    expect(h264).not.toHaveProperty("crf");
    const h265 = resolveExportPreset("h265-hardware", undefined, fullHd30);
    expect(h265).toMatchObject({
      codec: "h265",
      hardwareAcceleration: "required",
      videoBitrate: "12M",
    });
    expect(h265).not.toHaveProperty("crf");
  });

  it("scales hardware bitrate with pixels and frame rate, rounding to positive megabits", () => {
    expect(resolveExportPreset("h264-hardware", undefined, { width: 1280, height: 720, fps: 30 }).videoBitrate).toBe("9M");
    expect(resolveExportPreset("h264-hardware", undefined, { width: 1920, height: 1080, fps: 60 }).videoBitrate).toBe("40M");
    expect(resolveExportPreset("h265-hardware", undefined, { width: 320, height: 180, fps: 24 }).videoBitrate).toBe("1M");
  });

  it("uses effective pixels for scaled hardware presets while preserving explicit bitrate", () => {
    expect(resolveExportPreset("h264-hardware", { "h264-hardware": { scale: 0.5 } }, fullHd30).videoBitrate).toBe("5M");
    expect(resolveExportPreset("h265-hardware", { "h265-hardware": { scale: 0.5 } }, fullHd30).videoBitrate).toBe("3M");
    expect(resolveExportPreset("h264-hardware", { "h264-hardware": { scale: 2 } }, fullHd30).videoBitrate).toBe("80M");
    expect(resolveExportPreset("h265-hardware", { "h265-hardware": { scale: 0.1 } }, fullHd30).videoBitrate).toBe("1M");
    expect(resolveExportPreset("h264-hardware", { "h264-hardware": { scale: undefined } }, fullHd30).videoBitrate).toBe("20M");
    expect(resolveExportPreset("h264-hardware", { "h264-hardware": { scale: 0.5, videoBitrate: "8M" } }, fullHd30).videoBitrate).toBe("8M");
  });

  it("accepts project bitrate and CPU CRF overrides", () => {
    expect(resolveExportPreset("h264-hardware", { "h264-hardware": { videoBitrate: "26M" } }, fullHd30).videoBitrate).toBe("26M");
    expect(resolveExportPreset("h264-cpu", { "h264-cpu": { crf: 20 } }, fullHd30)).toMatchObject({
      codec: "h264",
      hardwareAcceleration: "disable",
      crf: 20,
    });
    expect(resolveExportPreset("custom", { custom: { videoBitrate: "8M" } }, fullHd30).videoBitrate).toBe("8M");
  });

  it("rejects CRF on hardware and project overrides that contradict an explicit mode", () => {
    expect(() => resolveExportPreset("h264-hardware", { "h264-hardware": { crf: 18 } }, fullHd30))
      .toThrow(/cannot combine crf with hardwareAcceleration/);
    expect(() => resolveExportPreset("h265-hardware", { "h265-hardware": { hardwareAcceleration: "disable" } }, fullHd30))
      .toThrow(/requires hardwareAcceleration required/);
    expect(() => resolveExportPreset("h264-cpu", { "h264-cpu": { codec: "h265" } }, fullHd30))
      .toThrow(/requires codec h264/);
    expect(() => resolveExportPreset("missing", undefined, fullHd30)).toThrow(/unknown preset "missing"/);
  });
});
