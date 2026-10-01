import { useMemo, type SVGProps } from "react";
import flubber from "flubber";
import { RoughGenerator } from "roughjs/bin/generator.js";

export { Lottie } from "@remotion/lottie";
export type { LottieAnimationData, LottieProps } from "@remotion/lottie";
export { Arrow, Callout, Circle, Rect, Star, makeArrow, makeCallout, makeCircle, makeRect, makeStar } from "@remotion/shapes";
export type { ArrowProps, CalloutProps, CircleProps, RectProps, StarProps } from "@remotion/shapes";

const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
export type SketchFillStyle = "solid" | "hachure" | "cross-hatch" | "dots";

export type SketchPathProps = Omit<SVGProps<SVGGElement>, "fill"> & {
  d: string;
  seed?: number;
  roughness?: number;
  fill?: string;
  fillStyle?: SketchFillStyle;
  stroke?: string;
  strokeWidth?: number;
  progress?: number;
};

/** A deterministic Rough.js path that can be drawn with Remotion's frame-based progress. */
export function SketchPath({ d, seed = 1, roughness = 1.25, fill = "none", fillStyle = "solid", stroke = "currentColor", strokeWidth = 2, progress = 1, ...props }: SketchPathProps) {
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > 2_147_483_647) {
    throw new RangeError("SketchPath seed must be an integer from 1 to 2147483647");
  }
  const paths = useMemo(() => {
    if (!d) return [];
    const generator = new RoughGenerator();
    return generator.toPaths(generator.path(d, { seed, roughness, fill, fillStyle, stroke, strokeWidth }));
  }, [d, seed, roughness, fill, fillStyle, stroke, strokeWidth]);
  const t = clamp(progress);
  return <g {...props}>
    {paths.map((path, index) => <path
      key={index}
      d={path.d}
      fill={t >= 1 ? path.fill : "none"}
      stroke={path.stroke}
      strokeWidth={path.strokeWidth}
      pathLength={1}
      strokeDasharray={1}
      strokeDashoffset={1 - t}
    />)}
  </g>;
}

export type MorphPathProps = Omit<SVGProps<SVGPathElement>, "d"> & {
  from: string;
  to: string;
  progress: number;
};

/** Morphs compatible SVG path shapes at a frame-driven, clamped progress value. */
export function MorphPath({ from, to, progress, ...props }: MorphPathProps) {
  const interpolate = useMemo(() => flubber.interpolate(from, to), [from, to]);
  const d = interpolate(clamp(progress));
  return <path {...props} d={d} />;
}
