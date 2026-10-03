import { expect, it } from "vitest";
import { createTtsJobs } from "../src/tts-jobs.ts";

it("returns a job before work finishes, bounds progress, and exposes the completed result", async () => {
  const jobs = createTtsJobs();
  let finish!: (value: unknown) => void;
  const job = jobs.start("generate", "breezyvoice", (progress) => {
    progress("x".repeat(3000));
    return new Promise((resolve) => { finish = resolve; });
  });
  expect(job.state).toBe("running");
  await Promise.resolve();
  expect(jobs.get(job.jobId).detail.length).toBe(2000);
  expect(() => jobs.start("generate", "breezyvoice", async () => ({}))).toThrow("already running");
  finish({ revision: 1, undoSteps: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(jobs.get(job.jobId)).toMatchObject({ state: "ready", result: { revision: 1, undoSteps: 1 } });
});

it("retains refusal codes and never presents a failed job as ready", async () => {
  const jobs = createTtsJobs();
  const job = jobs.start("setup", "kokoro", async () => { throw Object.assign(new Error("installation locked"), { code: "busy" }); });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(jobs.get(job.jobId)).toMatchObject({ state: "failed", error: { code: "busy", message: "installation locked" } });
  expect(() => jobs.get("missing")).toThrow("not found");
});
