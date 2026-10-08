import { configDefaults, defineConfig } from "vitest/config";

// Git worktrees live inside the repo; their copies of the tests are not this checkout's.
// codex-run-notify.test.mjs uses node:test; run it with `node --test scripts/codex-run-notify.test.mjs`.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, ".worktree/**", ".worktrees/**", "scripts/codex-run-notify.test.mjs"] } });
