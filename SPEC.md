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
- Keyframe animation, masks, color grading, chroma key, speed ramps, transitions library, stickers.
  (These are OpenCut features we may add later — see §13.)
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
  meta: { title: string; fps: number; width: number; height: number; background?: string };
  assets: Record<AssetId, Asset>;
  tracks: Track[];                  // render order: index 0 is bottom-most
  markers?: Marker[];               // named ranges/points: chapters, notes, "sections"
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
  role?: string;                    // free tag: "talking_head", "broll", ...
}

interface AudioItem extends ItemBase {
  assetId: AssetId;
  sourceIn: Seconds;
  volume?: number;
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
Readable ids matter because agents quote them back.

### 4.4 Invariants (checked by `validate()` on every write)
1. `duration >= 1` and `start >= 0` for every item.
2. No two items on the same video/audio/overlay track overlap.
3. Every `assetId` exists in `assets`; every anchored caption's `itemId` exists.
4. `sourceIn >= 0` and `sourceIn + duration/fps <= asset.duration` (when probed duration is known).
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
| `closeGap` | trackId, at | Closes the empty span containing `at`; later non-anchored items shift left. |
| `setProps` | itemId, patch | Whitelisted fields only (volume, fit, transform, fades, props, label, note). |
| `slip` | itemId, deltaSec | Changes `sourceIn` only; timeline position unchanged. |
| `addTrack` / `removeTrack` / `setTrack` | … | Empty tracks are allowed (unlike OpenCut). |
| `moveTrack` | trackId, to | Moves a track to layer index `to` (0 = bottom). |
| `addCaptionsFromTranscript` | itemId, trackId? | Creates anchored captions from the asset transcript. |
| `editCaption` | captionId, text \| "" | Empty text hides the caption (replaces the `----` convention). |
| `addMarker` / `removeMarker` | … | |
| `setMarker` | markerId, patch | label, start, duration, color; keeps markers sorted by start. |
| `batch` | ops[] | Atomic: all or nothing, one revision, one undo step. |

Undo/redo: the history is an op log with inverse snapshots, persisted to `.splicewright/history/`.
**One op = one undo step.** The UI sends one op when the drag ends, not one per pointer move; during
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
splicewright import <paths...> [--no-ingest]  # register + ingest
splicewright ingest [--only probe,proxy,analysis,thumbs,waveform,transcript,beats] [--jobs N]
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

### 7.2 MCP server
Write tools map 1:1 to core ops (`splicewright_split`, `splicewright_trim`, …, `splicewright_batch`).
Read tools are designed for token budget:

| Tool | Returns |
|---|---|
| `get_summary` | Tracks, item counts, total duration, markers. No per-item detail. ~1 KB. |
| `get_range` | Items + captions intersecting [a, b], with ids, timings, labels, notes. |
| `get_item` | One item, its asset metadata, and transcript text in its visible range. |
| `find` | Search transcripts, labels, notes → matching items/ranges. |
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
  S or Cmd+B split (plain `C` is not used, so Cmd+C stays copy), Delete / Shift+Delete (ripple),
  Cmd+Z / Cmd+Shift+Z.
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
  - Tracks: double-click to rename, magnet toggle, drag the header to reorder, +V/+A/+C/+O row; dropping media below the tracks makes a new one.
  - Markers: M adds, Alt+M removes the one at the playhead, click jumps, double-click renames; Up/Down also stop at markers.
  - Alt-drag a video item's body slips it (the player shows the new first frame; stops at the source edges); Alt+, / Alt+. slip one frame.
    Alt-drag a caption or overlay re-attaches it to the video under its new start.
  - Double-click a caption to edit it in place: Enter saves, Shift+Enter breaks the line, Esc cancels, Tab saves and edits the next.
  - Audio items show fade-in/out handles and a volume line (0–2, with dB) on hover or selection.

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
| transcript | `transcripts/*.json` | faster-whisper / mlx-whisper, asset time |
| scenes | `scenes/*.json` | optional |
| beats | `beats/*.json` | audio assets only; see §15.3 |

Concurrency is configurable (default: cores − 2). Hardware acceleration is detected, not assumed,
so the tool also runs on Linux.

---

## 9. Render

- `@splicewright/render` provides one Remotion composition, `SplicewrightProject`, that renders any
  `project.json`. It draws tracks bottom to top with `<Sequence from={start} durationInFrames={duration}>`.
- Built-in components (v1): `Text`, `Image`, `CaptionLayer` (styleable).
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

---

## 13. Later (candidate features, informed by OpenCut classic)
Transitions, keyframes on `transform`/`volume`, text styles and templates, speed changes,
masks, color adjustments, multi-select and group operations, nested sequences, and a desktop wrapper
(Tauri or Electron). Each one is added as a core op plus a schema extension with a schemaVersion
migration.

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
