// Text themes and role -> style resolution (SPEC-LOOK.md §3). Shared by the Player and the renderer, so
// preview equals render. Built-in themes are the FONT_PAIRS rows; sizes are fractions of frame height.

import { FONTS } from "./fonts.ts";
import type { Ctx, FontRole, Project, TextStyle, Theme } from "./schema.ts";
import { videoItems } from "./validate.ts";

const SIZE: Record<FontRole, number> = { title: 0.09, subtitle: 0.045, emphasis: 0.06, handwritten: 0.04 };
const NOTO = "Noto Sans TC";

// id, [title font, weight], [subtitle font, weight], [emphasis font, weight]; handwritten is always Caveat.
const ROWS: [string, [string, number], [string, number], [string, number]][] = [
  ["modern-vlog", ["Montserrat", 700], ["Inter", 400], ["Montserrat", 800]],
  ["soft-lifestyle", ["Poppins", 600], ["Lato", 400], ["Poppins", 700]],
  ["travel-cinematic", ["Bebas Neue", 400], ["Montserrat", 500], ["Bebas Neue", 400]],
  ["luxury", ["Playfair Display", 400], ["DM Sans", 400], ["Playfair Display", 700]],
  ["diary", ["Lora", 400], ["Inter", 400], ["Lora", 700]],
  ["shorts", ["Anton", 400], ["Montserrat", 700], ["Anton", 400]],
  ["zh-daily", [NOTO, 700], [NOTO, 400], [NOTO, 900]],
  ["zh-cinematic", ["Noto Serif TC", 700], [NOTO, 400], ["Noto Serif TC", 900]],
  ["zh-en-travel", ["Bebas Neue", 400], [NOTO, 400], ["Montserrat", 800]],
];

export const THEME_IDS = ROWS.map((r) => r[0]);

/** A built-in theme with px sizes for a frame `height`. */
export function builtinTheme(id: string, height: number): Theme | undefined {
  const row = ROWS.find((r) => r[0] === id);
  if (!row) return undefined;
  const [, title, subtitle, emphasis] = row;
  const at = (role: FontRole, [font, weight]: [string, number]): TextStyle => ({ font, weight, size: Math.round(SIZE[role] * height), color: "#ffffff" });
  return {
    name: id,
    roles: { title: at("title", title), subtitle: at("subtitle", subtitle), emphasis: at("emphasis", emphasis), handwritten: at("handwritten", ["Caveat", 400]) },
  };
}

/** The project's active theme: `meta.theme` looked up in `themes`, then the built-ins. */
export const themeOf = (p: Pick<Project, "meta" | "themes">): Theme | undefined =>
  p.meta.theme ? (p.themes?.[p.meta.theme] ?? builtinTheme(p.meta.theme, p.meta.height)) : undefined;

export const isTheme = (p: Pick<Project, "themes">, id: string) => THEME_IDS.includes(id) || !!p.themes?.[id];

const CJK = /[㐀-鿿豈-﫿]/;
const font = (name?: string) => FONTS.find((f) => f.name === name);

/** Weight clamped to the font's range (variable) or snapped to its nearest installed weight (static). */
function weightOf(f: (typeof FONTS)[number], w: number) {
  if (f.family.endsWith("Variable")) return Math.min(f.weights[1], Math.max(f.weights[0], w));
  return f.weights.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a));
}

/**
 * CSS for a text: the theme's `role` style, then `textStyle` over it, field by field. With no theme and no
 * textStyle this is empty, so existing projects render as before. Raw `props.style` goes over this.
 */
export function textCss(p: Pick<Project, "meta" | "themes">, role: FontRole, textStyle: TextStyle | undefined, text: string): Record<string, string | number> {
  const theme = themeOf(p);
  const s: TextStyle = { ...theme?.roles[role], ...textStyle };
  const css: Record<string, string | number> = {};
  const f = font(s.font);
  if (s.font) {
    // CJK text in a font without CJK glyphs: the theme's subtitle font if it has them, else Noto Sans TC.
    const sub = font(theme?.roles.subtitle?.font);
    const cjk = CJK.test(text) && !f?.cjk ? `, "${(sub?.cjk ? sub : font(NOTO))!.family}"` : "";
    css.fontFamily = `"${f?.family ?? s.font}"${cjk}, sans-serif`;
  }
  if (s.weight) css.fontWeight = f ? weightOf(f, s.weight) : s.weight;
  if (s.size) css.fontSize = s.size;
  if (s.color) css.color = s.color;
  if (s.tracking !== undefined) css.letterSpacing = `${s.tracking}em`;
  if (s.lineHeight) css.lineHeight = s.lineHeight;
  if (s.upper) css.textTransform = "uppercase";
  if (s.align) css.textAlign = s.align;
  if (s.stroke) Object.assign(css, { WebkitTextStroke: `${s.stroke.width}px ${s.stroke.color}`, paintOrder: "stroke fill" });
  if (s.shadow) css.textShadow = `0 ${s.shadow.y}px ${s.shadow.blur}px ${s.shadow.color}`;
  if (s.box) Object.assign(css, { background: s.box.color, borderRadius: s.box.radius, padding: s.box.pad });
  return css;
}

/** Op error text for an unknown font name, or undefined if `style.font` is fine. */
export const badFont = (style: TextStyle | undefined) =>
  style?.font && !font(style.font) ? `unknown font "${style.font}"; one of: ${FONTS.map((f) => f.name).join(", ")}` : undefined;

export type Word = { start: number; end: number; text: string };

/** Transcript words (source seconds) inside each anchored caption on a `highlight: "word"` track, by caption id. Free captions have none. */
export function captionWords(p: Project, ctx: Ctx): Record<string, Word[]> {
  const out: Record<string, Word[]> = {};
  const items = videoItems(p);
  // ctx.transcript reads a JSON file per call; many captions share one asset.
  const transcripts = new Map<string, ReturnType<NonNullable<Ctx["transcript"]>>>();
  const transcript = (id: string) => (transcripts.has(id) ? transcripts.get(id) : transcripts.set(id, ctx.transcript?.(id)).get(id));
  for (const t of p.tracks) {
    if (t.kind !== "caption" || t.highlight !== "word") continue;
    for (const c of t.items) {
      if (c.mode !== "anchored") continue;
      const asset = items.get(c.itemId)?.assetId;
      const words = !asset ? undefined : transcript(asset)?.flatMap((s) => s.words ?? []).filter((w) => w.start >= c.sourceStart - 0.05 && w.end <= c.sourceEnd + 0.05);
      if (words?.length) out[c.id] = words;
    }
  }
  return out;
}
