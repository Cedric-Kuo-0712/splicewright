# Splicewright — Project Guidelines

A file-first, agent-native video editor monorepo (`packages/core`, `packages/cli`, `packages/mcp`, `packages/ingest`, `apps/web`).

## Development & Build Commands

- **Unit tests**: `npm test` (Vitest across workspaces)
- **Targeted unit test**: `npx vitest run <path_to_test>` (e.g. `npx vitest run packages/core/test/ops.test.ts`)
- **Typecheck**: `npm run typecheck`
- **Web dev server**: `npm --workspace=@splicewright/web run dev`

## Coordinator & Subagent Architecture (Fanout & Cost Savings)

### 1. Decision Matrix: When to Fan Out vs. Execute Directly
Delegating to a subagent has a small startup cost (~10k tokens of base prompt/tools). Fanout is **NOT mandatory for trivial work**; the Coordinator should choose based on cost and context impact:

- **Execute Directly on Main Thread (No Subagent)**:
  - Scope: Single-file edits, typo/bug fixes, documentation or `SPEC.md` updates, quick tests (<5 turns expected).
  - Rationale: Spawning a subagent for minor work wastes tokens on dispatch overhead.
- **Delegate to Worker (`implement-agent`)**:
  - Trigger:
    1. The user explicitly requests it (e.g. "use subagent", "subagent-driven", "delegate to implement-agent").
    2. Full Milestone implementations (e.g. M10, M11...) requiring a new feature branch, multi-file changes, and iterative test-fix cycles.
    3. Tasks that produce heavy terminal outputs (vitest logs, build traces) that would otherwise pollute the Coordinator's context.
  - How: spawn via the Agent tool with `subagent_type: implement-agent` (fresh context — the brief is all it sees). Use `SendMessage` only to continue that same subagent (e.g. follow-up fixes after review).
  - *Note*: Even if the Coordinator is also running Sonnet, delegating heavy tasks is still strictly cost-effective because it keeps long test outputs isolated in the worker's ephemeral context.

### 2. Role Separation (When Delegating)
- **Coordinator (Architect / Reviewer)**:
  - Owns milestone scoping, task delegation, code review, git branching, and final verification.
  - **Do NOT perform deep exploratory searches or code edits before delegating.** Do not `grep` the entire codebase or `cat` multiple files just to construct the brief.
  - Read only the target milestone definition from `SPEC.md` using targeted `sed`/`grep`, then immediately dispatch.
- **Worker / Subagent (`implement-agent`)**:
  - Runs on Sonnet at low effort, set by `model`/`effort` in `.claude/agents/implement-agent.md` frontmatter.
  - Owns local code exploration, implementation, debugging, and running unit tests (`npx vitest run ...`).
  - Returns only a concise completion summary and test result. Intermediate bash logs and file diffs stay isolated in the worker context and do not bleed back to the Coordinator.

### 3. Self-Contained Delegation Brief
Subagents start with a clean context and know nothing about prior conversations. Every Agent tool prompt MUST be fully self-contained and specify:
1. **Target Milestone & Branch**: e.g., Milestone M10 on branch `feat/m10-transitions`.
2. **Acceptance Criteria**: Concrete functional requirements extracted from `SPEC.md`.
3. **Verification Command**: Explicit test command(s), e.g. `npx vitest run packages/render/test/transition.test.ts && npm run typecheck`.
4. **Touch Points**: Primary files to inspect or modify.
5. **Constraint**: Keep working tree clean/uncommitted for review, or commit with standard message.

### 4. Session Lifecycle & Milestone Boundaries
- **Never carry session context across milestones.** Running M7 through M10 in a single Coordinator session creates an exponential cache read cost ($45+ USD) and will trigger the 5-hour rate limit.
- **After each milestone is reviewed and merged, the Coordinator MUST ask the user to run `/clear` or start a fresh session** (`/clear` is user-only).
- 1M extended context is enabled and available when needed (e.g. `/model sonnet[1m]` or `opus[1m]`), but routine milestone work should stay within 200k to maintain speed and cost efficiency. If Coordinator context crosses 80k-100k tokens in standard workflows, compact or restart immediately.

## Two export routes: check both before adding a video or audio feature

`render()` (`packages/render/src/node.ts`, `pipeline: "auto"`) first tries the **layered** route and falls back to **Remotion** for the *whole* export when the planner throws `LayeredUnsupportedError`. The preview (Remotion Player) and the Remotion export both run `packages/render/src/Composition.tsx`; the layered route does video and audio in native ffmpeg (`layered.ts` planner, `layered-render.ts` filter graph) and only draws graphics with Chrome.

