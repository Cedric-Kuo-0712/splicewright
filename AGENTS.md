# Splicewright — Project Guidelines for Codex

A file-first, agent-native video editor monorepo (`packages/core`, `packages/cli`, `packages/mcp`, `packages/ingest`, `apps/web`).

## Development & Build Commands

- **Unit tests**: `npm test` (Vitest across workspaces)
- **Targeted unit test**: `npx vitest run <path_to_test>` (e.g. `npx vitest run packages/core/test/ops.test.ts`)
- **Typecheck**: `npm run typecheck`
- **Web dev server**: `npm --workspace=@splicewright/web run dev`

## Privacy in commits

This repository is public. Commit with the GitHub noreply email already set in this repo's git config; do not change `user.email`. Never put a real name, a personal email address, or an absolute home path (`/Users/<name>/...`) in a file, a commit message, a log or a test fixture. Use a placeholder such as `/path/to/project` or an environment variable.

## Long-running commands

Follow the global completion-notification policy. On this machine, use
`~/.codex/scripts/codex-run-notify.sh`; its maintained source and functional tests
are `scripts/codex-run-notify.sh` and `scripts/codex-run-notify.test.mjs`.
Keep per-project runtime evidence in the ignored `.codex-jobs/` directory.
Automatic continuation remains unverified until a real queued completion starts
an agent turn without user input.

```bash
~/.codex/scripts/codex-run-notify.sh --check --name regression -- npm test
nohup ~/.codex/scripts/codex-run-notify.sh --name regression -- npm test \
  >.codex-jobs/launcher.log 2>&1 </dev/null &
```

After successfully launching a detached job with the notification wrapper,
end the current turn instead of polling the job. For pipelines, pass
`bash -c 'set -o pipefail; command1 | command2'` after `--`.

## Subagent Architecture & Scheduling (`implement-agent`)

Codex is configured to use **`gpt-6-luna`** with **`high` reasoning effort** for the `implement-agent` worker.

### 1. Decision Matrix: When to Fan Out vs. Execute Directly
Delegating to a subagent has an invocation overhead. Fanout is **NOT mandatory for trivial work**; choose based on cost and context impact:

- **Execute Directly on Main Thread (No Subagent)**:
  - Scope: Single-file edits, typo/bug fixes, documentation or `SPEC.md` updates, quick tests (<5 turns expected).
  - Rationale: Spawning a subagent for minor work wastes tokens on dispatch overhead.
- **Delegate to Worker (`implement-agent`)**:
  - Trigger:
    1. The user explicitly requests it (e.g. "use subagent", "subagent-driven", "delegate to implement-agent").
    2. Full Milestone implementations (e.g. M10, M11...) requiring a new feature branch, multi-file changes, and iterative test-fix cycles.
    3. Tasks that produce heavy terminal outputs (vitest logs, build traces) that would otherwise pollute the Coordinator's active context.

### 2. Project-Level Subagents (`.codex/agents/`)
Subagents are configured natively in `.codex/agents/` at the project level:
- **`implement-agent`** (`.codex/agents/implement-agent.toml`):
  - Model: `gpt-6-luna`, reasoning effort: `high`, sandbox: `workspace-write`.
  - Role: Primary coding and milestone implementation worker. Follows strict scope discipline, zero raw media reads, selective `SPEC.md` slicing, and runs Vitest/typecheck.
- **`explorer`** (`.codex/agents/explorer.toml`):
  - Model: `gpt-6-luna`, reasoning effort: `high`, sandbox: `read-only`.
  - Role: Cheap codebase investigation and path tracing without context pollution.
- **`log_analyzer`** (`.codex/agents/log_analyzer.toml`):
  - Model: `gpt-6-luna`, reasoning effort: `high`, sandbox: `read-only`.
  - Role: Targeted analysis of long Vitest outputs and build error traces.
- **`reviewer`** (`.codex/agents/reviewer.toml`):
  - Model: `gpt-6-sol`, reasoning effort: `medium`, sandbox: `read-only`.
  - Role: Post-implementation review for correctness against `SPEC.md`, edge cases, and regressions.

