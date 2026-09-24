# Splicewright

A video editor that an AI agent and a person can work on at the same time. The edit is a single
`project.json`. An agent changes it through MCP tools, you change it in a browser timeline, and
Remotion renders it. Both sides use the same operations, so every change can be undone, is checked
before it is saved, and appears live on the other side.

The data model, the list of operations and the design decisions are in [SPEC.md](SPEC.md). This
file covers installing and using the editor.

## Install

Requirements:

- Node 26 or later. It runs the TypeScript sources directly, so there is no build step.
- `ffmpeg` and `ffprobe` on your `PATH`.
- Python 3, only if you want transcripts and beat detection. The other ingest steps run without it.

```sh
git clone <this repo> splicewright && cd splicewright
npm install
# Optional, for transcripts (faster-whisper) and beats (librosa):
python3 -m venv ingest/.venv && ingest/.venv/bin/pip install -r ingest/requirements.txt
# Optional, puts `splicewright` on your PATH:
(cd packages/cli && npm link)
```

Without `npm link`, run `node <repo>/packages/cli/src/main.ts <command>` wherever this manual says
`splicewright <command>`.

## Quick start

```sh
mkdir trip && cd trip
splicewright init --title "Trip" --fps 30 --size 1920x1080
cp ~/Movies/trip/*.mp4 raw/            # or: splicewright import ~/Movies/trip/*.mp4
splicewright ingest                     # probes, proxies, thumbnails, waveforms, transcripts, beats
splicewright open                       # the editor, at http://127.0.0.1:5190
splicewright render --preset draft      # quick check → out/final.mp4
splicewright render                     # master quality
```

You can also skip the `cp`/`import` step and drop files onto the media bin or the timeline in the
editor. They are copied into `raw/` and ingested in the background.

## Working with an agent

`init` writes three files alongside `project.json`:

| File | What it's for |
|---|---|
| `AGENTS.md` | The brief (goal, length, style, what to keep), the agent's workflow, and a Notes section where the agent keeps decisions between sessions. **Fill in the Brief before the first session.** |
| `CLAUDE.md` | Points Claude Code at `AGENTS.md`. |
| `.mcp.json` | Starts `splicewright mcp` in this folder, so the agent gets the editing tools. |

To start a session, open Claude Code (or any other MCP client) in the project folder and keep
`splicewright open` running so you can watch. Things you can ask for:

- "Make a 60-second rough cut of the best moments. Put the talking head on V1 and B-roll over it."
- "Cut the ums and the long pauses from talk.mp4."
- "Add captions from the transcript and fix any misheard names."
- "Put song.m4a under everything, and cut the photo slideshow to its beats."
- "Look at 0:40–0:55 and tell me what's there before you change anything."

How you and the agent share the project:

- Every agent step appears in your timeline right away, and each step is one entry in **History**.
  - Undo works the same way for both of you, and the agent is told to undo only its own last step.
- If you edit while the agent is working, its next write is rejected because it is out of date. The
  agent then re-reads the project instead of overwriting your change.
- You can point the agent at a spot in the edit.
  - Markers and the I/O range are part of the project, so the agent can see them.
  - The I/O range is also kept in the URL, so you can paste the link into the chat.
- Anything worth remembering, such as a chosen take or a rejected idea, goes under **Notes** in
  `AGENTS.md`.

## The editor

The screen has four areas: the media bin on the left, the player in the middle, the inspector on
the right, and the timeline along the bottom. Right-click almost anything (items, empty lanes, the
ruler, markers, track headers, media) to get a menu of the actions available for it.

### Timeline

- **Adding media.** Drag a clip from the bin onto a track. Dropping it below the last track creates
  a new track.
  - To swap the media of a clip that is already placed, use the bin menu's **Replace selected clip**.
- **Moving and trimming.** Drag an item to move it, or drag its edges to trim.
  - If several items are selected, dragging one of them moves them all in time.
  - Drag on an empty lane to draw a selection box: Shift adds to the selection, ⌘ toggles items.
