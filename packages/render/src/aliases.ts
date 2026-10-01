import { join } from "node:path";

/** Exact package subpath keeps animation components reachable beside the legacy config alias. */
export function projectAliases(renderSourceDir: string, existing: Record<string, unknown> = {}) {
  const remaining = Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "splicewright" && key !== "splicewright/animation$"));
  return {
    "splicewright/animation$": join(renderSourceDir, "animation.tsx"),
    splicewright: join(renderSourceDir, "config.ts"),
    ...remaining,
  };
}
