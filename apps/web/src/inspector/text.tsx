import { FONT_ROLES, FONTS, THEME_IDS, fontAssetFamily, type FontRole, type OverlayItem, type Project, type TextStyle, type Track } from "@splicewright/core";
import { app, op } from "../store.ts";
import { effectiveTextValues } from "../style.ts";
import { Field } from "./fields.tsx";
import { fieldLabel } from "./labels.ts";


/** Text overlay: the string, its role (theme slot) and style fields. Each edit rewrites props (one undo step); anything else stays in the JSON field below. */
export function TextFields({ p, item, set }: { p: Project; item: OverlayItem; set: (patch: Record<string, unknown>) => void }) {
  const props = item.props as { text?: string; role?: FontRole; textStyle?: TextStyle; style?: Record<string, unknown> };
  const put = (next: Record<string, unknown>) => set({ props: { ...props, ...next } });
  return (
    <>
      <Field label="text" value={props.text} onCommit={(v) => put({ text: v ?? "" })} />
      <label className="field">
        <span>文字用途（主題樣式）</span>
        <select value={props.role ?? "title"} onChange={(e) => put({ role: e.target.value })}>
          {FONT_ROLES.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <StyleFields
        p={p}
        role={props.role ?? "title"}
        style={props.textStyle}
        rawStyle={props.style}
        text={props.text ?? ""}
        onChange={(textStyle, key) => {
          // the raw CSS escape hatch would override the field just edited
          const { [RAW[key]]: _, ...style } = props.style ?? {};
          put({ textStyle, style });
        }}
      />
    </>
  );
}

const RAW = { font: "fontFamily", weight: "fontWeight", size: "fontSize", color: "color" } as const;
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

/** Font (★ first, each in its own face, 中 = has Chinese glyphs), weight, size, color. null clears a field back to the theme. */
export function StyleFields({ p, role, style = {}, rawStyle = {}, text, onChange }: { p: Project; role: FontRole; style?: TextStyle; rawStyle?: Record<string, unknown>; text: string; onChange: (next: TextStyle, key: keyof typeof RAW) => void }) {
  const put = (key: keyof typeof RAW, v: unknown) => {
    const { [key]: _, ...rest } = style;
    onChange(v === null ? rest : { ...rest, [key]: v }, key);
  };
  const face = (f: (typeof FONTS)[number]) => (
    <option key={f.name} value={f.name} style={{ fontFamily: `"${f.family}"` }}>
      {f.name}
      {f.cjk ? " 中" : ""}
    </option>
  );
  const chosen = FONTS.find((f) => f.name === style.font);
  const customFonts = Object.values(p.assets).filter((a) => a.kind === "font");
  const effectiveValues = effectiveTextValues(p, role, style, rawStyle, text);
  return (
    <>
      <div className="effective-style" aria-label="Effective rendered text style">
        <strong>目前實際顯示的樣式</strong>
        {effectiveValues.map(({ label, value, source }) => <div key={label}><span>{fieldLabel(label)}</span><code>{String(value)}</code><small>{source === "raw CSS" ? "進階 CSS 覆寫" : source === "text override" ? "此文字的設定" : source === "renderer default" ? "預設樣式" : source.replace(" theme", " 主題")}</small></div>)}
      </div>
      <label className="field" data-ui-control="font">
        <span>字體</span>
        <select value={style.font ?? ""} onChange={(e) => put("font", e.target.value || null)}>
          <option value="">使用主題設定</option>
          <optgroup label="★ 建議字體">{FONTS.filter((f) => f.core).map(face)}</optgroup>
          <optgroup label="其他字體">{FONTS.filter((f) => !f.core).map(face)}</optgroup>
          {customFonts.length > 0 && <optgroup label="已匯入字體">{customFonts.map((a) => <option key={a.id} value={a.id} style={{ fontFamily: `"${fontAssetFamily(a.id)}"` }}>{a.path.split("/").pop()} (raw)</option>)}</optgroup>}
        </select>
      </label>
      {chosen && !chosen.cjk && CJK.test(text) && <p className="dim">⚠ {chosen.name} has no Chinese glyphs; this text falls back to Noto Sans TC. Pick a 中 font for Chinese.</p>}
      <Field label="weight" type="number" value={style.weight} onCommit={(v) => put("weight", v === null ? null : Number(v))} />
      <Field control="size" label="size (px)" type="number" value={style.size} onCommit={(v) => put("size", v === null ? null : Number(v))} />
      <Field label="color" value={style.color} onCommit={(v) => put("color", v)} />
    </>
  );
}

/** A caption track's look: textStyle over the theme's subtitle role, and per-word highlight (anchored captions with transcript words). */
export function CaptionStyleFields({ t, text }: { t: Extract<Track, { kind: "caption" }>; text: string }) {
  const p = app.use((s) => s.project)!;
  return (
    <>
      <h4>caption track {t.name}</h4>
      <StyleFields p={p} role="subtitle" style={t.textStyle} text={text} onChange={(textStyle) => op("setTrack", { trackId: t.id, patch: { textStyle: Object.keys(textStyle).length ? textStyle : null } })} />
      <label className="field" title="Highlight the spoken word in the emphasis style (anchored captions only)">
        <span>highlight</span>
        <select value={t.highlight ?? "none"} onChange={(e) => op("setTrack", { trackId: t.id, patch: { highlight: e.target.value === "none" ? null : e.target.value } })}>
          <option>none</option>
          <option>word</option>
        </select>
      </label>
    </>
  );
}

/** Project theme: one op restyles every role-bound text. */
export function ThemeField({ p }: { p: Project }) {
  return (
    <label className="field" title="Restyles every Text overlay and caption track that uses a role (one undo step)">
      <span>專案文字主題</span>
      <select value={p.meta.theme ?? ""} onChange={(e) => op("setMeta", { theme: e.target.value || null })}>
        <option value="">(none)</option>
        {[...THEME_IDS, ...Object.keys(p.themes ?? {})].map((id) => (
          <option key={id}>{id}</option>
        ))}
      </select>
    </label>
  );
}

