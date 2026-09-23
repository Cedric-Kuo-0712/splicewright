import React from "react";
import { Composition } from "remotion";
import { createProject, durationFrames } from "@splicewright/core";
import { SplicewrightProject, type Props } from "./Composition.tsx";
import type { Config } from "./config.ts";

export const COMPOSITION_ID = "SplicewrightProject";

/** Remotion root for one project; the project itself arrives as inputProps. */
export function makeRoot(config: Config = {}) {
  const Comp: React.FC<Props> = (props) => <SplicewrightProject {...props} components={config.components} />;
  const defaultProps: Props = { project: createProject({ title: "", fps: 30, width: 1920, height: 1080 }), duck: {}, presets: config.presets };
  return () => (
    <Composition
      id={COMPOSITION_ID}
      component={Comp}
      defaultProps={defaultProps}
      calculateMetadata={({ props }) => {
        const { fps, width, height } = props.project.meta;
        return { fps, width, height, durationInFrames: Math.max(1, durationFrames(props.project)) };
      }}
    />
  );
}
