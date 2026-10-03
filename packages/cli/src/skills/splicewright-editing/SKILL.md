---
name: splicewright-editing
description: Use when assembling or refining a Splicewright timeline; includes material review, narrative starting points, transitions, motion, and audio guidance.
---

# Editing workflow

Read the project `AGENTS.md` Brief and MCP instructions, then inspect `get_summary`. Use current tool schemas and the latest `baseRevision` for writes. Treat the timeline as shared with the human editing in the web UI. On a revision conflict, re-read and re-plan.

Choose the route that fits the task:

- **Material-first assembly:** review only the new or relevant sources, then choose a story shape from [narrative structures](references/narrative-structures.md). Use [material review](references/material-review.md) for evidence, optional parallel review, and planning metadata.
- **Timeline refinement:** for a local fix, inspect only the affected range and items. Use [timeline refinement](references/timeline-refinement.md) to preserve cut anchors, music, ordering, and track behavior.

These are flexible starting points. Capture chronology can suggest an order, but it does not dictate story chronology; filenames and file times can be incomplete or misleading. Do not add an effect, transition, voiceover, or chronological structure without a reason in the brief.

## Shared workflow

1. State the intended story or local correction, the evidence and items it depends on, and the rough timing. Get agreement before a substantial recut.
2. Edit in one coherent round. `splicewright_batch` is atomic and creates one revision/undo step. For an approved agent-authored review round, `apply_edit_review` applies the ops atomically and records one revision/undo step with before/after snapshots. Do not bypass locks or silently unlock tracks; re-read when revision checks refuse a write.
3. Re-read the changed range and inspect a few meaningful frames. Run `lint` before rendering. For motion, check entry, middle, and exit; use audio measurements and reserve subjective listening for human review.

## Transition and motion reference

For exact PIP, keyframe, transition, and verification contracts, load only the relevant section of [operation mechanics](references/operation-mechanics.md). Preserve these constraints when adapting a creative recipe.

Use [transitions and motion](references/transitions-motion.md) only when a cut benefits from it. It lists supported transition kinds, prerequisites, common layered-photo approaches, failure modes, and simpler fallbacks. Tool schemas remain authoritative for exact arguments.

## Audio and narration

For a specific audio problem, make one change at a time and compare the result with the untreated source. `setProps.audioFx` supports EQ, pan, FFT denoise, and RNNoise with a user-supplied model; RNNoise requires `raw/<model>.rnnn`. Key `volume` for intentional ducking. A waveform, successful render, or loudness number cannot establish that speech sounds natural or that music is balanced.

For generated narration, use `tts_status` to inspect local Kokoro/BreezyVoice readiness. Install the chosen engine explicitly with `tts_setup` or `splicewright tts setup --engine kokoro|breezyvoice`; synthesis stays offline. Kokoro needs a matching language and voice. BreezyVoice uses Mandarin text and a saved `voiceId` from `tts_voice_list`. Register a local reference file with its exact transcript once using `tts_voice_register`. Call `tts_generate` with the current `baseRevision` and timeline frame `at`; insertion takes one revision and one undo step. Setup and BreezyVoice generation can return a `jobId`: inspect `tts_job_status` and do not resubmit a running generation. Jobs belong to the current MCP session. If insertion conflicts, re-read the project before trying again.
