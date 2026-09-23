// Browser-side entry (Remotion bundle, M4 Player). Node-side rendering lives in ./node.ts.
export { CaptionLayer, Image, SplicewrightProject, Text, type Props } from "./Composition.tsx";
export { defineConfig, type Config, type Preset } from "./config.ts";
export { duckGain, duckRanges, type Ranges } from "./duck.ts";
export { COMPOSITION_ID, makeRoot } from "./Root.tsx";