### 3. Execution & Coordination Protocol
Follow the standard Codex subagent scheduling lifecycle:
```text
# To invoke from Coordinator:
"Use the implement-agent subagent to implement Milestone M10 on branch feat/m10-transitions..."
```
Lifecycle:
```text
spawn_agent(agent_name="implement-agent", task=...) → ONE bounded wait_agent → inspect returned result → validate against acceptance criteria → integrate → continue autonomously
```
- **One Bounded Wait**: Exactly one bounded `wait_agent` is allowed. Never enter a polling loop (`sleep` + `ps`, empty `write_stdin`, repeated log checking).
- **Coordinator Role**: Owns milestone scoping, task delegation, code review, git branching, and final acceptance. Do NOT perform deep exploratory searches or code edits before delegating.
- **Worker Role**: Owns local code exploration, implementation, debugging, and targeted tests. Saves the result-ready record, queues completion metadata to the supplied parent ID before final, then returns a concise completion summary and test result.
- **Interactive Switching**: In Codex CLI, use `/agent` to view or switch between active subagent threads.

### 4. Self-Contained Delegation Brief
Every dispatch message to `implement-agent` MUST be fully self-contained and specify:
1. **Target Milestone & Branch**: e.g., Milestone M10 on branch `feat/m10-transitions`.
2. **Acceptance Criteria**: Concrete functional requirements extracted from `SPEC.md`.
3. **Verification Command**: Explicit test command(s), e.g. `npx vitest run packages/render/test/transition.test.ts && npm run typecheck`.
4. **Touch Points**: Primary files or packages to inspect or modify.
5. **Constraint**: Keep working tree clean/uncommitted for review, or commit with standard message.
6. **Completion envelope**: Exact runtime `PARENT_THREAD_ID`, unique `TASK_ID`, absolute `RESULT_PATH`, and absolute `NOTIFICATION_DIR` in the worker's writable scope. Include the obligation to queue result-ready metadata before final; these values are not automatically inherited environment variables.

### 5. Result-ready notification
- Apply the global AGENTS.md "Subagent result-ready queue notification" contract to every delegated task. The coordinator supplies the destination/envelope; the worker owns delivery before final. Do not wrap a native subagent in a shell job or rely on automatic parent-ID discovery.
- In a worker worktree, use ignored `.codex-jobs/subagents/<TASK_ID>/` for the JSON result and wrapper job logs. Prefer the installed `~/.codex/scripts/codex-run-notify.sh`; no completion-script change is needed.
- Result JSON contains `task_id`, `parent_thread_id`, `status` (`ready_for_review`, `failed`, `blocked`), working directory, commit, changed files, validation, and concerns. Queue only metadata by running the wrapper with explicit `--thread`, `--name subagent-ready-<TASK_ID>`, and `--log-dir`, using `cat <RESULT_PATH>` as its command. Run `--check` first; copying this result is not the delegated task itself.
- After one bounded wait times out, yield without polling; on notification, read and verify the result, deduplicate by task ID, and continue only the authorized task. Delivery failure belongs in the normal final report. Worker crash/host shutdown may prevent notification; automatic wakeup still needs end-to-end validation.

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
   - `SPEC.md` is >53 KB. **Never read or dump the full file into context.**
   - Target only the section or milestone relevant to the current task using line-bounded slices (e.g. `sed -n 320,380p SPEC.md`) or `grep -n`.
   - Update `SPEC.md` §12 implementation status with surgical edits, never full rewrites.

2. **Zero Raw Media Reads (Image / Video / Audio)**:
   - **Never call file-viewing or read tools on raw images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) or video/audio (`.mp4`, `.mov`, `.wav`)**. Doing so injects massive Base64 or binary payloads into context.
   - Always inspect media properties via CLI commands:
     - Image dimensions / EXIF: `sips -g all <file>` or `file <file>`
     - Media duration & streams: `ffprobe -v error -show_format -show_streams <file>`
     - Size & existence: `ls -lh <file>`

3. **Validation & Testing Boundaries**:
   - Verify core logic and CLI functionality via Vitest unit tests (`npx vitest run <path>`).
   - Do NOT construct ad-hoc browser automation or CDP test suites in temporary directories.
   - For UI changes, verify through TypeScript typechecking and component unit tests, then prompt the user for interactive browser verification.
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

4. **Milestone Session Boundaries**:
   - Scope each task to a single milestone or feature increment.
   - After completing and merging a milestone, start a fresh session to prevent context degradation and runaway prompt-cache read costs.
