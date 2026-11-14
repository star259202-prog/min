import { Engine } from './engine.js';
import { PARAMS, PARAM_MAP, GROUPS, HSL_BANDS, PRESETS, defaultParams, clampParam } from './params.js';
import { parseCommand, summarize } from './parser.js';

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const viewer = $('viewer');
const PREVIEW_MAX = 2048;

let engine;
try {
  engine = new Engine(canvas);
} catch (err) {
  alert(err.message);
  throw err;
}

const state = {
  params: defaultParams(),
  history: [{ label: '匯入', params: defaultParams() }],
  index: 0,
  loaded: false,
  fileName: 'photo',
  showOriginal: false,
  aiAvailable: false,
  commandHistory: [],
  busy: false,
};

// ---------- 繪製 ----------
let frame = 0;
function scheduleRender() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!state.loaded) return;
    engine.render(state.params, { original: state.showOriginal });
    scheduleHistogram();
  });
}

const histCanvas = $('histogram');
const sampleCanvas = document.createElement('canvas');
let histTimer = 0;
function scheduleHistogram() {
  clearTimeout(histTimer);
  histTimer = setTimeout(drawHistogram, 60);
}

function sampleImage(maxSide) {
  const s = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  sampleCanvas.width = Math.max(1, Math.round(canvas.width * s));
  sampleCanvas.height = Math.max(1, Math.round(canvas.height * s));
  const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, sampleCanvas.width, sampleCanvas.height);
  return ctx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
}

function drawHistogram() {
  if (!state.loaded) return;
  const data = sampleImage(256);
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) { r[data[i]]++; g[data[i + 1]]++; b[data[i + 2]]++; }
  let max = 1;
  for (let i = 2; i < 254; i++) max = Math.max(max, r[i], g[i], b[i]);
  const ctx = histCanvas.getContext('2d');
  const W = histCanvas.width, H = histCanvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  for (const [arr, color] of [[r, 'rgba(230,70,70,.75)'], [g, 'rgba(70,200,90,.75)'], [b, 'rgba(70,120,240,.75)']]) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * W, H - Math.min(1, arr[i] / max) * (H - 4));
    ctx.lineTo(W, H);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function imageStats() {
  const data = sampleImage(200);
  let n = 0, sl = 0, sr = 0, sg = 0, sb = 0, lo = 0, hi = 0, ss = 0;
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i] / 255, G = data[i + 1] / 255, B = data[i + 2] / 255;
    const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    sl += L; sr += R; sg += G; sb += B; ss += mx > 0 ? (mx - mn) / mx : 0;
    if (L < 0.02) lo++;
    if (mx > 0.98) hi++;
    n++;
  }
  const f = (x) => Math.round((x / n) * 1000) / 1000;
  return { meanLuminance: f(sl), meanR: f(sr), meanG: f(sg), meanB: f(sb), meanSaturation: f(ss), shadowClipRatio: f(lo), highlightClipRatio: f(hi) };
}

