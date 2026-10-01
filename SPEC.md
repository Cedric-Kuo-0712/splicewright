# Splicewright — Specification v0.1 (draft)

> A file-first, agent-native video editor. One project file, one pure core,
> three surfaces: a timeline UI for humans, a CLI for scripts, an MCP server for agents.

Status: draft for review. M1–M6 implemented (see §12).
Origin: extracted from the `video-cut` Kaohsiung vlog project (`apps/editor` + `my-video` + `scripts/`).

---

## 1. Goals and non-goals

### Goals (v1)
1. **Standalone tool.** Installed once, used by any project folder. No project-specific code inside.
2. **Agent-native.** Every edit a human can make in the UI, an agent can make through MCP or the CLI,
   through the *same* function, with no browser in the loop.
3. **File is the truth.** Project state is a plain JSON file on disk: diffable, committable, readable by
   an agent without tools.
4. **WYSIWYG render.** The UI preview and the final render come from the same Remotion composition.
5. **Token-efficient by design.** Read tools return compact summaries; visual inspection goes
   metadata → transcript → contact sheet → low-res proxy → still frame, never raw footage.
6. **Extensible per project.** A project can register its own Remotion components (e.g. Polaroid overlay)
   without forking the tool.

### Non-goals (v1)
- Bezier keyframe curves, chroma key, curves/LUT color grading, speed ramps, stickers.
  (These are OpenCut features we may add later — see §13. Masks moved into the roadmap as M8.)
- Cloud sync, accounts, collaboration server.
- Mobile / touch UI.
- In-browser export. Export always goes through Remotion render on the local machine.

---

## 2. Design principles

| Principle | Consequence |
|---|---|
| **One core, three surfaces** | `@splicewright/core` exports pure ops `(project, args) → result`. UI, CLI, MCP are thin adapters. No edit logic lives in a surface. |
| **Integer frames on the timeline** | Timeline positions and durations are integer frames at project fps. Eliminates the 0.1 s rounding drift of the current editor. |
| **One source of duration** | An item stores `start`, `duration`, `sourceIn`. Source-out is derived. The current `source_in`/`source_out` + separately rounded frame count can disagree; this cannot. |
| **Instance id ≠ asset id** | Every timeline item has a unique `id`; the media it plays is `assetId`. Splitting creates a new `id`, never a mangled asset reference (fixes the `clip_0015_b` proxy/caption bug). |
| **Captions anchored to source time** | Transcript segments live in *asset* time. Timeline caption positions are derived at render/preview. Trimming or moving a clip never desyncs captions, and no re-sync script is needed. |
| **Optimistic concurrency** | Every write carries the `revision` it was based on. Stale writes are rejected, not merged. Human and agent can work on the same project without silent overwrites. |
| **Validate on every write** | The core validates invariants (§4.4) before any save. An invalid project never reaches disk. |

---

## 3. Project folder convention

```
my-trip/                        # a user project (its own git repo)
├── project.json                # the timeline — single source of truth
├── splicewright.config.ts      # optional: custom components, output presets
├── components/                 # optional: project-specific Remotion components
├── raw/                        # source media (or symlinks to external drives)
├── out/                        # renders (gitignored)
└── .splicewright/              # generated, gitignored, safe to delete
    ├── assets.json             # probed metadata + fingerprints
    ├── proxies/edit/           # 540p, all-intra: smooth UI scrubbing
    ├── proxies/analysis/       # 360p, 0.5–1 fps: agent visual inspection
    ├── thumbs/                 # per-asset filmstrip thumbnails
    ├── contact-sheets/         # 3×4 grids for LLM inspection
    ├── waveforms/              # per-asset peak data for the UI
    ├── transcripts/            # per-asset Whisper segments (asset time)
    └── history/                # op log for undo across sessions
```

Media paths in `project.json` are relative to the project root. Cache entries are keyed by
content fingerprint (size + mtime + partial hash), so moving or renaming files doesn't trigger
re-processing.

---

## 4. Project schema (`project.json`, schemaVersion 1)

Validated with zod; the zod schema is the source of the TypeScript types.

```ts
type Frames = number;   // integer, project fps
type Seconds = number;  // float, source media time

interface Project {
  schemaVersion: 1;
  revision: number;                 // incremented by core on every committed op
  meta: { title: string; fps: number; width: number; height: number; background?: string; limiter?: boolean };  // limiter: render-only −1 dBFS master limiter, on for new projects
  assets: Record<AssetId, Asset>;
  tracks: Track[];                  // render order: index 0 is bottom-most
  markers?: Marker[];               // named ranges/points: chapters, notes, "sections"
  ids?: Record<string, number>;     // highest counter handed out per id prefix (§4.3)
}

interface Asset {
  id: AssetId;                      // stable, e.g. "a_vid20260627191257"
  path: string;                     // relative to project root
  kind: "video" | "audio" | "image";
  // probed values are cached in .splicewright/assets.json, not stored here
  rotation?: 0 | 90 | 180 | 270;    // override for phones that lie about orientation
}

type Track = VideoTrack | AudioTrack | CaptionTrack | OverlayTrack;

interface TrackBase {
  id: TrackId;
  name: string;
  muted?: boolean;
  hidden?: boolean;
  locked?: boolean;                 // ops targeting a locked track are rejected
  magnetic?: boolean;               // edits on this track ripple by default (main storyline)
}

interface VideoTrack extends TrackBase { kind: "video"; items: VideoItem[] }
interface AudioTrack extends TrackBase { kind: "audio"; volume?: number; items: AudioItem[] }
interface CaptionTrack extends TrackBase { kind: "caption"; style?: string; items: CaptionItem[] }
interface OverlayTrack extends TrackBase { kind: "overlay"; items: OverlayItem[] }

interface ItemBase {
  id: ItemId;                       // unique across the project
  start: Frames;
  duration: Frames;                 // >= 1
  label?: string;
  note?: string;                    // free text for humans/agents (was `description`)
}

interface VideoItem extends ItemBase {
  assetId: AssetId;
  sourceIn: Seconds;
  volume?: number;                  // live audio, 0..2, default 1
  fit?: "contain" | "cover";
  transform?: { x?: number; y?: number; scale?: number; rotation?: number; opacity?: number };
  // CSS filters on the picture; 1 is neutral for the first three, 0 for the rest.
  effects?: { brightness?: number; contrast?: number; saturation?: number; hue?: number /* deg */;
              blur?: number /* px */; grayscale?: number; sepia?: number; invert?: number };
  crop?: { top?: number; right?: number; bottom?: number; left?: number };  // fractions of the visible picture, upright
  mask?: Mask;                      // §13.2; drawn after crop
  blend?: Blend;                    // §13.2; mix-blend-mode of the item's layer
  // Animation of transform, effects, volume and mask geometry props. Per prop, keys sorted by t in SOURCE seconds, so
  // split/trim/slip/speed keep them on the same content. A keyed prop ignores its plain value; values
  // hold past the first and last key; ease shapes the segment leaving a key (smoothstep).
  keyframes?: Partial<Record<"x"|"y"|"scale"|"rotation"|"opacity"|"volume"|keyof Effects
                             |"maskX"|"maskY"|"maskW"|"maskH"|"maskFeather",
                             { t: Seconds; v: number; ease?: "linear" | "ease" }[]>>;
  role?: string;                    // free tag: "talking_head", "broll", ...
  speed?: number;                   // 0.1..10, source seconds per timeline second; no reverse
  fadeIn?: Frames;                  // opacity and volume ramps
  fadeOut?: Frames;
  // Into the next item on the track when they touch, centred on the cut (Diffusion Studio's model).
  // every kind but dip plays duration/2 frames of source past both sides of the cut; dip needs no handles.
  transition?: { kind: "dissolve" | "dip" | "wipe" | "slide" | "push" | "zoom"; duration: Frames; direction?: "left" | "right" | "up" | "down" };
}

interface AudioItem extends ItemBase {
  assetId: AssetId;
  sourceIn: Seconds;
  volume?: number;
  keyframes?: Partial<Record<"volume", { t: Seconds; v: number; ease?: "linear" | "ease" }[]>>;  // source seconds, like video
  fadeIn?: Frames;
  fadeOut?: Frames;
  duck?: { under: TrackId[]; level: number };  // v1: duck while speech exists on those tracks
}

// Captions are either anchored to a video item's source time (auto-follow trims),
// or free-floating with explicit timing.
type CaptionItem =
  | (ItemBase & { mode: "anchored"; itemId: ItemId; sourceStart: Seconds; sourceEnd: Seconds; text: string })
  | (ItemBase & { mode: "free"; text: string });

interface OverlayItem extends ItemBase {
  component: string;                // built-in ("Text", "Image") or registered in splicewright.config.ts
  props: Record<string, unknown>;   // validated by the component's own zod schema if provided
  mask?: Mask;                      // §13.2, over the whole frame
  blend?: Blend;
}

interface Marker { id: string; label: string; start: Frames; duration?: Frames; color?: string }
```

