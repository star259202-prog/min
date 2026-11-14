// 離線中文指令解析器：把「口語描述」轉成參數調整。
// 沒有設定 Claude API 金鑰時使用；有金鑰時由伺服器端的 Claude 理解更複雜的描述。

import { PARAM_MAP, PRESETS, HSL_BANDS, clampParam, describeParam } from './params.js';

// 每個參數「一步」的大小
const STEP = {
  exposure: 0.3, contrast: 15, highlights: 20, shadows: 20, whites: 12, blacks: 12,
  temp: 10, tint: 8, texture: 12, clarity: 12, dehaze: 12, vibrance: 15, saturation: 12,
  sharpen: 25, vignette: 15, grain: 15, hsl: 15,
};

const COLOR_WORDS = {
  紅: 'red', 橙: 'orange', 橘: 'orange', 黃: 'yellow', 綠: 'green', 青: 'aqua', 藍: 'blue', 紫: 'purple', 洋紅: 'magenta', 粉: 'magenta',
};

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnToNumber(s) {
  if (/^\d/.test(s)) return parseFloat(s);
  let total = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch in CN_DIGIT) cur = CN_DIGIT[ch];
    else if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
    else if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
  }
  return total + cur;
}

export function magnitude(seg) {
  if (/一點點|一丁點|微微|稍稍|一咪咪/.test(seg)) return 0.35;
  if (/非常|超級|極度|大幅|大量|很多|狠狠|強烈|超/.test(seg)) return 2.2;
  if (/明顯|多一些|很|蠻|滿|相當/.test(seg)) return 1.6;
  if (/一點|一些|稍微|有點|些許|一下|輕微|淡淡|略/.test(seg)) return 0.7;
  return 1;
}

// 回傳 { value, absolute } 或 null
export function findNumber(seg) {
  const m = seg.match(/(到|為|成|設|調到|變成|=)?\s*([+\-－]?)\s*(\d+(?:\.\d+)?|[零一二兩三四五六七八九十百]+(?![點些下]))\s*(%|格|度|級|檔|ev|EV)?/);
  if (!m) return null;
  if (!/\d/.test(m[3]) && !/[十百]/.test(m[3]) && !m[1] && !m[4] && !/(加|減|增加|減少|提高|降低)\s*$/.test(seg.slice(0, m.index))) return null;
  let value = cnToNumber(m[3]);
  if (m[2] === '-' || m[2] === '－') value = -value;
  return { value, absolute: Boolean(m[1]) };
}

const INC_MULTI = /(增加|提高|提升|拉高|調高|加強|加大|多一點|多一些|更多|強一點|高一點|大一點|拉回|救回|找回|提亮|拉亮|變亮|加亮|亮一點|亮一些|明亮|更亮|加重|變強|變多|變高)/;
const DEC_MULTI = /(降低|減少|減弱|拉低|調低|壓低|壓暗|變暗|少一點|少一些|弱一點|低一點|小一點|淡一點|暗一點|暗一些|更暗|收一點|減輕|變弱|變少|變低|拿掉|去掉|移除|不要那麼|別那麼|沒那麼)/;
const INC_SINGLE = /[加增提升拉高強多大亮]/;
const DEC_SINGLE = /[減降低弱少小壓暗收淡]/;

export function direction(text) {
  const dm = text.match(DEC_MULTI);
  const im = text.match(INC_MULTI);
  if (dm && (!im || dm.index <= im.index)) return -1;
  if (im) return 1;
  const ds = text.match(DEC_SINGLE);
  const is = text.match(INC_SINGLE);
  if (ds && (!is || ds.index <= is.index)) return -1;
  if (is) return 1;
  return 0;
}

function invertFactor(seg) {
  // 「太亮」「過曝」→ 反向；「不夠」→ 不反向
  if (/(太|過於|過度|過頭)/.test(seg) && !/不太/.test(seg)) return -1;
  if (/(不要|別|不用|不想)/.test(seg) && !/不要太|別太/.test(seg) && !DEC_MULTI.test(seg)) return -1;
  return 1;
}