function thumbnail() {
  const s = Math.min(1, 640 / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * s);
  c.height = Math.round(canvas.height * s);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

// ---------- 滑桿面板 ----------
const sliderEls = {};
function makeSlider(p) {
  const row = document.createElement('div');
  row.className = 'slider';
  const id = `s_${p.key}`;
  row.innerHTML = `<label for="${id}" title="雙擊重設">${p.label}</label>
    <input id="${id}" type="range" min="${p.min}" max="${p.max}" step="${p.step}" />
    <output></output>`;
  const input = row.querySelector('input');
  const out = row.querySelector('output');
  input.addEventListener('input', () => {
    state.params[p.key] = clampParam(p.key, parseFloat(input.value));
    updateSlider(p.key);
    scheduleRender();
  });
  input.addEventListener('change', () => commit(`${p.label} ${formatVal(p.key, state.params[p.key])}`));
  const reset = () => {
    state.params[p.key] = defaultParams()[p.key];
    syncSliders();
    scheduleRender();
    commit(`重設${p.label}`);
  };
  row.querySelector('label').addEventListener('dblclick', reset);
  input.addEventListener('dblclick', reset);
  sliderEls[p.key] = { row, input, out };
  return row;
}

function formatVal(key, v) {
  const p = PARAM_MAP[key];
  if (p.step < 1) return (v > 0 ? '+' : '') + v.toFixed(2);
  if (key.endsWith('Hue') || key === 'shadowSat' || key === 'highlightSat' || key === 'sharpen' || key === 'grain') return String(Math.round(v));
  return (v > 0 ? '+' : '') + Math.round(v);
}

function updateSlider(key) {
  const el = sliderEls[key];
  if (!el) return;
  const v = state.params[key];
  el.input.value = v;
  el.out.textContent = formatVal(key, v);
  el.row.classList.toggle('changed', v !== defaultParams()[key]);
}

function syncSliders() {
  for (const p of PARAMS) updateSlider(p.key);
}

function buildPanels() {
  const root = $('sliders');
  for (const g of GROUPS) {
    const det = document.createElement('details');
    det.className = 'group';
    det.open = ['wb', 'tone', 'presence'].includes(g.key);
    det.innerHTML = `<summary>${g.label}</summary>`;
    if (g.key === 'hsl') {
      for (const b of HSL_BANDS) {
        const wrap = document.createElement('div');
        wrap.className = 'hsl-band';
        wrap.innerHTML = `<h3><span class="swatch" style="background:hsl(${b.hue} 80% 55%)"></span>${b.label}</h3>`;
        for (const p of PARAMS.filter((x) => x.band === b.key)) wrap.appendChild(makeSlider(p));
        det.appendChild(wrap);
      }
    } else {
      for (const p of PARAMS.filter((x) => x.group === g.key)) det.appendChild(makeSlider(p));
    }
    root.appendChild(det);
  }
  const presets = $('presets');
  for (const name of Object.keys(PRESETS)) {
    const btn = document.createElement('button');
    btn.textContent = name;
    btn.disabled = true;
    btn.addEventListener('click', () => runCommand(name, { localOnly: true }));
    presets.appendChild(btn);
  }
  syncSliders();
}

// ---------- 歷史記錄 ----------
function commit(label) {
  const last = state.history[state.index].params;
  if (PARAMS.every((p) => last[p.key] === state.params[p.key])) return;
  state.history = state.history.slice(0, state.index + 1);
  state.history.push({ label, params: { ...state.params } });
  state.index = state.history.length - 1;
  renderHistory();
}

function goTo(i) {
  if (i < 0 || i >= state.history.length) return false;
  state.index = i;
  state.params = { ...state.history[i].params };
  syncSliders();
  scheduleRender();
  renderHistory();
  return true;
}

function renderHistory() {
  const list = $('historyList');
  list.innerHTML = '';
  state.history.forEach((h, i) => {
    const li = document.createElement('li');
    li.textContent = h.label;
    li.title = h.label;
    if (i === state.index) li.className = 'current';
    else if (i > state.index) li.className = 'future';
    li.addEventListener('click', () => goTo(i));
    list.appendChild(li);
  });
  list.lastChild?.scrollIntoView({ block: 'nearest' });
  $('undoBtn').disabled = !state.loaded || state.index === 0;
  $('redoBtn').disabled = !state.loaded || state.index >= state.history.length - 1;
}

// ---------- 套用變更（有動畫，讓使用者看得到滑桿移動） ----------
function animateTo(changes) {
  const from = { ...state.params };
  const keys = Object.keys(changes);
  for (const k of keys) {
    sliderEls[k]?.row.classList.add('flash');
    const det = sliderEls[k]?.row.closest('details');
    if (det) det.open = true;
  }
  return new Promise((resolve) => {
    const t0 = performance.now();
    const dur = 350;
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      for (const k of keys) {
        const a = from[k], b = changes[k];
        let v = a + (b - a) * e;
        if (k.endsWith('Hue') && Math.abs(b - a) > 180) v = b; // 色相不做繞圈動畫
        state.params[k] = t === 1 ? b : v;
        updateSlider(k);
      }
      engine.render(state.params);
      if (t < 1) requestAnimationFrame(tick);
      else {
        setTimeout(() => keys.forEach((k) => sliderEls[k]?.row.classList.remove('flash')), 600);
        scheduleRender();
        resolve();
      }
    };
    requestAnimationFrame(tick);
  });
}

