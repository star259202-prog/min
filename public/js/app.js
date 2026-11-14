import { Engine } from './engine.js';
import { PARAMS, PARAM_MAP, GROUPS, HSL_BANDS, PRESETS, defaultParams, clampParam } from './params.js';
import { parseCommand, parseMaskIntent, summarize } from './parser.js';
import {
  LOCAL_PARAMS, LOCAL_MAP, MASK_KINDS, clampLocal, defaultLocalAdj, createMask, maskHasEffect, brushCanvas, brushAppend,
  dropBrushCache, syncNextId,
} from './masks.js';
import { isRawFile, decodeRaw, describeRaw } from './raw.js';

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const overlay = $('overlay');
const viewer = $('viewer');
const stage = $('stage');
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
  masks: [],
  activeMaskId: null,
  overlay: false,
  tool: null,            // 'paint' | 'erase' | 'eyedropper' | null
  brush: { size: 0.06, feather: 60, flow: 60 },
  history: [],
  index: 0,
  loaded: false,
  fileName: 'photo',
  aspect: 1.5,
  srcSample: null,       // 原圖小樣本（滴管取色用）
  showOriginal: false,
  aiAvailable: false,
  commandHistory: [],
  busy: false,
};

const activeMask = () => state.masks.find((m) => m.id === state.activeMaskId) || null;
const snapshot = () => ({ params: { ...state.params }, masks: structuredClone(state.masks) });
const sameSnap = (a, b) => JSON.stringify(a.params) === JSON.stringify(b.params) && JSON.stringify(a.masks) === JSON.stringify(b.masks);

// ---------- 繪製 ----------
function renderMasks() {
  const list = state.masks.filter((m) => m.visible && (maskHasEffect(m) || (state.overlay && m.id === state.activeMaskId)));
  for (const m of list) {
    if (m.shape.type === 'brush') {
      const e = brushCanvas(m, state.aspect);
      engine.setMaskCanvas(m.id, e.key, e.canvas);
    }
  }
  return list;
}

function renderNow() {
  if (!state.loaded) return;
  engine.render(state.params, {
    masks: renderMasks(),
    original: state.showOriginal,
    overlayId: state.overlay ? state.activeMaskId : null,
  });
}

let frame = 0;
function scheduleRender() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    renderNow();
    drawOverlay();
    scheduleHistogram();
  });
}

// 讓畫布依照片比例填滿檢視區
function layoutStage() {
  if (!state.loaded) return;
  const r = viewer.getBoundingClientRect();
  const pad = window.innerWidth < 1000 ? 16 : 32;
  const W = Math.max(50, r.width - pad);
  const H = Math.max(50, r.height - pad);
  let w = W;
  let h = W / state.aspect;
  if (h > H) { h = H; w = H * state.aspect; }
  stage.style.width = `${Math.round(w)}px`;
  stage.style.height = `${Math.round(h)}px`;
  const dpr = window.devicePixelRatio || 1;
  overlay.width = Math.round(w * dpr);
  overlay.height = Math.round(h * dpr);
  drawOverlay();
}
new ResizeObserver(layoutStage).observe(viewer);

const histCanvas = $('histogram');
const sampleCanvas = document.createElement('canvas');
let histTimer = 0;
function scheduleHistogram() {
  clearTimeout(histTimer);
  histTimer = setTimeout(drawHistogram, 80);
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

// ---------- 滑桿 ----------
const sliderEls = {};

function formatVal(spec, v) {
  if (spec.step < 1) return (v > 0 ? '+' : '') + v.toFixed(2);
  if (spec.min >= 0) return String(Math.round(v));
  return (v > 0 ? '+' : '') + Math.round(v);
}

// 通用滑桿：get/set 決定綁定到整體參數或遮罩參數
function makeSlider(spec, { get, set, def = 0, label = spec.label, onCommit, className = '' }) {
  const row = document.createElement('div');
  row.className = `slider ${className}`;
  const id = `s_${Math.random().toString(36).slice(2)}`;
  row.innerHTML = `<label for="${id}" title="雙擊重設">${label}</label>
    <input id="${id}" type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" />
    <output></output>`;
  const input = row.querySelector('input');
  const out = row.querySelector('output');
  const update = () => {
    const v = get();
    input.value = v;
    out.textContent = formatVal(spec, v);
    row.classList.toggle('changed', v !== def);
  };
  input.addEventListener('input', () => {
    set(parseFloat(input.value));
    update();
    scheduleRender();
  });
  input.addEventListener('change', () => onCommit?.(`${label} ${formatVal(spec, get())}`));
  const reset = () => {
    set(def);
    update();
    scheduleRender();
    onCommit?.(`重設${label}`);
  };
  row.querySelector('label').addEventListener('dblclick', reset);
  input.addEventListener('dblclick', reset);
  update();
  return { row, update };
}

function buildGlobalPanels() {
  const root = $('sliders');
  const defs = defaultParams();
  const add = (parent, p) => {
    const s = makeSlider(p, {
      get: () => state.params[p.key],
      set: (v) => { state.params[p.key] = clampParam(p.key, v); },
      def: defs[p.key],
      onCommit: commit,
    });
    sliderEls[p.key] = s;
    parent.appendChild(s.row);
  };
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
        for (const p of PARAMS.filter((x) => x.band === b.key)) add(wrap, p);
        det.appendChild(wrap);
      }
    } else {
      for (const p of PARAMS.filter((x) => x.group === g.key)) add(det, p);
    }
    root.appendChild(det);
  }
  const presets = $('presets');
  for (const name of Object.keys(PRESETS)) {
    const btn = document.createElement('button');
    btn.textContent = name;
    btn.disabled = true;
    btn.addEventListener('click', () => runCommand(name, { localOnly: true, forceGlobal: true }));
    presets.appendChild(btn);
  }
}

