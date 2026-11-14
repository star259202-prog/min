// 所有可調整參數的定義（仿 Lightroom Classic 的「基本」「細節」「HSL」「色彩分級」「效果」面板）
// 這些全部都是「整體像素色彩/色調」運算，不含任何幾何變形或生成式 AI，因此不會讓人臉變形或「AI 化」。

export const HSL_BANDS = [
  { key: 'red', label: '紅', hue: 0 },
  { key: 'orange', label: '橙', hue: 30 },
  { key: 'yellow', label: '黃', hue: 60 },
  { key: 'green', label: '綠', hue: 120 },
  { key: 'aqua', label: '青', hue: 180 },
  { key: 'blue', label: '藍', hue: 225 },
  { key: 'purple', label: '紫', hue: 275 },
  { key: 'magenta', label: '洋紅', hue: 320 },
];

const basic = [
  { key: 'temp', label: '色溫', min: -100, max: 100, step: 1, group: 'wb' },
  { key: 'tint', label: '色調', min: -100, max: 100, step: 1, group: 'wb' },
  { key: 'exposure', label: '曝光度', min: -5, max: 5, step: 0.05, group: 'tone' },
  { key: 'contrast', label: '對比', min: -100, max: 100, step: 1, group: 'tone' },
  { key: 'highlights', label: '亮部', min: -100, max: 100, step: 1, group: 'tone' },
  { key: 'shadows', label: '陰影', min: -100, max: 100, step: 1, group: 'tone' },
  { key: 'whites', label: '白色', min: -100, max: 100, step: 1, group: 'tone' },
  { key: 'blacks', label: '黑色', min: -100, max: 100, step: 1, group: 'tone' },
  { key: 'texture', label: '紋理', min: -100, max: 100, step: 1, group: 'presence' },
  { key: 'clarity', label: '清晰度', min: -100, max: 100, step: 1, group: 'presence' },
  { key: 'dehaze', label: '去朦朧', min: -100, max: 100, step: 1, group: 'presence' },
  { key: 'vibrance', label: '細節飽和度', min: -100, max: 100, step: 1, group: 'presence' },
  { key: 'saturation', label: '飽和度', min: -100, max: 100, step: 1, group: 'presence' },
  { key: 'sharpen', label: '銳利化', min: 0, max: 150, step: 1, group: 'detail' },
  { key: 'vignette', label: '暗角（負值變暗）', min: -100, max: 100, step: 1, group: 'effects' },
  { key: 'grain', label: '顆粒', min: 0, max: 100, step: 1, group: 'effects' },
  { key: 'shadowHue', label: '陰影色相', min: 0, max: 360, step: 1, group: 'grading' },
  { key: 'shadowSat', label: '陰影飽和', min: 0, max: 100, step: 1, group: 'grading' },
  { key: 'highlightHue', label: '亮部色相', min: 0, max: 360, step: 1, group: 'grading' },
  { key: 'highlightSat', label: '亮部飽和', min: 0, max: 100, step: 1, group: 'grading' },
  { key: 'gradingBalance', label: '平衡', min: -100, max: 100, step: 1, group: 'grading' },
];

const hsl = [];
for (const b of HSL_BANDS) {
  hsl.push({ key: `hue_${b.key}`, label: `${b.label} 色相`, min: -100, max: 100, step: 1, group: 'hsl', band: b.key, kind: 'hue' });
  hsl.push({ key: `sat_${b.key}`, label: `${b.label} 飽和`, min: -100, max: 100, step: 1, group: 'hsl', band: b.key, kind: 'sat' });
  hsl.push({ key: `lum_${b.key}`, label: `${b.label} 明度`, min: -100, max: 100, step: 1, group: 'hsl', band: b.key, kind: 'lum' });
}

export const PARAMS = [...basic, ...hsl];
export const PARAM_MAP = Object.fromEntries(PARAMS.map((p) => [p.key, p]));

export const GROUPS = [
  { key: 'wb', label: '白平衡' },
  { key: 'tone', label: '色調' },
  { key: 'presence', label: '外觀' },
  { key: 'detail', label: '細節' },
  { key: 'hsl', label: 'HSL / 顏色' },
  { key: 'grading', label: '色彩分級' },
  { key: 'effects', label: '效果' },
];

export function defaultParams() {
  const o = {};
  for (const p of PARAMS) o[p.key] = 0;
  o.shadowHue = 210;
  o.highlightHue = 40;
  return o;
}

export function clampParam(key, value) {
  const p = PARAM_MAP[key];
  if (!p || !Number.isFinite(value)) return undefined;
  if (key === 'shadowHue' || key === 'highlightHue') return ((Math.round(value) % 360) + 360) % 360;
  const v = Math.min(p.max, Math.max(p.min, value));
  return p.step < 1 ? Math.round(v * 100) / 100 : Math.round(v);
}

// 預設集（全部只用整體調整）
export const PRESETS = {
  日系清新: { exposure: 0.35, contrast: -18, highlights: -30, shadows: 30, whites: 10, blacks: 15, temp: -8, tint: 3, vibrance: 12, saturation: -12, lum_green: 10, sat_orange: -8, lum_orange: 8 },
  電影感: { contrast: 18, highlights: -25, shadows: 10, blacks: 12, vibrance: -5, saturation: -10, shadowHue: 195, shadowSat: 25, highlightHue: 38, highlightSat: 20, vignette: -20, grain: 15 },
  復古底片: { contrast: -10, highlights: -15, blacks: 25, temp: 12, saturation: -20, shadowHue: 160, shadowSat: 12, highlightHue: 45, highlightSat: 18, grain: 35, vignette: -15 },
  人像柔和: { exposure: 0.15, contrast: -10, highlights: -20, shadows: 15, texture: -15, clarity: -8, vibrance: 8, sat_orange: -6, lum_orange: 10, lum_red: 4 },
  黑白經典: { saturation: -100, contrast: 25, clarity: 10, blacks: -10, whites: 10 },
  風景通透: { dehaze: 15, clarity: 15, vibrance: 25, highlights: -35, shadows: 25, sat_blue: 15, lum_blue: -12, sat_green: 10, sharpen: 40 },
};

export function describeParam(key) {
  return PARAM_MAP[key]?.label ?? key;
}
