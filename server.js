// 本機伺服器：提供網頁，並（若設定了 ANTHROPIC_API_KEY）用 Claude 把口語描述轉成修圖參數。
// API 金鑰只存在伺服器端，不會送到瀏覽器。
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { PARAMS, PARAM_MAP, PRESETS, clampParam } from './public/js/params.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const AI_ENABLED = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = AI_ENABLED ? new Anthropic() : null;

const paramDoc = PARAMS.map((p) => `- ${p.key}（${p.label}）：${p.min} ~ ${p.max}`).join('\n');

const SYSTEM = `你是一位專業的人像與風景修圖師，正在操作一套類似 Lightroom Classic 的修圖軟體。
使用者會用口語（多半是台灣繁體中文，可能來自語音辨識、沒有標點或有錯字）描述想要的效果，你要把它轉成具體的參數值。

## 可用參數（只能使用這些，全部都是整體色彩／色調調整）
${paramDoc}

說明：
- exposure 單位是 EV（光圈格數）；其餘多為 -100 ~ 100，0 是原圖。
- vignette 負值是四周變暗（一般說的「加暗角」），正值是四周變亮。
- shadowHue / highlightHue 是色彩分級的色相角度（0 紅、30 橙、60 黃、120 綠、180 青、220 藍、280 紫），需搭配 shadowSat / highlightSat 才有效果。
- hue_/sat_/lum_ 加上 red, orange, yellow, green, aqua, blue, purple, magenta 是 HSL 分色調整。膚色主要落在 orange（和部分 red）。
- 內建風格預設可參考：${JSON.stringify(PRESETS)}

## 原則
1. 你只輸出「調整後的絕對數值」，只列出需要變動的參數；沒提到的維持現值。
2. 調整要符合專業修圖師的直覺，以使用者目前的數值為基準。「一點／稍微」小幅度，「很多／非常」大幅度。「再多一點」「再一點」代表延續上一個指令的方向。
3. 人像要自然、真實：絕不追求網紅濾鏡、AI 感或塑膠皮膚。texture 不要低於 -30、clarity 用於人像時不要低於 -20；膚色（orange）的飽和度與色相調整要保守（通常 ±15 以內），避免臉色發灰、發橘或蠟黃。
4. 這套軟體沒有、也不允許任何液化、瘦臉、大眼、變形、換臉或 AI 生成功能。如果使用者要求這類效果，請在 reply 中客氣說明做不到，並視情況提供可行的替代（例如用光影讓臉部更立體）。
5. 使用者說「復原／上一步」用 action=undo，「重做」用 redo，「重置／還原原圖」用 reset；這時 adjustments 給空陣列。
6. 如果有附上照片預覽與統計數據，請依照片實際狀況判斷（例如是否已經過曝、偏色、是否有人物）。
7. reply 用繁體中文，一兩句話簡短說明你做了什麼與原因。`;

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'action', 'adjustments'],
  properties: {
    reply: { type: 'string' },
    action: { type: 'string', enum: ['none', 'undo', 'redo', 'reset'] },
    adjustments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['param', 'value'],
        properties: {
          param: { type: 'string', enum: PARAMS.map((p) => p.key) },
          value: { type: 'number' },
        },
      },
    },
  },
};

async function interpret({ text, params, stats, thumbnail, history }) {
  const current = Object.entries(params || {})
    .filter(([k]) => PARAM_MAP[k])
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const lines = [
    `目前參數：${current}`,
    stats ? `照片統計（0~1）：${JSON.stringify(stats)}` : '',
    Array.isArray(history) && history.length ? `最近的指令（舊→新）：\n${history.slice(-6).map((h) => `- ${h}`).join('\n')}` : '',
    `使用者這次說：「${String(text).slice(0, 1000)}」`,
  ].filter(Boolean);

  const content = [];
  if (typeof thumbnail === 'string' && thumbnail.startsWith('data:image/jpeg;base64,')) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: thumbnail.slice(23) } });
  }
  content.push({ type: 'text', text: lines.join('\n\n') });

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    messages: [{ role: 'user', content }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude 拒絕了這個請求');
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude 沒有回傳內容');
  const data = JSON.parse(textBlock.text);
  const changes = {};
  for (const { param, value } of data.adjustments || []) {
    const v = clampParam(param, value);
    if (v !== undefined) changes[param] = v;
  }
  return { reply: data.reply, action: data.action === 'none' ? null : data.action, changes };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('請求太大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/status') return sendJson(res, 200, { ai: AI_ENABLED, model: AI_ENABLED ? MODEL : null });
    if (url.pathname === '/api/interpret' && req.method === 'POST') {
      if (!AI_ENABLED) return sendJson(res, 503, { error: '未設定 ANTHROPIC_API_KEY，使用離線解析' });
      const body = await readBody(req);
      try {
        return sendJson(res, 200, await interpret(body));
      } catch (err) {
        if (err instanceof Anthropic.RateLimitError) return sendJson(res, 429, { error: '請求太頻繁，請稍後再試' });
        if (err instanceof Anthropic.AuthenticationError) return sendJson(res, 401, { error: 'API 金鑰無效' });
        if (err instanceof Anthropic.APIStatusError) return sendJson(res, 502, { error: `Claude API 錯誤（${err.status}）` });
        if (err instanceof Anthropic.APIConnectionError) return sendJson(res, 502, { error: '無法連線到 Claude API' });
        throw err;
      }
    }
    // 靜態檔案
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'not found' });
    console.error(err);
    sendJson(res, 500, { error: err.message || '伺服器錯誤' });
  }
});

server.listen(PORT, () => {
  console.log(`修圖工具已啟動：http://localhost:${PORT}`);
  console.log(AI_ENABLED ? `Claude 語意理解：已啟用（${MODEL}）` : 'Claude 語意理解：未啟用（未設定 ANTHROPIC_API_KEY），使用內建離線解析');
});
