import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, rmSync: vi.fn(fs.rmSync), renameSync: vi.fn(fs.renameSync) };
});
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEditReview, getEditReview, historyList, init, load, revertEditReview, undo } from "../src/persistence.ts";
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "swr-review-failure-")); dirs.push(dir);
  init(dir, { title: "Review", fps: 30, width: 640, height: 360 });
  mkdirSync(join(dir, ".splicewright/history/redo"), { recursive: true });
  return dir;
}
it("keeps committed project, ledger and undo when retired redo cleanup fails", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(rmSync).mockImplementation((path, options) => {
    if (String(path).includes("redo-retired")) throw new Error("cleanup failure");
    return actual.rmSync(path, options);
  });
  const dir = fixture();
  const result = applyEditReview(dir, [{ op: "addMarker", args: { label: "round", start: 1 } }]);
  expect(result).toMatchObject({ project: { revision: 1 } });
  const review = getEditReview(dir)!;
  expect(review.afterRevision).toBe(1);
  mkdirSync(join(dir, ".splicewright/history/redo"), { recursive: true });
  expect(revertEditReview(dir, review.id)).toMatchObject({ project: { revision: 2 } });
  expect(getEditReview(dir)?.status).toBe("reverted");
  expect(load(dir).revision).toBe(2);
  expect(undo(dir)).toMatchObject({ project: { revision: 3, markers: [{ label: "round" }] } });
});
it("rolls back review and history if canonical project commit fails", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const dir = fixture();
  vi.mocked(renameSync).mockImplementation((source, target) => {
    if (String(target) === join(dir, "project.json")) throw new Error("commit failure");
    return actual.renameSync(source, target);
  });
  expect(applyEditReview(dir, [{ op: "addMarker", args: { label: "round", start: 1 } }])).toHaveProperty("error");
  expect(load(dir).revision).toBe(0);
  expect(getEditReview(dir)).toBeUndefined();
  expect(historyList(dir)).toEqual({ undo: [], redo: [] });
});
