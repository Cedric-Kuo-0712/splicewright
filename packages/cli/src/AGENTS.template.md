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

## Context and execution

Use the smallest current evidence needed for the next decision; load relevant instructions and source ranges progressively.
Reuse valid analysis and artifacts. Select compact fields and bounded ranges before returning tool output; keep full logs on disk.
Group independent reads, preserve revision ordering for edits, and diagnose failures before retrying. Use bounded waits or the
host's supported background completion mechanism instead of repeated status-only calls. When delegating, pass a self-contained
brief with ownership and acceptance criteria; prefer fresh context over unrelated history where supported.

## Workflow

The human watches and edits in the web UI while you work; treat it as a shared timeline, not your scratch space.
Op names below are the `splicewright_<op>` tools.

1. **Orient.** `get_summary`, then this file. If the Brief above is empty, ask for it (goal, length, style,
   must-keep, music/captions) before cutting, and write the answers into it.
2. **Choose an editing route.** For a new assembly or broad source review, use `.agents/skills/splicewright-editing/SKILL.md` and its material-first route. For a local timeline correction, inspect only affected items and use its timeline-refinement route; do not repeat a library-wide review.
3. **Propose, then cut.** Share the selected sources, story beats or local change, and rough timing. Get agreement before a substantial recut. Material preparation caches analysis but does not count as review. After inspecting a source, record observations against its listed version with `record_material_review`. New sources are candidates, never automatic timeline insertions.
4. **Edit and refine.** Keep each `batch` to one coherent intent. The editing skill and linked references cover supported motion and creative starting points without requiring a fixed style or effects. For filler cuts, show `find_fillers` suggestions and get agreement before applying `cutRanges`.
5. **Sound and captions.** Add transcript captions with `addCaptionsFromTranscript`, correct names with `editCaption`, and use audio tools only for an identified need. Generated narration setup and voice handling are in the MCP tool instructions.
6. **Review.** Re-read the changed range; use `storyboard` or selected `still` frames to check it. Run `lint` before rendering and report changed timecodes.
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

## Editing reference

For exact PIP, keyframe, transition, and validation contracts, load the relevant section of `.agents/skills/splicewright-editing/references/operation-mechanics.md`.

Use `.agents/skills/splicewright-editing/SKILL.md` for the shared workflow. Its bundled references cover [material review](.agents/skills/splicewright-editing/references/material-review.md), [narrative starting points](.agents/skills/splicewright-editing/references/narrative-structures.md), [transitions and motion](.agents/skills/splicewright-editing/references/transitions-motion.md), and [local timeline refinement](.agents/skills/splicewright-editing/references/timeline-refinement.md).

## Notes

<!-- Decisions worth keeping across sessions (chosen takes, rejected ideas, open questions). Agents append here. -->
