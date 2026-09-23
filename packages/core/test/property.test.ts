import { expect, it } from "vitest";
import { apply, createProject, validate, type Ctx, type Item, type Project } from "../src/index.ts";

// §10: random op sequences never break the §4.4 invariants, and never mutate their input.

const ctx: Ctx = {
  assetDurations: { a_a: 20, a_b: 8, a_m: 120 },
  transcript: () => Array.from({ length: 20 }, (_, k) => ({ start: k, end: k + 0.8, text: `w${k}` })),
};

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function randomOp(p: Project, r: () => number): [string, unknown] {
  const int = (n: number) => Math.floor(r() * n);
  const pick = <T>(xs: T[]): T | undefined => xs[int(xs.length)];
  const all = p.tracks.flatMap((t): Item[] => t.items);
  const it = pick(all);
  const id = it?.id ?? "missing";
  const at = it ? it.start + int(it.duration + 20) - 10 : int(300);
  const choices: [string, unknown][] = [
    ["insertItem", { assetId: pick(["a_a", "a_b", "a_m", "a_p"]), at: int(600), duration: 1 + int(200), sourceIn: r() * 5, ripple: r() < 0.5 }],
    ["insertItem", { text: "t", at: int(600), duration: 1 + int(60) }],
    ["insertItem", { component: "Text", props: {}, at: int(600), duration: 1 + int(60) }],
    ["split", { itemId: id, at }],
    ["trim", { itemId: id, edge: pick(["start", "end"]), to: Math.max(0, at), ripple: r() < 0.5 }],
    ["move", { itemId: id, to: int(600), trackId: pick(p.tracks)?.id, ripple: r() < 0.5 }],
    ["delete", { itemIds: [id], ripple: r() < 0.5 }],
    ["slip", { itemId: id, deltaSec: r() * 4 - 2 }],
    ["setProps", { itemId: id, patch: { volume: r() * 2 } }],
    ["addCaptionsFromTranscript", { itemId: id }],
    ["addTrack", { kind: pick(["video", "audio", "caption", "overlay"]), magnetic: r() < 0.3 }],
    ["setTrack", { trackId: pick(p.tracks)?.id, patch: { locked: r() < 0.3 } }],
    ["removeTrack", { trackId: pick(p.tracks)?.id }],
    ["addMarker", { label: "m", start: int(600) }],
    ["attach", { itemId: id, to: r() < 0.3 ? null : (pick(all.filter((i) => "sourceIn" in i && !("fadeIn" in i || "duck" in i)))?.id ?? "missing") }],
  ];
  const [op, args] = pick(choices)!;
  return r() < 0.1 ? ["batch", { ops: [{ op, args }, (([o, a]) => ({ op: o, args: a }))(pick(choices)!)] }] : [op, args];
}

it("random op sequences keep every invariant", () => {
  let committed = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed);
    let p = createProject({ title: "prop", fps: 30, width: 1280, height: 720 });
    for (const path of ["raw/a.mp4", "raw/b.mov", "raw/m.mp3", "raw/p.png"]) {
      const res = apply(p, "importAsset", { path }, ctx);
      if ("error" in res) throw new Error(res.error.message);
      p = res.project;
    }
    for (let step = 0; step < 60; step++) {
      const [op, args] = randomOp(p, r);
      const before = JSON.stringify(deepFreeze(p));
      const res = apply(p, op, args, ctx);
      expect(JSON.stringify(p)).toBe(before);
      if ("error" in res) continue;
      const errs = validate(res.project, p, ctx);
      if (errs.length) throw new Error(`seed ${seed} step ${step} ${op} ${JSON.stringify(args)}: ${errs.join("; ")}`);
      expect(res.project.revision).toBe(p.revision + 1);
      p = res.project;
      committed++;
    }
  }
  // Guard against a generator that only produces rejected ops.
  expect(committed).toBeGreaterThan(3000);
});