// ---------- 指令 ----------
function logMsg(text, who, extra = '') {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.textContent = text;
  if (extra) {
    const s = document.createElement('span');
    s.className = 'src';
    s.textContent = extra;
    div.appendChild(s);
  }
  $('log').appendChild(div);
  $('log').scrollTop = $('log').scrollHeight;
  return div;
}

async function interpretWithClaude(text) {
  const res = await fetch('/api/interpret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      params: state.params,
      stats: imageStats(),
      thumbnail: thumbnail(),
      history: state.commandHistory.slice(-6),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function runCommand(text, { localOnly = false } = {}) {
  text = text.trim();
  if (!text) return;
  if (!state.loaded) {
    logMsg('請先開啟一張照片。', 'bot err');
    return;
  }
  if (state.busy) return;
  state.busy = true;
  logMsg(text, 'user');
  const before = { ...state.params };
  let result;
  let source = '離線解析';
  if (state.aiAvailable && !localOnly) {
    const pending = logMsg('理解中…', 'bot');
    try {
      result = await interpretWithClaude(text);
      source = 'Claude';
      pending.remove();
    } catch (err) {
      pending.remove();
      logMsg(`AI 理解失敗（${err.message}），改用離線解析。`, 'bot err');
    }
  }
  if (!result) {
    result = parseCommand(text, state.params);
    if (!result.understood && !result.action) {
      logMsg('我沒聽懂要調整哪裡，可以試試：「亮一點」「對比強一點」「天空藍一點」「膚色自然一點」「暖色調」「加一點暗角」。', 'bot err');
      state.busy = false;
      return;
    }
  }

  state.commandHistory.push(text);
  if (result.action === 'undo') goTo(state.index - 1);
  else if (result.action === 'redo') goTo(state.index + 1);
  else if (result.action === 'reset') {
    await animateTo(defaultParams());
    commit('還原原圖');
  }
  const changes = result.changes || {};
  if (Object.keys(changes).length) {
    await animateTo(changes);
    commit(text);
  }
  const reply = result.reply || summarize(before, changes, result.action) || '沒有需要調整的地方。';
  const detail = source === 'Claude' && Object.keys(changes).length ? `\n→ ${summarize(before, changes, null)}` : '';
  logMsg(reply + detail, 'bot', source);
  state.busy = false;
}

$('cmdForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('cmdInput').value;
  $('cmdInput').value = '';
  runCommand(v);
});

// ---------- 語音 ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = $('micBtn');
let recognition = null;
let listening = false;
if (!SR) {
  micBtn.disabled = true;
  micBtn.title = '此瀏覽器不支援語音辨識（建議使用 Chrome、Edge 或 Safari），請改用文字輸入';
} else {
  recognition = new SR();
  recognition.lang = 'zh-TW';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = (e) => {
    let interim = '';
    let final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t;
      else interim += t;
    }
    $('interim').textContent = interim ? `🎙 ${interim}` : '';
    if (final) {
      $('interim').textContent = '';
      runCommand(final);
    }
  };
  recognition.onerror = (e) => {
    if (e.error === 'not-allowed') logMsg('麥克風權限被拒絕，請在瀏覽器設定中允許使用麥克風。', 'bot err');
    else if (e.error !== 'no-speech' && e.error !== 'aborted') logMsg(`語音辨識錯誤：${e.error}`, 'bot err');
  };
  recognition.onend = () => {
    listening = false;
    micBtn.classList.remove('listening');
    $('interim').textContent = '';
  };
  micBtn.addEventListener('click', () => {
    if (listening) { recognition.stop(); return; }
    try {
      recognition.start();
      listening = true;
      micBtn.classList.add('listening');
      $('interim').textContent = '🎙 請說…';
    } catch { /* 已在聆聽中 */ }
  });
}

