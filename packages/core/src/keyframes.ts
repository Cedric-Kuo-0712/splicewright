import { MASK_PROPS, Transform, type Animatable, type Project, type VideoItem } from "./schema.ts";
import { secPerFrame, sourceAt } from "./validate.ts";

type Keys = NonNullable<VideoItem["keyframes"]>;

/** Keyed value of `prop` at timeline frame `f`; undefined when the prop has no keys. */
export function valueAt(p: Project, item: VideoItem, prop: Animatable, f: number): number | undefined {
  const ks = item.keyframes?.[prop];
  if (!ks) return undefined;
  const t = sourceAt(p, item, f);
  const i = ks.findIndex((k) => k.t > t);
  if (i === 0) return ks[0].v;
  if (i < 0) return ks[ks.length - 1].v;
  const [a, b] = [ks[i - 1], ks[i]];
  let u = (t - a.t) / (b.t - a.t);
  if (a.ease === "ease") u = u * u * (3 - 2 * u);
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

const near = (p: Project, item: VideoItem, t: number, at: number) => Math.abs(t - sourceAt(p, item, at)) < secPerFrame(p, item) / 2;

/** The key of `prop` on frame `at`, if any. */
export const keyAt = (p: Project, item: VideoItem, prop: Animatable, at: number) => item.keyframes?.[prop]?.find((k) => near(p, item, k.t, at));

/** `item.keyframes` with `prop` keyed to `value` on frame `at`, replacing a key on that frame; null removes it. */
export function withKey(p: Project, item: VideoItem, prop: Animatable, at: number, value: number | null, ease?: "linear" | "ease"): Keys | undefined {
  const ks = (item.keyframes?.[prop] ?? []).filter((k) => !near(p, item, k.t, at));
  if (value !== null) ks.push({ t: Math.max(0, +sourceAt(p, item, at).toFixed(4)), v: value, ...(ease && { ease }) });
  const out: Keys = { ...item.keyframes, [prop]: ks.sort((a, b) => a.t - b.t) };
  if (!ks.length) delete out[prop];
  return Object.keys(out).length ? out : undefined;
}
