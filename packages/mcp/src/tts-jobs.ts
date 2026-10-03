import { randomUUID } from "node:crypto";

export type TtsJob = { jobId: string; kind: "setup" | "generate"; engine: "kokoro" | "breezyvoice"; state: "running" | "ready" | "failed"; detail: string; createdAt: string; finishedAt?: string; result?: unknown; error?: { code: string; message: string } };

/** The stdio server stays alive between calls; jobs avoid the SDK's 60-second request timeout. */
export function createTtsJobs() {
  const jobs = new Map<string, TtsJob>();
  return {
    start(kind: TtsJob["kind"], engine: TtsJob["engine"], work: (progress: (line: string) => void) => Promise<unknown>): TtsJob {
      if ([...jobs.values()].some((job) => job.state === "running" && job.engine === engine)) throw Object.assign(new Error(`a ${engine} TTS job is already running`), { code: "busy" });
      if (jobs.size >= 100) {
        const completed = [...jobs.values()].find((job) => job.state !== "running");
        if (!completed) throw Object.assign(new Error("too many TTS jobs are running"), { code: "busy" });
        jobs.delete(completed.jobId);
      }
      const job: TtsJob = { jobId: randomUUID(), kind, engine, state: "running", detail: "", createdAt: new Date().toISOString() };
      jobs.set(job.jobId, job);
      void Promise.resolve().then(() => work((line) => { job.detail = (job.detail + line).slice(-2000); })).then((result) => {
        job.result = result; job.state = "ready"; job.finishedAt = new Date().toISOString();
      }).catch((error: Error & { code?: string }) => {
        job.error = { code: error.code ?? "tts_failed", message: error.message }; job.state = "failed"; job.finishedAt = new Date().toISOString();
      });
      return { ...job };
    },
    get(jobId: string): TtsJob {
      const job = jobs.get(jobId);
      if (!job) throw Object.assign(new Error("TTS job not found; jobs belong to the current MCP server session"), { code: "not_found" });
      return { ...job };
    },
  };
}
