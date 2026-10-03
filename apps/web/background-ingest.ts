import { STEPS, type Step } from "@splicewright/ingest";

const EDITING_STEPS: Step[] = ["proxy", "reverse", "thumbs", "waveform"];
const ALL_STEPS: Step[] = [...STEPS];

type Run = (assetId: string, steps: Step[]) => Promise<void>;
type Notify = (assetId: string, error?: string) => void;
type AssetWork = { editing: Set<Step>; background: Set<Step> };

/** Serializes cache-writing ingest calls while letting probes and editing prep pass queued analysis work. */
export class BackgroundIngestScheduler {
  private readonly pending = new Map<string, AssetWork>();
  private readonly running = new Set<string>();
  private readonly exclusive: Array<{ run: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  private readonly failures = new Map<string, string[]>();
  private closed = false;
  private pumping = false;
  private readonly runTask: Run;
  private readonly notifyTask: Notify;

  constructor(run: Run, notify: Notify = () => {}) {
    this.runTask = run;
    this.notifyTask = notify;
  }

  runExclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("ingest scheduler is closed"));
    return new Promise<T>((resolve, reject) => {
      this.exclusive.push({ run, resolve: resolve as (value: unknown) => void, reject });
      this.pump();
    });
  }

  enqueueFull(id: string) {
    this.enqueue(id, ALL_STEPS);
  }

  enqueueOnly(id: string, steps: Step[]) {
    this.enqueue(id, steps);
  }

  close() {
    this.closed = true;
    this.pending.clear();
    for (const task of this.exclusive.splice(0)) task.reject(new Error("ingest scheduler is closed"));
  }

  private enqueue(id: string, steps: Step[]) {
    if (this.closed) return;
    const work = this.work(id);
    const running = this.running.has(id) ? this.active.get(id) : undefined;
    for (const step of steps) {
      if (running?.has(step)) continue;
      (EDITING_STEPS.includes(step) ? work.editing : work.background).add(step);
    }
    this.pump();
  }

  private readonly active = new Map<string, Set<Step>>();

  private work(id: string): AssetWork {
    let work = this.pending.get(id);
    if (!work) this.pending.set(id, work = { editing: new Set(), background: new Set() });
    return work;
  }

  private pump() {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    void this.drain().finally(() => {
      this.pumping = false;
      if (!this.closed && this.hasPending()) this.pump();
    });
  }

  private hasPending() {
    return this.exclusive.length > 0 || [...this.pending.values()].some((w) => w.editing.size || w.background.size);
  }

  private take(priority: "editing" | "background"): { id: string; steps: Set<Step> } | undefined {
    for (const [id, state] of this.pending) {
      if (this.running.has(id)) continue;
      const source = priority === "editing" ? state.editing : priority === "background" ? state.background : undefined;
      if (!source?.size) continue;
      const steps = new Set(source);
      source.clear();
      return { id, steps };
    }
    return undefined;
  }

  private async drain() {
    while (!this.closed) {
      let work = this.take("editing");
      if (!work) {
        const external = this.exclusive.shift();
        if (external) {
          try { external.resolve(await external.run()); }
          catch (error) { external.reject(error); }
          continue;
        }
        work = this.take("background");
      }
      if (!work) return;
      this.running.add(work.id);
      this.active.set(work.id, work.steps);
      let error: string | undefined;
      try {
        await this.runTask(work.id, [...work.steps]);
      } catch (e) {
        error = (e as Error).message;
      } finally {
        this.active.delete(work.id);
        this.running.delete(work.id);
        if (error) this.failures.set(work.id, [...(this.failures.get(work.id) ?? []), error]);
        const state = this.pending.get(work.id);
        const complete = !state || (!state.editing.size && !state.background.size);
        if (!this.closed && complete) {
          const errors = this.failures.get(work.id);
          this.notifyTask(work.id, errors?.join("; "));
          this.failures.delete(work.id);
        }
        if (state && complete) this.pending.delete(work.id);
      }
    }
  }
}