### 4.1 Anchored captions
For an anchored caption, `start`/`duration` are **derived**, not authored: the core computes the
intersection of `[sourceStart, sourceEnd]` with the referenced item's visible source range and maps it
to the timeline. If the intersection is empty, the caption is hidden (not deleted). Splitting a
video item re-points each anchored caption to whichever half contains it.
This generalizes `scripts/apply_subtitles_correction.py` and replaces it.

### 4.2 Sections → markers
The current `sections[]` structure (clips implicitly sequential) becomes a `magnetic` main video
track plus `markers` for section names. Section-specific data (e.g. `location_title`) becomes an
`OverlayItem` with `component: "LocationCard"`.

### 4.3 IDs
Generated ids are short and readable: `<prefix>_<base36 counter>` (`i_1f`, `t_3`, `c_a2`).
Readable ids matter because agents quote them back. Counters only move forward (`ids` records the
highest per prefix, and undo keeps it), so a deleted id is never handed to a new item: an id an agent
remembers either still names the same thing or is not found.

### 4.4 Invariants (checked by `validate()` on every write)
1. `duration >= 1` and `start >= 0` for every item.
2. No two items on the same video/audio/overlay track overlap.
3. Every `assetId` exists in `assets`; every anchored caption's `itemId` exists.
4. `sourceIn >= 0` and `sourceIn + duration × speed/fps <= asset.duration` (when probed duration is known);
   a dissolve or wipe also needs its handles inside the source (images always have them).
5. Item and track ids are unique.
6. Locked tracks are unchanged relative to the previous revision.

---

## 5. Core ops (`@splicewright/core`)

All ops are pure: `op(project, args) → { project, changes: ChangeSummary } | { error }`.
The core bumps `revision`, runs `validate()`, and appends the op to the history log.
The adapters (UI/CLI/MCP) only call ops and persist the result.

| Op | Args | Semantics |
|---|---|---|
| `importAsset` | path | Register asset; probe; enqueue ingest. Idempotent by fingerprint. |
| `insertItem` | trackId?, assetId \| component, at, duration?, sourceIn?, ripple? | Omitted `trackId` → first track of matching kind with room, or a new track. |
| `split` | itemId, at | Two items; the second gets a new id; anchored captions re-pointed. |
| `trim` | itemId, edge: "start"\|"end", to (frame), ripple? | Trimming "start" moves `start` and `sourceIn` together, so the right edge stays put. |
| `move` | itemId, to, trackId?, ripple? | Rejects overlap unless `ripple`. |
| `delete` | itemIds[], ripple? | Ripple closes the gap on magnetic tracks. |
| `cutRanges` | itemId, ranges[[sourceStart, sourceEnd]] (asset s), ripple? = true | Splits at each range and deletes it, latest first; one undo step (§13.5). |
| `closeGap` | trackId, at | Closes the empty span containing `at`; later non-anchored items shift left. |
| `setProps` | itemId, patch | Whitelisted fields only (volume, fit, transform, effects, crop, mask, blend, keyframes, fades, transition, speed, props, label, note; mask and blend also on overlays). `speed` here keeps the duration. |
| `setKeyframe` | itemId, prop, at, value \| null, ease? | Video items, any prop; audio items, `volume` only. Keys `prop` at timeline frame `at` (inside the item), replacing a key within half a frame; null removes it. |
| `normalizeLoudness` | itemIds, target = -14 | Audio or video items: `volume` = clamp(10^((target − L)/20), 0, 2), L = the asset's LUFS from the `loudness` step. One undo step. Refused for assets without loudness (run `ingest --only loudness`) and items with volume keyframes. |
| `detachAudio` | itemId | Video clip only: audio item (same asset, start, duration, sourceIn, volume, fades) on the first audio track that is unlocked, unmuted, visible, at volume 1 and has room, else a new one; the video's `volume` becomes 0 and its volume keyframes move to the audio item. Not linked afterwards. Refused for images, speed ≠ 1, volume already 0, a muted or hidden video track. |
| `setSpeed` | itemId, speed, ripple? | Video only: keeps the source range, scales the duration; ripple (default on magnetic) moves later items. |
| `slip` | itemId, deltaSec | Changes `sourceIn` only; timeline position unchanged. |
| `addTrack` / `removeTrack` / `setTrack` | … | Empty tracks are allowed (unlike OpenCut). |
| `setMeta` | title?, background?, limiter? | null unsets background/limiter. `fps`, `width`, `height` are refused: frame positions and normalized transforms/masks would need retiming or rescaling. |
| `moveTrack` | trackId, to | Moves a track to layer index `to` (0 = bottom). |
| `addCaptionsFromTranscript` | itemId, trackId? | Creates anchored captions from the asset transcript. |
| `editCaption` | captionId, text \| "" | Empty text hides the caption (replaces the `----` convention). |
| `addMarker` / `removeMarker` | … | |
| `setMarker` | markerId, patch | label, start, duration, color; keeps markers sorted by start. |
| `batch` | ops[] | Atomic: all or nothing, one revision, one undo step. |

Undo/redo: the history is an op log with inverse snapshots, persisted to `.splicewright/history/`.
Undo and redo take an optional `baseRevision`, rejected as a conflict unless the project is still at it,
so an agent undoing its own last step never undoes a newer human edit. **One op = one undo step.** The UI sends one op when the drag ends, not one per pointer move; during
the drag it previews locally.

Snapping, the adaptive ruler, and beat points are specified in §15.

---

## 6. Persistence and concurrency

- `load(dir)` → project + `revision`.
- `commit(dir, project, baseRevision)`: if the on-disk revision ≠ `baseRevision`, reject with
  `conflict`. Otherwise write to a temp file and `rename` it over `project.json` (atomic).
- The UI watches `project.json`. On an external change: if the UI has no uncommitted local state, it
  reloads silently; if it does, it shows "Project changed on disk — reload / keep mine".
- The UI commits every op immediately. Its dirty state is only an in-progress drag, so "unsaved
  changes" mostly goes away as a concept. Cmd+S becomes a no-op kept out of habit.

---

## 7. Surfaces

