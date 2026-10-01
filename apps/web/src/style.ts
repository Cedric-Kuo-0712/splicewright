import { textCss, themeOf, type FontRole, type Item, type Project, type TextStyle, type Track, type VideoItem } from "@splicewright/core";

export type StyleClipboard =
  | { kind: "video"; effects: VideoItem["effects"] | null; grade?: VideoItem["grade"] | null; key?: VideoItem["key"] | null }
  | { kind: "text"; role?: unknown; textStyle?: unknown }
  | { kind: "caption"; textStyle?: unknown; highlight?: unknown };

export type StyleOperation = { op: string; args: Record<string, unknown> };
const EFFECT_KEYS = ["brightness", "contrast", "saturation", "hue", "blur", "grayscale", "sepia", "invert"] as const;

export function effectiveTextValues(project: Project, role: FontRole, style: TextStyle | undefined, raw: Record<string, unknown> = {}, text = "") {
  const css = { ...textCss(project, role, style, text), ...raw };
  const inherited = themeOf(project)?.roles[role] ?? {};
  return ([
    ["font", css.fontFamily ?? "component default", "fontFamily", "font"],
    ["weight", css.fontWeight ?? "component default", "fontWeight", "weight"],
    ["size", typeof css.fontSize === "number" ? `${css.fontSize}px` : css.fontSize ?? "component default", "fontSize", "size"],
    ["color", css.color ?? "component default", "color", "color"],
  ] as const).map(([label, value, cssKey, styleKey]) => ({
    label,
    value,
    source: Object.hasOwn(raw, cssKey) ? "raw CSS" : Object.hasOwn(style ?? {}, styleKey) ? "text override" : Object.hasOwn(inherited, styleKey) ? `${role} theme` : "renderer default",
  }));
}

export function captureStyle(track: Track, item: Item): StyleClipboard | null {
  if (track.kind === "video" && "assetId" in item) {
    const video = item as VideoItem;
    // grade.lut.assetId points into this project's assets, so a pasted style is only valid within the same project.
    return { kind: "video", effects: video.effects ? structuredClone(video.effects) : null, grade: video.grade ? structuredClone(video.grade) : null, key: video.key ? structuredClone(video.key) : null };
  }
  if (track.kind === "overlay" && "component" in item && item.component === "Text") {
    const props = item.props as { role?: unknown; textStyle?: unknown };
    return { kind: "text", role: props.role, textStyle: props.textStyle ? structuredClone(props.textStyle) : null };
  }
  if (track.kind === "caption" && "mode" in item) return { kind: "caption", textStyle: track.textStyle ? structuredClone(track.textStyle) : null, highlight: track.highlight ?? null };
  return null;
}

export function styleOperations(project: Project, selection: string[], style: StyleClipboard, wordTimedIds = new Set<string>()) {
  const operations: StyleOperation[] = [];
  let skipped = 0;
  let animated = 0;
  let noWordTiming = 0;
  const captionTracks = new Set<string>();
  const captionsWithTiming = new Set<string>();
  for (const id of selection) {
    const found = find(project, id);
    if (!found) { skipped++; continue; }
    const { track, item } = found;
    if (track.locked) { skipped++; continue; }
    if (style.kind === "video" && track.kind === "video" && "assetId" in item) {
      operations.push({ op: "setProps", args: { itemId: item.id, patch: { effects: style.effects ?? null, grade: style.grade ?? null, key: style.key ?? null } } });
      if (EFFECT_KEYS.some((key) => item.keyframes?.[key]?.length)) animated++;
      continue;
    }
    if (style.kind === "text" && track.kind === "overlay" && "component" in item && item.component === "Text") {
      const { role: _role, textStyle: _style, ...props } = item.props as Record<string, unknown>;
      if (style.role != null) props.role = style.role;
      if (style.textStyle != null) props.textStyle = structuredClone(style.textStyle);
      operations.push({ op: "setProps", args: { itemId: item.id, patch: { props } } });
      continue;
    }
    if (style.kind === "caption" && track.kind === "caption" && "mode" in item) {
      if (captionTracks.has(track.id)) continue;
      captionTracks.add(track.id);
      // Timing is supplied only after word highlighting is enabled. An anchored track must
      // remain eligible on its first application; the renderer skips missing transcript words.
      if (track.items.some((caption) => caption.mode === "anchored" || wordTimedIds.has(caption.id))) captionsWithTiming.add(track.id);
      const patch: Record<string, unknown> = { textStyle: style.textStyle ?? null };
      if (style.highlight !== "word" || captionsWithTiming.has(track.id)) patch.highlight = style.highlight ?? null;
      else noWordTiming++;
      operations.push({ op: "setTrack", args: { trackId: track.id, patch } });
      continue;
    }
    skipped++;
  }
  return { operations, skipped, animated, noWordTiming };
}

function find(project: Project, id: string): { track: Track; item: Item } | null {
  for (const track of project.tracks) {
    const item = track.items.find((candidate) => candidate.id === id);
    if (item) return { track, item };
  }
  return null;
}
