# Operation mechanics

Load only the relevant section when implementing a transition, PIP, keyframes, or audio edit. These technical contracts complement the creative starting points; use current tool schemas for exact arguments.

## Transitions

The outgoing video item owns its transition. The incoming item must touch it on the same track. For every type except `dip`, the cut needs `duration / 2` source frames beyond each side; a dip goes through black and needs no handles. Check both clips' selected ranges and available source before setting it. Speed and reverse change which source frames are available, so re-check the handle constraint after either change. Prefer a short transition only when it supports the cut; a transition cannot repair mismatched action or story continuity.

```json
{
  "itemId": "<outgoing-item-id>",
  "patch": { "transition": { "kind": "dissolve", "duration": 12 } }
}
```

## Picture-in-picture

Use an upper video track and call `apply_pip_preset` for a standard corner/side/circle layout; it reuses the editor's preset geometry. Read the returned item and render after applying it. If doing custom geometry with `setProps`, `transform.x/y` are pixel offsets from the composition center; mask `x/y/w/h` are fractions of the fitted picture box with `x/y` at its top-left. Set the mask before keying mask geometry. Inspect existing transform or mask keyframes first: keyed values override the plain preset value, so remove or deliberately update conflicting keys rather than assuming the preset will win. Keep faces, captions and other essential content unobstructed.

```json
{
  "itemId": "<upper-track-video-item-id>",
  "preset": "tr",
  "baseRevision": 7
}
```

Available presets: `tl`, `tr`, `bl`, `br`, `left`, `right`, `circle`. `circle` adds a mask to the current placement; it does not shrink or move a full-frame clip into a corner. Use the live tool schema for the current revision and supported values.

## Keyframes

`setKeyframe.at` is a timeline frame inside the item's half-open interval `[start, start + duration)`. The stored key follows source seconds so it stays attached to the same content through trim, slip and speed changes. Add the starting value, then the ending value on a frame still inside the item (normally `start + duration - 1`). `ease` belongs to a key and shapes the segment leaving that key toward the next; it does not ease into that key. Use `linear`, smooth `ease`, or the supported cubic-bezier tuple. Inspect neighboring keys because an existing key may change the whole curve. Video supports transform/effects/volume/mask geometry; audio supports volume only. Set a mask before keying its geometry. Overlay component props and grade/LUT are not animatable with `setKeyframe`.

Example: replace placeholders with actual timeline frames and values; verify the easing and endpoints from a rendered still/storyboard at entry, middle and exit.

```json
{
  "itemId": "<video-item-id>",
  "prop": "scale",
  "at": 48,
  "value": 1,
  "ease": "ease"
}
```

## Audio shaping

For ducking, key only `volume` on the audio item at timeline frames around the dialogue; use a small number of keys with smooth ramps, and preserve its baseline volume. Video audio may also key volume. `setProps.audioFx` supports EQ, pan, FFT denoise, and RNNoise with a user-supplied model; choose an effect for an audible problem, make one change at a time, and compare the processed output with the untreated source. RNNoise requires `raw/<model>.rnnn`; never invent or download a model path. Listen to the rendered result where possible. A waveform, successful render, or loudness number cannot establish that speech sounds natural or that music is balanced.

For generated narration, use `tts_status` to inspect local Kokoro/BreezyVoice readiness. Install the chosen engine explicitly with `tts_setup` or `splicewright tts setup --engine kokoro|breezyvoice`; synthesis stays offline. Kokoro uses matching language/voice; BreezyVoice uses Mandarin text and a saved `voiceId` from `tts_voice_list`. Save a local reference file plus exact transcript once with `tts_voice_register`. Call `tts_generate` with the current `baseRevision` and timeline frame `at`; insertion takes one revision and one undo step. Setup and BreezyVoice generation return a `jobId`: inspect `tts_job_status`, retain the completed result revision, and do not resubmit a running generation. Jobs belong to the current MCP session. If insertion conflicts, re-read the project before trying again.

## Verify before calling it done

- Re-read the changed timeline range; run `lint` before a master render.
- For motion and transitions, render/still the entry, middle, cut and exit frames; inspect the actual output, not only keyed values.
- For PiP, check placement, crop/mask, faces, captions and safe margins at the project dimensions.
- For audio, compare before/after and listen for noise artifacts, clipping and dialogue/music balance. Flag subjective listening that still needs a human.
- If a result is unclear, report the exact check still needed; do not claim visual or audio correctness from parameter values alone.

For numerical preview checks, `scripts/probe_preview.py` reports dimensions and selected RGB pixels without adding image data to context; this does not establish perceptual quality.