### 7.1 CLI (`splicewright`)
```
splicewright init [--fps 30 --size 1920x1080]  # also AGENTS.md, CLAUDE.md, .mcp.json
splicewright import <paths...> [--no-ingest]  # register + ingest; files outside the project are copied into raw/
splicewright ingest [--only probe,proxy,reverse,analysis,thumbs,waveform,transcript,beats,loudness] [--jobs N]
splicewright status                         # compact JSON summary (see get_summary)
splicewright op <opName> '<json args>'      # any core op
splicewright open                           # start the UI for the current folder
splicewright still --at <frame|timecode> -o f.jpg
splicewright render [-o out/final.mp4] [--preset draft|master] [--range a-b]
splicewright mcp                            # MCP server over stdio
splicewright migrate video-cut <path>       # one-off importer (§11)
```
All commands print one concise JSON object on stdout; logs go to stderr or files.

`init` also writes the agent setup, keeping any file that already exists (so it can be re-run in an
existing project): `AGENTS.md` (the per-project brief and notes, from `packages/cli/src/AGENTS.template.md`),
`CLAUDE.md` (`@AGENTS.md`, for Claude Code) and `.mcp.json` (adds a `splicewright` server that runs this CLI's
`mcp` by absolute path). How to use the tools is not in AGENTS.md: it is the MCP server's `instructions` (§7.2),
so it stays current with the tools. Project state is not in AGENTS.md either: agents read it with `get_summary`.
`init --refresh-agents` rewrites `AGENTS.md` from the current template and `meta`, keeping its `## Brief` and `## Notes` sections.
`init` also copies bundled animation and art-direction skills (including references, component templates and optional-engine setup scripts) to `.agents/skills/`. Existing files are preserved. Managed content hashes in `.splicewright/agent-skills.json` allow `--refresh-agents` to update unchanged shipped files while preserving local edits; missing/invalid tracking data never authorizes overwriting existing skills. The CLI's web `onInit` hook uses the same provisioning path. Animation/style choices are recorded in the project's existing Notes.

### 7.2 MCP server
Write tools map 1:1 to core ops (`splicewright_split`, `splicewright_trim`, …, `splicewright_batch`).
Read tools are designed for token budget:

| Tool | Returns |
|---|---|
| `get_summary` | Tracks, item counts, total duration, markers. No per-item detail. ~1 KB. |
| `get_range` | Items + captions intersecting [a, b], with ids, timings, labels, notes. |
| `get_item` | One item, its asset metadata, and transcript text in its visible range. |
| `find` | Search transcripts, labels, notes → matching items/ranges. |
| `find_fillers` | Filler words and long silences → per item, source ranges (asset s) to feed `cutRanges` (§13.5). |
| `inspect_asset` | Metadata + transcript + contact-sheet path (image), no video. |
| `still` | Rendered frame at t (JPEG, ≤ 960 px wide): what the composition actually shows. |
| `peek` | Grid of n frames (~320 px tiles) from a video asset's source range + tile times. Reads the analysis proxy when its spacing allows. |
| `storyboard` | Grid of n composition frames from a timeline range + tile frames: the edit at a glance. |
| `render` | Starts a render job → job id; `render_status` polls it. |

The server sends `instructions` on connect (the workflow: read cheaply before cutting, batch edits,
baseRevision and conflicts, shared undo); the text is `INSTRUCTIONS` in `packages/mcp/src/server.ts`.

Every write tool accepts `baseRevision` (optional; if omitted, uses latest) and returns the new
revision plus a one-line change summary.

### 7.3 Web UI
Evolves from `video-cut/apps/editor`. Every mutation goes through core ops.
- v1 panels: media bin (assets + thumbnails), player (Remotion Player), inspector, timeline
  (N tracks, ruler, markers, playhead, snapping, thumbnails on video items, waveforms on audio items).
- Playback state (current frame) is isolated from the project state, so ticking the playhead
  re-renders only the playhead and timecode (fixes the 60 Hz full-app re-render).