function syncSliders() {
  for (const s of Object.values(sliderEls)) s.update();
  maskSliders.forEach((s) => s.update());
}

// ---------- 遮罩面板 ----------
let maskSliders = [];

function selectMask(id) {
  state.activeMaskId = id;
  const m = activeMask();
  if (!m) state.tool = null;
  else if (m.shape.type === 'brush') state.tool = state.tool === 'erase' ? 'erase' : 'paint';
  else state.tool = null;
  renderMaskUi();
  scheduleRender();
}

function addMask(kind, { select = true } = {}) {
  const m = createMask(kind, state.aspect);
  state.masks.push(m);
  if (select) selectMask(m.id);
  if (kind === 'brush') logMsg('在照片上拖曳來塗抹遮罩範圍（按住 Alt 或切換「擦除」可擦掉），塗好後再說出要怎麼調整。', 'bot');
  else if (kind === 'linear') logMsg('在照片上拖曳畫出漸層：起點是完全套用，終點是完全不套用。', 'bot');
  else if (kind === 'radial') logMsg('在照片上從中心往外拖曳畫出範圍（按住 Shift 可畫橢圓），拖曳中心點可移動。', 'bot');
  else if (kind === 'color') logMsg('按「滴管」再點照片上的顏色，就會選取相近顏色的區域。', 'bot');
  else if (['sky', 'skin', 'subject', 'edges'].includes(kind)) logMsg(`已建立「${MASK_KINDS[kind]}」遮罩（依位置／顏色／亮度選取，不使用 AI）。可勾選「顯示疊加」檢查範圍。`, 'bot');
  return m;
}

function deleteMask(id) {
  state.masks = state.masks.filter((m) => m.id !== id);
  engine.dropMask(id);
  dropBrushCache(id);
  if (state.activeMaskId === id) state.activeMaskId = null;
  renderMaskUi();
  scheduleRender();
  commit('刪除遮罩');
}

function renderMaskUi() {
  const list = $('maskList');
  list.innerHTML = '';
  for (const m of state.masks) {
    const li = document.createElement('li');
    if (m.id === state.activeMaskId) li.classList.add('sel');
    if (!m.visible) li.classList.add('hidden-mask');
    li.innerHTML = `<span class="name"></span>
      <button class="icon" data-act="eye" title="顯示／隱藏">${m.visible ? '◉' : '○'}</button>
      <button class="icon" data-act="del" title="刪除">✕</button>`;
    li.querySelector('.name').textContent = m.name;
    li.addEventListener('click', (e) => {
      const act = e.target.dataset?.act;
      if (act === 'del') { e.stopPropagation(); deleteMask(m.id); return; }
      if (act === 'eye') {
        e.stopPropagation();
        m.visible = !m.visible;
        renderMaskUi();
        scheduleRender();
        commit(m.visible ? '顯示遮罩' : '隱藏遮罩');
        return;
      }
      selectMask(m.id === state.activeMaskId ? null : m.id);
    });
    list.appendChild(li);
  }
  renderMaskEditor();
  document.body.classList.toggle('editing-mask', Boolean(activeMask()));
  overlay.classList.toggle('active', Boolean(activeMask()));
  overlay.classList.toggle('tool-paint', state.tool === 'paint');
  overlay.classList.toggle('tool-erase', state.tool === 'erase');
  $('overlayChk').checked = state.overlay;
}