- **Magnetic tracks (⧉).** On a magnetic track, removing something closes the gap it leaves, and
  inserting something pushes the later items along. Turn it off on overlay tracks where you want
  gaps to stay.
- **Slip.** Alt-drag a video item to change which part of the source it shows, without moving it on
  the timeline. The player shows the new first frame while you drag.
- **Captions and overlays** are attached to the video item under them and move with it.
  - Alt-drag a caption or overlay to attach it to a different video item.
  - Double-click a caption to edit its text.
- **Fades and volume.** Hover over an audio or video item to show its fade handles and its volume
  line, then drag them.
- **Transitions.** Right-click the first of two touching clips, then pick Dissolve, Dip to black or
  Wipe into the next clip.
  - Dissolve and wipe need extra source media past the cut on both sides. If there isn't enough, the
    editor tells you.
- **Speed.** Item menu → **Speed…**, or the inspector. The same source range plays faster or slower,
  and the clip gets shorter or longer to match.
- **Freeze frame.** Press ⇧F. The frame at the playhead becomes a 2-second still, inserted into the
  clip at that point.
- **Tracks.**
  - Double-click a track's name to rename it; drag its header to reorder.
  - The header buttons are M (mute), H (hide) and L (lock).
  - Use the +V / +A / +C / +O row to add a video, audio, caption or overlay track.
  - A caption track's menu has **Export SRT**.

### Keyboard

| Keys | Action |
|---|---|
| Space · J / K / L | Play/pause · shuttle backward / stop / forward (press again to go faster) |
| ← / → · ⇧← / ⇧→ | Step 1 frame · step 10 frames |
| ↑ / ↓ · ⇧↑ / ⇧↓ | Previous/next edit or marker · also stop at beats and captions |
| Home / End · `[` / `]` | Start/end of the timeline · start/end of the selected clip |
| S or ⌘B | Split at the playhead |
| ⌫ · ⇧⌫ | Delete · ripple delete |
| ⌘C / ⌘V / ⌘⇧V / ⌘D | Copy · paste at the playhead · paste and push later items along · duplicate |
| ⌘A · Esc | Select all · clear the selection (and leave crop mode) |
| `,` / `.` (⇧ for 10) | Nudge the selection by 1 frame (10 with ⇧) |
| ⌥, / ⌥. | Slip the selection by one frame |
| I / O · ⌥X · `/` | Set in/out · clear the range · loop the range |
| M · ⌥M · ⇧M | Add a marker · remove the marker at the playhead · add a range marker around the selection |
| B | Tap a beat on the selected audio item |
| ⇧F | Freeze frame |
| ⇧C | Crop mode on the player |
| N | Snapping on/off |
| + / − · ⇧Z | Zoom in/out · fit the whole timeline |
| ⌘Z / ⌘⇧Z | Undo / redo (the History button lists every step) |

When an I/O range is set and nothing is selected, the range acts as the selection:

- **Split** cuts at both ends of the range.
- ⌫ lifts the range out and leaves a gap; ⇧⌫ extracts it and closes the gap.
- **Fit to beats** is limited to the range.

### Player: position, scale, rotation, crop

- **Transform box.** Select one video item and put the playhead over it. A box appears on the
  player:
  - drag inside the box to move the picture (it snaps to the centre; hold Alt to stop snapping);
  - drag a corner to scale;
  - drag the knob above the box to rotate (hold Shift to step by 15°);
  - double-click to reset.
- **Crop.** Press ⇧C, or click **crop → on preview** in the inspector. The box now shows crop
  edges:
  - drag an edge to crop that side;
  - double-click to remove the crop;
  - press Esc to leave crop mode.

  Crop sides always refer to the picture's own top, right, bottom and left, even when the picture
  is rotated.

### Inspector: effects, looks, keyframes

