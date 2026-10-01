# Splicewright — Look spec: fonts, text styles, themes, color, LUTs, keying, beauty

Companion to SPEC.md (§13 rules apply: every new field is optional, `schemaVersion` stays 1, each milestone
is core op/schema → render → UI → MCP/CLI). This file covers how a video *looks*; the other §13.6 items
(audio processing, Bezier ease, stickers, reverse, lint, desktop) are in SPEC.md §13.7.

## 0. Status

| # | Milestone | Needs | Acceptance (short) | Status |
|---|---|---|---|---|
| F | Built-in fonts + agent font guide | — | font still test: Latin and CJK render in the font, not the fallback | ✅ done (merged 9a5a746) |
| L1 | Text styles and themes | F | one `setMeta { theme }` restyles every role-bound text in one undo step | ✅ done (merged 65092a6; user fonts from `raw/` not built) |
| L0 | Canvas video path (spike) | — | a color-key still matches between Player and render; existing still tests unchanged | ✅ done (UI verified by user) |
| L2 | Color: grade, curves, LUT | L0 | our LUT within 2/255 of ffmpeg `lut3d` on a test image | 🟡 implemented; UI manual check pending |
| L3 | Keying: chroma, luma | L2 | keyed green shows the track below; the red subject survives | 🟡 implemented; UI manual check pending |
| L4 | Beauty: smooth, whiten | L0 (+ `faces` ingest for face-only) | detail drops inside the face box, not outside | planned |

Build order: F → L1 (DOM only, no L0 needed) → L0 → L2 → L3 → L4.

## 1. The rule this spec has to keep

Preview and render are one program: the Remotion composition in `packages/render/src/Composition.tsx`, drawn
by the Player in the browser and by headless Chromium for export. Anything that only exists in one of them
(an ffmpeg-only filter at export, Web Audio only in preview) makes the preview lie, so it is not allowed.
ffmpeg filters may still be used as a **test oracle** (L2) or to **bake a file** both sides then play (SPEC.md §13.7 A1).

Text (fonts, styles, themes) is DOM/CSS and needs nothing new. Per-pixel work (grade, LUT, key, beauty)
needs the canvas path in L0.

### Tools and the use-or-rewrite decision

