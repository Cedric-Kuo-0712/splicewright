# Style recipes

These are adjustable starting points, not preset names in the project schema.
Use the project's chosen theme/fonts rather than installing fonts by default.

## Clean editorial

Use one strong text hierarchy, crisp lines and a small palette sampled from
the established theme. Keep cards compact with enough contrast over footage.
Use a short fade or small slide, hold while readable, then exit. Prefer this
for frequent factual labels and visually busy shots. It is cheap to revise
because text and geometry remain component props.

## Travel sketchbook

Use warm paper, dark ink and one accent; seeded irregular lines and sparse
hatching. Layer a route, location dot and label as separate objects. Reveal the
line, then hold the label. Rough.js supplies the line style, not detailed scenic
illustration. Never change the seed each frame to simulate handwriting: that
produces jitter rather than a stable drawing. Avoid dense hatching over faces
or when scaling small. Combine paper textures only when an actual approved
asset is available; a paper-colored rectangle is not a real paper texture.

## Playful stickers

Use rounded silhouettes, limited expressions and one quick squash/pop or
settling spring. Suitable for a snack, surprise or short reaction; use less of
it in a calm documentary. Prefer reusable local Lottie assets or simple SVG.
For a character, keep the same viewBox and corresponding part IDs across poses;
animate eyes/mouth separately. Complex topology needs carefully prepared poses,
not an arbitrary whole-character Flubber morph.

## Postcard / collage

Combine existing photos/artwork, a modest border, restrained rotation and a
small date/location caption. Use for chapter openings or memory montages;
avoid covering a shot whose action matters. Fade layers or use a small camera
move. Retain original assets, their origin/license and editable layer positions.
Do not treat random rotations as sufficient art direction.

## Watercolor / painterly

Prepare artwork using an available image tool or supplied licensed assets;
reuse approved material for consistency. Animate layers, masks or a subtle
pan inside Remotion. SVG filters can approximate texture but are not a promise
of convincing watercolor. Detailed source artwork costs more to revise; ask
about broad direction before commissioning a whole sequence when unspecified.
If no image tool/assets are available, say so and offer a vector alternative.

## Technical explainer

Use aligned labels, explicit relationships and consistent scale. Sequential
reveals should clarify the explanation. Motion Canvas is useful for a longer
sequence; Manim supplies mathematical objects and transforms. This direction
fits an actual explanation, not every travel route merely because it has lines.

## Bold kinetic typography

Use oversized, high-contrast type, one vivid accent and deliberate line breaks. Suitable for an opening hook, destination reveal, chapter break or a short beat accent. Give the title a quiet shot or a deliberate full-screen card; avoid hiding faces, action or subtitles. It is not the default treatment for every informational label.

Reveal words/lines in a short stagger with a settling scale or slide, hold the complete title long enough to read, then leave cleanly. Match an actual chosen beat when music exists; do not invent beat timing. Prefer one primary movement over combining bounce, spin, shake and flashing. Keep safe margins, check portrait and landscape separately, and scale down or split long text rather than clipping it. For calm travel films, retain the large hierarchy but soften colors and motion.

Use editable text with ordinary fonts; see [typography](typography.md) for language coverage, real weights and loading. Outlined SVG lettering is optional for custom lettering/path effects, with an editable source retained. [BoldTitle](../../splicewright-animation/assets/BoldTitle.tsx.template) is a starting component, not an automatic fitting or beat-detection system.

## Guidance sources

Original recipes for this project, with related external references rather than
copied upstream skill packs:

- [Rough.js drawing controls](https://github.com/rough-stuff/rough)
- [LottieFiles motion design guidance](https://github.com/LottieFiles/motion-design-skill)
- [SVG construction guidance](https://github.com/linyaosky/svg-skill)
- [SVG character states and matching parts](https://github.com/molauu/svg-character-animator)