// ---------- 規則 ----------
// noun: 名詞型主題，方向由句子中的動詞決定（如「陰影」「對比」）
// verb: 動詞型主題，本身就帶方向（如「提亮」「暖一點」）
const RULES = [
  {
    id: 'skin', noun: true,
    re: /(臉上?的皮膚|臉上?的肌膚|膚色|皮膚|肌膚|臉色|氣色|膚質|人臉|臉部|臉)(的)?(顏色)?(看起來)?(再|更|太|偏|很|有點)?(紅潤|白皙|透亮|健康|自然|光滑|細緻|白|亮|暗|黑|黃|紅|柔)?/g,
    apply(seg, ctx) {
      const m = magnitude(seg);
      if (/紅潤|氣色好|有血色|健康/.test(seg)) { ctx.add('sat_red', 6 * m); ctx.add('sat_orange', 5 * m); ctx.add('hue_orange', -4 * m); return; }
      if (/(太|偏|很)黃|蠟黃|黃黃/.test(seg)) { ctx.add('hue_orange', -8 * m); ctx.add('sat_orange', -10 * m); ctx.add('sat_yellow', -8 * m); return; }
      if (/(太|偏|很)紅/.test(seg)) { ctx.add('sat_red', -10 * m); ctx.add('hue_red', 6 * m); ctx.add('sat_orange', -5 * m); return; }
      if (/(太|偏|很)(暗|黑)/.test(seg)) { ctx.add('lum_orange', 12 * m); ctx.add('lum_red', 5 * m); ctx.add('shadows', 8 * m); return; }
      if (/白|亮|透|明亮/.test(seg) && !/暗/.test(seg)) { ctx.add('lum_orange', 12 * m); ctx.add('lum_red', 5 * m); ctx.add('sat_orange', -5 * m); return; }
      if (/暗|黑|深|古銅/.test(seg)) { ctx.add('lum_orange', -10 * m); ctx.add('sat_orange', 5 * m); return; }
      if (/柔|光滑|細緻|平滑|乾淨/.test(seg)) { ctx.add('texture', -Math.min(15 * m, 30)); return; }
      // 預設：讓膚色自然（降低過度飽和、微提亮）
      ctx.add('sat_orange', -6 * m); ctx.add('lum_orange', 6 * m); ctx.add('sat_red', -3 * m);
      ctx.note('膚色只透過橙/紅色的 HSL 調整，不會改變臉型');
    },
  },
  {
    id: 'lips', noun: true, re: /(嘴唇|唇色|口紅)/g,
    apply(seg, ctx) { ctx.add('sat_red', 10 * ctx.dir(seg, 1) * magnitude(seg)); },
  },
  {
    id: 'sky', noun: true, re: /(天空|藍天|天色|雲)(的)?(顏色)?(再|更|太|很)?(藍|深|淡|淺|亮|暗|青)?/g,
    apply(seg, ctx) {
      const m = magnitude(seg);
      if (/淡|淺|白|亮/.test(seg) && !/暗|深/.test(seg)) {
        const d = invertFactor(seg);
        ctx.add('lum_blue', 15 * m * d); ctx.add('sat_blue', -8 * m * d); return;
      }
      if (/暗|深|沉/.test(seg) && !/藍/.test(seg)) { ctx.add('lum_blue', -15 * m); ctx.add('highlights', -10 * m); return; }
      const d = ctx.dir(seg, 1);
      ctx.add('sat_blue', 18 * m * d); ctx.add('lum_blue', -12 * m * d); ctx.add('sat_aqua', 8 * m * d);
    },
  },
  {
    id: 'plants', noun: true, re: /(草地|草皮|樹葉|樹木|樹|葉子|植物|森林|草)(的)?(顏色)?(再|更|太|很)?(綠|暗|深|黃)?/g,
    apply(seg, ctx) {
      const m = magnitude(seg);
      if (/暗|深/.test(seg)) { ctx.add('lum_green', -12 * m); ctx.add('sat_green', 5 * m); return; }
      if (/黃|秋/.test(seg)) { ctx.add('hue_green', -15 * m); ctx.add('hue_yellow', -10 * m); return; }
      const d = ctx.dir(seg, 1);
      ctx.add('sat_green', 15 * m * d); ctx.add('sat_yellow', 6 * m * d); ctx.add('lum_green', 4 * m * d);
    },
  },
  {
    id: 'sunset', noun: true, re: /(夕陽|晚霞|日落|日出|黃昏)/g,
    apply(seg, ctx) {
      const d = ctx.dir(seg, 1); const m = magnitude(seg);
      ctx.add('sat_orange', 15 * m * d); ctx.add('sat_red', 8 * m * d); ctx.add('temp', 10 * m * d); ctx.add('highlights', -10 * m);
    },
  },
  {
    id: 'water', noun: true, re: /(海水|大海|海|湖水|湖)(的)?(顏色)?(再|更|很)?(藍|綠|青)?/g,
    apply(seg, ctx) {
      const d = ctx.dir(seg, 1); const m = magnitude(seg);
      ctx.add('sat_aqua', 15 * m * d); ctx.add('sat_blue', 8 * m * d); ctx.add('lum_aqua', -5 * m * d);
    },
  },
  { id: 'reset', re: /(全部重置|重置|全部還原|恢復原圖|還原原圖|重新開始|清除所有|清除全部)/g, apply(seg, ctx) { ctx.action('reset'); } },
  { id: 'undo', re: /(復原|上一步|撤銷|撤回|取消剛剛|回到剛剛|剛剛那樣不好|不要剛剛)/g, apply(seg, ctx) { ctx.action('undo'); } },
  { id: 'redo', re: /(重做|下一步)/g, apply(seg, ctx) { ctx.action('redo'); } },
  {
    id: 'preset',
    re: /(日系|清新|電影感|電影|cinematic|復古|底片|懷舊|人像柔和|柔美人像|黑白|單色|風景通透|風景)/gi,
    apply(seg, ctx, match) {
      const w = match[1];
      const name = /日系|清新/.test(w) ? '日系清新' : /電影|cinematic/i.test(w) ? '電影感' : /復古|底片|懷舊/.test(w) ? '復古底片'
        : /人像|柔美/.test(w) ? '人像柔和' : /黑白|單色/.test(w) ? '黑白經典' : '風景通透';
      ctx.preset(name, magnitude(seg));
    },
  },
  { id: 'castWarm', verb: true, re: /(偏黃|太黃|偏暖|太暖|偏橘|太橘)/g, apply(seg, ctx) { ctx.add('temp', -STEP.temp * magnitude(seg)); } },
  { id: 'castCool', verb: true, re: /(偏藍|太藍|偏冷|太冷)/g, apply(seg, ctx) { ctx.add('temp', STEP.temp * magnitude(seg)); } },
  { id: 'castGreen', verb: true, re: /(偏綠|太綠)/g, apply(seg, ctx) { ctx.add('tint', STEP.tint * magnitude(seg)); } },
  { id: 'castMagenta', verb: true, re: /(偏紫|太紫|偏洋紅|偏粉|太粉|偏紅|太紅)/g, apply(seg, ctx) { ctx.add('tint', -STEP.tint * magnitude(seg)); } },
  {
    id: 'hslColor', noun: true,
    re: /(洋紅|紅|橙|橘|黃|綠|青|藍|紫|粉)色?的?(飽和度?|鮮豔度?|鮮艷度?|明度|亮度|色相|顏色)?/g,
    apply(seg, ctx, match) {
      const band = COLOR_WORDS[match[1]];
      const attr = match[2] || '';
      const m = magnitude(seg);
      const n = findNumber(seg.replace(match[0], ''));
      const rest = seg.replace(match[0], '');
      let kind = 'sat';
      if (/明度|亮度/.test(attr) || (!attr && /亮|暗/.test(rest))) kind = 'lum';
      if (/色相/.test(attr)) kind = 'hue';
      const key = `${kind}_${band}`;
      if (n) { n.absolute ? ctx.set(key, n.value) : ctx.add(key, n.value * ctx.dir(rest, 1)); return; }
      if (kind === 'lum') { ctx.add(key, STEP.hsl * m * (/暗|深/.test(rest) ? -1 : 1) * invertFactor(seg)); return; }
      if (kind === 'hue') { ctx.add(key, STEP.hsl * m * ctx.dir(rest, 1)); return; }
      const d = /淡|灰|少|降|減|低|弱/.test(rest) ? -1 : 1;
      ctx.add(key, STEP.hsl * m * d * invertFactor(seg));
    },
  },
  {
    id: 'highlights', noun: true, re: /(亮部細節|亮部|高光|亮處|亮的地方|過曝的地方)/g,
    apply(seg, ctx, match) {
      if (/(拉回|救回|找回|細節)/.test(seg + match[0]) && !findNumber(seg)) { ctx.add('highlights', -STEP.highlights * magnitude(seg)); return; }
      ctx.step('highlights', seg);
    },
  },
  {
    id: 'shadows', noun: true, re: /(暗部細節|陰影|暗部|暗處|暗的地方|影子)/g,
    apply(seg, ctx) { ctx.step('shadows', seg); },
  },
  { id: 'whites', noun: true, re: /(白色|白階|白場|白點)/g, apply(seg, ctx) { ctx.step('whites', seg, 1); } },
  { id: 'blacks', noun: true, re: /(黑色|黑階|黑場|黑點)/g, apply(seg, ctx) { ctx.step('blacks', seg, /深|沉|重/.test(seg) ? -1 : 1); } },
  { id: 'contrast', noun: true, re: /(對比度?|反差)/g, apply(seg, ctx) { ctx.step('contrast', seg, 1); } },
  { id: 'vibrance', noun: true, re: /(細節飽和度?|自然飽和度?|鮮豔度|鮮艷度|自然鮮豔)/g, apply(seg, ctx) { ctx.step('vibrance', seg, 1); } },
  { id: 'saturation', noun: true, re: /(飽和度?|色彩濃度|彩度)/g, apply(seg, ctx) { ctx.step('saturation', seg, 1); } },
  { id: 'warm', verb: true, re: /(溫暖|暖色調?|暖調|暖一點|暖一些|暖些|更暖|暖)/g, apply(seg, ctx) { ctx.add('temp', STEP.temp * magnitude(seg) * invertFactor(seg)); } },
  { id: 'cool', verb: true, re: /(冷色調?|冷調|清冷|冷一點|冷一些|更冷|冷)/g, apply(seg, ctx) { ctx.add('temp', -STEP.temp * magnitude(seg) * invertFactor(seg)); } },
  { id: 'temperature', noun: true, re: /(色溫)/g, apply(seg, ctx) { ctx.step('temp', seg, 1); } },
  { id: 'tintParam', noun: true, re: /(色調|色偏)(?!偏)/g, apply(seg, ctx) { ctx.step('tint', seg, /綠/.test(seg) ? -1 : 1); } },
  { id: 'exposureNoun', noun: true, re: /(曝光度?|亮度|整體亮度)/g, apply(seg, ctx) { ctx.step('exposure', seg, 1); } },
  { id: 'textureP', noun: true, re: /(紋理|質感)/g, apply(seg, ctx) { ctx.step('texture', seg, 1); } },
  { id: 'clarityP', noun: true, re: /(清晰度|立體感|層次感?|空氣感)/g, apply(seg, ctx) { ctx.step('clarity', seg, 1); } },
  { id: 'dehazeP', noun: true, re: /(去朦朧|去霧|霧氣|霧感|朦朧感?)/g,
    apply(seg, ctx, match) { ctx.step('dehaze', seg, /去/.test(match[0]) ? 1 : -1); } },
  { id: 'sharpenP', noun: true, re: /(銳利度|銳利化|銳化|銳度|細節)/g, apply(seg, ctx) { ctx.step('sharpen', seg, 1); } },
  { id: 'vignetteP', noun: true, re: /(暗角|四周|周圍|邊角|邊緣)/g,
    apply(seg, ctx, match) {
      const rest = seg.replace(match[0], '');
      const m = magnitude(seg);
      if (/暗角/.test(match[0])) ctx.add('vignette', -STEP.vignette * m * ctx.dir(rest, 1));
      else ctx.add('vignette', STEP.vignette * m * (/亮|白/.test(rest) ? 1 : -1));
    } },
  { id: 'grainP', noun: true, re: /(顆粒感?|雜訊|噪點|底片顆粒)/g,
    apply(seg, ctx) {
      if (/(降噪|去|減|少)/.test(seg) && /雜訊|噪點/.test(seg)) { ctx.add('grain', -100); ctx.note('降噪需要專業演算法，這裡只移除額外加入的顆粒'); return; }
      ctx.step('grain', seg, 1);
    } },
  // ---- 動詞型（本身帶方向）----,
  { id: 'vivid', verb: true, re: /(鮮豔|鮮艷|鮮明|色彩豐富|顏色濃|濃郁|飽滿)/g,
    apply(seg, ctx) { const f = magnitude(seg) * invertFactor(seg); ctx.add('vibrance', STEP.vibrance * f); ctx.add('saturation', 5 * f); } },
  { id: 'muted', verb: true, re: /(低飽和|淡雅|素雅|灰調|莫蘭迪|顏色淡|色彩淡|褪色)/g,
    apply(seg, ctx) { const f = magnitude(seg) * invertFactor(seg); ctx.add('saturation', -STEP.saturation * 1.3 * f); ctx.add('vibrance', -5 * f); } },
  { id: 'sharp', verb: true, re: /(清晰|清楚|銳利|立體|有層次|通透)/g,
    apply(seg, ctx, match) {
      const f = magnitude(seg) * invertFactor(seg);
      if (/銳利/.test(match[0])) ctx.add('sharpen', STEP.sharpen * f);
      else if (/通透/.test(match[0])) { ctx.add('dehaze', 10 * f); ctx.add('clarity', 6 * f); }
      else ctx.add('clarity', STEP.clarity * f);
    } },
  { id: 'soft', verb: true, re: /(柔和|柔焦|柔一點|夢幻|朦朧)/g,
    apply(seg, ctx) { const f = magnitude(seg) * invertFactor(seg); ctx.add('clarity', -10 * f); ctx.add('contrast', -8 * f); ctx.add('highlights', -5 * f); } },
  { id: 'overexposed', verb: true, re: /(過曝|太亮|亮過頭|曝光過度)/g,
    apply(seg, ctx) { const m = magnitude(seg); ctx.add('exposure', -STEP.exposure * m); ctx.add('highlights', -15 * m); } },
  { id: 'underexposed', verb: true, re: /(欠曝|太暗|曝光不足|不夠亮|暗暗的|黑黑的)/g,
    apply(seg, ctx) { const m = magnitude(seg); ctx.add('exposure', STEP.exposure * m); ctx.add('shadows', 10 * m); } },
  { id: 'brighter', verb: true, re: /(提亮|變亮|拉亮|加亮|亮一點|亮一些|亮些|更亮|明亮|調亮|亮)/g,
    apply(seg, ctx) { ctx.add('exposure', STEP.exposure * magnitude(seg) * invertFactor(seg)); } },
  { id: 'darker', verb: true, re: /(壓暗|變暗|調暗|暗一點|暗一些|暗些|更暗|暗)/g,
    apply(seg, ctx) { ctx.add('exposure', -STEP.exposure * magnitude(seg) * invertFactor(seg)); } },
];

