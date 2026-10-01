export type PanelLayout = { bin: number; inspector: number; timeline: number };

export const DEFAULT_LAYOUT: PanelLayout = { bin: 220, inspector: 260, timeline: 260 };

export function constrainLayout(layout: PanelLayout, width: number, height: number): PanelLayout {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  const bin = Number.isFinite(layout.bin) ? layout.bin : DEFAULT_LAYOUT.bin;
  const inspector = Number.isFinite(layout.inspector) ? layout.inspector : DEFAULT_LAYOUT.inspector;
  const timeline = Number.isFinite(layout.timeline) ? layout.timeline : DEFAULT_LAYOUT.timeline;
  return {
    bin: Math.round(Math.max(Math.min(150, safeWidth * 0.28), Math.min(bin, safeWidth * 0.28))),
    inspector: Math.round(Math.max(Math.min(200, safeWidth * 0.34), Math.min(inspector, safeWidth * 0.34))),
    timeline: Math.round(Math.max(Math.min(140, safeHeight * 0.48), Math.min(timeline, safeHeight * 0.48))),
  };
}

export function numericLimit(raw: string, min: number, max: number): number | null {
  if (!raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : null;
}
