const LABELS: Record<string, string> = {
  "size (px)": "字級（px）", text: "文字內容", font: "字體", weight: "字重", size: "字級", color: "顏色",
  x: "水平位置", y: "垂直位置", scale: "縮放倍率", rotation: "旋轉角度", opacity: "透明度",
  "pan (−1 left, +1 right)": "左右聲像（−1 左／＋1 右）", "gain (dB)": "增益（dB）", "denoise mix (0–1)": "降噪強度（0–1）", top: "上方裁切", right: "右方裁切", bottom: "下方裁切", left: "左方裁切",
  volume: "音量", "speed (×)": "播放速度（倍）", "transition (f)": "轉場長度（格）",
  brightness: "亮度", contrast: "對比", saturation: "飽和度", hue: "色相", blur: "模糊",
  grayscale: "灰階", sepia: "復古褐色", invert: "反相", exposure: "曝光", temperature: "色溫",
  tint: "色調", vibrance: "自然飽和度", shadows: "陰影", highlights: "高光",
  "LUT strength": "色彩風格強度", "key color": "移除的顏色", similarity: "顏色容差", smoothness: "邊緣柔化", spill: "去除溢色",
  "luma low": "亮度下限", "luma high": "亮度上限", feather: "邊緣柔化", radius: "圓角",
};
export const fieldLabel = (label: string) => LABELS[label] ?? label;
