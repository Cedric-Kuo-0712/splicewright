# Title typography

Animated titles normally use ordinary font files rendered as editable React text. Motion comes from frame-driven transforms, opacity and masks; it does not require a special animation font. SVG outlines are useful for custom lettering or drawing glyph paths, but lose easy text editing and language substitution. Retain the original text/font and licensed source if outlining.

## Choose from the existing project first

Preserve confirmed typography unless the brief changes it. Inspect the project's theme and the installed core `FONTS` catalog: its `family` is the exact CSS family, `weights` are the loaded weights, and `cjk` indicates Traditional Chinese coverage. The render package already imports bundled Fontsource faces for preview and export. Use explicit family/weight props on custom titles rather than assuming inheritance from the theme.

| Title intention | Existing font starting points | Weight / language constraint |
| --- | --- | --- |
| Vivid Latin hook | Anton, Bebas Neue | Both use 400; their heavy/condensed appearance is in the face itself, not a fabricated 900 weight |
| Modern travel title | Montserrat Variable | 700–900; Latin text |
| Friendly food / daily vlog | Poppins | 700 or 800 are loaded; Latin text |
| Bold Traditional Chinese or mixed Chinese/English | Noto Sans TC Variable | 800–900; covers Traditional Chinese |
| Literary / cinematic | Noto Serif TC Variable or Playfair Display Variable | Use an available weight; Playfair is for Latin text |

These are candidates, not compulsory pairings. Mixed titles may use separate spans for Chinese and Latin when deliberate, with consistent baseline and hierarchy. Do not set Anton on Chinese and assume fallback produces the same design. Avoid forced uppercase or expanded letter spacing on Chinese; check punctuation, accents and actual text coverage. Japanese and other languages require checking the actual font coverage rather than treating `cjk` as an all-language guarantee.

## Loading and validation

Prefer installed fonts so rendering does not depend on an agent's OS fonts or a network download. New fonts need a usable license, the actual required faces/weights, and a loading path shared by preview and export. Record font source/license and exact family/weight in Notes. A CSS family name alone does not install a font. Do not add a font dependency silently just to try a look; use a built-in candidate unless the brief warrants it.

For a new custom face, use an explicitly installed Remotion font loader or the documented FontFace workflow, and wait for loading before capture; propagate loading errors instead of rendering fallback silently. Consult [Remotion font loading](https://www.remotion.dev/docs/fonts-api/) before choosing a loader: `@remotion/fonts` is not currently a dependency of this project.

Compose 1–3 intentional lines and expose their text, family, weight, size and colors as props. Fit the actual longest text, keep safe margins, and check the fully revealed title plus entry/exit frames. The BoldTitle template does not measure text or automatically shrink it; adjust line breaks/fontSize against the output dimensions. Ask about typography only when it materially changes a broad unspecified direction; a small title within an established style does not need a separate font-choice question.