| Need | Tool | Decision |
|---|---|---|
| Fonts | Fontsource npm packages (OFL, Google Fonts builds) | use directly (done) |
| Pixel effects host | `@remotion/media` `<Video>` + `@remotion/effects` (both at 4.0.520; `effects` prop from 4.0.464) | use directly |
| Grade | `@remotion/effects`: `exposure`, `white-balance`, `vibrance`, `levels`, `shadows-highlights`, `color-correction` | use directly |
| Chroma key | `@remotion/effects/color-key` | use directly |
| LUT parse | `cube-lut.js` (npm) | local strict `.cube` parser; verified package ESM entry has extensionless internal imports that fail under Node |
| LUT apply, curves, luma key | `createEffect()` (core `remotion`; 2D canvas, WebGL2 or WebGPU) | write our own shader |
| Skin smoothing / whitening | GPUPixel (C++/OpenGL, Apache-2.0) | port its shaders; keep its LICENSE/NOTICE in `packages/render/third_party/gpupixel/` |
| Face landmarks | MediaPipe Face Landmarker (Python `mediapipe`, Apache-2.0; check the `.task` model's own terms) | use directly, in ingest |
| Caption word timing | `@remotion/captions` (4.0.520) | evaluate in L1; our transcript words may be enough |
| Not used | three.js `LUTCubeLoader` (whole 3D engine for one pass), ffmpeg `lut3d`/`colorkey` at export (breaks the rule) | — |

## 2. F — Built-in fonts (done)

- `packages/core/src/fonts.ts`: `FONTS` (name, exact CSS `family`, weights, `cjk`, `core` ★, roles, feel, use,
  avoid) and `FONT_PAIRS`. This is the one source: the render loader, the agent guide and the L1 picker read it.
- `packages/render/src/fonts.ts` imports each Fontsource package (variable where one exists; Poppins 400–800 and
  Lato 400/700/900 as static weights). Files ship in `node_modules`, so render works offline. Fontsource splits
  faces by unicode-range, so a frame only fetches the slices its text uses; Remotion waits for CSS fonts.
- Family names are Fontsource's: variable packages end in ` Variable` (`"Inter Variable"`), static ones don't.
- Agents: `init` (and `init --refresh-agents`) writes a `## Type` section into AGENTS.md from `FONTS`: the table,
  the role rule (title / subtitle / emphasis / handwritten, 2–3 families per video) and the pairings.
- Test: `packages/render/test/still.test.ts` "built-in fonts render" draws `TOKYO` in Anton and `九月的台北` in Noto
  Sans TC against plain monospace; with the loader removed it fails (0 pixels differ), so it guards the loader.
- Only Noto Sans TC and Noto Serif TC have CJK glyphs. TikTok Sans has none.
- Adding a font: an OFL font with a Fontsource package → one import line + one `FONTS` entry.
- Not built: user fonts from `raw/`. Planned in L1 as asset kind `font`, loaded with the `FontFace` API +
  `delayRender`/`continueRender` (Remotion's documented path for local fonts).

## 3. L1 — Text styles and themes

```ts
type TextStyle = {
  font?: string;            // a FONTS name ("Montserrat") or a font asset id; resolves to its family + fallbacks
  weight?: number;          // clamped to the font's weights
  size?: number;            // px at output resolution
  color?: string;
  tracking?: number;        // letter-spacing in em
  lineHeight?: number;
  upper?: boolean;          // text-transform: uppercase
  align?: "left" | "center" | "right";
  stroke?: { color: string; width: number };           // -webkit-text-stroke, paint-order stroke
  shadow?: { color: string; blur: number; y: number };
  box?: { color: string; radius: number; pad: number }; // the caption plate
};
type FontRole = "title" | "subtitle" | "emphasis" | "handwritten";
type Theme = { name: string; roles: Partial<Record<FontRole, TextStyle>> };

// project level
meta.theme?: string;                    // a built-in theme id or a key of `themes`
themes?: Record<string, Theme>;         // project-defined, e.g. copied from a built-in and edited
// Text overlay props
props.role?: FontRole;                  // default "title"
props.textStyle?: TextStyle;            // overrides the role's style field by field
// caption track
textStyle?: TextStyle;                  // captions use role "subtitle" + this
highlight?: "none" | "word";            // per-word highlight in the "emphasis" style
```

- Resolution order for a text: theme role → `textStyle` → the existing `props.style` (raw CSS, the escape hatch,
  kept as-is). With no `meta.theme`, the role styles are today's look, so existing projects render unchanged.
- Font stack: `"<family>", <CJK family if the text has CJK and the font has none>, <generic>`. CJK means
  `/[㐀-鿿豈-﫿]/`. The CJK fallback is the theme's subtitle font if it is CJK, else Noto Sans TC.
- Built-in themes are the nine `FONT_PAIRS` rows, with ids (`modern-vlog`, `soft-lifestyle`, `travel-cinematic`,
  `luxury`, `diary`, `shorts`, `zh-daily`, `zh-cinematic`, `zh-en-travel`), each filling all four roles with
  weights and sizes as fractions of frame height (so 9:16 and 16:9 both work). They live in core next to `FONTS`.
- Per-word highlight uses the transcript words of captions anchored to a video item (`find` already has them);
  free captions have no words and ignore it. Evaluate `@remotion/captions` for paging before writing our own.
- Ops: `setMeta` accepts `theme` (and validates the id); `setProps` on Text overlays for `role`/`textStyle`;
  `setTrack` gains `textStyle` and `highlight` on caption tracks. An unknown font name is an op error listing
  `FONTS` names. The theme switch is one op, so one undo step.
- UI: a font picker (★ group first, each name drawn in its own face, a 中 badge on CJK fonts, a warning when
  the text has CJK and the chosen font doesn't); the theme menu in project settings; a role select and style
  fields on Text overlays and caption tracks.
- Agents: the AGENTS.md Type section changes from "put `fontFamily` in `props.style`" to "pick a theme, set roles".
- Acceptance: one `setMeta { theme }` restyles every role-bound Text overlay and caption track, and one undo
  restores them. A still per built-in theme renders every role without fallback (the F test pattern).
  Projects without `meta.theme` keep the snapshot in `examples/basic/expected-30.png`.

## 4. L0 — Canvas video path (spike first)

Today every video item is an `OffthreadVideo` with CSS `filter`. `@remotion/effects` only runs on canvas
components, so pixel features need `@remotion/media` `<Video>`, which decodes with Mediabunny/WebCodecs and draws
to a `<canvas>` in the Player and in render (Remotion docs, `/docs/media/video`).

- Scope rule: an item takes the canvas path **only** when it has a pixel field (`grade`, `key`, `beauty`). Every
  other item stays on `OffthreadVideo`, so nothing that works today moves.
- Fallback: `<Video>` falls back to `OffthreadVideo` when it can't decode, and the fallback has no `effects`.
  Set `disallowFallbackToOffthreadVideo` on the canvas path: render then fails naming the item instead of
  dropping its look without saying so. The Player shows the item with a "look off: can't decode" badge.
- Known costs to measure in the spike:
  - Pitch: on the Mediabunny path `playbackRate` shifts audio pitch. If it does for us, canvas-path items with
    `speed ≠ 1` get their sound from a separate `<Audio>` (as `Sound` does) and the `<Video>` is muted.
  - Props to carry over: `trimBefore`, `playbackRate`, the `volume` callback, `objectFit` as a prop (CSS
    `object-fit` is not supported there), rotation from `mediaBox`, crop `clip-path`, mask wrapper.
  - Decode: edit proxies are H.264 (`packages/ingest/src/index.ts`), which WebCodecs handles; check HEVC raw
    files with proxies off.
  - Speed: frames/s of a draft render with one canvas item vs today.
- Order on a canvas item: **beauty → grade → curves → LUT → key**, then the existing CSS `effects`, crop, mask,
  transform, blend. Beauty comes first because it reads skin tones before a grade shifts them.
- Acceptance: a still test keys a synthetic green frame with `color-key` over a blue track and reads pixels;
  the user checks the same frame in the Player; all existing still tests pass unchanged.

## 5. L2 — Color: grade, curves, LUT

```ts
// on VideoItem (image items too: <Img> takes `effects` as well)
grade?: {
  exposure?: number; temperature?: number; tint?: number; vibrance?: number;
  shadows?: number; highlights?: number;
  levels?: { inBlack: number; inWhite: number; gamma: number; outBlack: number; outWhite: number };
  curves?: Partial<Record<"all" | "r" | "g" | "b", [number, number][]>>;   // points in 0..1, 2..16 per curve
  lut?: { assetId: string; strength?: number };                            // strength 0..1, default 1
};
// Asset.kind gains "lut" (`.cube` files; imported like any asset, never placed on a track)
```

- Grade fields map to `@remotion/effects` functions and use their installed ranges: exposure ±5 stops; temperature,
  tint, vibrance, shadows and highlights ±1; input/output levels 0..1 with input white above input black and
  gamma 0.01..10.
- Curves: x values strictly increase; y values may rise and fall. Use shape-preserving piecewise monotone
  cubic interpolation with no local overshoot, clamp outside endpoint x values, and store the four 256-entry
  tables in one 256×1 RGBA texture. Apply curves and the LUT in the same WebGL2 pass.
- LUT: parse the `cube-lut.js` `.cube` shape; 3D only (a 1D `.cube` is an import error), size 2..65,
  `DOMAIN_MIN/MAX` honoured. Upload as a WebGL2 3D float texture with linear filtering (trilinear sampling),
  mix with the input by `strength`. Parsed tables are cached per asset in the bundle, not per frame.
- Grade, curves and LUT strength are static in L2. Look keyframes and their ◇ controls are deferred.
- Not included: adjustment layers (a grade on a track that applies to everything below). Apply a look to many
  items with one `batch` of `setProps`.
- UI: inspector Color section (static sliders with live preview; editable curves; LUT dropdown
  of `lut` assets + strength). The item gets a small "look" badge on the timeline.
- Acceptance: a generated test image (ffmpeg `testsrc2`) through a test `.cube` (e.g. a channel swap and a
  warm grade): our render vs `ffmpeg -vf lut3d=file=…:interp=trilinear`, mean absolute difference ≤ 2/255.
  Strength 0 is identical to no LUT. A curve through (0,0),(1,1) is identical to none.

## 6. L3 — Keying

```ts
key?: { kind: "chroma"; color: string; similarity: number; smoothness: number; spill?: number }
    | { kind: "luma"; low: number; high: number; invert?: boolean };      // all 0..1
```

- Chroma and spill suppression use `@remotion/effects/color-key` directly.
- Luma: our own `createEffect` (alpha from Rec.709 luma between `low` and `high`, with a soft edge).
- Luma alpha is `smoothstep(low, high, Rec709 luma)`; below `low` is transparent, above `high` opaque,
  and `invert` uses `1 - alpha`. Equal thresholds are invalid.
- Keyed pixels are transparent, so the tracks below show; `blend` and masks still apply after the key.
- UI: Key section in the inspector; an eyedropper pauses playback and samples selected media after grade, curves
  and LUT but before keying, with canvas scaling, crop and transforms applied.
- Acceptance: synthetic source (green frame with a red square, ffmpeg `lavfi`) keyed over a blue track: the
  green area reads blue, the square stays red (the §10 still-test tolerance of 40 per channel).

## 7. L4 — Beauty

```ts
beauty?: { smooth?: number; whiten?: number; faceOnly?: boolean };   // 0..1
```

- Shaders ported from GPUPixel's beauty filter (read its source at implementation time; its reshape, lipstick
  and blusher filters take landmarks, while the smooth/whiten one works without them).
- `faceOnly` limits the effect to face boxes from a new ingest step `faces`: Python `mediapipe` Face Landmarker
  in `packages/ingest` next to the transcript scripts, sampled every N source frames and interpolated, written to
  `.splicewright/faces/<assetId>.json`. Landmarks are precomputed, never detected per frame in render: that is
  slower and flickers between frames. Without the step, `faceOnly` is an op error naming it.
- Not included: face reshape (slim face, big eyes; needs a mesh warp from landmarks), makeup.
- Acceptance: on a face clip, high-frequency energy (Laplacian variance) inside the face box drops at
  `smooth: 1`, and outside it stays within 5% with `faceOnly`. Items without `beauty` are unchanged.