// ---------- 載入 / 輸出 ----------
function enableUi() {
  for (const id of ['resetBtn', 'exportBtn']) $(id).disabled = false;
  document.querySelectorAll('#presets button').forEach((b) => (b.disabled = false));
  $('beforeBtn').hidden = false;
  document.body.classList.add('has-image');
}

async function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    logMsg('請選擇圖片檔（JPEG、PNG、WebP、HEIC 需瀏覽器支援）。', 'bot err');
    return;
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    logMsg('無法讀取這張圖片（RAW 檔請先轉成 JPEG/TIFF）。', 'bot err');
    return;
  }
  engine.loadImage(bitmap);
  const s = Math.min(1, PREVIEW_MAX / Math.max(engine.width, engine.height));
  canvas.width = Math.round(engine.width * s);
  canvas.height = Math.round(engine.height * s);
  state.fileName = file.name.replace(/\.[^.]+$/, '') || 'photo';
  state.loaded = true;
  state.params = defaultParams();
  state.history = [{ label: `匯入 ${file.name}`, params: defaultParams() }];
  state.index = 0;
  state.commandHistory = [];
  syncSliders();
  renderHistory();
  enableUi();
  scheduleRender();
  logMsg(`已開啟 ${file.name}（${engine.width}×${engine.height}）。直接說出想調整的地方吧！`, 'bot');
}

$('fileInput').addEventListener('change', (e) => loadFile(e.target.files[0]));
['dragenter', 'dragover'].forEach((t) => viewer.addEventListener(t, (e) => { e.preventDefault(); viewer.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((t) => viewer.addEventListener(t, (e) => { e.preventDefault(); viewer.classList.remove('dragging'); }));
viewer.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

$('exportBtn').addEventListener('click', async () => {
  const btn = $('exportBtn');
  btn.disabled = true;
  btn.textContent = '輸出中…';
  try {
    const blob = await engine.exportBlob(state.params, 'image/jpeg', 0.95);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.fileName}_edited.jpg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = '輸出 JPEG';
  }
});

$('undoBtn').addEventListener('click', () => goTo(state.index - 1));
$('redoBtn').addEventListener('click', () => goTo(state.index + 1));
$('resetBtn').addEventListener('click', () => {
  state.params = defaultParams();
  syncSliders();
  scheduleRender();
  commit('還原原圖');
});

// 前後對比
function setOriginal(on) {
  state.showOriginal = on;
  $('beforeLabel').hidden = !on;
  scheduleRender();
}
const beforeBtn = $('beforeBtn');
beforeBtn.addEventListener('pointerdown', () => setOriginal(true));
['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => beforeBtn.addEventListener(t, () => setOriginal(false)));

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;
  if (e.key === '\\' && !e.repeat) setOriginal(true);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    goTo(e.shiftKey ? state.index + 1 : state.index - 1);
  }
});
document.addEventListener('keyup', (e) => { if (e.key === '\\') setOriginal(false); });

// ---------- 啟動 ----------
buildPanels();
renderHistory();
fetch('/api/status')
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null)
  .then((s) => {
    const el = $('aiStatus');
    state.aiAvailable = Boolean(s?.ai);
    el.textContent = state.aiAvailable ? '● Claude 語意理解' : '● 離線解析模式';
    el.classList.toggle('ai', state.aiAvailable);
    el.title = state.aiAvailable ? `使用 ${s.model} 理解口語描述` : '未設定 ANTHROPIC_API_KEY：使用內建關鍵字解析（常見說法都能用）';
  });
