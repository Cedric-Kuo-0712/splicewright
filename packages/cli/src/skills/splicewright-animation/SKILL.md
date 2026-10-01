---
name: splicewright-animation
description: Create and revise frame-driven SVG, hand-drawn graphics, shape morphs and Lottie overlays in a Splicewright video project; prepare isolated Motion Canvas or Manim scenes when needed.
---

# Animation authoring

Read the project's AGENTS.md Brief and Notes first. For art direction, use
[the style guide](../splicewright-animation-style/SKILL.md). Keep source graphics,
timing and user-editable content separate: changing a café name should not require
regenerating a whole scene.

## Choose the smallest suitable tool

| Need | Tool | Read next |
| --- | --- | --- |
| Location tags, arrows, itinerary, cards, subtitles | React/SVG in existing Remotion composition | [Runtime](references/runtime.md) |
| Sketch lines, hatching, hand-drawn maps | `SketchPath` (Rough.js) | [Runtime](references/runtime.md) |
| A shape changes into another shape | `MorphPath` (Flubber) | [Runtime](references/runtime.md) |
| Reusable animated sticker already available as local JSON | `Lottie` | [Runtime](references/runtime.md) |
| Long scene with sequential actions and narration | Isolated Motion Canvas | [Other engines](references/engines.md) |
| Formula, coordinate systems, geometric explanation | Isolated Manim | [Other engines](references/engines.md) |

The first five helpers are supplied by `splicewright/animation`; do not install
another Remotion version inside the video project. Motion Canvas and Manim are
optional engines with explicit preparation, not services assumed to be running.

## Author and integrate

1. Identify the overlay's purpose and the shot/time range it belongs to. Do not
   add decorative motion to every cut; preserve faces, subtitles and the story.
2. Create a named component in `components/`. Keep text, palette, sizing and
   duration in typed props. A small editable starting point is
   [LocationTag.tsx.template](assets/LocationTag.tsx.template); copy it to a `.tsx`
   file and adjust for project dimensions and the selected style.
3. Drive every animated value from `useCurrentFrame()` and `useVideoConfig()`.
   Inside the overlay the frame is local to that item. Calculate seconds using
   `frame / fps`; use the actual item duration for the exit. Avoid CSS keyframes,
   `requestAnimationFrame`, wall-clock timers and unseeded randomness.
4. Register the component through `defineConfig({components: {...}})` in
   `splicewright.config.ts`. Merge existing registrations and presets; do not
   replace the whole file. Add/update the overlay through MCP/CLI operations.
   `insertItem` accepts `component`, `props`, `at`, `duration`, optional `trackId`.
   Numeric `at` and `duration` are **frames**, not seconds. At 30 fps, an overlay
   starting after 1 second and lasting 3 seconds uses `at: 30`, `duration: 90`;
   its `durationInFrames` prop must also be 90. Calculate these from project fps.
   Do not hand-edit `project.json`.
5. If using an external engine, keep authored source in `animations/`, then
   import its verified rendered asset. It becomes media on the timeline, not a
   live editable nested scene. Prefer in-process Remotion when text/timing will
   be revised repeatedly.

## Editable title starting point

For opening hooks and large chapter titles, use the [bold kinetic typography recipe](../splicewright-animation-style/references/styles.md#bold-kinetic-typography) and [font selection guidance](../splicewright-animation-style/references/typography.md). Copy `assets/BoldTitle.tsx.template` into a project component `.tsx`, register `BoldTitle`, and supply 1–3 explicit `lines` plus `durationInFrames` matching the overlay duration. The component exposes font family, weight, size and colors; it does not automatically fit text or detect beats. Use enough duration for the complete title to be read, then check clipping on the actual shot. Avoid adding a generation script for this: the editable component is the reusable implementation; `scripts/setup_engine.py` is for optional external engine setup.

## Check the actual result

- Bundle/render the custom component; TypeScript alone does not prove imports
  from an external project resolve. Use the existing `still`/`render` tools on
  entry, hold and exit frames, plus the actual timeline interval.
- Verify duration, fps, dimensions and alpha when needed with `ffprobe`; do not
  assume a file exists because a command started. Check visual readability using
  the project's permitted preview workflow. If visual inspection is unavailable,
  say which aspect still needs human review.
- Check stable sketch geometry when seeking backward or rendering frames out of
  order. Fixed `seed` means fixed drawing; animate reveal/transform separately.
- An exported video with a solid background is not a transparent overlay. Use a
  supported alpha export or present it as a full-frame insert.
- For long jobs use the existing runner/detached-job rules in AGENTS.md, preserve
  logs and completion status, and do not poll in a loop.

Record the chosen style, source asset/license and meaningful design decisions in
the existing Notes section. Do not claim one engine is cheaper in tokens or
better looking without comparable measured work.
