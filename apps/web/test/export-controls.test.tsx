import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ExportControls } from "../src/ExportControls.tsx";
import { EXPORT_OPTIONS, exportLabel, isExportPreset } from "../export-options.ts";

it("offers Auto first, the three explicit encoder modes, and keeps Draft", () => {
  const markup = renderToStaticMarkup(<ExportControls preset="h264-cpu" onChange={() => {}} onRender={() => {}} />);
  expect(markup).toContain('aria-label="Export preset"');
  for (const option of EXPORT_OPTIONS) expect(markup).toContain(`value="${option.value}"`);
  expect(markup).toContain('value="h264-cpu" selected=""');
  expect(markup).toContain("H.265 · Hardware");
  expect(EXPORT_OPTIONS[0].value).toBe("auto");
  expect(exportLabel("default")).toBe("Auto · recommended");
  expect(isExportPreset("master")).toBe(true);
  expect(isExportPreset({ preset: "h264-cpu" })).toBe(false);
});

it.each(["auto", "h264-cpu", "h264-hardware", "h265-hardware"] as const)("sends %s without changing it", async (preset) => {
  const request = vi.fn(async () => ({ ok: true, json: async () => ({ id: preset, status: "running", preset, output: `${preset}.mp4` }) }));
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("location", { hash: "" });
  const { app, startExport } = await import("../src/store.ts");
  app.set({ exports: [] });
  try {
    await startExport(preset);
    expect(request).toHaveBeenCalledWith("/api/export", expect.objectContaining({ body: JSON.stringify({ preset }) }));
    expect(app.get().exports[0].preset).toBe(preset);
  } finally { vi.unstubAllGlobals(); }
});