function renderMaskEditor() {
  const ed = $('maskEditor');
  maskSliders = [];
  const m = activeMask();
  ed.hidden = !m;
  ed.innerHTML = '';
  if (!m) return;
  const el = (html) => {
    const d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstChild;
  };
  const addSlider = (parent, spec, get, set, def, className) => {
    const s = makeSlider(spec, { get, set, def, onCommit: commit, className });
    maskSliders.push(s);
    parent.appendChild(s.row);
  };

  ed.appendChild(el(`<h4>${m.name}</h4>`));

  // 形狀設定
  const s = m.shape;
  if (s.type === 'brush') {
    const row = el('<div class="row"></div>');
    const mk = (tool, text) => {
      const b = el(`<button class="mini">${text}</button>`);
      if (state.tool === tool) b.classList.add('on');
      b.addEventListener('click', () => { state.tool = tool; renderMaskUi(); });
      row.appendChild(b);
    };
    mk('paint', '🖌 塗抹');
    mk('erase', '⌫ 擦除');
    const clr = el('<button class="mini">清除筆畫</button>');
    clr.addEventListener('click', () => { s.strokes = []; scheduleRender(); commit('清除筆刷'); });
    row.appendChild(clr);
    ed.appendChild(row);
    const B = state.brush;
    addSlider(ed, { label: '筆刷大小', min: 1, max: 40, step: 0.5 }, () => Math.round(B.size * 1000) / 10, (v) => { B.size = v / 100; }, 6);
    addSlider(ed, { label: '羽化', min: 0, max: 100, step: 1 }, () => B.feather, (v) => { B.feather = v; }, 60);
    addSlider(ed, { label: '流量', min: 5, max: 100, step: 1 }, () => B.flow, (v) => { B.flow = v; }, 60);
    ed.appendChild(el('<div class="hint">快捷鍵：[ ] 調整筆刷大小，按住 Alt 暫時擦除</div>'));
  } else if (s.type === 'linear') {
    ed.appendChild(el('<div class="hint">在照片上拖曳重新畫漸層，或拖曳端點調整。</div>'));
  } else if (s.type === 'radial') {
    ed.appendChild(el('<div class="hint">從中心往外拖曳重新畫範圍（Shift＝橢圓），拖曳中心移動、拖曳邊緣縮放。</div>'));
    addSlider(ed, { label: '羽化', min: 0, max: 100, step: 1 }, () => s.feather, (v) => { s.feather = v; }, 50);
  }

  const opts = el('<div class="row"></div>');
  const inv = el(`<label class="chk"><input type="checkbox" ${m.invert ? 'checked' : ''}/> 反轉</label>`);
  inv.querySelector('input').addEventListener('change', (e) => { m.invert = e.target.checked; scheduleRender(); commit('反轉遮罩'); });
  opts.appendChild(inv);
  ed.appendChild(opts);
  addSlider(ed, { label: '遮罩強度', min: 0, max: 100, step: 1 }, () => m.amount, (v) => { m.amount = v; }, 100);

  // 顏色範圍
  const colorHead = el(`<div class="row"><label class="chk"><input type="checkbox" ${m.color.on ? 'checked' : ''}/> 限定顏色範圍</label></div>`);
  colorHead.querySelector('input').addEventListener('change', (e) => { m.color.on = e.target.checked; renderMaskEditor(); scheduleRender(); commit('顏色範圍'); });
  const dropper = el(`<button class="mini ${state.tool === 'eyedropper' ? 'on' : ''}">💧 滴管</button>`);
  dropper.addEventListener('click', () => {
    state.tool = state.tool === 'eyedropper' ? (m.shape.type === 'brush' ? 'paint' : null) : 'eyedropper';
    renderMaskUi();
  });
  colorHead.appendChild(dropper);
  ed.appendChild(colorHead);
  if (m.color.on) {
    addSlider(ed, { label: '色相', min: 0, max: 360, step: 1 }, () => m.color.hue, (v) => { m.color.hue = v; }, m.color.hue, 'hue-track');
    addSlider(ed, { label: '範圍', min: 10, max: 180, step: 1 }, () => m.color.width, (v) => { m.color.width = v; }, 40);
  }

  // 明度範圍
  const lumHead = el(`<div class="row"><label class="chk"><input type="checkbox" ${m.lum.on ? 'checked' : ''}/> 限定明度範圍</label></div>`);
  lumHead.querySelector('input').addEventListener('change', (e) => { m.lum.on = e.target.checked; renderMaskEditor(); scheduleRender(); commit('明度範圍'); });
  ed.appendChild(lumHead);
  if (m.lum.on) {
    addSlider(ed, { label: '最暗', min: 0, max: 100, step: 1 }, () => m.lum.min, (v) => { m.lum.min = Math.min(v, m.lum.max); }, 0);
    addSlider(ed, { label: '最亮', min: 0, max: 100, step: 1 }, () => m.lum.max, (v) => { m.lum.max = Math.max(v, m.lum.min); }, 100);
    addSlider(ed, { label: '過渡', min: 0, max: 50, step: 1 }, () => m.lum.feather, (v) => { m.lum.feather = v; }, 15);
  }

  ed.appendChild(el('<h4>局部調整</h4>'));
  for (const p of LOCAL_PARAMS) {
    addSlider(ed, p, () => m.adj[p.key], (v) => { autoHideOverlay(); m.adj[p.key] = clampLocal(p.key, v); }, 0);
  }
  const done = el('<button class="btn done">完成（回到整體調整）</button>');
  done.addEventListener('click', () => selectMask(null));
  ed.appendChild(done);
}