- Proxy toggle uses **edit proxies** (smooth), not the 0.5 fps analysis proxies.
- Server binds to `127.0.0.1` by default.
- Keyboard: Space, ←/→ (±1 frame), Shift+←/→ (±10), J/K/L shuttle, Up/Down (previous/next edit),
  Alt+←/→ (previous/next keyframe), S or Cmd+B split (plain `C` is not used, so Cmd+C stays copy), Delete / Shift+Delete (ripple),
  Cmd+X (cut), Cmd+I (Import…), Alt+S (detach audio), X (range from selection), F (fullscreen preview),
  Shift+Up/Down (also beats and captions), Home/End, `[` / `]` (selected clip's start/end), Cmd+A (select all),
  Cmd+Z / Cmd+Shift+Z. The History button lists both stacks (`GET /api/history`); picking an entry sends
  `POST /api/undo|redo {steps, baseRevision}`. Every non-GET API request with a foreign `Origin` is refused.
- Editing (all through ops, one undo step per gesture):
  - Cmd+C / Cmd+V paste at the playhead (Cmd+Shift+V inserts and pushes later items), Cmd+D duplicates after the selection.
    Items go back to their track, else the first unlocked track of the same kind; anchored captions follow their video.
  - Drag on an empty lane draws a selection box (Shift adds, Cmd toggles); a click seeks and selects the gap there.
    Only the ruler scrubs. Dragging one of several selected items moves them all in time, never across tracks.
  - I / O set a range (mirrored in the URL hash, handles on the ruler), Alt+X clears it, `/` loops it.
    With a range and no selection: Split cuts at both ends, Delete lifts it, Shift+Delete extracts it; Fit to beats uses it.
  - Right-click menus on items, lanes, ruler, markers and track headers.
  - Import… button, or drop files on the bin or timeline: `POST /api/import?name=` streams into `raw/`
    (same-origin only, empty bodies refused, duplicate content resolves to the existing asset), probes, then ingests in the background.
    HEIC/HEIF photos (which Chrome can't decode) are converted to a JPEG beside the original in `raw/` by ffmpeg, here and in
    `splicewright import`; `importAsset` alone refuses them, so an agent is told to import them through the CLI.
  - Tracks: double-click to rename, magnet toggle, drag the header to reorder, +V/+A/+C/+O row; dropping media below the tracks makes a new one.
  - Markers: M adds, Alt+M removes the one at the playhead, click jumps, double-click renames; Up/Down also stop at markers.
  - Alt-drag a video item's body slips it (the player shows the new first frame; stops at the source edges); Alt+, / Alt+. slip one frame.
    Alt-drag a caption or overlay re-attaches it to the video under its new start.
  - Double-click a caption to edit it in place: Enter saves, Shift+Enter breaks the line, Esc cancels, Tab saves and edits the next.
  - Audio and video items show fade-in/out handles and a volume line (0–2, with dB) on hover or selection.
  - Video item menu and inspector: Speed… (setSpeed), transition into the next item (dissolve, dip to black, wipe, slide, push, zoom; the
    inspector sets wipe/slide/push `direction`), PIP presets (`PIP ▾` and the item menu);
    the timeline marks each transition across its cut.
  - With one video item selected under the playhead, a box on the player drags its transform: body moves (snaps to center, Alt bypasses),
    corners scale, the top knob rotates (Shift: 15°), double-click resets. The box fits the visible picture (probed size).
    Shift+C (or the inspector's crop button) swaps in crop edges; double-click uncrops, Esc leaves crop mode.
    Shift+K (or the mask section's button) swaps in the mask's box: drag inside moves it, corners resize; keyed
    maskX/Y/W/H take a key at the playhead. Video items only; Esc leaves mask mode.
  - Inspector effect and crop sliders preview live while dragged and commit one `setProps` on release (one undo step);
    double-click a slider resets it. ◇ beside a field keys its value at the playhead (◆: a key is here, click removes it);
    ◇ in the transform, effects and mask headers does the whole section in one `batch`: keys every field (◈: some are
    keyed here), or removes them all when all are;
    once a prop has keys, editing it (field, slider, or the preview box) keys it at the playhead. Items show a diamond per
    keyed frame; clicking one seeks there. Look ▾ applies a preset (B&W, Noir, Warm, Cool, Vintage, Vivid, Faded) as `effects`.
  - Freeze frame (Shift+F, item menu): `POST /api/freeze {itemId, frame}` grabs the source frame into `raw/` as a PNG and imports it
    (its own undo step), then a batch splits the clip and ripple-inserts 2 s of the still on that track only.
  - Lane menu: remove all gaps on a track, insert space (pushes items starting after the frame on every unlocked track),
    select all after here (track or all). Track menu: select all on track, Export SRT (caption tracks, client-side).
  - Media bin menu: Replace selected clip keeps start, length (clipped to the new media), props and anchored items.
  - Shift+M adds a range marker around the selection; the marker menu sets its color.

---

## 8. Ingest pipeline

v1 ports the working Python scripts from `video-cut/scripts/` as-is, made generic (no hardcoded clip
ids or paths), and invokes them from the CLI. Steps, each cached by fingerprint:

> **As built (M5):** `@splicewright/ingest` runs the ffmpeg steps (probe, proxies, thumbs, waveform)
> from Node; only transcript and beats are Python (`ingest/*.py`, venv per `ingest/requirements.txt`,
> interpreter from `SPLICEWRIGHT_PYTHON` → `ingest/.venv` → `python3`). A missing Python module skips
> that step with a hint instead of failing the run. Cache files are keyed by asset id; the fingerprint
> lives in `assets.json` per step. `scenes` is not implemented (nothing consumes it yet).

| Step | Output | Notes |
|---|---|---|
| probe | `assets.json` | ffprobe: duration, fps, size, rotation, audio streams |
| edit proxy | `proxies/edit/*.mp4` | 540p, source fps, all-intra, VideoToolbox when available |
| analysis proxy | `proxies/analysis/*.mp4` | 360p, 0.5–1 fps (current `make_proxy.py`) |
| thumbs + contact sheet | `thumbs/`, `contact-sheets/` | |
| waveform | `waveforms/*.json` | peaks for UI |
| transcript | `transcripts/*.json` | faster-whisper / mlx-whisper, asset time; segments carry `words: [{ start, end, text }]` (format 2) |
| scenes | `scenes/*.json` | optional |
| beats | `beats/*.json` | audio assets only; see §15.3 |
| loudness | `assets.json` (`loudness`, LUFS) | ffmpeg `ebur128` integrated loudness; assets with an audio stream. Silent assets (−70 LUFS gate floor) get no value. Runs by default on import (it is in `STEPS`) and decodes the whole audio once per asset. Read by `normalizeLoudness`. |

Concurrency is configurable (default: cores − 2). Hardware acceleration is detected, not assumed,
so the tool also runs on Linux.

---

## 9. Render

- `@splicewright/render` provides one Remotion composition, `SplicewrightProject`, that renders any
  `project.json`. It draws tracks bottom to top with `<Sequence from={start} durationInFrames={duration}>`.
- Built-in components (v1): `Text`, `Image`, `CaptionLayer` (styleable).
- Agent-authored custom overlays can import `splicewright/animation` in both preview and render: seeded `SketchPath` (Rough.js), `MorphPath` (Flubber), Remotion `Lottie`, and selected SVG shapes. These are authoring helpers, not new timeline item kinds or user controls. Optional Motion Canvas/Manim scenes are prepared in isolated project-local folders and imported as rendered media.
- Props: `project`, `duck` (speech ranges), and `sizes` (coded asset size from the probe; crop and the
  editor's transform box use it to find the fitted picture, else the picture is taken to fill the frame).
  `effects` is a CSS `filter` and `crop` a `clip-path: inset()` on the media element.
- Audio: per-item volume, fades, and `duck` (implemented; the current `duck_under_speech` field is
  declared but never used by `Vlog.tsx`).
- Custom components are registered in `splicewright.config.ts`:
  ```ts
  import { defineConfig } from "splicewright";
  import { Polaroid } from "./components/Polaroid";
  export default defineConfig({
    components: { Polaroid },                         // OverlayItem.component === "Polaroid"
    presets: { master: { crf: 18, hardwareAcceleration: "if-possible", concurrency: 8 } },
  });
  ```
  The UI and the renderer both load this file (via the Vite / Remotion bundler), so custom
  components preview and render the same way.

---

## 10. Repository layout and stack

```
splicewright/
├── packages/
│   ├── core/        # schema (zod), ops, validate, history, persistence — no DOM, no Node-only APIs except in persistence
│   ├── render/      # Remotion composition + built-in components
│   ├── cli/         # bin: splicewright (includes `mcp` subcommand)
│   └── mcp/         # MCP tool definitions over core
├── apps/web/        # timeline UI (Vite + React 19)
├── ingest/          # Python ingest scripts + requirements.txt
└── examples/        # tiny sample project used by tests
```
- TypeScript, npm workspaces (matches `video-cut`), vitest, zod, `@modelcontextprotocol/sdk`, Remotion.
- Tests: every core op has unit tests, including a property-style test that random op sequences never
  break the §4.4 invariants. The render package has a still-frame snapshot test on `examples/`.

---

## 11. Migration from `video-cut` (v1 acceptance test)

`splicewright migrate video-cut <path>` converts the existing project. Mapping:

| video-cut | splicewright |
|---|---|
| `sections[].clips[]` (sequential) | items on magnetic track `V1`, `start` accumulated in frames |
| `clip_id` | `assetId` (via source path) + fresh item `id`; the old id kept in `label` |
| `source_in` / `source_out` | `sourceIn` + `duration = round((out − in) × fps)` |
| `live_audio_volume`, `rotation`, `fit`, `role`, `description` | `volume`, asset/transform rotation, `fit`, `role`, `note` |
| `music_tracks[]` | audio track `A1` items; `duck_under_speech` → `duck` |
| `custom_video_tracks` / `custom_audio_tracks` | additional video/audio tracks |
| `sections[].id` | markers |
| `SECTION_TITLES`, `CONCERT_SONGS` (hardcoded in `Vlog.tsx`) | overlay items `LocationCard` / `NowPlayingCard` |
| `POLAROID_MOMENTS` / `plan.polaroids` | overlay items `Polaroid` |
| `isIntroTitle` hardcode, `component: "FilmStrip"` | overlay items `IntroTitleCard` / `FilmStrip` |
| `work/subtitles_correction.json` (clip_id + source times) | anchored caption items |
| the `clip_0041` special case in `apply_subtitles_correction.py` | resolved by anchoring; to be verified during migration |

The vlog-specific components move into the `video-cut` project's `components/` and are registered in
its `splicewright.config.ts`.

**v1 is done when:** the migrated Kaohsiung vlog renders with Splicewright, and a frame comparison
against a render from the current pipeline, sampled at every cut ±1 frame and every 2 s, shows no
missing clips, no caption desync, and total duration within 1 frame. Differences are listed and
explained, not hidden.

---

## 12. Milestones

| # | Deliverable | Exit check | Status |
|---|---|---|---|
| M1 | `core`: schema, ops, validate, history, persistence + tests | invariant property test green | ✅ done |
| M2 | `cli` + `mcp` over core; `migrate video-cut` | agent can split/trim the migrated project via MCP; `validate` passes | ✅ done |
| M3 | `render`: generic composition, config loader, captions, ducking | §11 acceptance comparison | ✅ done (frames; audio not compared) |
| M4 | `apps/web` ported to core ops, file watching, edit proxies, thumbs/waveforms; adaptive ruler + snapping (§15.1–15.2) | manual pass over §7.3 checklist; `rulerTicks`/`snap` unit tests | ✅ done (UI plays edit proxies if present; generating them is M5) |
| M5 | `ingest` generic port | fresh project from raw files → first render with no manual steps | ✅ done (no `scenes` step) |
| M6 | Beat detection + beat ops (§15.3–15.4) | synthetic click track within ±1 frame; `fitToBeats` on a photo slideshow | ✅ done (real-music F-measure: tool `ingest/beat_eval.py` ready; number pending a hand-tapped reference) |
| M7 | New-project flow + aspect presets (§13.1) | `open` in an empty folder → form → project renders; recent list only opens listed paths | ✅ done (browser pass by hand; switch fallback path untested) |
| M8 | Masks + blend modes (§13.2) | still-frame snapshots per shape, feather, invert; mask keyframes survive split/trim | ✅ done (pixel probes on an ellipse, an inverted feathered rect and blend; other shapes by `maskStyle` string tests; player mask box (Shift+K) for video items, not overlays; 90°/270° assets unrendered) |
| M8.5 | Shortcuts from the CapCut comparison (§13.2a) | each new key has a menu or button showing it; `detachAudio` op tested (split/undo keep audio in sync) | ✅ done (keys verified by hand; detach is Alt+S, not CapCut's Cmd+Shift+S) |
| M9 | Audio: item keyframes, loudness, master limiter (§13.3) | volume keys on an audio item survive split/trim; `loudness` step within ±0.5 LU of ffmpeg `ebur128` | ✅ done (limiter render-only, -1 dBFS before AAC, ≤ ~1 dB overshoot after; toggled by `setMeta`) |
| M10 | More transitions + PIP presets (§13.4) | still-frame snapshot mid-transition per kind; handles invariant (§4.4 #4) holds | ✅ done (mid-frame still per kind at t=0.5, up/down covered by `look()` string tests only; PIP `border` not built; UI verified by typecheck only) |
| M11 | Transcript cuts: fillers and silences (§13.5) | on `examples/`, one `batch` removes the listed words; anchored captions stay in sync | ✅ done (unit-tested on synthetic transcripts; `findFillers` checked on real Whisper word output from TTS speech, zh + en; the re-transcribe path is not run end to end; no CLI verb for `findFillers`, MCP only) |

---

## 13. Roadmap (M7–M11, in build order) and later candidates

Each milestone is a core op and/or schema extension, then render, then UI, then MCP/CLI exposure
(automatic, since they wrap core ops). Every new field is **optional**, so existing projects stay valid
and `schemaVersion` stays 1; bump it only for a change that alters the meaning of an existing field.
Everything renders through the DOM/CSS Remotion composition, so preview and render stay identical;
features that would break that (EQ, pan, LUT, chroma key) are deferred on purpose.

References: OpenCut classic (MIT, archived, `github.com/OpenCut-app/opencut-classic`), borrowed for
design, not code: its masks and blend modes partly live in a Rust/WASM compositor, ours are CSS.
video-use (`github.com/browser-use/video-use`) for transcript-driven cutting; video-autopilot-kit
(`github.com/Hao0321/video-autopilot-kit`) for caption styling and pre-export checks.

### 13.1 M7 — New-project flow and aspect presets
Today a project needs `splicewright init` then `splicewright open`, and the server serves one folder.
- `splicewright open` in a folder without `project.json` serves a **New project** form instead of an
  error: title, aspect preset, fps. Submit calls the existing `init()`; importing happens afterwards in the editor through the normal Import/drop flow.
- Aspect presets: 16:9 (1920×1080), 9:16 (1080×1920), 1:1 (1080×1080), 4:5 (1080×1350); fps 24/25/30/60.
  `init --preset 9:16` does the same from the CLI (`--preset` and `--size` together is a usage error).
  The table lives in `packages/core/src/presets.ts`. The form posts to `POST /api/init`; the cli passes
  `onInit` (its `agentFiles`) into `open()`, so web never imports cli. Until a project exists every
  `/api` route except `GET /api/project` (`{ dir, empty: true }`) and `POST /api/init` answers 409.
- Recent projects: `~/.splicewright/recent.json` (path, title, last opened), written by `open`, listed
  on the form page. **Security:** the server switches only to a path in that list or the folder it
  was started in, never to an arbitrary path from the browser; the foreign-`Origin` refusal (§7.3) and
  the `127.0.0.1` bind stay. `SPLICEWRIGHT_HOME` overrides the home dir (tests). `POST /api/switch { path }`
  (403 unlisted, 404 no `project.json`) closes the Vite server and starts a new one on the same port
  with the new folder (the folder is baked into its config); the client polls, then reloads, which
  also restarts the file watcher and clears undo UI state.
- Reference: OpenCut classic `apps/web/src/app/projects/page.tsx`, `core/managers/project-manager.ts`,
  `fps/presets.ts`.

### 13.2 M8 — Masks and blend modes
```ts
// on VideoItem and OverlayItem
type Mask = { shape: "rect" | "ellipse" | "diamond" | "star" | "polygon";
              x: number; y: number; w: number; h: number;   // fractions of the fitted picture box (the one crop is
                                                            // measured in, before crop); x,y top-left; w,h > 0; may leave 0..1
              radius?: number;                              // rect only: corner radius, 0..0.5 of min(w, h)
              points?: [number, number][];                  // polygon only (and required for it): >= 3, fractions of the mask box
              feather?: number;                             // px at output resolution, 0..200
              invert?: boolean };
type Blend = "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "difference";
```
As built: no heart (needs an SVG path, not a CSS basic shape) and no mask rotation. Overlays measure the box
against the whole frame (they have no picture).
- Render: `maskStyle(mask, frame, pic)` in `Composition.tsx` returns the CSS for a wrapper that fills the frame
  and centres the media, so it clips after the media's own crop. Plain shapes → `clip-path` (`inset(... round r)`,
  `ellipse()`, `polygon()`; star and diamond are fixed polygons). Feather or invert → one `mask-image`: an inline
  SVG of the shape (`feGaussianBlur` with σ = feather / 2; invert cuts it from a full rect with an SVG `<mask>`).
  The wrapper sits inside the item's transform layer, so the mask moves and scales with the item; it stays upright
  when the item is rotated. `blend` → `mix-blend-mode` on that layer (for overlays, on a wrapper around the component).
- Keyframes (video only): `maskX`, `maskY`, `maskW`, `maskH`, `maskFeather` join the keyable props (source time, as §4);
  a keyed prop overrides the matching `mask` field. Keying one on an item without a mask is an error.
- UI: inspector Mask section (shape, x/y/w/h/feather/radius sliders with live preview, ◇ keying and double-click
  reset as for effects; invert; blend). A shape pick starts centred, w = h = 0.6. Shift+K drags the
  mask's box on the player (move, corner resize; any shape, since all fill x/y/w/h). Polygon points are not draggable.
- Circle picture-in-picture is `mask: { shape: "ellipse" }` plus `transform`; no separate feature.
- Reference: OpenCut classic `apps/web/src/masks/` (builtin shapes, `feather.ts`, freeform path,
  `toggle-mask-inverted.ts`) and `rust/crates/compositor/src/blend_mode.rs`.
- Not included: chroma key and luma key (need per-pixel canvas/WebGL; see Later).

### 13.2a M8.5 — Shortcuts (from a CapCut/剪映 comparison)
Most of CapCut's editing keys already exist (§7.3). Deliberate differences stay: Cmd+D duplicates (Esc deselects),
S splits, no tool modes (A/B/V/C/H/Z), `+`/`-` zoom (Cmd+= zooms the browser page), no Cmd+S (every op is saved),
Cmd+N/Cmd+O are the browser's (the M7 form and Recent… cover them). Added:

| Key | Action | Notes |
|---|---|---|
| Cmd+X | Cut | copy, then delete, as ONE undo step (a `batch`) |
| Cmd+I | Import… | opens the existing file picker |
| X | Range from selection | I/O set to the selection's outer span; Alt+X still clears |
| Alt+← / Alt+→ | Previous / next keyframe | on the selected item (else the item under the playhead); Cmd+← is the browser's Back on macOS |
| Alt+wheel | Scroll the timeline horizontally | plain wheel stays vertical; Cmd+wheel still zooms |
| Alt+S | Detach audio | CapCut's Cmd+Shift+S is taken by the macOS screenshot shortcut, which a page can't intercept. New op `detachAudio {itemId}` (see §5). Volume keys move to the audio item (M9); `speed` ≠ 1 is refused. |
| F | Fullscreen preview | Player's fullscreen; Esc leaves. Not Cmd+F (browser find) |

**Discoverability:** every action that has a key shows it where the action lives: context-menu entries through the
existing `hint` field (`edit.ts`, rendered as `<kbd>`), toolbar and inspector buttons in their `title` tooltip
(e.g. `Import… (⌘I)`). New menu entries: Cut, Detach audio, Previous/Next keyframe (item menu); Range from selection (lane menu).
The key and its label come from one place per action so they can't drift apart.
Not added: export (Cmd+E, needs a render-from-server job), group/ungroup (Cmd+G, §13.6), hide one clip (V, schema),
batch split and linkage toggle (behaviour not pinned down).

### 13.3 M9 — Audio: item keyframes, loudness, master limiter
Already built: item volume, fades, ducking, volume keyframes on video items.
- **Audio item keyframes:** `AudioItem.keyframes` with prop `volume` only, same shape and semantics as
  video keyframes (source seconds), so `setKeyframe` accepts audio items. UI: the existing volume line
  gains keys on click, like the ◇ inspector button.
- **Loudness:** new ingest step `loudness` (ffmpeg `ebur128`) caches integrated LUFS per asset in
  `assets.json`. Op `normalizeLoudness { itemIds, target = -14 }` sets each item's `volume` so its asset
  hits the target (clamped to 0..2); it is an ordinary `setProps` batch, undoable.
- **Master limiter:** `meta.limiter?: boolean` (default off for existing projects, on for new ones).
  **As built: render only.** Remotion's `<Audio>` exposes a per-frame `volume` curve, not a node graph, so
  `render()` runs an ffmpeg pass after `renderMedia` (`-c:v copy -af alimiter=limit=0.891:attack=1:release=120:level=disabled`,
  0.891 ≈ −1 dBFS) and replaces the output. `level=disabled` is required: alimiter's default auto-level
  scales the peak back up to 0 dBFS. The preview has no limiter (no Web Audio), so it can differ from the
  render on peaks above −1 dBFS. The limiter sets a −1 dBFS sample peak before encoding; after AAC, peaks can
  overshoot by up to ~1 dB on dense, loud material (measured 0.3–1.2 dB on pink noise) but do not clip. A strict
  post-encode −1 dBTP would need true-peak detection or a measure-and-re-encode pass; deferred. Existing projects stay off; `setMeta { limiter: true }` turns it on.
  As built also: audio item volume keys are edited through the inspector slider + ◇ button and drawn as ◆
  on the item; `normalizeLoudness` is its own op (not a `setProps` batch) so it can check loudness and keys.
- Reference: OpenCut classic `apps/web/src/media/audio-mastering.ts` (limiter: −1 dB threshold,
  ratio 20, 1 ms attack, 120 ms release).
- Deferred: EQ, pan, noise reduction (no per-frame equivalent in the render path; would need baked audio).

### 13.4 M10 — More transitions and PIP presets
- `transition.kind` adds `slide`, `push`, `zoom`, and `wipe` gains `direction?: "left"|"right"|"up"|"down"`
  (default `left`, today's behaviour). Each is one more branch in `look()` in `Composition.tsx`;
  handle rules follow dissolve (both sides need `duration/2` of source).
- Picture-in-picture presets (inspector and item menu): corner (TL/TR/BL/BR at 30% scale, 4% margin),
  side-by-side, circle (uses the M8 ellipse mask). Presets only write `transform`/`mask`; no new schema.
  Optional `border?: { width: px; color }` and rounded corners come from the mask `radius`.
- More Look presets as data (still `effects`); LUTs stay deferred.
- Reference: Remotion's `@remotion/transitions` presentations *(names unverified)*.
- **As built:** `direction` is the side the incoming picture enters from (default `left`); wipe, slide and push
  use it, the others ignore it. `look()` (exported) also returns `dx`, `dy` (frame fractions) and `zoom`;
  slide moves only the incoming item, push also shoves the outgoing one out the opposite side, zoom fades the
  incoming item in while it settles from 1.25× and the outgoing one grows to 1.25×. `transitionOf` carries
  `direction`. PIP is the pure `pip(p, item, size, preset)` in `Composition.tsx` (`tl|tr|bl|br|left|right|circle`);
  placement targets the visible region (mask box, else crop box, else the whole picture), other transform
  fields survive, rotation is ignored. Side presets scale the visible region to fit its half. `border` is not
  built (needs a schema field). Looks added: Cinematic, Sepia, Fresh.

### 13.5 M11 — Transcript cuts: fillers and silences
- Ingest `transcript` gains word timestamps (faster-whisper `word_timestamps=True`):
  `segments[].words: [{ start, end, text }]`. Today segments carry no words (`ingest/transcribe.py`).
  Assets transcribed before this re-run the step (fingerprint includes a transcript format version).
- Query `findFillers { itemId?, words = ["um","uh","嗯","那個","就是"], minSilence = 0.6 }` returns source
  ranges (words, and gaps between words longer than `minSilence`), padded 2 frames each side.
- Op `cutRanges { itemId, ranges: [sourceStart, sourceEnd][], ripple = true }`: splits and ripple-deletes
  each range in one batch (one undo step); anchored captions follow via the existing split logic.
- Agent workflow (AGENTS.template.md): propose the cut list first, cut only after the user confirms,
  then `still`/contact sheet to self-check (video-use's ask → confirm → execute → self-eval).
- Reference: video-use's `pack_transcripts.py` (compact transcript for the LLM) and `timeline_view.py`.
- **As built:** ranges are **source seconds** (asset time, the unit of `sourceIn` and of the transcript), so they
  are stable across speed changes and match what `find`/`inspect_asset` show. `findFillers` (MCP `find_fillers`;
  no CLI verb, the CLI only runs ops) returns `{ items: [{ itemId, assetId, ranges, what }], hints? }`. A filler
  word grows by 2 frames each side; a silence *shrinks* by 2 frames each side so the cut never clips the
  neighbouring words (deviation from "pad each range"). Silences are gaps between consecutive words only, not
  before the first or after the last. Ranges are clamped to the item's visible source and merged. Items whose
  transcript lacks `words` come back in `hints` (`ingest --only transcript`); the step re-runs because its
  done-stamp is `fingerprint#t2` (`TRANSCRIPT_FORMAT` in `packages/ingest/src/index.ts`). `cutRanges` calls
  `split` and `delete` internally (overlapping ranges merge, out-of-item ranges are ignored, nothing left = no-op
  message but still a revision). Splitting drops `fadeOut` on earlier pieces and `fadeIn` on later ones, and a
  cut that removes an item's tail also removes its `transition`. Whisper writes Mandarin in simplified characters
  even for Taiwanese speech (checked with `say -v Meijia`: 那个, and 呃 heard as 二), so the default word list
  also has 那个; 呃 is not reliably transcribed.

### 13.6 Later (not scheduled)
Fonts, caption styles, themes, color grading, LUTs, curves, chroma/luma key and beauty moved to
**SPEC-LOOK.md** (built-in fonts are done there). The rest is specced in §13.7. Still unspecced: keyframes on
overlay props, nested sequences.

### 13.7 Next candidates (non-look)
Same rules as §13 and SPEC-LOOK.md §1: preview and render run one program, so a process either renders in the
composition or bakes a file that both sides play.

- **A1 Audio processing (EQ, pan, noise reduction).** `audioFx?: { eq?: { hz: number; gain: number; q?: number }[];
  pan?: number /* -1..1 */; denoise?: { kind: "rnnoise" | "fft"; mix?: number; model?: `raw/<name>.rnnn` } }` on audio and video items.
  Remotion's `<Audio>` has no EQ or pan, so this is **baked**: ffmpeg `equalizer`, `pan`, `arnndn` (RNNoise;
  ship one model file from `richardpl/arnndn-models`) / `afftdn` (all present in ffmpeg 9.0.1 here) render the whole
  source to `.splicewright/audio/<assetId>-<hash of audioFx>.m4a`, and the item plays that file in both preview
  and render. The item shows "processing…" until the file exists; the render refuses items whose file is
  missing. Loudness (M9) is measured on the baked file. Later: DeepFilterNet (MIT/Apache) as a better `denoise`
  kind through its `deep-filter` CLI (48 kHz WAV only). Acceptance: a 1 kHz tone + pink noise: `eq` −12 dB at 1 kHz
  lowers the tone by 12 ± 1 dB; `pan: -1` leaves the right channel silent; `denoise` lowers noise-only RMS.
  **As built (partial, 2026-10-01):** EQ, pan, FFT denoise, baked preview/render selection, per-item baked loudness, render preflight, and user-supplied RNNoise models are implemented. A custom RNNoise model must be a `.rnnn` file under `raw/`; its content hash invalidates the bake cache. No model is bundled or downloaded. Built-in model distribution remains deferred because the referenced upstream model repository has no model license statement.
- **E1 Bezier ease.** Keys gain `ease: [x1, y1, x2, y2]` besides `"linear" | "ease"`. Core evaluates it with its own
  cubic-bezier solver (Newton + bisection, ~20 lines), since core does not depend on Remotion. UI: presets
  (ease-in, ease-out, ease-in-out, overshoot) on a key's context menu. Acceptance: the solver matches CSS
  `cubic-bezier()` reference values within 1e-3. ✅ done: `Ease` schema, `bezier()` in `keyframes.ts`, key diamond right-click presets in the timeline.
- **S1 Stickers and GIF.** Built-in overlay component `Sticker { src, fit }` over Remotion's `<AnimatedImage>`
  (public in `remotion` 4.0.520; GIF, animated WebP/PNG), looping over the item. `.gif`/`.webp` import as image
  assets marked animated at probe time. Acceptance: two stills a few frames apart differ on an animated GIF.
  ✅ done: built-in Sticker UI/render path, animated-image probing, and deterministic GIF progression/loop/item-end test.
- **R1 Reverse.** `reverse?: boolean` on video items. `@remotion/media` `<Video>` can't play backwards and
  `OffthreadVideo` would seek frame by frame, so ingest bakes a reversed proxy (ffmpeg `reverse` + `areverse`, in
  ~10 s chunks and concatenated, since `reverse` buffers the whole input). `sourceIn` keeps meaning source time
  on the forward file. Acceptance: frame k of a reversed item equals frame (n−1−k) of the forward one. ✅ done: ingest reverses bounded ~10 s chunks with ffmpeg reverse/areverse and concatenates chunks in reverse order; sourceIn remains the lower bound of the forward-source selection, with trim, speed, transition, preview, and render time mapping handled in reverse.
- **Lint.** Read-only op `lint` → `{ level, what, at, itemId? }[]`: gaps on the magnetic track, captions or text
  outside the title-safe area, CJK text in a font without CJK glyphs, peaks above −1 dBFS without the limiter,
  items on the canvas path that can't decode. MCP instructions tell agents to run it before `render` master. ✅ done: `lint(project)` in core, CLI `splicewright lint`, MCP `lint`. Implemented: magnetic-track gaps, default-caption/Text inset vs title-safe (px insets only), CJK font. Not yet: peaks (no peak measurement is stored, only LUFS) and decode failures (no recorded probe signal).
- **Desktop wrapper.** Electron: rendering needs Node + Chromium, which Electron has; Tauri would need a bundled
  Node as a sidecar. Not before the web UI stabilises.

---

## 14. Open questions
1. **Remotion license.** The current editor sets `acknowledgeRemotionLicense`. Remotion's terms for
   companies differ from those for individuals; confirm on remotion.dev before a public release. *(unverified)*
2. **Repo visibility and license.** Public + MIT? (OpenCut classic is MIT, so borrowing code is fine either way.)
3. **CLI name.** `splicewright` is long to type; add a short alias (`swr`)?
4. **Asset ids.** Derive them from the filename (readable) or from the fingerprint (stable across renames)?
   Current proposal: from the filename, with the fingerprint stored alongside to detect renames.
5. **Where the UI runs.** A Vite dev server started by `splicewright open` (simple), or a prebuilt static
   bundle with a small Node server (faster startup, needed for npm distribution)?
6. **Beat detector.** Start with librosa (§15.3). Evaluate a learned model (madmom or Beat This!) only if
   librosa misses too many beats on real project music. License and maintenance status of both are
   *unverified*.
7. **Beat offset calibration.** Editors often cut a frame before the beat so it feels tight. Add a
   per-project `beatOffsetFrames` knob if real use shows the cuts feel late. Not in v1.

---

## 15. Timing aids: adaptive ruler, snapping, beat points

Three features that make fine timing adjustments fast, modelled on CapCut (剪映). They share one idea:
the timeline has a set of **snap points**, and every drag, whether a human's or an agent's, can be pulled
onto them.

All timeline positions are already integer frames (§2), so frame-level quantization is built in.
Snapping here means being *attracted* to meaningful points, not rounding to frames.

### 15.1 Adaptive ruler

The ruler above the tracks picks its tick spacing from the current zoom, so labels never crowd
together and never get too sparse.

- **Zoom is measured in px per frame**, on a log scale. The range runs from "fit the whole project" to
  about 24 px/frame, where single frames are easy to target. (The current video-cut editor tops out at
  180 px/s, which is 6 px/frame at 30 fps: too coarse for frame edits.)
- **Candidate steps**, in frames: `1, 2, 5, 10, 15` (only those below `fps`), then `1, 2, 5, 10, 15, 30 s`,
  `1, 2, 5, 10 min` (multiplied by `fps`).
- **Major tick** = the smallest candidate whose on-screen width is ≥ 80 px. It gets a label.
- **Minor tick** = the largest candidate that divides the major step evenly and is ≥ 8 px wide. No label.
- **Label format** follows the major step: below 1 s → `mm:ss:ff`; 1 s or more → `mm:ss`; 1 h or more → `hh:mm:ss`.
- Zoom anchors on the mouse cursor (pinch, or Cmd + scroll) or on the playhead (`+` / `-`).
  `Shift+Z` fits the whole project.
- Implemented as a pure function `rulerTicks(fps, pxPerFrame, visibleRange) → {major[], minor[], labels[]}`
  in core, with unit tests at several fps/zoom combinations (no two labels overlap, and ticks line up with
  frames exactly).

### 15.2 Snapping

**Snap targets**, in priority order (when two are equally close, the higher one wins):

1. Playhead (UI only)
2. Edges of other items on any track
3. Markers
4. Beat points (§15.3)
5. Caption boundaries
6. Major ruler ticks: off by default. Useful for evenly timed slideshows; toggled separately.

**Behaviour:**
- The threshold is set in **screen pixels** (default 8 px) and converted to frames at the current zoom,
  so snapping feels the same at every zoom level. It is never less than 1 frame.
- Moving an item tests both of its edges. Moving an audio item also tests its own beat points, so
  dragging the music can land a beat exactly on a video cut, and dragging a clip can land its edge on a beat.
- Trimming tests only the edge being dragged.
- While snapped, a vertical guide line appears with a short label (`beat`, `clip edge`, `marker`, …).

**Overrides:**
- A magnet toggle in the toolbar (key `N`) turns snapping on or off.
- Holding `Alt/Option` during a drag bypasses snapping for that drag only.
- Keyboard nudges ignore snapping: `,` / `.` move the selected item by 1 frame, `Shift` makes it 10.

**Core API**, shared by the UI and agents:
```ts
snapPoints(project, range, opts) → SnapPoint[]            // { frame, kind, ref }, cached per revision
snap(points, frame, thresholdFrames, exclude?) → { frame, target: SnapPoint | null }
```
For agents, any op argument that takes a frame (`at`, `to`) also accepts
`{ near: Frames, snapTo?: ("edge" | "marker" | "beat")[], within?: Frames }`. The core resolves it with the
same `snap()` the UI uses, so "put the photo on the beat near 12 s" means exactly one thing.

### 15.3 Beat detection (自動踩點)

**How automatic beat marking works.** This is the standard music-information-retrieval pipeline that
tools like librosa implement. CapCut's own implementation is not public.

1. **Onset strength.** Compute a spectrogram and measure, frame by frame, how much energy *increases*
   (spectral flux). The result peaks wherever a drum hits or a note starts.
2. **Tempo.** Autocorrelating the onset curve shows which spacing between peaks repeats most, which gives
   the BPM.
3. **Beat tracking.** Dynamic programming (Ellis, 2007) chooses a sequence of beat times that sit on strong
   onsets while keeping the spacing close to the tempo. This produces a steady grid that holds up through
   quiet passages, instead of just marking every loud sound.
4. **Downbeats (the "1" of each bar)** need the meter. Learned models detect them directly. The v1
   heuristic: assume 4/4 and pick the one-in-four phase whose beats have the most low-frequency onset energy.
   *(Known ceiling: wrong for 3/4 and for songs whose bass does not land on the one. The fix is a learned
   downbeat model, see §14.6.)*
5. **Strength.** Each beat keeps its onset strength, so the UI can offer densities.

CapCut offers two beat modes. As far as I recall, one marks every beat and the other a sparser set of
stronger beats *(unverified)*. Splicewright exposes this as an explicit density setting:

| Density | Keeps |
|---|---|
| `all` | every tracked beat |
| `strong` | beats whose onset strength is above the track's 60th percentile |
| `downbeat` | the first beat of each bar |
| `every:N` | every Nth beat, counted from the first downbeat |

**Implementation:**
- Ingest step `beats` (Python, in `ingest/`). v1 uses **librosa** (`onset.onset_strength`,
  `beat.beat_track`). It is pip-installable and fits the existing Python ingest. Output goes to
  `.splicewright/beats/<assetId>.json` (fingerprint tracked in `assets.json`) as
  `{ algo, version, tempo, beats: [{ t, strength }], downbeats: [t] }`, in **asset seconds**.
  Avoid GPL/AGPL analyzers (aubio, essentia, per my understanding; *verify*) if the repo is MIT.
- **Schema extension** (optional field, so no `schemaVersion` bump):
  `AudioItem.beats?: Seconds[]`. This is the chosen beat list in **asset time**, sorted. It lives in
  `project.json` so that manual edits persist and snapping never depends on the cache.
  `AudioItem.downbeats?: Seconds[]` is the subset of those beats that start a bar (set by `detectBeats`,
  kept in step by `removeBeat`/`clearBeats`; tapped beats are never downbeats). `get_range` reports both
  as frames (`beatFrames`, `downbeatFrames`).
- Like anchored captions (§4.1), beats are mapped to the timeline on the fly:
  `frame = start + round((t − sourceIn) × fps)`, keeping only the ones inside the item's visible range.
  Moving, trimming or slipping the music carries its beats along. Rounding to frames shifts a beat by at
  most half a frame (16.7 ms at 30 fps). *(Inferred: that is well below audible/visible sync error.)*
- **Display:** small ticks on the audio item's top edge (downbeats taller). When the item is selected,
  faint full-height guide lines run across all tracks.

### 15.4 Beat ops

| Op | Args | Semantics |
|---|---|---|
| `detectBeats` | itemId, density | Copies beats from the ingest cache into `item.beats`. Fails with a clear message if the `beats` ingest has not run. |
| `addBeat` / `removeBeat` | itemId, at (frame) | Manual correction. In the UI, pressing `B` during playback taps a beat at the playhead (tap-along). |
| `clearBeats` | itemId | |
| `fitToBeats` | trackId, audioItemId, { every?: N, range?, from? } | Beat sync (卡點). Walks consecutive items on a magnetic track and sets each cut onto the next beat (every Nth). Images: set the duration directly. Video: trim the end, never past the source. If a clip is too short to reach the next beat, it uses the nearest reachable beat and reports it. Runs as one `batch`, so it is one undo step. Returns a list of changed and skipped items. |

On the MCP side:
- `get_range` includes each audio item's beat frames within the range, as a compact integer list.
- `detect_beats` and `fit_to_beats` are write tools.
- Typical agent flow: "make the Day 2 photos change on every second beat of the Sneakers track" becomes
  `detect_beats(density: "all")` → `fit_to_beats(every: 2, range: marker "Day 2")`.

### 15.5 Acceptance checks
- `rulerTicks` and `snap`: unit tests (tick alignment, no label overlap, pixel-threshold behaviour at
  three zoom levels, priority ordering, Alt bypass is a UI concern and is not tested in core).
- Beats: `examples/` gains a synthetic click track generated by ffmpeg at a known BPM (e.g. 120 BPM with an
  accent every 4th click). Detected beats must be within ±1 frame of the truth, and downbeats must fall on
  the accents.
- Real music: tap a reference beat list by hand for one project song and report F-measure at a ±70 ms
  tolerance, the usual MIR evaluation window. This is a reported number, not a pass/fail gate, until we
  know what "good enough" feels like in the editor. Tap the reference with `B` in the UI on a cleared
  audio item, then run `python ingest/beat_eval.py <project> <itemId>` (greedy one-to-one matching, no
  warm-up trim; B lands on the playhead frame, so taps carry up to half a frame of quantization).
- `fitToBeats`: unit test on a slideshow of 8 images plus a synthetic beat list, checking that every cut
  lands on a beat and the total duration is correct.
