// 遮罩（局部調整）：筆刷、線性漸層、放射狀漸層、顏色範圍、明度範圍。
// 遮罩只決定「調整作用在哪裡、作用多少」，選取方式完全依照位置、顏色、亮度，
// 不使用 AI 分割，也不會產生或改變任何像素內容。

export const LOCAL_PARAMS = [
  { key: 'temp', label: '色溫', min: -100, max: 100, step: 1 },
  { key: 'tint', label: '色調', min: -100, max: 100, step: 1 },
  { key: 'exposure', label: '曝光度', min: -4, max: 4, step: 0.05 },
  { key: 'contrast', label: '對比', min: -100, max: 100, step: 1 },
  { key: 'highlights', label: '亮部', min: -100, max: 100, step: 1 },
  { key: 'shadows', label: '陰影', min: -100, max: 100, step: 1 },
  { key: 'whites', label: '白色', min: -100, max: 100, step: 1 },
  { key: 'blacks', label: '黑色', min: -100, max: 100, step: 1 },
  { key: 'texture', label: '紋理', min: -100, max: 100, step: 1 },
  { key: 'clarity', label: '清晰度', min: -100, max: 100, step: 1 },
  { key: 'dehaze', label: '去朦朧', min: -100, max: 100, step: 1 },
  { key: 'saturation', label: '飽和度', min: -100, max: 100, step: 1 },
  { key: 'sharpen', label: '銳利度', min: -100, max: 100, step: 1 },
];
export const LOCAL_MAP = Object.fromEntries(LOCAL_PARAMS.map((p) => [p.key, p]));

export function clampLocal(key, value) {
  const p = LOCAL_MAP[key];
  if (!p || !Number.isFinite(value)) return undefined;
  const v = Math.min(p.max, Math.max(p.min, value));
  return p.step < 1 ? Math.round(v * 100) / 100 : Math.round(v);
}

export function defaultLocalAdj() {
  return Object.fromEntries(LOCAL_PARAMS.map((p) => [p.key, 0]));
}

export const MASK_KINDS = {
  brush: '筆刷',
  linear: '線性漸層',
  radial: '放射狀漸層',
  color: '顏色範圍',
  luminance: '明度範圍',
  sky: '天空',
  skin: '膚色',
  subject: '中央主體',
  edges: '四周',
  top: '上半部',
  bottom: '下半部／地面',
  left: '左側',
  right: '右側',
  highlightsArea: '亮部區域',
  shadowsArea: '暗部區域',
};

let nextId = 1;
export function syncNextId(masks) {
  for (const m of masks) nextId = Math.max(nextId, m.id + 1);
}

// aspect = 寬 / 高；座標都是 0~1 的影像座標（左上角為原點）
export function createMask(kind, aspect = 1.5) {
  const id = nextId++;
  const m = {
    id,
    kind,
    name: `遮罩 ${id}・${MASK_KINDS[kind] ?? kind}`,
    visible: true,
    shape: { type: 'all', ax: 0.5, ay: 0, bx: 0.5, by: 0.5, cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3 * aspect, feather: 50, strokes: [] },
    invert: false,
    color: { on: false, hue: 210, width: 40 },
    lum: { on: false, min: 0, max: 100, feather: 15 },
    amount: 100,
    adj: defaultLocalAdj(),
  };
  const s = m.shape;
  switch (kind) {
    case 'brush': s.type = 'brush'; break;
    case 'linear': s.type = 'linear'; break;
    case 'radial': s.type = 'radial'; break;
    case 'color': m.color.on = true; break;
    case 'luminance': Object.assign(m.lum, { on: true, min: 60, max: 100 }); break;
    case 'sky': s.type = 'linear'; Object.assign(s, { ax: 0.5, ay: 0.05, bx: 0.5, by: 0.6 }); Object.assign(m.lum, { on: true, min: 30, max: 100, feather: 20 }); break;
    case 'skin': m.color = { on: true, hue: 22, width: 36 }; Object.assign(m.lum, { on: true, min: 12, max: 97, feather: 10 }); break;
    case 'subject': s.type = 'radial'; Object.assign(s, { rx: 0.28, ry: 0.28 * aspect * 1.2, feather: 60 }); break;
    case 'edges': s.type = 'radial'; Object.assign(s, { rx: 0.42, ry: 0.42 * aspect, feather: 70 }); m.invert = true; break;
    case 'top': s.type = 'linear'; Object.assign(s, { ax: 0.5, ay: 0.3, bx: 0.5, by: 0.6 }); break;
    case 'bottom': s.type = 'linear'; Object.assign(s, { ax: 0.5, ay: 0.75, bx: 0.5, by: 0.45 }); break;
    case 'left': s.type = 'linear'; Object.assign(s, { ax: 0.25, ay: 0.5, bx: 0.6, by: 0.5 }); break;
    case 'right': s.type = 'linear'; Object.assign(s, { ax: 0.75, ay: 0.5, bx: 0.4, by: 0.5 }); break;
    case 'highlightsArea': Object.assign(m.lum, { on: true, min: 65, max: 100, feather: 15 }); break;
    case 'shadowsArea': Object.assign(m.lum, { on: true, min: 0, max: 35, feather: 15 }); break;
    default: break;
  }
  return m;
}

