import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cancelRender, renderStatus, startRender } from "../src/node.ts";

const dirs: string[] = [];
const tempProject = () => {
  const dir = mkdtempSync(join(tmpdir(), "swr-export-job-"));
  dirs.push(dir);
  return dir;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("background export jobs", () => {
  it("cancels a queued render and leaves no published or partial output", async () => {
    const dir = tempProject();
    const output = join(dir, "final.mp4");
    const job = startRender(dir, { output, preset: "draft" });
    expect(cancelRender(job.id)).toBe(true);
    expect(cancelRender(job.id)).toBe(false);
    await settle();
    expect(renderStatus(job.id)).toMatchObject({ status: "cancelled", progress: 0, preset: "draft" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("records preparation failures and removes its staging output", async () => {
    const dir = tempProject();
    const job = startRender(dir, { output: join(dir, "final.mp4") });
    await settle();
    expect(renderStatus(job.id)).toMatchObject({ status: "error" });
    expect(renderStatus(job.id)?.error).toMatch(/project\.json/);
    expect(readdirSync(dir)).toEqual([]);
    expect(cancelRender(job.id)).toBe(false);
  });

  it("settles as error even when cleanup also fails on an overlong staging filename", async () => {
    const dir = tempProject();
    const job = startRender(dir, { output: join(dir, `${"x".repeat(300)}.mp4`) });
    await settle();
    expect(renderStatus(job.id)).toMatchObject({ status: "error" });
    expect(job.error).toContain("project.json");
    expect(job.error).toContain("staging cleanup failed");
    expect(cancelRender(job.id)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