Select an item to see its fields.

- **Effects.** Brightness, contrast, saturation, hue, blur, grayscale, sepia and invert are sliders.
  - The player updates while you drag, and letting go saves the change as a single undo step.
  - Double-click a slider to reset it.
- **Look ▾.** Applies a preset: B&W, Noir, Warm, Cool, Vintage, Vivid or Faded. The preset replaces
  the item's current effects, and you can then adjust the sliders from there.
- **Crop sliders.** Set each side precisely, as a fraction of the picture.
- **Keyframes** (◇ / ◆) are available on volume, x, y, scale, rotation, opacity and every effect.
  1. Move the playhead to where the change should start, then click ◇ next to the field. That
     records the current value as a keyframe.
  2. Move the playhead to where the change should end, and change the value using the field, the
     slider or the box on the player. Once a property has keyframes, any edit you make to it adds
     or updates a keyframe at the playhead.
  3. ◆ means there is a keyframe at the playhead; click it to remove that keyframe.
  4. Keyframes show as small diamonds on the timeline item. Click a diamond to jump to it.

  Keyframes are stored against the clip's own media, not its position on the timeline. So they stay
  with the same moment of footage when you trim, split, slip or change the speed.
- **Audio items** have a beats section:
  - **Detect beats** finds the beats; B taps one in by hand at the playhead.
  - **Fit to beats** re-cuts a magnetic video track so its clips change on the beats.

### Proxies

The **Proxy** toggle plays lightweight edit proxies in the player so playback stays smooth. It has
no effect on renders, which always use the original files.

## Rendering

```sh
splicewright still --at 00:12.5            # one frame → out/still-<frame>.jpg
splicewright render --preset draft          # half resolution, fast
splicewright render --range 300-900 -o out/part.mp4
splicewright render                         # master: full resolution, crf 18
```

You can add your own presets and Remotion components in `splicewright.config.ts`. See
[SPEC.md §9](SPEC.md) and `examples/basic`.

## Command reference

Every command prints one JSON object. On error it exits with status 1.

```
splicewright init [--title T] [--fps 30] [--size 1920x1080]
splicewright import <paths...> [--no-ingest]
splicewright ingest [--only proxy,analysis,thumbs,waveform,transcript,beats] [--jobs N]
splicewright status
splicewright op <opName> '<json args>' [--base <revision>]
splicewright undo | redo
splicewright still --at <frame|[hh:]mm:ss[.s]> [-o file.jpg]
splicewright render [-o out/final.mp4] [--preset draft|master] [--range a-b]
splicewright open [--port 5190]
splicewright mcp
splicewright migrate video-cut <path> [--out <dir>] [--force]
```

`op` gives you every edit the agent has, from a script. Example:
`splicewright op setKeyframe '{"itemId":"i_4","prop":"opacity","at":40,"value":0}'`. The
operations are listed in [SPEC.md §5](SPEC.md).

## Project folder

```
project.json          the edit; change it only through the editor, the CLI or the agent
raw/                  source media; never modified
out/                  renders and stills
AGENTS.md CLAUDE.md .mcp.json    agent brief and wiring (from init)
splicewright.config.ts           optional: custom components and render presets
.splicewright/        caches (proxies, thumbnails, transcripts, beats) and undo history; safe to delete, ingest rebuilds the caches
```

## Troubleshooting

- **"conflict" on an edit.** Someone else, you or the agent, changed the project first. The editor
  reloads by itself; the agent re-reads the project before it decides what to do next.
- **No transcript or beats.** Check that the Python virtual environment from Install exists, or set
  `SPLICEWRIGHT_PYTHON` to an interpreter that has `faster-whisper` and `librosa` installed. Then
  run `splicewright ingest --only transcript,beats`.
- **Crop or the transform box looks misaligned on a clip.** Ingest that asset so its pixel size is
  known. Until then, the editor assumes the picture fills the frame.