export function maskHasEffect(m) {
  return m.visible && m.amount > 0 && LOCAL_PARAMS.some((p) => m.adj[p.key] !== 0);
}

// ---------- 筆刷點陣化 ----------
const BRUSH_RES = 1600;
const brushCache = new Map(); // id -> { key, canvas, drawnStrokes }

export function strokesKey(strokes) {
  let n = 0;
  let s = 0;
  for (const st of strokes) {
    n += st.pts.length;
    s += st.size + (st.erase ? 7 : 3) + st.flow * 0.01 + st.feather * 0.001;
    for (const [x, y] of st.pts) s += x * 1.37 + y * 2.11;
  }
  return `${strokes.length}:${n}:${s.toFixed(4)}`;
}

function drawStroke(ctx, st, W, H, skipFirst = false) {
  const long = Math.max(W, H);
  const r = Math.max(1, (st.size * long) / 2);
  const inner = Math.max(0, 1 - st.feather / 100);
  const alpha = Math.max(0.02, st.flow / 100);
  ctx.globalCompositeOperation = st.erase ? 'destination-out' : 'source-over';
  const dab = (x, y) => {
    const g = ctx.createRadialGradient(x, y, r * inner * 0.999, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${alpha})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  const spacing = Math.max(1, r * 0.2);
  let prev = null;
  for (const [nx, ny] of st.pts) {
    const x = nx * W;
    const y = ny * H;
    if (!prev) { if (!skipFirst) dab(x, y); prev = [x, y]; continue; }
    const dx = x - prev[0];
    const dy = y - prev[1];
    const dist = Math.hypot(dx, dy);
    if (dist < spacing) continue;
    const steps = Math.floor(dist / spacing);
    for (let i = 1; i <= steps; i++) dab(prev[0] + (dx * i) / steps, prev[1] + (dy * i) / steps);
    prev = [x, y];
  }
  ctx.globalCompositeOperation = 'source-over';
}

function entryFor(mask, aspect) {
  const W = aspect >= 1 ? BRUSH_RES : Math.round(BRUSH_RES * aspect);
  const H = aspect >= 1 ? Math.round(BRUSH_RES / aspect) : BRUSH_RES;
  let entry = brushCache.get(mask.id);
  if (!entry || entry.canvas.width !== W || entry.canvas.height !== H) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    entry = { key: null, canvas };
    brushCache.set(mask.id, entry);
  }
  return entry;
}

// 回傳 { canvas, key }；筆刷內容改變（例如復原）時才整張重畫
export function brushCanvas(mask, aspect) {
  const entry = entryFor(mask, aspect);
  const key = strokesKey(mask.shape.strokes);
  if (entry.key !== key) {
    const ctx = entry.canvas.getContext('2d');
    ctx.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
    for (const st of mask.shape.strokes) drawStroke(ctx, st, entry.canvas.width, entry.canvas.height);
    entry.key = key;
  }
  return entry;
}

// 繪製中：只把最後一筆從 fromIndex 開始的新線段畫上去，不重畫整張
export function brushAppend(mask, aspect, fromIndex) {
  const entry = entryFor(mask, aspect);
  const strokes = mask.shape.strokes;
  const st = strokes[strokes.length - 1];
  const start = Math.max(0, fromIndex - 1);
  drawStroke(entry.canvas.getContext('2d'), { ...st, pts: st.pts.slice(start) }, entry.canvas.width, entry.canvas.height, start > 0);
  entry.key = strokesKey(strokes);
  return entry;
}

export function dropBrushCache(id) {
  brushCache.delete(id);
}
