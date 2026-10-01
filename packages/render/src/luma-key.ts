import { createEffect, type EffectDefinition } from "remotion";

export const lumaKey = createEffect<LumaParams, null>({
  type: "splicewright-luma-key", label: "Luma key", documentationLink: null, backend: "2d", schema: {},
  calculateKey: (p) => `${p.low}:${p.high}:${p.invert}`,
  validateParams: ({ low, high }) => { if (!(low < high)) throw new Error("luma key low must be less than high"); },
  setup: () => null,
  apply: ({ source, target, params, width, height }) => {
    const ctx = target.getContext("2d", { willReadFrequently: true })!;
    ctx.clearRect(0, 0, width, height); ctx.drawImage(source, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height), px = image.data;
    for (let i = 0; i < px.length; i += 4) {
      const y = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      const t = Math.max(0, Math.min(1, (y - params.low) / (params.high - params.low)));
      const alpha = t * t * (3 - 2 * t);
      px[i + 3] = Math.round(px[i + 3] * (params.invert ? 1 - alpha : alpha));
    }
    ctx.putImageData(image, 0, 0);
  },
  cleanup: () => {},
} as EffectDefinition<LumaParams, null>);

export type LumaParams = { low: number; high: number; invert?: boolean };
