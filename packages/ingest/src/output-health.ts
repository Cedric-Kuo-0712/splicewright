import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fingerprint } from "@splicewright/core/node";
import { measureFinalMix } from "./source-health.ts";

/** Explicit output-file measurement, separate from source lint and live playback. */
export async function checkOutput(dir: string, path: string) {
  const root = realpathSync(dir), file = realpathSync(resolve(root, path));
  if (!file.startsWith(root + sep)) throw new Error("output must be a file inside the project");
  const before = fingerprint(file);
  const measurement = await measureFinalMix(file);
  if (!before || fingerprint(file) !== before) throw new Error("output changed during measurement");
  return { scope: "final-mix" as const, path: relative(root, file), fingerprint: before, measuredAt: new Date().toISOString(), ...measurement };
}
