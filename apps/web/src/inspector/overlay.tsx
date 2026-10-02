import React from "react";
import { animateOverlay, type OverlayItem, type Project } from "@splicewright/core";
import { op, playhead } from "../store.ts";
import { Field, KeyButton } from "./fields.tsx";

const TRANSFORM = ["x", "y", "scale", "rotation", "opacity"] as const;

export function OverlayFields({ p, item, set }: { p: Project; item: OverlayItem; set: (patch: Record<string, unknown>) => void }) {
  const frame = playhead.use((s) => s.frame);
  const now = animateOverlay(p, item, frame);
  const numericProps = Object.entries(item.props).filter(([, value]) => typeof value === "number").map(([name]) => [name, String(name)] as const);
  const textSize = (item.props.textStyle as { size?: unknown } | undefined)?.size;
  if (item.component === "Text" && typeof textSize === "number") numericProps.push(["textStyle.size", "textStyle.size"]);
  const transform = item.transform ?? {};
  const setTransform = (name: string, value: number | null) => {
    const next = { ...transform } as Record<string, number | undefined>;
    if (value === null) delete next[name]; else next[name] = value;
    set({ transform: Object.keys(next).length ? next : null });
  };
  const write = (prop: string, value: number) => void op("setKeyframe", { itemId: item.id, prop, at: frame, value });
  const keyed = (prop: string) => !!item.keyframes?.[prop];
  return <>
    <h4>Overlay transform</h4>
    {TRANSFORM.map((prop) => {
      const value = now.transform?.[prop] ?? (prop === "scale" || prop === "opacity" ? 1 : 0);
      return <Field key={prop} label={prop} type="number" value={value} mark={<KeyButton p={p} item={item} prop={prop} frame={frame} value={value} />}
        onCommit={(v) => v !== null && (keyed(prop) ? write(prop, Number(v)) : setTransform(prop, Number(v)))} />;
    })}
    {numericProps.map(([name, path]) => {
      const prop = `props.${path}`;
      const value = path === "textStyle.size" ? Number((now.props.textStyle as { size: number }).size) : Number(now.props[path]);
      return <Field key={prop} label={name} type="number" value={value} mark={<KeyButton p={p} item={item} prop={prop} frame={frame} value={value} />}
        onCommit={(v) => {
          if (v === null) return;
          if (keyed(prop)) write(prop, Number(v));
          else if (path === "textStyle.size") set({ props: { ...item.props, textStyle: { ...(item.props.textStyle as object), size: Number(v) } } });
          else set({ props: { ...item.props, [path]: Number(v) } });
        }} />;
    })}
  </>;
}
