---
name: splicewright-animation-style
description: Choose or preserve art direction for Splicewright video graphics, decide when to ask about style, and translate a vlog brief into consistent illustration and motion rules.
---

# Art direction for video graphics

Read the Brief, Notes, project theme and any supplied references. Style and
engine are separate choices: a hand-drawn map can still use Remotion. Do not
select an engine merely because its demo used a particular look.

## Decide whether to ask

- If the user specifies a style or references, follow them; ask only about a
  conflicting requirement or missing detail that blocks the result.
- If revising an established project, preserve its palette, typography, stroke
  and motion vocabulary. A new café label does not reopen the whole art direction.
- If a new project has materially different plausible directions and the change
  affects many graphics or a long sequence, offer 2–3 concrete choices before
  implementing that direction. Describe appearance and editing tradeoffs, not
  library names. Continue independent footage/rough-cut work while awaiting it.
- If a small reversible overlay has no art direction, make a restrained choice
  from the current theme, state the assumption and provide a preview. Do not
  interrupt to ask about every color, stroke width or easing curve.
- If the user asks for options/demos, produce representative swatches before
  rolling a style through the whole edit. If they explicitly delegate the choice,
  choose and record it; no redundant confirmation.

Example choices for an undecided travel vlog: **clean location labels** (quiet,
easy to revise), **travel sketchbook** (warm paper and irregular ink), or
**playful stickers** (rounded shapes with brief bounce). Match the audience and
footage; none is a universal default or a promise of higher quality.

## Turn the choice into a reusable recipe

Record a compact decision under the existing Notes: name, 3–5 color roles,
project-supported fonts, stroke/texture, typical entrance/exit, and where it is
used. Reuse these props across components. Keep confirmed decisions until the
user changes them; if a new request conflicts, explain the choice that matters.

Read only the relevant [style recipe](references/styles.md):

| Direction | Suitable moments | Drawing route |
| --- | --- | --- |
| Clean editorial | Names, dates, prices over busy live footage | SVG/shapes + theme type |
| Travel sketchbook | Route recaps, diary notes, personal commentary | Seeded SketchPath + paper colors |
| Playful stickers | Reactions, food highlights, quick celebrations | Simple SVG or licensed local Lottie |
| Postcard / collage | Chapter opening, reflective montage, souvenirs | Layered imagery + SVG labels |
| Watercolor / painterly | Illustrated introduction or scenic insert | Prepared raster artwork + restrained motion |
| Technical explainer | Facts, route logic, coordinates or formulas | SVG/Motion Canvas; Manim for math |
| Bold kinetic typography | Opening hooks, big chapter titles, beat accents | Editable React text + frame-driven Remotion transforms |

For title animation, read [typography and font selection](references/typography.md). Choose available fonts by language, mood and supported weight; do not rely on silent fallback or convert ordinary titles into outlines. Start from [BoldTitle](../splicewright-animation/assets/BoldTitle.tsx.template) when useful, then adapt it to the shot and brief.

## Preserve coherence

Use one primary direction with limited accents. Keep location labels quieter
than chapter titles and reactions short. Do not animate important text so fast
it cannot be read. Faces, subtitles and essential footage get priority over
decorations. Avoid invented Japanese labels or icons whose cultural meaning was
not established by the brief.

For painterly artwork or a recurring character, reuse approved assets; a skill
cannot guarantee consistent new illustrations. Keep parts editable when they
need independent animation. Confirm readability, clipping and consistency on
actual shots through the project's review workflow, not only a blank demo.

Implementation: [animation skill](../splicewright-animation/SKILL.md).
