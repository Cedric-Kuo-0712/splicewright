import type { Project } from "@splicewright/core";
import { findItem } from "./edit.ts";
import type { InspectorSection, SearchAction, SearchContext } from "./workspace-search.ts";

export type ControlLocation = { section: InspectorSection; control: string; serial: number };

export function searchContext(p: Project, selection: string[]): SearchContext {
  const found = selection.length === 1 ? findItem(p, selection[0]) : null;
  return {
    selectionCount: selection.length,
    kind: found?.track.kind,
    component: found && "component" in found.item ? found.item.component : undefined,
    still: !!(found && "assetId" in found.item && p.assets[found.item.assetId]?.kind === "image"),
    locked: !!found?.track.locked,
    hasImages: Object.values(p.assets).some((a) => a.kind === "image"),
  };
}

/** Open collapsed ancestors before focusing; search never commits an edit. */
export function focusControl(root: HTMLElement, control: string): boolean {
  const target = root.querySelector<HTMLElement>(`[data-ui-control="${control}"]`);
  if (!target) return false;
  let parent: HTMLElement | null = target;
  while (parent && root.contains(parent)) {
    if (parent.tagName === "DETAILS") (parent as HTMLDetailsElement).open = true;
    parent = parent.parentElement;
  }
  target.scrollIntoView({ block: "nearest" });
  const field = target.matches("input, select, textarea, button") ? target : target.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), summary");
  if (field) field.focus({ preventScroll: true });
  else { target.tabIndex = -1; target.focus({ preventScroll: true }); }
  return true;
}

export function shortcutHint(action: SearchAction, mac: boolean, context?: SearchContext): string | undefined {
  if (action.id === "mask" && context?.kind === "overlay") return undefined;
  return action.hint?.replaceAll("⌘", mac ? "⌘" : "Ctrl+");
}
