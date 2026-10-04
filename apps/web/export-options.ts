/** Shared by export controls and the HTTP boundary; legacy master remains accepted by the API. */
export const EXPORT_OPTIONS = [
  { value: "draft", label: "Draft · faster" },
  { value: "h264-cpu", label: "H.264 · CPU" },
  { value: "h264-hardware", label: "H.264 · Hardware" },
  { value: "h265-hardware", label: "H.265 · Hardware" },
] as const;

export type ExportPreset = typeof EXPORT_OPTIONS[number]["value"];
export function exportLabel(preset: string) {
  return EXPORT_OPTIONS.find((option) => option.value === preset)?.label ?? preset;
}

export function isExportPreset(value: unknown): value is ExportPreset | "master" {
  return value === "master" || EXPORT_OPTIONS.some((option) => option.value === value);
}
