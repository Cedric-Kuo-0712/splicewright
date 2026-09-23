import type { ComponentType } from "react";

// Spec §9. A project's splicewright.config.ts default-exports defineConfig({...}); the bundler
// aliases `splicewright` to this file, so the config needs no install of its own.

/** Options passed straight through to Remotion's renderMedia(). */
export interface Preset {
  crf?: number;
  scale?: number;
  concurrency?: number;
  hardwareAcceleration?: "disable" | "if-possible" | "required";
}

export interface Config {
  /** OverlayItem.component name → React component. A caption track's `style` names a replacement
   * for the built-in CaptionLayer, which receives `{ texts: string[] }`. */
  components?: Record<string, ComponentType<any>>;
  presets?: Record<string, Preset>;
}

export const defineConfig = (config: Config) => config;
