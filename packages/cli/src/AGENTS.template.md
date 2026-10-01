# {{title}}

Splicewright video project, {{width}}×{{height}} at {{fps}} fps. Edit it through the `splicewright` MCP tools
(their instructions cover the workflow); the human reviews in the web UI (`splicewright open`).

## Brief

<!-- Fill these in before the first session; the agent reads them every time. -->
- Goal and audience:
- Target length and delivery format:
- Style and pacing:
- Must keep / must cut:
- Music and captions:

## Workflow

The human watches and edits in the web UI while you work; treat it as a shared timeline, not your scratch space.
Op names below are the `splicewright_<op>` tools.

1. **Orient.** `get_summary`, then this file. If the Brief above is empty, ask for it (goal, length, style,
   must-keep, music/captions) before cutting, and write the answers into it.
2. **Know the footage.** `ingest`, then per asset `inspect_asset` (transcript + contact sheet); `find` to locate
   lines or moments; `peek` a source range when the sheet isn't enough. Note one line per asset under Notes.
3. **Propose, then cut.** Outline the edit in chat (sections, chosen takes, rough timings) and wait for a yes on
   anything larger than a small fix. Mark sections with `addMarker` so the human can navigate them.
4. **Rough cut.** Main story on the magnetic V1 track (`insertItem` in a `batch`); B-roll, titles and overlays on
   tracks above. Cut talking heads from transcript times; remove dead air and retakes.
5. **Refine** only where it earns it: `trim`/`slip` for timing, `setProps` transition on cuts that need one, `setSpeed`,
   `effects`/`crop`/`transform` to match shots or reframe, `setKeyframe` for moves and fades over time (e.g. a slow
   push-in: scale keys at the start and end of a clip; a key's optional `ease` shapes the segment leaving it: `linear`,
   `ease`, or a CSS `[x1, y1, x2, y2]` cubic-bezier with x in 0..1, y beyond it overshoots); `setProps` `mask` + `transform` scale for a circle
   picture-in-picture (ellipse mask), `blend` (screen, multiply…) for light leaks and overlays; `detachAudio` for
   J/L-cuts (detach, then trim the audio separately).
6. **Sound.** Music on an audio track with `volume` and fades; `detectBeats` then `fitToBeats` to cut a montage on
   the beat. `normalizeLoudness` (after `ingest --only loudness`) before mixing dialogue and music; `setKeyframe` on an
   audio item's `volume` for manual ducking.
   **Cutting fillers and dead air.** `find_fillers` (add `itemId` for one clip); if it returns `hints`, run
   `ingest --only transcript` first. Show the user the proposed cuts (`what` and times) and cut with `cutRanges`
   only after they confirm; then `still` a few cut points or `storyboard` the range to check.
7. **Captions.** `addCaptionsFromTranscript`, then `editCaption` for names and mishearings.
8. **Review.** `storyboard` over what changed, `still` on a few key frames, `render` preset `draft` for a full pass.
   Report changes with timecodes so the human can jump to them; run `lint` and fix its errors, then `render` master when they approve.

Rules: one intent per `batch` (one undo step each); re-read on a conflict, never force; don't undo the human's
steps (pass your last write's revision as `baseRevision` to undo); ask before deleting footage-heavy sections or changing the format.

## Agent animation skills
For graphics and overlays, read `.agents/skills/splicewright-animation/SKILL.md`; for art direction, read `.agents/skills/splicewright-animation-style/SKILL.md`. Follow the Brief and visual references, preserve confirmed styles, and ask when a broad direction is materially ambiguous. For one small reversible overlay with no direction, use a restrained look from the current theme. Record the chosen style in Notes.

## Type

Pick a theme, then set roles. `setMeta { theme }` (one undo step) restyles every role-bound text at once.
Built-in themes: {{themes}}. They are the pairings below (same order); each fills the four roles (title,
subtitle, emphasis, handwritten) with font, weight and size scaled to the frame. A Text overlay takes
`props.role` (default title) and optional `props.textStyle`; a caption track takes `textStyle` (over the
subtitle role) and `highlight: "word"` (spoken word in the emphasis style, anchored captions only) via `setTrack`.
`textStyle` = `{font, weight, size, color, tracking, lineHeight, upper, align, stroke, shadow, box}` and overrides the
role field by field; `props.style` (raw CSS) still wins over both. For your own look, define `themes` in `setMeta`.
Fonts are built in and work offline; `font` is a name from the table. Use at most 2–3 families, and build
hierarchy with weight, size and letter-spacing. Suggest the ★ set first. Only the two Noto TC fonts have Chinese
glyphs; Chinese text in any other font falls back to the theme's subtitle font (Noto Sans TC). Record the chosen
theme and any overrides under Notes.

{{fonts}}

## Folder

- `raw/` source media: never modify or move.
- `project.json` the edit: change it only through the tools.
- `out/` renders. `.splicewright/` caches: disposable, rebuilt by ingest.

## Notes

<!-- Decisions worth keeping across sessions (chosen takes, rejected ideas, open questions). Agents append here. -->
