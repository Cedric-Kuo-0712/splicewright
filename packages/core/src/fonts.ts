// Built-in fonts (SPEC-LOOK.md §2). The render package loads each from its Fontsource package, so they work
// offline in preview and render. `family` is the exact CSS font-family value to put in a style.

export type FontRole = "title" | "subtitle" | "emphasis" | "handwritten";

export interface Font {
  name: string;
  family: string;
  /** Loaded weights: a variable range [min, max], or the static weights installed. */
  weights: number[];
  /** Covers Traditional Chinese. The others have no CJK glyphs; Chinese text in them falls back. */
  cjk?: boolean;
  /** In the default set: suggest these first, reach for the rest only when the brief asks. */
  core?: boolean;
  roles: FontRole[];
  feel: string;
  use: string;
  avoid: string;
}

export const FONTS: Font[] = [
  { name: "Montserrat", family: "Montserrat Variable", weights: [100, 900], core: true, roles: ["title", "subtitle"], feel: "clean, modern, geometric", use: "vlog and travel titles, chapter titles, lower thirds, Shorts captions at 800", avoid: "long body text" },
  { name: "Poppins", family: "Poppins", weights: [400, 500, 600, 700, 800], core: true, roles: ["title", "subtitle"], feel: "friendly, round, young", use: "lifestyle, café, food, campus, tutorials", avoid: "serious documentary" },
  { name: "Inter", family: "Inter Variable", weights: [100, 900], core: true, roles: ["subtitle"], feel: "neutral, digital, high x-height", use: "the default English subtitle; talking head, podcast, tech, tutorials", avoid: "titles that need personality" },
  { name: "Roboto", family: "Roboto Variable", weights: [100, 900], roles: ["subtitle"], feel: "neutral, invisible", use: "interviews, documentary, info overlays; the safe fallback", avoid: "designed opening titles" },
  { name: "DM Sans", family: "DM Sans Variable", weights: [100, 1000], roles: ["subtitle"], feel: "minimal, soft modern", use: "minimal vlog, product video, small corner text (date, place, time)", avoid: "dramatic cinematic titles" },
  { name: "Lato", family: "Lato", weights: [400, 700, 900], roles: ["subtitle"], feel: "warm, human, relaxed", use: "daily vlog, food, travel, wellness", avoid: "high-impact titles" },
  { name: "TikTok Sans", family: "TikTok Sans Variable", weights: [300, 900], roles: ["subtitle", "emphasis"], feel: "casual, social-native", use: "English Shorts/Reels/TikTok captions", avoid: "Chinese (no CJK glyphs), cinematic titles" },
  { name: "Bebas Neue", family: "Bebas Neue", weights: [400], core: true, roles: ["title", "emphasis"], feel: "tall, condensed, cinematic, all caps", use: "trailer-style titles, travel chapters (CHAPTER 02 — THE CITY), sports", avoid: "full sentences" },
  { name: "Anton", family: "Anton", weights: [400], core: true, roles: ["emphasis"], feel: "very bold, high impact", use: "short hooks and keywords (DAY 1, WAIT., $10), thumbnails; one emphasised word inside a caption", avoid: "whole captions" },
  { name: "Oswald", family: "Oswald Variable", weights: [200, 700], roles: ["title"], feel: "condensed, serious, urban", use: "documentary, news style, city and architecture", avoid: "soft lifestyle vlog" },
  { name: "Playfair Display", family: "Playfair Display Variable", weights: [400, 900], core: true, roles: ["title"], feel: "elegant, editorial, high contrast", use: "fashion, café, wedding, cinematic travel titles", avoid: "subtitles and small text" },
  { name: "Lora", family: "Lora Variable", weights: [400, 700], roles: ["title"], feel: "literary, storytelling", use: "travel diary, personal essay, quotes", avoid: "fast Shorts captions" },
  { name: "Caveat", family: "Caveat Variable", weights: [400, 700], core: true, roles: ["handwritten"], feel: "handwritten, personal", use: "small annotations (↖ our hotel, day two ♡, 7:35 am), scrapbook and diary looks", avoid: "the main subtitle" },
  { name: "Noto Sans TC", family: "Noto Sans TC Variable", weights: [100, 900], cjk: true, core: true, roles: ["title", "subtitle", "emphasis"], feel: "neutral, clean Chinese", use: "the default 繁中 subtitle (500 vlog, 700 Shorts, 900 emphasis), lower thirds", avoid: "titles that need strong character" },
  { name: "Noto Serif TC", family: "Noto Serif TC Variable", weights: [200, 900], cjk: true, core: true, roles: ["title"], feel: "editorial, literary Chinese serif", use: "繁中 cinematic titles, quotes (600–700)", avoid: "long fast subtitles" },
];

/** Title + supporting pairs by style; these become the built-in themes (SPEC-LOOK.md §3). */
export const FONT_PAIRS: { style: string; title: string; support: string }[] = [
  { style: "Modern vlog", title: "Montserrat 700", support: "Inter 400" },
  { style: "Soft lifestyle", title: "Poppins 600", support: "Lato 400" },
  { style: "Travel cinematic", title: "Bebas Neue", support: "Montserrat 500" },
  { style: "Luxury / fashion", title: "Playfair Display", support: "DM Sans" },
  { style: "Diary vlog", title: "Lora", support: "Inter, Caveat for annotations" },
  { style: "Shorts / Reels", title: "Anton", support: "Montserrat or TikTok Sans" },
  { style: "繁中日常 vlog", title: "Noto Sans TC 700", support: "Noto Sans TC 400" },
  { style: "繁中 cinematic", title: "Noto Serif TC 700", support: "Noto Sans TC 400" },
  { style: "中英 travel", title: "Bebas Neue or Montserrat", support: "Noto Sans TC" },
];
