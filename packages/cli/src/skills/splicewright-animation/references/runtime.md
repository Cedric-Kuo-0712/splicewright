# Runtime available in custom overlays

```tsx
import {SketchPath, MorphPath, Lottie, Arrow, Rect, Circle, Star, Callout} from 'splicewright/animation';
import {interpolate, spring, useCurrentFrame, useVideoConfig, staticFile} from 'remotion';
```

`splicewright/animation` is supplied by the editor's bundler. It is not an npm
package the video project must install. `splicewright` remains the config import.

## SketchPath

Place inside an SVG with a deliberate `viewBox`. Props: `d`, optional `seed`
(default 1), `roughness` (1.25), `fill` (`none`), `stroke` (`currentColor`),
`strokeWidth` (2), `progress` (1), and SVG presentation props.
`fillStyle` defaults to `solid`; use `hachure`, `cross-hatch` or `dots` for
sketchbook textures. Keep patterned fills sparse when the graphic is small.

```tsx
<svg viewBox="0 0 500 120">
  <SketchPath d="M20 20 H480 V100 H20 Z" seed={42} roughness={1.2}
    stroke="#29443a" fill="#f6eddc" progress={progress} />
</svg>
```

The helper prepares seeded Rough.js geometry; `progress` is clamped to 0–1 and
reveals strokes. Use a positive integer seed from 1 to 2147483647; zero is not a
fixed Rough.js seed. Keep seed and shape stable across frames. Solid fills appear
when progress reaches 1; use a separate background shape if the card needs fill
throughout its outline reveal. Fade the group when entering the whole graphic.
This is a sketch renderer, not watercolor or a
model that invents detailed illustrations.

## MorphPath

```tsx
<MorphPath from="M0 0 L80 0 L40 70 Z" to="M0 0 H80 V70 H0 Z"
  progress={progress} fill="#e6a15c" />
```

Use inside SVG. `from` and `to` are closed path strings; `progress` is clamped
to 0–1. Flubber is best for simple silhouettes. Holes/multiple subpaths are not
fully handled by its single-shape interpolator; use separate paths for separate
parts or crossfade complex artwork. Do not flatten a face into one compound
path if eyes and mouth must remain independently editable.

## Lottie and shapes

`Lottie` is Remotion's frame-driven component, with its upstream props. Prefer
local, licensed animation JSON. Load it once with Remotion's documented loading
pattern (`delayRender`/`continueRender` for async data), and provide a visible
error for failed loads; never fetch afresh each frame. Source-relative images
inside JSON must resolve too. Avoid hand-authoring huge Lottie JSON when a few
SVG primitives suffice.

`Arrow`, `Rect`, `Circle`, `Star`, `Callout` are the upstream `@remotion/shapes`
React components. Their geometry props differ: consult the installed types or
official documentation rather than treating them as native SVG elements.

## Maintained references

This is an original, project-specific guide; it does not vendor full upstream
skills or claim their quality guarantees. Runtime dependencies retain their own
licenses. Check installed versions before adopting newer API examples.

- [Remotion animation](https://www.remotion.dev/docs/animating-properties)
- [Remotion shapes](https://www.remotion.dev/docs/shapes)
- [Remotion Lottie](https://www.remotion.dev/docs/lottie/lottie)
- [Rough.js](https://github.com/rough-stuff/rough)
- [Flubber, including topology limitations](https://github.com/veltman/flubber)
- [SVG skill: SVG construction examples](https://github.com/linyaosky/svg-skill)
- [SVG character animator: matching parts across poses](https://github.com/molauu/svg-character-animator)