- **Graphics** (overlay components, captions, text): drawn once by `Composition.tsx` and used by both routes. Nothing to duplicate.
- **Anything that changes video pixels or audio** (a `VideoItem`/`AudioItem` field, transition, effect, mask, transform): lives in `Composition.tsx` (preview + Remotion export) and must either be implemented again in `layered.ts` + `layered-render.ts` or be refused in `planLayeredExport` so the export falls back. Never leave a field unhandled: the layered route would silently ignore it and the export would differ from the preview.
- A new `VideoItem` field must be added to `LAYERED_FIELDS` in `packages/render/test/layered.test.ts`; that test fails until you say whether layered renders it or refuses it, with a sample value for each.
- A refusal names the feature in its message (it becomes `job.fallbackReason`, shown in the web export card, the CLI and MCP). Keep it specific.
- To implement a feature in layered: add a pixel test in `layered-ffmpeg.test.ts` and mutation-check it (break the code, see the test fail); compare against a Remotion render of the same project with frames paired by index (`setpts=N/30/TB`), including a deliberately wrong pairing as a sensitivity control; benchmark layered vs Remotion in the same session, alternating, 3 reps (machine speed drifts ~40% between sessions).
- In a `.worktrees/*` checkout, `@splicewright/*` resolves to the main checkout unless `node_modules/@splicewright/*` is symlinked to the worktree's packages; link them first or edits to `packages/core` are invisible to tests.

## Token & Context Discipline for Splicewright

1. **Selective `SPEC.md` Reading**:
   - `SPEC.md` is >53 KB. **Never use `@SPEC.md` (file mention) in prompts**, as it injects all 53 KB (~14k tokens / 7% of context) into the conversation history.
   - Target only the section or milestone relevant to the current task using line-bounded slices (e.g. `sed -n 320,380p SPEC.md`) or `grep -n`.
   - Update `SPEC.md` §12 implementation status with surgical edits, never full rewrites.

2. **Zero Raw Media Reads (Image / Video / Audio)**:
   - **Never use the `Read` tool on image files (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) or video/audio (`.mp4`, `.mov`, `.wav`)**. Doing so dumps hundreds of thousands of Base64 characters directly into context.
   - An active `PreToolUse` hook (`.claude/hooks/block-raw-image-read.py`) blocks these reads automatically.
   - Always inspect media properties via CLI commands:
     - Image dimensions / EXIF: `sips -g all <file>` or `file <file>`
     - Media streams & duration: `ffprobe -v error -show_format -show_streams <file>`
     - Size & existence: `ls -lh <file>`

3. **Validation & Testing Boundaries**:
   - Verify core logic and CLI functionality via Vitest unit tests (`npx vitest run <path>`).
   - **Do NOT construct ad-hoc browser automation or CDP test suites** in temporary directories (e.g. `/tmp` or `drive.mjs`) to test the UI.
   - For UI changes, verify through TypeScript typechecking and component unit tests, then ask the human user to verify interactive behavior in the browser.
   - **Who verifies what.** CLI, MCP and the web UI all call the same core ops. A CLI check therefore proves that the op works, but it never runs the UI code that calls it.
     - *Agent verifies, and reports the command and result:*
       - op semantics: results, refusals, `validate`, and how many undo steps an edit takes (`node packages/cli/src/main.ts op …` / `undo`, run from the project folder);
       - project state: `lint` and `ls`/`ffprobe` on the files;
       - numbers: unit tests;
       - render output: stills with pixel probes, or keyed values read at chosen frames, for example to confirm that an ease curve or a LUT took effect.
     - *Human verifies in the browser, and only this:*
       - UI wiring: a menu item, button or shortcut is present and sends the right op, and disabled or locked states;
       - interaction feel: dragging, scrubbing, resizing;
       - Player-only behaviour (WebGL/WebCodecs in the browser, which differ from the headless render);
       - subjective quality: whether a look reads well, whether motion feels smooth, whether a layout is clear.
     - A manual-check list sent to the user has two parts. "Agent-verified" lists the command and result for each item. "Please check in the UI" lists only the wiring, feel and look items. Never send the user an item that the CLI, a test or a render can settle.

4. **Tool Selection**:
   - Always use native `Edit` or `Write` tools to modify TypeScript, JSON, or markdown files.
   - Avoid executing `sed -i` or inline `python3 - <<'EOF'` in Bash to patch repository code.
