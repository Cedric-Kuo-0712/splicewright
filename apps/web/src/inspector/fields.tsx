import React from "react";
import { fieldLabel } from "./labels.ts";
import { keyAt, type Animatable, type AudioItem, type OverlayItem, type Project, type VideoItem } from "@splicewright/core";
import { app, op, playhead } from "../store.ts";


/** Text or number input that commits on Enter or blur; empty clears the field. */

export function Field({ label, value, onCommit, type = "text", mark, control }: { label: string; value: unknown; onCommit: (v: string | number | null) => void; type?: "text" | "number"; mark?: React.ReactNode; control?: string }) {
  const initial = value === undefined || value === null ? "" : String(value);
  const commit = (raw: string) => {
    if (raw === initial) return;
    if (raw === "") return onCommit(null);
    if (type === "number") {
      const n = Number(raw);
      if (Number.isFinite(n)) onCommit(n);
      return;
    }
    onCommit(raw);
  };
  const id = React.useId();
  return (
    <label className="field" htmlFor={id} data-ui-control={control ?? label}>
      <span>
        {fieldLabel(label)}
        {mark}
      </span>
      <input
        id={id}
        name={label}
        key={initial}
        type={type}
        step="any"
        defaultValue={initial}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") { e.currentTarget.value = initial; e.currentTarget.blur(); }
        }}
      />
    </label>
  );
}

/** ◆ when a key sits on the playhead (click removes it), ◇ otherwise (click keys `value` there); lit once the prop has keys. */
export function KeyButton({ p, item, prop, frame, value }: { p: Project; item: VideoItem | AudioItem | OverlayItem; prop: string; frame: number; value: number }) {
  const on = !!keyAt(p, item, prop, frame);
  const inside = frame >= item.start && frame < item.start + item.duration;
  return (
    <button
      className={`kf-btn ${(item.keyframes as Record<string, unknown[]> | undefined)?.[prop] ? "keyed" : ""}`}
      disabled={!inside}
      title={inside ? (on ? `remove the ${prop} key here` : `key ${prop} here`) : "move the playhead into the item to key it"}
      onClick={() => op("setKeyframe", { itemId: item.id, prop, at: frame, value: on ? null : +value.toFixed(4) })}
    >
      {on ? "◆" : "◇"}
    </button>
  );
}

/** ◇ for a whole section: keys every prop at the playhead (keeping keys already there), or, when all are keyed here, removes them all. One undo step. */
export function KeyGroupButton({ p, item, frame, props }: { p: Project; item: VideoItem; frame: number; props: [Animatable, number][] }) {
  const here = props.filter(([k]) => keyAt(p, item, k, frame));
  const all = here.length === props.length;
  const inside = frame >= item.start && frame < item.start + item.duration;
  const ops = (all ? props.map(([prop]) => [prop, null] as const) : props.filter((kv) => !here.includes(kv)).map(([prop, v]) => [prop, +v.toFixed(4)] as const)).map(([prop, value]) => ({
    op: "setKeyframe",
    args: { itemId: item.id, prop, at: frame, value },
  }));
  return (
    <button
      className={`kf-btn ${props.some(([k]) => item.keyframes?.[k]) ? "keyed" : ""}`}
      disabled={!inside}
      title={inside ? (all ? "remove every key here in this section" : "key every field in this section here") : "move the playhead into the item to key it"}
      onClick={() => op("batch", { ops })}
    >
      {all ? "◆" : here.length ? "◈" : "◇"}
    </button>
  );
}


/** name, min, max, step, neutral */
export const EFFECTS = [
  ["brightness", 0, 2, 0.01, 1],
  ["contrast", 0, 2, 0.01, 1],
  ["saturation", 0, 3, 0.01, 1],
  ["hue", -180, 180, 1, 0],
  ["blur", 0, 40, 0.5, 0],
  ["grayscale", 0, 1, 0.01, 0],
  ["sepia", 0, 1, 0.01, 0],
  ["invert", 0, 1, 0.01, 0],
] as const;
export const EFFECT_ZERO: Record<string, number> = Object.fromEntries(EFFECTS.map(([k, , , , z]) => [k, z]));

/** Drop neutral values (`zero[k]`, else 0), so a fully reset group unsets the field. */
export const prune = (o: Record<string, number | undefined>, zero: Record<string, number>) => {
  const out = Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && v !== (zero[k] ?? 0)));
  return Object.keys(out).length ? out : null;
};

/** Range slider: the preview follows the drag through `live`, release commits one setProps (one undo step); double-click resets. */
export function Slider({ itemId, label, min, max, step, zero, value, patch, mark }: { itemId: string; label: string; min: number; max: number; step: number; zero: number; value: number; patch: (v: number) => Partial<VideoItem> | Record<string, unknown>; mark?: React.ReactNode }) {
  const commit = (v: number) => op("setProps", { itemId, patch: patch(v) }).finally(() => app.set({ live: null }));
  const release = (v: number) => app.get().live?.itemId === itemId && commit(v);
  const id = React.useId();
  return (
    <label data-ui-control={label} className="field slider" htmlFor={id} title="drag; arrow keys step; double-click resets">
      <span>
        {fieldLabel(label)}
        {mark}
      </span>
      <input
        id={id}
        onDoubleClick={() => value !== zero && commit(zero)}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => app.set({ live: { itemId, patch: patch(+e.currentTarget.value) as Partial<VideoItem> } })}
        onPointerUp={(e) => release(+e.currentTarget.value)}
        onKeyUp={(e) => release(+e.currentTarget.value)}
      />
      <output>{+value.toFixed(3)}</output>
    </label>
  );
}

export function PropsField({ value, onCommit }: { value: unknown; onCommit: (v: unknown) => void }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <label className="field column">
      <span>props (JSON)</span>
      <textarea
        key={text}
        defaultValue={text}
        rows={6}
        onBlur={(e) => {
          if (e.currentTarget.value === text) return;
          try {
            onCommit(JSON.parse(e.currentTarget.value));
          } catch (err) {
            app.set({ message: { text: `props: ${(err as Error).message}`, error: true } });
          }
        }}
      />
    </label>
  );
}
