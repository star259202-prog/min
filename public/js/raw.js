// RAW 檔讀取：用 LibRaw（WebAssembly，在 Web Worker 中執行）解碼成 16 位元 RGB。
// 照片不會上傳到任何地方，全部在瀏覽器裡處理。
// 若 LibRaw 不支援該機型，退回使用 RAW 檔內嵌的全尺寸 JPEG 預覽。

export const RAW_EXTENSIONS = [
  'dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'rwl', 'pef', 'ptx',
  'srw', 'x3f', '3fr', 'fff', 'iiq', 'mos', 'mef', 'mrw', 'erf', 'kdc', 'dcr', 'k25', 'raw', 'gpr', 'braw',
];

export function isRawFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return RAW_EXTENSIONS.includes(ext);
}

const SETTINGS = {
  outputBps: 16,        // 16 位元輸出，保留寬容度
  useCameraWb: true,    // 使用相機白平衡（之後可再用色溫調整）
  outputColor: 1,       // sRGB
  gamm: [1 / 2.4, 12.92], // sRGB 曲線
  highlight: 2,         // 亮部混合重建，避免過曝處偏洋紅
  userQual: 3,          // AHD 反馬賽克
  useFujiRotate: 1,
};

let LibRawClass = null;
async function loadLibRaw() {
  if (!LibRawClass) LibRawClass = (await import('/vendor/libraw/index.js')).default;
  return LibRawClass;
}

async function decodeWithLibRaw(bytes, maxSide) {
  const LibRaw = await loadLibRaw();
  const raw = new LibRaw();
  try {
    // open() 會把 buffer 轉移給 worker，所以每次都傳一份複本
    await raw.open(bytes.slice(), { ...SETTINGS });
    const meta = await raw.metadata();
    if (Math.max(meta.width, meta.height) > maxSide) {
      // 超過顯示卡紋理上限：用 LibRaw 的半尺寸模式（同時更快）
      await raw.open(bytes.slice(), { ...SETTINGS, halfSize: true });
    }
    const img = await raw.imageData();
    if (!img || !img.width || !img.data) throw new Error('LibRaw 沒有輸出影像');
    return { img, meta };
  } finally {
    raw.dispose();
  }
}

// 從 RAW 檔中找出最大的內嵌 JPEG（大多數相機都會內嵌全尺寸預覽）
export function findEmbeddedJpegs(bytes) {
  const sois = [];
  const eois = [];
  for (let i = 0; i < bytes.length - 2; i++) {
    if (bytes[i] !== 0xff) continue;
    const b = bytes[i + 1];
    if (b === 0xd8 && bytes[i + 2] === 0xff) sois.push(i);
    else if (b === 0xd9) eois.push(i + 2);
  }
  const candidates = [];
  for (const s of sois) {
    // 取這個 SOI 之後最後一個 EOI（內含縮圖的 JPEG 會有巢狀 SOI/EOI）
    let end = -1;
    for (const e of eois) if (e > s) end = e;
    if (end > s) candidates.push([s, end]);
    // 也考慮第一個 EOI（獨立的小預覽）
    const first = eois.find((e) => e > s);
    if (first && first !== end) candidates.push([s, first]);
  }
  candidates.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
  return candidates;
}

async function embeddedPreview(bytes) {
  for (const [s, e] of findEmbeddedJpegs(bytes).slice(0, 8)) {
    if (e - s < 20000) continue;
    try {
      const bmp = await createImageBitmap(new Blob([bytes.subarray(s, e)], { type: 'image/jpeg' }));
      if (bmp.width >= 640) return bmp;
      bmp.close();
    } catch { /* 試下一個 */ }
  }
  return null;
}

export async function decodeRaw(file, maxSide) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const { img, meta } = await decodeWithLibRaw(bytes, maxSide);
    return { kind: 'raw', img, meta };
  } catch (err) {
    const bmp = await embeddedPreview(bytes);
    if (bmp) return { kind: 'preview', bitmap: bmp, error: err.message };
    throw new Error(`無法解碼這個 RAW 檔（${err.message}）`);
  }
}

export function describeRaw(meta) {
  if (!meta) return '';
  const parts = [];
  const cam = [meta.camera_make, meta.camera_model].filter(Boolean).join(' ').trim();
  if (cam) parts.push(cam);
  if (meta.iso_speed) parts.push(`ISO ${Math.round(meta.iso_speed)}`);
  if (meta.shutter) parts.push(meta.shutter >= 1 ? `${meta.shutter}s` : `1/${Math.round(1 / meta.shutter)}s`);
  if (meta.aperture) parts.push(`f/${Math.round(meta.aperture * 10) / 10}`);
  if (meta.focal_len) parts.push(`${Math.round(meta.focal_len)}mm`);
  return parts.join('・');
}
