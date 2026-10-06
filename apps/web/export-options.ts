/** Shared by export controls and the HTTP boundary; legacy master remains accepted by the API. */
export const EXPORT_OPTIONS = [
  // "auto" names no preset: the server then picks what the CLI and MCP pick (hardware H.264 on macOS with VideoToolbox, else the software master).
  { value: "auto", label: "Auto · recommended" },
  { value: "draft", label: "Draft · faster" },
  { value: "h264-cpu", label: "H.264 · CPU" },
  { value: "h264-hardware", label: "H.264 · Hardware" },
  { value: "h265-hardware", label: "H.265 · Hardware" },
] as const;

export type ExportPreset = typeof EXPORT_OPTIONS[number]["value"];
export function exportLabel(preset: string) {
  // A running auto job reports "default" until the render settles on the preset it used.
  if (preset === "default") return EXPORT_OPTIONS[0].label;
  return EXPORT_OPTIONS.find((option) => option.value === preset)?.label ?? preset;
}

export function isExportPreset(value: unknown): value is ExportPreset | "master" {
  return value === "master" || EXPORT_OPTIONS.some((option) => option.value === value);
}

/** One line saying which route an export took, and why when it is the slower Remotion one. */
export function exportRouteNote(job: { pipelineUsed?: "layered" | "remotion"; fallbackReason?: string }) {
  if (job.fallbackReason) return `Slower Remotion route: ${job.fallbackReason.replace(/^layered export unsupported: /, "")}`;
  if (job.pipelineUsed === "layered") return "Fast route";
  return undefined;
}
