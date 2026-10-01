import { textCss, themeOf, type FontRole, type Project, type TextStyle } from "@splicewright/core";

export function effectiveTextValues(project: Project, role: FontRole, style: TextStyle | undefined, raw: Record<string, unknown> = {}, text = "") {
  const css = { ...textCss(project, role, style, text), ...raw };
  const inherited = themeOf(project)?.roles[role] ?? {};
  return ([
    ["font", css.fontFamily ?? "component default", "fontFamily", "font"],
    ["weight", css.fontWeight ?? "component default", "fontWeight", "weight"],
    ["size", typeof css.fontSize === "number" ? `${css.fontSize}px` : css.fontSize ?? "component default", "fontSize", "size"],
    ["color", css.color ?? "component default", "color", "color"],
  ] as const).map(([label, value, cssKey, styleKey]) => ({
    label,
    value,
    source: Object.hasOwn(raw, cssKey) ? "raw CSS" : Object.hasOwn(style ?? {}, styleKey) ? "text override" : Object.hasOwn(inherited, styleKey) ? `${role} theme` : "renderer default",
  }));
}