const GAP_RE = /^[\s的都再也把將給讓些一點稍微再來]*$/;

function splitClauses(text) {
  return text
    .split(/[，,。；;！!？?\n]|然後|並且|接著|再來|同時|另外|還有/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function findTopics(clause) {
  let masked = clause;
  const found = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    const re = new RegExp(rule.re.source, rule.re.flags);
    while ((m = re.exec(masked))) {
      if (!m[0].trim()) { re.lastIndex++; continue; }
      found.push({ rule, start: m.index, end: m.index + m[0].length, match: m });
      masked = masked.slice(0, m.index) + ' '.repeat(m[0].length) + masked.slice(m.index + m[0].length);
    }
  }
  found.sort((a, b) => a.start - b.start);
  // 「陰影提亮」「壓暗亮部」：緊貼名詞的動詞型詞語，視為那個名詞的方向
  return found.filter((t, i) => {
    if (!t.rule.verb || !/^(brighter|darker)$/.test(t.rule.id)) return true;
    const prev = found[i - 1];
    const next = found[i + 1];
    if (prev && prev.rule.noun && GAP_RE.test(clause.slice(prev.end, t.start))) return false;
    if (next && next.rule.noun && GAP_RE.test(clause.slice(t.end, next.start))) return false;
    return true;
  });
}

export function parseCommand(text, current) {
  const base = { ...current };
  const out = { ...current };
  const touched = new Set();
  const notes = [];
  let action = null;
  const matchedTopics = [];

  const ctx = {
    add(key, delta) {
      if (!PARAM_MAP[key] || !Number.isFinite(delta)) return;
      out[key] = clampParam(key, out[key] + delta);
      touched.add(key);
    },
    set(key, value) {
      const v = clampParam(key, value);
      if (v === undefined) return;
      out[key] = v;
      touched.add(key);
    },
    note(s) { if (!notes.includes(s)) notes.push(s); },
    action(a) { action = a; },
    preset(name, m) {
      const p = PRESETS[name];
      const strength = Math.min(m, 1.5);
      for (const [k, v] of Object.entries(p)) {
        if (k.endsWith('Hue')) ctx.set(k, v);
        else ctx.set(k, v * strength);
      }
      ctx.note(`套用「${name}」風格`);
    },
    dir(text, dflt) {
      const d = direction(text) || dflt;
      return d * invertFactor(text);
    },
    // 名詞型主題的通用步進：支援「對比加20」「飽和度調到-30」「亮部壓一點」
    step(key, seg, dflt = 1) {
      const topicless = seg;
      const n = findNumber(topicless);
      if (n) {
        if (n.absolute) ctx.set(key, n.value);
        else ctx.add(key, Math.abs(n.value) * (n.value < 0 ? -1 : (direction(topicless) || 1)));
        return;
      }
      const s = STEP[key] ?? 10;
      ctx.add(key, s * magnitude(seg) * ctx.dir(seg, dflt));
    },
  };

  for (const clause of splitClauses(text)) {
    const topics = findTopics(clause);
    if (!topics.length) continue;
    // 動詞在前（「提亮陰影」）→ 主題之間的文字歸給下一個主題；否則歸給前一個
    const verbFirst = direction(clause.slice(0, topics[0].start)) !== 0;
    topics.forEach((t, i) => {
      const prev = topics[i - 1];
      const next = topics[i + 1];
      let s;
      let e;
      if (verbFirst) {
        s = prev ? prev.end : 0;
        e = next ? t.end : clause.length;
      } else {
        s = prev ? t.start : 0;
        e = next ? next.start : clause.length;
      }
      const seg = clause.slice(s, e);
      // 方向判斷時移除主題本身的字（例如「高光」裡的「高」）
      const segNoTopic = clause.slice(s, t.start) + ' ' + clause.slice(t.end, e);
      const topicText = clause.slice(t.start, t.end);
      const useSeg = t.rule.noun && !['skin', 'sky', 'plants', 'hslColor', 'dehazeP', 'vignetteP'].includes(t.rule.id)
        ? segNoTopic + (/太|過/.test(topicText) ? '太' : '')
        : seg;
      t.rule.apply(useSeg, ctx, t.match);
      matchedTopics.push(t.rule.id);
    });
  }

  const changes = {};
  for (const k of touched) if (out[k] !== base[k]) changes[k] = out[k];
  return {
    action,
    changes,
    understood: matchedTopics.length > 0,
    reply: summarize(base, changes, action, notes),
  };
}

export function summarize(before, changes, action, notes = []) {
  if (action === 'reset') return '已還原成原圖。';
  if (action === 'undo') return '已回到上一步。';
  if (action === 'redo') return '已重做。';
  const parts = Object.entries(changes).map(([k, v]) => {
    const d = v - (before[k] ?? 0);
    const sign = d > 0 ? '+' : '';
    const val = PARAM_MAP[k].step < 1 ? d.toFixed(2) : Math.round(d);
    return `${describeParam(k)} ${sign}${val}`;
  });
  if (!parts.length) return notes.length ? notes.join('；') : '';
  return parts.join('、') + (notes.length ? `（${notes.join('；')}）` : '');
}

export { HSL_BANDS };
