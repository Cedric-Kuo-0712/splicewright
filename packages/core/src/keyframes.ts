import { MASK_PROPS, Transform, type Animatable, type Ease, type AudioItem, type Project, type VideoItem } from "./schema.ts";
import { secPerFrame, sourceAt } from "./validate.ts";

type Keyed = VideoItem | AudioItem;
type Keys = NonNullable<VideoItem["keyframes"]>;

/** CSS cubic-bezier(x1, y1, x2, y2) at progress `x`: Newton on x(s), bisection when the slope is flat. */
export function bezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const c = (a: number, b: number, s: number) => 3 * a * (1 - s) ** 2 * s + 3 * b * (1 - s) * s * s + s ** 3;
  const dx = (s: number) => 3 * x1 * (1 - s) ** 2 + 6 * (x2 - x1) * (1 - s) * s + 3 * (1 - x2) * s * s;
  let s = x;
  for (let i = 0; i < 8; i++) {
    const err = c(x1, x2, s) - x;
    if (Math.abs(err) < 1e-7) return c(y1, y2, s);
    const d = dx(s);
    if (Math.abs(d) < 1e-6) break;
    s -= err / d;
  }
  let [lo, hi] = [0, 1];
  s = x;
  for (let i = 0; i < 40; i++) {
    c(x1, x2, s) < x ? (lo = s) : (hi = s);
    s = (lo + hi) / 2;
  }
  return c(y1, y2, s);
}

/** Keyed value of `prop` at timeline frame `f`; undefined when the prop has no keys. */
export function valueAt(p: Project, item: Keyed, prop: Animatable, f: number): number | undefined {
  const ks = item.keyframes?.[prop];
  if (!ks) return undefined;
  const t = sourceAt(p, item, f);
  const i = ks.findIndex((k) => k.t > t);
  if (i === 0) return ks[0].v;
  if (i < 0) return ks[ks.length - 1].v;
  const [a, b] = [ks[i - 1], ks[i]];
  let u = (t - a.t) / (b.t - a.t);
  if (a.ease === "ease") u = u * u * (3 - 2 * u);
  else if (Array.isArray(a.ease)) u = bezier(...a.ease, u);
  return a.v + (b.v - a.v) * u;
}

/** The item as it stands at frame `f`: keyed props resolved into transform, effects, volume and mask. */
export function animate(p: Project, item: VideoItem, f: number): VideoItem {
  if (!item.keyframes) return item;
  const out = { ...item, transform: { ...item.transform }, effects: { ...item.effects } } as VideoItem & { transform: Record<string, number>; effects: Record<string, number> };
  for (const k of Object.keys(item.keyframes) as Animatable[]) {
    const v = valueAt(p, item, k, f)!;
    if (k === "volume") out.volume = v;
    else if (k in MASK_PROPS) {
      if (out.mask) out.mask = { ...out.mask, [MASK_PROPS[k as keyof typeof MASK_PROPS]]: v };
    }
    else if (k in Transform.shape) out.transform[k] = v;
    else out.effects[k] = v;
  }
  return out;
}

const near = (p: Project, item: Keyed, t: number, at: number) => Math.abs(t - sourceAt(p, item, at)) < secPerFrame(p, item) / 2;

/** The key of `prop` on frame `at`, if any. */
export const keyAt = (p: Project, item: Keyed, prop: Animatable, at: number) => item.keyframes?.[prop]?.find((k) => near(p, item, k.t, at));

/** `item.keyframes` with `prop` keyed to `value` on frame `at`, replacing a key on that frame; null removes it. */
export function withKey(p: Project, item: Keyed, prop: Animatable, at: number, value: number | null, ease?: Ease): Keys | undefined {
  ease ??= keyAt(p, item, prop, at)?.ease; // re-keying a value keeps the key's curve
  const ks = (item.keyframes?.[prop] ?? []).filter((k) => !near(p, item, k.t, at));
  if (value !== null) ks.push({ t: Math.max(0, +sourceAt(p, item, at).toFixed(4)), v: value, ...(ease && { ease }) });
  const out: Keys = { ...item.keyframes, [prop]: ks.sort((a, b) => a.t - b.t) };
  if (!ks.length) delete out[prop];
  return Object.keys(out).length ? out : undefined;
}
