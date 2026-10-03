import { expect, it } from "vitest";
import { createTtsJobs } from "../src/tts-jobs.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

it("returns a job before work finishes, bounds progress, and exposes the completed result", async () => {
  const jobs = createTtsJobs();
  const work = deferred<unknown>();
  const job = jobs.start("generate", "breezyvoice", (progress) => {
    progress("x".repeat(3000));
    return work.promise;
  });
  expect(job.state).toBe("running");
  await Promise.resolve();
  expect(jobs.get(job.jobId).detail.length).toBe(2000);
  expect(() => jobs.start("generate", "breezyvoice", async () => ({}))).toThrow("already running");
  expect(() => jobs.start("setup", "breezyvoice", async () => ({}))).toThrow("already running");
  work.resolve({ revision: 1, undoSteps: 1 });
  await nextTick();
  expect(jobs.get(job.jobId)).toMatchObject({ state: "ready", result: { revision: 1, undoSteps: 1 } });
});

it("excludes setup and generation in either direction while allowing another engine", async () => {
  const jobs = createTtsJobs();
  const setupWork = deferred<unknown>();
  const setup = jobs.start("setup", "kokoro", () => setupWork.promise);
  expect(() => jobs.start("generate", "kokoro", async () => ({}))).toThrow("already running");
  const otherEngine = jobs.start("generate", "breezyvoice", async () => ({}));
  await nextTick();
  expect(jobs.get(otherEngine.jobId).state).toBe("ready");
  setupWork.resolve({ ready: true });
  await nextTick();
  const generateWork = deferred<unknown>();
  const generate = jobs.start("generate", "kokoro", () => generateWork.promise);
  expect(() => jobs.start("setup", "kokoro", async () => ({}))).toThrow("already running");
  generateWork.resolve({});
  await nextTick();
  expect(jobs.get(generate.jobId).state).toBe("ready");
});

it("retains refusal codes and releases engine exclusion after a failure", async () => {
  const jobs = createTtsJobs();
  const failed = jobs.start("setup", "kokoro", async () => { throw Object.assign(new Error("installation locked"), { code: "busy" }); });
  await nextTick();
  expect(jobs.get(failed.jobId)).toMatchObject({ state: "failed", error: { code: "busy", message: "installation locked" } });
  const next = jobs.start("generate", "kokoro", async () => ({ ready: true }));
  await nextTick();
  expect(jobs.get(next.jobId).state).toBe("ready");
  expect(() => jobs.get("missing")).toThrow("not found");
});
