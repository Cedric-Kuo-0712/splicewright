# Transitions and motion

Use motion to clarify a relationship, reveal a layer, or carry attention across a cut. A straight cut is the baseline and needs no transition property. Try the cut first; keep an effect only when it improves continuity or meaning.

## Supported transition contract

The video-item schema supports `dissolve`, `dip`, `wipe`, `slide`, `push`, and `zoom`. A transition is set on the outgoing video item with `setProps` and a `{ kind, duration }` value; the optional `direction` is `left`, `right`, `up`, or `down`. The incoming item must touch it on the same track. Durations are timeline frames. For every kind except `dip`, each side needs at least half the transition duration in available source handles. A `dip` passes through black and needs no handles. Check the selected source ranges and re-check after changing speed or reverse. Use current schemas for exact patch shape and values.

Prefer a short dissolve when two shots should blend, a dip when a deliberate blackout helps, and a wipe/slide/push/zoom only when direction or movement has a clear visual relation. A transition cannot repair mismatched action, missing source handles, or an unclear story cut. The simpler fallback is to remove the transition and refine the edit point or shot choice.

## Building blocks

- **Match cut:** align shape, direction, gesture, or composition across a straight cut. It needs two shots with a visible shared cue; trim or slip their source ranges to line that cue up. If the cue does not read, use a clean cut with a brief hold or choose a clearer pair.
- **Sound bridge:** let dialogue or ambient sound continue across the picture cut. `detachAudio` creates a separate audio item, but does not keep it linked to its source video afterward. Trim and place the audio intentionally; preserve dialogue clarity and use a straight picture cut if the sound edit distracts.
- **Mask reveal:** use an existing mask on a video item and, when useful, key supported mask geometry with `setKeyframe`. The mask is fitted to the picture box, so inspect its actual crop and edges. Set a mask before keying its geometry. If the reveal clips the subject or is hard to read, use a dissolve or a cut.
- **Layered photo or sliding composition:** place stills on separate video tracks or use an overlay with supported transform props. `setKeyframe` can animate supported numeric transforms; it does not create motion automatically. Check overlap, safe margins, and the composition at entry, middle, and exit. If layers compete, hold one still or return to a single-track montage.

## Check each change

Before setting a transition, confirm the incoming clip touches the outgoing item on the same track and the source handles exist. After adding motion, inspect an entry frame, a middle frame, and an exit/cut frame with a render or still. Look for jumps in position, clipped subjects, mask edges, obscured captions, and motion that starts or stops abruptly. Verify keyed values as well as the rendered result when the issue is timing. Keep the simpler cut, hold, or dissolve if the more complex treatment does not read clearly.