document.querySelectorAll('.mask-add button').forEach((b) => b.addEventListener('click', () => {
  addMask(b.dataset.kind);
  state.overlay = true; // 新建遮罩時先顯示紅色疊加，方便確認範圍；開始調整後自動關閉
  state.overlayAuto = true;
  renderMaskUi();
  scheduleRender();
  commit(`新增${MASK_KINDS[b.dataset.kind]}遮罩`);
}));
$('overlayChk').addEventListener('change', (e) => { state.overlay = e.target.checked; state.overlayAuto = false; scheduleRender(); });

function autoHideOverlay() {
  if (!state.overlayAuto) return;
  state.overlayAuto = false;
  state.overlay = false;
  $('overlayChk').checked = false;
}

// ---------- 照片上的遮罩操作 ----------
function overlayPoint(e) {
  const r = overlay.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, w: r.width, h: r.height };
}
let hover = null;
let drag = null;

function drawOverlay() {
  const m = activeMask();
  overlay.style.visibility = m && !state.showOriginal ? 'visible' : 'hidden';
  // 重設尺寸會完整清空畫布（比 clearRect 可靠，也一併重設陰影等狀態）
  overlay.width = overlay.width; // eslint-disable-line no-self-assign
  if (!m || state.showOriginal) return;
  const ctx = overlay.getContext('2d');
  const W = overlay.width, H = overlay.height;
  const dpr = window.devicePixelRatio || 1;
  ctx.lineWidth = 1.5 * dpr;
  const handle = (x, y, filled) => {
    ctx.beginPath();
    ctx.arc(x, y, 6 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = filled ? '#5aa2ff' : '#fff';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.stroke();
  };
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.shadowColor = 'rgba(0,0,0,.8)';
  ctx.shadowBlur = 3;
  const s = m.shape;
  if (s.type === 'linear') {
    const ax = s.ax * W, ay = s.ay * H, bx = s.bx * W, by = s.by * H;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const px = (-dy / len) * Math.max(W, H) * 2, py = (dx / len) * Math.max(W, H) * 2;
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    for (const [x, y] of [[ax, ay], [bx, by]]) {
      ctx.beginPath(); ctx.moveTo(x - px, y - py); ctx.lineTo(x + px, y + py); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    handle(ax, ay, true);
    handle(bx, by, false);
  } else if (s.type === 'radial') {
    const cx = s.cx * W, cy = s.cy * H;
    ctx.beginPath();
    ctx.ellipse(cx, cy, s.rx * W, s.ry * H, 0, 0, Math.PI * 2);
    ctx.stroke();
    const f = 1 - s.feather / 100;
    if (f > 0.02) {
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.ellipse(cx, cy, s.rx * W * f, s.ry * H * f, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    handle(cx, cy, true);
    handle(cx + s.rx * W, cy, false);
  }
  if ((state.tool === 'paint' || state.tool === 'erase') && hover) {
    const r = (state.brush.size * Math.max(W, H)) / 2;
    ctx.beginPath(); ctx.arc(hover.x * W, hover.y * H, r, 0, Math.PI * 2); ctx.stroke();
    const inner = r * (1 - state.brush.feather / 100);
    if (inner > 2) {
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath(); ctx.arc(hover.x * W, hover.y * H, inner, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (hover.erase) { ctx.fillStyle = '#fff'; ctx.fillText('−', hover.x * W - 3, hover.y * H + 4); }
  }
}

function sampleSourceHue(p) {
  const s = state.srcSample;
  if (!s) return null;
  const x = Math.min(s.width - 1, Math.max(0, Math.round(p.x * (s.width - 1))));
  const y = Math.min(s.height - 1, Math.max(0, Math.round(p.y * (s.height - 1))));
  let R = 0, G = 0, B = 0, n = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const xx = Math.min(s.width - 1, Math.max(0, x + dx));
    const yy = Math.min(s.height - 1, Math.max(0, y + dy));
    const i = (yy * s.width + xx) * 4;
    R += s.data[i]; G += s.data[i + 1]; B += s.data[i + 2]; n++;
  }
  R /= n * 255; G /= n * 255; B /= n * 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
  if (d < 0.03) return { hue: null };
  let h;
  if (mx === R) h = ((G - B) / d) % 6;
  else if (mx === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return { hue: Math.round(((h * 60) + 360) % 360) };
}

overlay.addEventListener('pointerdown', (e) => {
  const m = activeMask();
  if (!m) return;
  e.preventDefault();
  overlay.setPointerCapture(e.pointerId);
  const p = overlayPoint(e);
  const s = m.shape;

  if (state.tool === 'eyedropper') {
    const r = sampleSourceHue(p);
    if (r?.hue == null) logMsg('這個位置接近無彩色（灰／白／黑），請改用「明度範圍」選取。', 'bot err');
    else {
      m.color.on = true;
      m.color.hue = r.hue;
      state.tool = s.type === 'brush' ? 'paint' : null;
      renderMaskUi();
      scheduleRender();
      commit('滴管選取顏色');
    }
    return;
  }
  if (s.type === 'brush' && (state.tool === 'paint' || state.tool === 'erase')) {
    const stroke = { erase: state.tool === 'erase' || e.altKey, size: state.brush.size, feather: state.brush.feather, flow: state.brush.flow, pts: [[p.x, p.y]] };
    s.strokes.push(stroke);
    const entry = brushAppend(m, state.aspect, 0);
    engine.setMaskCanvas(m.id, entry.key, entry.canvas);
    drag = { kind: 'brush', drawn: 1 };
    scheduleRender();
    return;
  }
  const near = (x, y) => Math.hypot((x - p.x) * p.w, (y - p.y) * p.h) < 14;
  if (s.type === 'linear') {
    if (near(s.ax, s.ay)) drag = { kind: 'linA' };
    else if (near(s.bx, s.by)) drag = { kind: 'linB' };
    else { s.ax = s.bx = p.x; s.ay = s.by = p.y; drag = { kind: 'linB', fresh: true }; }
  } else if (s.type === 'radial') {
    const d = Math.hypot((p.x - s.cx) / s.rx, (p.y - s.cy) / s.ry);
    if (near(s.cx, s.cy)) drag = { kind: 'move', ox: p.x - s.cx, oy: p.y - s.cy };
    else if (Math.abs(d - 1) < 0.15 || near(s.cx + s.rx, s.cy)) drag = { kind: 'scale', rx: s.rx, ry: s.ry, d0: Math.max(d, 0.05) };
    else { s.cx = p.x; s.cy = p.y; s.rx = 0.01; s.ry = 0.01 * state.aspect; drag = { kind: 'new' }; }
  }
  scheduleRender();
});

overlay.addEventListener('pointermove', (e) => {
  const m = activeMask();
  if (!m) return;
  const p = overlayPoint(e);
  hover = { x: p.x, y: p.y, erase: e.altKey || state.tool === 'erase' };
  if (!drag) { if (state.tool === 'paint' || state.tool === 'erase') drawOverlay(); return; }
  const s = m.shape;
  switch (drag.kind) {
    case 'brush': {
      const st = s.strokes[s.strokes.length - 1];
      const last = st.pts[st.pts.length - 1];
      if (Math.hypot((p.x - last[0]) * p.w, (p.y - last[1]) * p.h) < 2) return;
      st.pts.push([p.x, p.y]);
      const entry = brushAppend(m, state.aspect, drag.drawn);
      drag.drawn = st.pts.length;
      engine.setMaskCanvas(m.id, entry.key, entry.canvas);
      break;
    }
    case 'linA': s.ax = p.x; s.ay = p.y; break;
    case 'linB': s.bx = p.x; s.by = p.y; break;
    case 'move': s.cx = p.x - drag.ox; s.cy = p.y - drag.oy; break;
    case 'scale': {
      const d = Math.hypot((p.x - s.cx) / drag.rx, (p.y - s.cy) / drag.ry);
      const k = Math.max(0.05, d / drag.d0);
      s.rx = drag.rx * k; s.ry = drag.ry * k;
      break;
    }
    case 'new': {
      const dx = Math.abs(p.x - s.cx) * p.w;
      const dy = Math.abs(p.y - s.cy) * p.h;
      if (e.shiftKey) { s.rx = Math.max(dx, 4) / p.w; s.ry = Math.max(dy, 4) / p.h; }
      else { const r = Math.max(Math.hypot(dx, dy), 4); s.rx = r / p.w; s.ry = r / p.h; }
      break;
    }
    default: break;
  }
  scheduleRender();
});

function endDrag() {
  if (!drag) return;
  const m = activeMask();
  const kind = drag.kind;
  drag = null;
  if (!m) return;
  if (kind === 'linB' && m.shape.type === 'linear' && Math.hypot(m.shape.bx - m.shape.ax, m.shape.by - m.shape.ay) < 0.01) {
    m.shape.by = Math.min(1, m.shape.ay + 0.3); // 只點一下：給預設長度
  }
  scheduleRender();
  commit(kind === 'brush' ? '筆刷' : kind.startsWith('lin') ? '調整漸層' : '調整放射範圍');
}
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);
overlay.addEventListener('pointerleave', () => { hover = null; drawOverlay(); });

// ---------- 歷史記錄 ----------
function commit(label) {
  if (!state.loaded) return;
  const snap = snapshot();
  if (state.history.length && sameSnap(state.history[state.index], snap)) return;
  state.history = state.history.slice(0, state.index + 1);
  state.history.push({ label, ...snap });
  state.index = state.history.length - 1;
  renderHistory();
}

function goTo(i) {
  if (i < 0 || i >= state.history.length) return false;
  state.index = i;
  const h = state.history[i];
  state.params = { ...h.params };
  state.masks = structuredClone(h.masks);
  if (!activeMask()) state.activeMaskId = null;
  syncSliders();
  renderMaskUi();
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

// ---------- 套用變更（動畫，讓使用者看得到滑桿移動） ----------
// targets: [{ obj, key, to }]
function animate(targets) {
  if (!targets.length) return Promise.resolve();
  for (const t of targets) {
    if (t.obj === state.params) {
      const el = sliderEls[t.key]?.row;
      el?.classList.add('flash');
      const det = el?.closest('details');
      if (det) det.open = true;
    }
    t.from = t.obj[t.key];
  }
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / 350);
      const e = 1 - Math.pow(1 - k, 3);
      for (const t of targets) {
        let v = t.from + (t.to - t.from) * e;
        if (t.key.endsWith('Hue') && Math.abs(t.to - t.from) > 180) v = t.to;
        t.obj[t.key] = k === 1 ? t.to : v;
      }
      syncSliders();
      renderNow();
      if (k < 1) requestAnimationFrame(tick);
      else {
        setTimeout(() => document.querySelectorAll('.slider.flash').forEach((r) => r.classList.remove('flash')), 600);
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

function maskContext() {
  return {
    masks: state.masks.map((m) => ({
      id: m.id, name: m.name, kind: m.kind, invert: m.invert,
      adjustments: Object.fromEntries(Object.entries(m.adj).filter(([, v]) => v !== 0)),
    })),
    activeMaskId: state.activeMaskId,
  };
}

async function interpretWithClaude(text) {
  const res = await fetch('/api/interpret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      params: state.params,
      ...maskContext(),
      stats: imageStats(),
      thumbnail: thumbnail(),
      history: state.commandHistory.slice(-6),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// 離線解析：先處理遮罩指令，再解析調整
function interpretLocally(text, forceGlobal) {
  const intent = forceGlobal ? { any: false, rest: text } : parseMaskIntent(text);
  const willHaveMask = !forceGlobal && !intent.exit && (intent.create || (state.activeMaskId && !intent.remove));
  let parsed;
  if (willHaveMask) {
    const cur = intent.create ? defaultLocalAdj() : activeMask().adj;
    parsed = parseCommand(intent.rest, { ...defaultParams(), ...cur });
  } else {
    parsed = parseCommand(intent.rest, state.params);
  }
  return {
    action: parsed.action,
    mask: {
      command: intent.exit ? 'exit' : intent.remove ? 'delete' : intent.create ? 'create' : intent.invert ? 'invert' : 'none',
      kind: intent.create || null,
      invert: Boolean(intent.invert && intent.create),
      overlay: intent.overlay ?? null,
    },
    target: willHaveMask ? 'mask' : 'global',
    changes: parsed.changes,
    understood: parsed.understood || intent.any,
    reply: null,
  };
}

async function applyResult(result) {
  const notes = [];
  const mc = result.mask || {};
  if (mc.command === 'exit') selectMask(null);
  if (mc.command === 'delete' && activeMask()) deleteMask(state.activeMaskId);
  if (mc.command === 'create' && mc.kind && MASK_KINDS[mc.kind]) {
    const m = addMask(mc.kind);
    if (mc.invert) m.invert = true;
  }
  if (mc.command === 'invert' && activeMask()) activeMask().invert = !activeMask().invert;
  if (mc.overlay !== null && mc.overlay !== undefined) { state.overlay = mc.overlay; state.overlayAuto = false; }
  renderMaskUi();

  if (result.action === 'undo') goTo(state.index - 1);
  else if (result.action === 'redo') goTo(state.index + 1);
  else if (result.action === 'reset') {
    const defs = defaultParams();
    state.masks = [];
    state.activeMaskId = null;
    renderMaskUi();
    await animate(PARAMS.map((p) => ({ obj: state.params, key: p.key, to: defs[p.key] })));
  }

  const changes = result.changes || {};
  const targets = [];
  const before = { ...state.params };
  const m = activeMask();
  let applied = {};
  if (result.target === 'mask' && m) {
    if (Object.keys(changes).length) autoHideOverlay();
    const beforeAdj = { ...m.adj };
    for (const [k0, v] of Object.entries(changes)) {
      const k = k0 === 'vibrance' ? 'saturation' : k0;
      if (LOCAL_MAP[k]) {
        const val = clampLocal(k, v);
        targets.push({ obj: m.adj, key: k, to: val });
        applied[k] = val;
      } else notes.push(`${PARAM_MAP[k0]?.label ?? k0} 只能整體調整`);
    }
    await animate(targets);
    result.summary = Object.keys(applied).length ? `［${m.name}］${summarize({ ...defaultParams(), ...beforeAdj }, applied, null)}` : '';
  } else {
    for (const [k, v] of Object.entries(changes)) {
      if (!PARAM_MAP[k]) continue;
      targets.push({ obj: state.params, key: k, to: v });
      applied[k] = v;
    }
    await animate(targets);
    result.summary = summarize(before, applied, null);
  }
  if (result.action !== 'undo' && result.action !== 'redo') commit(result.label);
  scheduleRender();
  return notes;
}

async function runCommand(text, { localOnly = false, forceGlobal = false } = {}) {
  text = text.trim();
  if (!text) return;
  if (!state.loaded) { logMsg('請先開啟一張照片。', 'bot err'); return; }
  if (state.busy) return;
  state.busy = true;
  logMsg(text, 'user');
  try {
    let result;
    let source = '離線解析';
    if (state.aiAvailable && !localOnly) {
      const pending = logMsg('理解中…', 'bot');
      try {
        result = await interpretWithClaude(text);
        source = 'Claude';
      } catch (err) {
        logMsg(`AI 理解失敗（${err.message}），改用離線解析。`, 'bot err');
      } finally {
        pending.remove();
      }
    }
    if (!result) {
      result = interpretLocally(text, forceGlobal);
      if (!result.understood && !result.action) {
        logMsg('我沒聽懂要調整哪裡。可以試試：「亮一點」「天空藍一點」「只把天空壓暗一點」「選取膚色，提亮一點」「加一點暗角」。', 'bot err');
        return;
      }
    }
    if (forceGlobal) result.target = 'global';
    result.label = text;
    state.commandHistory.push(text);
    const notes = await applyResult(result);
    let reply = result.reply || '';
    if (result.action === 'undo') reply ||= '已回到上一步。';
    if (result.action === 'redo') reply ||= '已重做。';
    if (result.action === 'reset') reply ||= '已還原成原圖。';
    if (!reply && !result.summary) {
      const c = result.mask?.command;
      reply = c === 'exit' ? '已回到整體調整。' : c === 'delete' ? '已刪除遮罩。' : c === 'invert' ? '已反轉遮罩。' : '';
    }
    if (result.summary) reply = reply ? `${reply}\n→ ${result.summary}` : result.summary;
    if (notes.length) reply += `（${notes.join('；')}）`;
    logMsg(reply || '好的。', 'bot', source);
  } finally {
    state.busy = false;
  }
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
  recognition.onresult = (e) => {
    let interim = '';
    let final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t;
      else interim += t;
    }
    $('interim').textContent = interim ? `🎙 ${interim}` : '';
    if (final) { $('interim').textContent = ''; runCommand(final); }
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
function setBusy(text) {
  $('busy').hidden = !text;
  if (text) $('busyText').textContent = text;
}

function enableUi() {
  for (const id of ['resetBtn', 'exportBtn']) $(id).disabled = false;
  document.querySelectorAll('#presets button, .mask-add button').forEach((b) => (b.disabled = false));
  $('beforeBtn').hidden = false;
  document.body.classList.add('has-image');
}

function makeSample(srcCanvas) {
  const s = Math.min(1, 400 / Math.max(srcCanvas.width, srcCanvas.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(srcCanvas.width * s));
  c.height = Math.max(1, Math.round(srcCanvas.height * s));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(srcCanvas, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

async function loadFile(file) {
  if (!file) return;
  const raw = isRawFile(file);
  if (!raw && !file.type.startsWith('image/')) {
    logMsg('請選擇圖片或相機 RAW 檔。', 'bot err');
    return;
  }
  let srcCanvas;
  let info = '';
  try {
    if (raw) {
      setBusy(`正在解碼 RAW（${(file.size / 1048576).toFixed(1)} MB）…`);
      const r = await decodeRaw(file, engine.maxTex);
      if (r.kind === 'raw') {
        srcCanvas = engine.loadRaw(r.img);
        info = `RAW ${r.img.bits} 位元・${describeRaw(r.meta)}${engine.highPrecision ? '・高精度處理' : ''}`;
      } else {
        srcCanvas = engine.loadImage(r.bitmap);
        info = `LibRaw 不支援此機型，改用內嵌 JPEG 預覽（${r.error}）`;
      }
    } else {
      setBusy('讀取中…');
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      srcCanvas = engine.loadImage(bitmap);
    }
  } catch (err) {
    setBusy(null);
    logMsg(err.message || '無法讀取這張圖片。', 'bot err');
    return;
  }
  setBusy(null);
  for (const m of state.masks) { engine.dropMask(m.id); dropBrushCache(m.id); }
  state.aspect = engine.width / engine.height;
  const s = Math.min(1, PREVIEW_MAX / Math.max(engine.width, engine.height));
  canvas.width = Math.round(engine.width * s);
  canvas.height = Math.round(engine.height * s);
  state.srcSample = makeSample(srcCanvas);
  state.fileName = file.name.replace(/\.[^.]+$/, '') || 'photo';
  state.loaded = true;
  state.params = defaultParams();
  state.masks = [];
  state.activeMaskId = null;
  state.history = [];
  state.index = 0;
  state.commandHistory = [];
  commit(`匯入 ${file.name}`);
  syncSliders();
  renderMaskUi();
  enableUi();
  layoutStage();
  scheduleRender();
  logMsg(`已開啟 ${file.name}（${engine.width}×${engine.height}）${info ? `\n${info}` : ''}\n直接說出想調整的地方吧！`, 'bot');
}

$('fileInput').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
['dragenter', 'dragover'].forEach((t) => viewer.addEventListener(t, (e) => { e.preventDefault(); viewer.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((t) => viewer.addEventListener(t, (e) => { e.preventDefault(); viewer.classList.remove('dragging'); }));
viewer.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

$('exportBtn').addEventListener('click', async () => {
  const btn = $('exportBtn');
  btn.disabled = true;
  btn.textContent = '輸出中…';
  try {
    const masks = state.masks.filter((m) => maskHasEffect(m));
    const blob = await engine.exportBlob(state.params, masks, 'image/jpeg', 0.95);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.fileName}_edited.jpg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = '輸出 JPEG';
    scheduleRender();
  }
});

$('undoBtn').addEventListener('click', () => goTo(state.index - 1));
$('redoBtn').addEventListener('click', () => goTo(state.index + 1));
$('resetBtn').addEventListener('click', () => {
  state.params = defaultParams();
  state.masks = [];
  state.activeMaskId = null;
  syncSliders();
  renderMaskUi();
  scheduleRender();
  commit('還原原圖');
});

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
    return;
  }
  if (!state.loaded) return;
  if (e.key.toLowerCase() === 'o') { state.overlay = !state.overlay; renderMaskUi(); scheduleRender(); }
  if (e.key === 'Escape') selectMask(null);
  if (e.key === '[' || e.key === ']') {
    state.brush.size = Math.min(0.4, Math.max(0.01, state.brush.size * (e.key === ']' ? 1.15 : 1 / 1.15)));
    maskSliders.forEach((s) => s.update());
    drawOverlay();
  }
});
document.addEventListener('keyup', (e) => { if (e.key === '\\') setOriginal(false); });

// ---------- 啟動 ----------

buildGlobalPanels();
syncNextId([]);
renderHistory();
renderMaskUi();
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
