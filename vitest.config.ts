import { configDefaults, defineConfig } from "vitest/config";

// Git worktrees live inside the repo; their copies of the tests are not this checkout's.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, ".worktree/**", ".worktrees/**"] } });
