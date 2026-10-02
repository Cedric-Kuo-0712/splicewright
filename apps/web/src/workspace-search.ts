export const WORKSPACE_CATEGORIES = ["素材", "文字", "貼紙", "轉場", "畫面調整", "音訊"] as const;
export type WorkspaceCategory = typeof WORKSPACE_CATEGORIES[number];
export type InspectorSection = "basic" | "screen" | "audio" | "text" | "advanced" | "project";
export type SearchContext = { selectionCount: number; kind?: "video" | "audio" | "overlay" | "caption"; component?: string; still?: boolean; locked?: boolean; hasImages?: boolean };
export type SearchAction = {
  id: string; label: string; category: WorkspaceCategory; section: InspectorSection; control: string;
  destination?: "panel" | "toolbar"; hint?: string; aliases: string[];
  available: (context: SearchContext) => boolean; unavailable: string;
};
const selected = (c: SearchContext, kind: SearchContext["kind"]) => c.selectionCount === 1 && c.kind === kind;
const video = (c: SearchContext) => selected(c, "video");
const screen = (c: SearchContext) => video(c) || selected(c, "overlay");
const audio = (c: SearchContext) => selected(c, "audio") || video(c) && !c.still;
const text = (c: SearchContext) => selected(c, "caption") || selected(c, "overlay") && c.component === "Text";
const make = (id: string, label: string, category: WorkspaceCategory, section: InspectorSection, aliases: string[], available: SearchAction["available"], unavailable: string, extra: Partial<SearchAction> = {}): SearchAction => ({ id, label, category, section, control: id, aliases, available, unavailable, ...extra });
const videoReason = "請先選取影片或圖片片段。";
const screenReason = "請先選取影片、圖片或圖層。";
const audioReason = "請先選取影片或音訊片段；圖片沒有音訊控制。";
const textReason = "請先選取文字圖層或字幕。";
export const SEARCH_ACTIONS: SearchAction[] = [
  make("import", "匯入素材", "素材", "basic", ["匯入", "import", "media", "影片", "音樂"], () => true, "", { destination: "panel", hint: "⌘I" }),
  make("create-text", "新增文字圖層", "文字", "text", ["新增文字", "新增標題", "add text", "title"], () => true, "", { destination: "panel", hint: "T" }),
  make("create-sticker", "從圖片新增貼紙", "貼紙", "screen", ["新增貼紙", "sticker", "image overlay"], (c) => !!c.hasImages, "請先匯入圖片素材。", { destination: "panel" }),
  make("split", "分割片段", "轉場", "basic", ["分割", "剪開", "split"], () => true, "", { destination: "toolbar", hint: "S / ⌘B" }),
  make("start", "開始時間（格）", "畫面調整", "basic", ["開始", "移動", "start", "move"], (c) => c.selectionCount === 1, "請先選取一個項目。"),
  make("duration", "片段長度（格）", "畫面調整", "basic", ["長度", "duration", "trim"], (c) => c.selectionCount === 1, "請先選取一個項目。"),
  make("fit", "完整顯示／填滿畫面", "畫面調整", "screen", ["fit", "contain", "cover"], (c) => video(c) || selected(c, "overlay") && c.component === "Sticker", videoReason),
  make("scale", "縮放", "畫面調整", "screen", ["放大", "縮小", "scale", "zoom"], screen, screenReason),
  make("x", "位置", "畫面調整", "screen", ["位置", "transform", "position", "平移"], screen, screenReason),
  make("rotation", "旋轉", "畫面調整", "screen", ["旋轉", "rotation", "rotate"], screen, screenReason),
  make("opacity", "透明度", "畫面調整", "screen", ["透明", "opacity"], screen, screenReason),
  make("speed", "播放速度", "畫面調整", "screen", ["倍速", "慢動作", "speed"], (c) => video(c) && !c.still, "請先選取影片片段。"),
  make("reverse", "倒放", "畫面調整", "screen", ["倒放", "reverse"], (c) => video(c) && !c.still, "請先選取影片片段。"),
  make("transition", "片段轉場", "轉場", "screen", ["轉場", "transition", "dissolve", "dip", "wipe", "slide", "push"], video, videoReason),
  make("crop", "裁切畫面", "畫面調整", "screen", ["裁切", "crop"], video, videoReason, { hint: "Shift+C" }),
  make("mask", "遮罩", "畫面調整", "screen", ["遮罩", "mask"], screen, screenReason, { hint: "Shift+K" }),
  make("key", "去背", "畫面調整", "screen", ["綠幕", "色鍵", "chroma", "luma", "key"], video, videoReason),
  make("lut", "色彩風格（LUT）", "畫面調整", "screen", ["調色", "lut", "grade", "color", "colour"], video, videoReason),
  make("brightness", "亮度", "畫面調整", "screen", ["亮度", "brightness", "effects"], video, videoReason),
  make("contrast", "對比", "畫面調整", "screen", ["contrast", "對比"], video, videoReason),
  make("saturation", "飽和度", "畫面調整", "screen", ["saturation", "飽和"], video, videoReason),
  make("blur", "模糊", "畫面調整", "screen", ["blur", "模糊"], video, videoReason),
  make("volume", "音量", "音訊", "audio", ["音量", "volume"], audio, audioReason),
  make("fade-in", "聲音淡入", "音訊", "audio", ["淡入", "fade in"], audio, audioReason),
  make("fade-out", "聲音淡出", "音訊", "audio", ["淡出", "fade out"], audio, audioReason),
  make("normalize", "統一響度", "音訊", "audio", ["響度", "loudness", "normalize"], audio, audioReason),
  make("audio-fx", "聲音處理", "音訊", "audio", ["聲音處理", "audio fx", "audio processing"], audio, audioReason),
  make("beats", "節拍與卡點", "音訊", "audio", ["卡點", "節拍", "節奏", "beat", "fit to beats"], (c) => selected(c, "audio"), "請先選取音訊片段。"),
  make("text", "文字內容與樣式", "文字", "text", ["文字", "字幕", "text", "caption", "style"], text, textReason),
  make("font", "字體", "文字", "text", ["字體", "font"], text, textReason),
  make("size", "字級", "文字", "text", ["字級", "文字大小", "font size"], text, textReason),
  make("weight", "字重", "文字", "text", ["粗體", "字重", "font weight", "bold"], text, textReason),
  make("text-color", "文字顏色", "文字", "text", ["文字顏色", "text color"], text, textReason, { control: "color" }),
  make("pan", "左右聲像", "音訊", "audio", ["聲像", "pan"], audio, audioReason),
  make("eq", "等化器", "音訊", "audio", ["等化器", "eq", "equalizer"], audio, audioReason),
  make("denoise", "降噪", "音訊", "audio", ["降噪", "去除雜音", "denoise", "noise"], audio, audioReason),
  make("advanced", "進階參數", "畫面調整", "advanced", ["原始參數", "props", "advanced", "raw"], (c) => selected(c, "overlay"), "請先選取圖層。"),
  make("project", "專案文字主題", "文字", "project", ["主題", "theme", "project", "專案設定"], () => true, ""),
];
export function actionAvailability(action: SearchAction, context: SearchContext) {
  const locked = context.locked && !action.destination && action.id !== "project";
  const available = !locked && action.available(context);
  return { available, reason: available ? "" : locked ? "此軌道已鎖定，無法編輯。" : action.unavailable };
}
export function searchActions(query: string, context: SearchContext) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean).map(normalize);
  return SEARCH_ACTIONS.filter((a) => !terms.length || terms.every((term) => normalize([a.label, ...a.aliases].join(" ")).includes(term)))
    .map((action) => ({ action, ...actionAvailability(action, context) }));
}
function normalize(value: string) { return value.toLocaleLowerCase().replace(/[\s（）()／/]+/g, ""); }
