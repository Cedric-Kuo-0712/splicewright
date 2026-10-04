import React from "react";
import { EXPORT_OPTIONS, type ExportPreset } from "../export-options.ts";

export function ExportControls({ preset, onChange, onRender }: {
  preset: ExportPreset;
  onChange: (preset: ExportPreset) => void;
  onRender: () => void;
}) {
  return <div className="export-start">
    <select aria-label="Export preset" value={preset} onChange={(e) => onChange(e.target.value as ExportPreset)}>
      {EXPORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    <button onClick={onRender}>Render</button>
  </div>;
}
