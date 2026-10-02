import { GRADE_ANIMATABLE, MASK_PROPS, Transform, type Ease, type AudioItem, type GradeAnimatable, type KeyframeProp, type OverlayItem, type Project, type VideoItem } from "./schema.ts";
import { frameOf, secPerFrame, sourceAt, videoItems } from "./validate.ts";

type Keyed = VideoItem | AudioItem | OverlayItem;
type Keys = NonNullable<VideoItem["keyframes"]>;
type Key = { t: number; v: number; ease?: Ease };
const keyList = (item: Keyed, prop: string): Key[] | undefined => (item.keyframes as Record<string, Key[]> | undefined)?.[prop];

const overlayOrigin = (p: Project, item: OverlayItem) => {
  const target = item.anchor && videoItems(p).get(item.anchor.itemId);
  return target && item.anchor ? frameOf(p, target, target.reverse ? item.anchor.sourceEnd - secPerFrame(p, target) : item.anchor.sourceStart) : item.start;
};
const mediaTime = (p: Project, item: VideoItem | AudioItem | OverlayItem, f: number) =>
  "sourceIn" in item ? sourceAt(p, item, f) : (f - overlayOrigin(p, item)) / p.meta.fps + (item.keyframeOffset ?? 0);
/** Timeline frame of a key, including anchored overlay phase and local trim offset. */
export const keyframeFrame = (p: Project, item: Keyed, t: number) => "sourceIn" in item ? frameOf(p, item, t) : overlayOrigin(p, item) + (t - (item.keyframeOffset ?? 0)) * p.meta.fps;
const halfFrame = (p: Project, item: VideoItem | AudioItem | OverlayItem) =>
  "sourceIn" in item ? secPerFrame(p, item) / 2 : 0.5 / p.meta.fps;

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
export function valueAt(p: Project, item: Keyed, prop: string, f: number): number | undefined {
  const ks = keyList(item, prop);
  if (!ks) return undefined;
  const t = mediaTime(p, item, f);
  const i = ks.findIndex((k) => k.t > t);
  if (i === 0) return ks[0].v;
  if (i < 0) return ks[ks.length - 1].v;
  const [a, b] = [ks[i - 1], ks[i]];
  let u = (t - a.t) / (b.t - a.t);
  if (a.ease === "ease") u = u * u * (3 - 2 * u);
  else if (Array.isArray(a.ease)) u = bezier(...(a.ease as [number, number, number, number]), u);
  return a.v + (b.v - a.v) * u;
}

/** The item as it stands at frame `f`: keyed props resolved into transform, effects, volume and mask. */
export function animate(p: Project, item: VideoItem, f: number): VideoItem {
  if (!item.keyframes && !item.lutKeyframes) return item;
  const out = { ...item, transform: { ...item.transform }, effects: { ...item.effects } } as VideoItem & { transform: Record<string, number>; effects: Record<string, number> };
  for (const k of Object.keys(item.keyframes ?? {}) as KeyframeProp[]) {
    const v = valueAt(p, item, k, f)!;
    if (k === "volume") out.volume = v;
    else if ((GRADE_ANIMATABLE as readonly string[]).includes(k)) {
      out.grade = { ...out.grade, ...(k === "lutStrength" ? { lut: out.grade?.lut ? { ...out.grade.lut, strength: v } : undefined } : { [k]: v }) };
    }
    else if (k in MASK_PROPS) {
      if (out.mask) out.mask = { ...out.mask, [MASK_PROPS[k as keyof typeof MASK_PROPS]]: v };
    }
    else if (k in Transform.shape) out.transform[k] = v;
    else out.effects[k] = v;
  }
  const lutAssetId = lutAssetAt(p, item, f);
  if (out.grade?.lut && lutAssetId) out.grade = { ...out.grade, lut: { ...out.grade.lut, assetId: lutAssetId } };
  return out;
}

/** Discrete LUT selection: the active asset is the last keyed asset at or before source time. */
export function lutAssetAt(p: Project, item: VideoItem, f: number): string | undefined {
  const keys = item.lutKeyframes;
  if (!keys?.length) return item.grade?.lut?.assetId;
  const t = sourceAt(p, item, f);
  let active = item.grade?.lut?.assetId;
  for (const key of keys) {
    if (key.t > t) break;
    active = key.assetId;
  }
  return active;
}

/** Resolve overlay transform and numeric props at frame `f`; keys use item-local seconds. */
export function animateOverlay(p: Project, item: OverlayItem, f: number): OverlayItem {
  if (!item.keyframes) return item;
  const out = { ...item, transform: { ...item.transform }, props: { ...item.props } };
  for (const prop of Object.keys(item.keyframes)) {
    const value = valueAt(p, item, prop, f)!;
    if (["x", "y", "scale", "rotation", "opacity"].includes(prop))
      out.transform = { ...out.transform, [prop]: value };
    else {
      const path = prop.slice("props.".length).split(".");
      if (path.length === 1) out.props[path[0]] = value;
      else {
        const root = path[0];
        const nested = out.props[root];
        if (nested && typeof nested === "object") out.props[root] = { ...nested, [path[1]]: value };
      }
    }
  }
  return out;
}

const near = (p: Project, item: Keyed, t: number, at: number) => Math.abs(t - mediaTime(p, item, at)) < halfFrame(p, item);

/** The key of `prop` on frame `at`, if any. */
export const keyAt = (p: Project, item: Keyed, prop: string, at: number) => keyList(item, prop)?.find((k) => near(p, item, k.t, at));

/** `item.keyframes` with `prop` keyed to `value` on frame `at`, replacing a key on that frame; null removes it. */
export function withKey(p: Project, item: Keyed, prop: string, at: number, value: number | null, ease?: Ease): Keys | undefined {
  ease ??= keyAt(p, item, prop, at)?.ease; // re-keying a value keeps the key's curve
  const ks = (keyList(item, prop) ?? []).filter((k) => !near(p, item, k.t, at));
  if (value !== null) ks.push({ t: Math.max(0, +mediaTime(p, item, at).toFixed(4)), v: value, ...(ease && { ease }) });
  const out = { ...(item.keyframes as Record<string, Key[]> | undefined), [prop]: ks.sort((a, b) => a.t - b.t) } as Keys;
  if (!ks.length) delete (out as Record<string, Key[]>)[prop];
  return Object.keys(out).length ? out : undefined;
}
