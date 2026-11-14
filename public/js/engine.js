// WebGL 修圖引擎：所有運算都是逐像素的色彩／色調轉換與「同位置」的局部對比（模糊相減），
// 沒有任何像素位移、液化、變形或 AI 生成，所以臉部形狀不會被改變。
//
// 流程：原圖 →（整體調整）→ 遮罩 1 局部調整 → 遮罩 2 … → 畫面
// RAW 檔以 16 位元解碼後用半浮點紋理儲存，大幅拉陰影／亮部時不會出現色階斷層。

import { HSL_BANDS } from './params.js';

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const BLUR_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  vec4 s = texture2D(uTex, vUv) * 0.2270270270;
  s += texture2D(uTex, vUv + uDir * 1.3846153846) * 0.3162162162;
  s += texture2D(uTex, vUv - uDir * 1.3846153846) * 0.3162162162;
  s += texture2D(uTex, vUv + uDir * 3.2307692308) * 0.0702702703;
  s += texture2D(uTex, vUv - uDir * 3.2307692308) * 0.0702702703;
  gl_FragColor = s;
}`;

const COPY_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
void main() { gl_FragColor = texture2D(uTex, vUv); }`;

// 整體與局部共用的函式與基本調整
const COMMON = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform sampler2D uBlurS;
uniform sampler2D uBlurM;
uniform sampler2D uBlurL;
uniform float uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks;
uniform vec3 uWB;
uniform float uTexture, uClarity, uDehaze, uSaturation, uSharpen;
uniform float uAspect;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 toLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 toGam(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

float scurve(float x) {
  float p = 0.45;
  return x < p ? p * pow(x / p, 1.8) : 1.0 - (1.0 - p) * pow((1.0 - x) / (1.0 - p), 1.8);
}
float iscurve(float x) {
  float p = 0.45;
  return x < p ? p * pow(x / p, 0.6) : 1.0 - (1.0 - p) * pow((1.0 - x) / (1.0 - p), 0.6);
}

vec3 applyLum(vec3 c, float L, float newL) {
  vec3 ratio = c * (newL / max(L, 1.0e-4));
  vec3 add = c + (newL - L);
  return mix(add, ratio, 0.5);
}

// c：要調整的顏色；mid：中頻細節；bL：大範圍模糊（局部平均）
vec3 applyBasic(vec3 c, float mid, vec3 bL) {
  c += vec3(mid * uTexture * 1.4);

  vec3 lin = toLin(c) * uWB;
  vec3 linL = toLin(bL) * uWB;
  float ex = exp2(uExposure);
  lin *= ex; linL *= ex;
  lin = lin / (1.0 + max(lin - 0.8, 0.0) * 0.6);
  c = toGam(lin);
  vec3 cL = toGam(linL);

  float L = luma(c);
  float Lb = luma(cL);
  float newL = L;
  float m = mix(L, Lb, 0.6);

  float hMask = smoothstep(0.4, 1.0, m);
  float sMask = 1.0 - smoothstep(0.0, 0.55, m);
  newL += uHighlights * 0.45 * hMask * (uHighlights < 0.0 ? newL * 0.6 : (1.0 - newL));
  newL += uShadows * 0.5 * sMask * (uShadows > 0.0 ? (1.0 - newL) * 0.55 : newL);
  newL += uWhites * 0.22 * smoothstep(0.3, 1.0, newL);
  newL += uBlacks * 0.14 * (1.0 - smoothstep(0.0, 0.55, newL));
  newL = clamp(newL, 0.0, 1.2);

  float nl = clamp(newL, 0.0, 1.0);
  if (uContrast >= 0.0) nl = mix(nl, scurve(nl), uContrast);
  else nl = mix(nl, iscurve(nl), -uContrast);
  newL = nl + max(newL - 1.0, 0.0);

  float midMask = 1.0 - pow(abs(newL * 2.0 - 1.0), 2.0);
  newL += uClarity * 0.8 * (L - Lb) * midMask;

  c = applyLum(c, L, max(newL, 0.0));

  if (uDehaze > 0.0) {
    float w = smoothstep(0.15, 0.9, Lb);
    float k = uDehaze * 0.18 * w;
    c = (c - vec3(k)) / (1.0 - k);
    c = mix(vec3(luma(c)), c, 1.0 + uDehaze * 0.25);
  } else if (uDehaze < 0.0) {
    c = mix(c, vec3(0.78), -uDehaze * 0.35);
  }
  return c;
}
`;

const MAIN_FRAG = COMMON + `
uniform float uOriginal;
uniform float uVibrance;
uniform float uVignette, uGrain;
uniform vec2 uRes;
uniform vec3 uShadowTint, uHighlightTint;
uniform float uBalance;
uniform float uCenter[8];
uniform float uLeftW[8];
uniform float uRightW[8];
uniform float uHslHue[8];
uniform float uHslSat[8];
uniform float uHslLum[8];

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec3 c = texture2D(uSrc, vUv).rgb;
  if (uOriginal > 0.5) { gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0); return; }
  vec3 bS = texture2D(uBlurS, vUv).rgb;
  vec3 bM = texture2D(uBlurM, vUv).rgb;
  vec3 bL = texture2D(uBlurL, vUv).rgb;
  float fine = luma(c) - luma(bS);
  float mid = luma(bS) - luma(bM);

  c = applyBasic(c, mid, bL);

  // HSL
  vec3 hsv = rgb2hsv(clamp(c, 0.0, 1.0));
  float hdeg = hsv.x * 360.0;
  float hueShift = 0.0, satMul = 0.0, lumShift = 0.0;
  for (int i = 0; i < 8; i++) {
    float d = mod(hdeg - uCenter[i] + 540.0, 360.0) - 180.0;
    float t = d >= 0.0 ? 1.0 - d / uRightW[i] : 1.0 + d / uLeftW[i];
    float w = smoothstep(0.0, 1.0, clamp(t, 0.0, 1.0));
    hueShift += w * uHslHue[i];
    satMul += w * uHslSat[i];
    lumShift += w * uHslLum[i];
  }
  float chroma = hsv.y;
  hsv.x = fract((hdeg + hueShift * 30.0 * smoothstep(0.02, 0.15, chroma)) / 360.0 + 1.0);
  hsv.y = clamp(hsv.y * (1.0 + satMul), 0.0, 1.0);
  vec3 hc = hsv2rgb(hsv);
  float Lh = luma(hc);
  float Lc = luma(clamp(c, 0.0, 1.0));
  hc *= Lc / max(Lh, 1.0e-4);
  hc *= 1.0 + lumShift * 0.45 * smoothstep(0.03, 0.3, chroma);
  c = mix(c, hc, step(1.0e-4, abs(hueShift) + abs(satMul) + abs(lumShift)));

  // 細節飽和度（保護膚色）＋飽和度
  vec3 hsv2 = rgb2hsv(clamp(c, 0.0, 1.0));
  float hd = hsv2.x * 360.0;
  float skin = smoothstep(0.0, 15.0, hd) * (1.0 - smoothstep(40.0, 60.0, hd));
  float vib = uVibrance * (1.0 - hsv2.y) * (uVibrance > 0.0 ? (1.0 - 0.65 * skin) : 1.0);
  c = mix(vec3(luma(c)), c, 1.0 + vib);
  c = mix(vec3(luma(c)), c, 1.0 + uSaturation);

  // 色彩分級
  float Lg = clamp(luma(c), 0.0, 1.0);
  float pivot = 0.5 + uBalance * 0.3;
  c += uShadowTint * (1.0 - smoothstep(0.0, pivot, Lg)) + uHighlightTint * smoothstep(pivot, 1.0, Lg);

  c += vec3(fine * uSharpen * 1.6);

  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = length(q) / length(vec2(uAspect, 1.0) * 0.5);
  float v = smoothstep(0.35, 1.05, r);
  if (uVignette < 0.0) c *= 1.0 + uVignette * v * 0.85;
  else c = mix(c, vec3(1.0), uVignette * v * 0.7);

  if (uGrain > 0.0) {
    float n = hash(floor(vUv * uRes)) - 0.5;
    c += vec3(n * uGrain * 0.12 * (1.0 - abs(luma(c) * 2.0 - 1.0) * 0.5));
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// 局部調整：依遮罩權重混合
const LOCAL_FRAG = COMMON + `
uniform sampler2D uBase;
uniform sampler2D uMaskTex;
uniform float uShapeType;   // 0 全圖 1 筆刷 2 線性 3 放射
uniform vec4 uLine;         // ax, ay, bx, by
uniform vec4 uEllipse;      // cx, cy, rx, ry
uniform float uFeather;
uniform float uInvert;
uniform vec3 uColorRange;   // on, hue(度), width(度)
uniform vec4 uLumRange;     // on, min, max, feather (0~1)
uniform float uAmount;
uniform float uOverlay;

float maskWeight(vec3 src) {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y);
  float w = 1.0;
  if (uShapeType > 0.5 && uShapeType < 1.5) {
    w = texture2D(uMaskTex, vUv).a;
  } else if (uShapeType > 1.5 && uShapeType < 2.5) {
    vec2 P = vec2(p.x * uAspect, p.y);
    vec2 A = vec2(uLine.x * uAspect, uLine.y);
    vec2 B = vec2(uLine.z * uAspect, uLine.w);
    vec2 AB = B - A;
    float t = dot(P - A, AB) / max(dot(AB, AB), 1.0e-6);
    w = 1.0 - smoothstep(0.0, 1.0, t);
  } else if (uShapeType > 2.5) {
    float d = length((p - uEllipse.xy) / max(uEllipse.zw, vec2(1.0e-4)));
    float f = clamp(uFeather, 0.0, 1.0);
    w = 1.0 - smoothstep(1.0 - f - 1.0e-3, 1.0, d);
  }
  if (uInvert > 0.5) w = 1.0 - w;
  if (uColorRange.x > 0.5) {
    vec3 hsv = rgb2hsv(clamp(src, 0.0, 1.0));
    float dh = abs(mod(hsv.x * 360.0 - uColorRange.y + 540.0, 360.0) - 180.0);
    float hw = uColorRange.z * 0.5;
    w *= 1.0 - smoothstep(hw * 0.6, hw + 8.0, dh);
    w *= smoothstep(0.06, 0.2, hsv.y) * smoothstep(0.03, 0.12, hsv.z);
  }
  if (uLumRange.x > 0.5) {
    float L = luma(clamp(src, 0.0, 1.0));
    float fe = max(uLumRange.w, 0.005);
    w *= smoothstep(uLumRange.y - fe, uLumRange.y, L) * (1.0 - smoothstep(uLumRange.z, uLumRange.z + fe, L));
  }
  return clamp(w * uAmount, 0.0, 1.0);
}

void main() {
  vec3 base = texture2D(uBase, vUv).rgb;
  vec3 src = texture2D(uSrc, vUv).rgb;
  float w = maskWeight(src);
  vec3 outc = base;
  if (w > 0.001) {
    vec3 bS = texture2D(uBlurS, vUv).rgb;
    vec3 bM = texture2D(uBlurM, vUv).rgb;
    vec3 bL = texture2D(uBlurL, vUv).rgb;
    float fine = luma(src) - luma(bS);
    float mid = luma(bS) - luma(bM);
    // 把原圖的局部平均換算成「整體調整後」的亮度，讓亮部／陰影判斷依照目前畫面
    float ratio = clamp(luma(base) / max(luma(src), 1.0e-3), 0.0, 4.0);
    vec3 c = applyBasic(base, mid, bL * ratio);
    c = mix(vec3(luma(c)), c, 1.0 + uSaturation);
    c += vec3(fine * (uSharpen > 0.0 ? uSharpen * 1.6 : uSharpen));
    outc = mix(base, c, w);
  }
  if (uOverlay > 0.5) outc = mix(outc, vec3(1.0, 0.15, 0.25), w * 0.55);
  gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader 編譯失敗：' + gl.getShaderInfoLog(s));
  return s;
}

function program(gl, frag) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Shader 連結失敗：' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

function hueToRgb(h) {
  const k = (n) => (n + h / 30) % 12;
  const f = (n) => 0.5 - 0.5 * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

export function whiteBalanceGains(temp, tint) {
  const t = temp / 100;
  const m = tint / 100;
  const g = [1 + 0.22 * t + 0.06 * m, 1 + 0.03 * t - 0.16 * m, 1 - 0.3 * t + 0.06 * m];
  const l = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
  return g.map((x) => x / l);
}

// float32 → half float 位元（給 RAW 16 位元資料上傳用）
const HALF_LUT = (() => {
  const lut = new Uint16Array(65536);
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  for (let i = 0; i < 65536; i++) {
    f32[0] = i / 65535;
    const x = u32[0];
    const e = ((x >> 23) & 0xff) - 127 + 15;
    const m = x & 0x7fffff;
    if (i === 0) lut[i] = 0;
    else if (e <= 0) lut[i] = (m | 0x800000) >> (1 - e + 13);
    else lut[i] = (e << 10) | (m >> 13);
  }
  return lut;
})();

const SHAPE_TYPE = { all: 0, brush: 1, linear: 2, radial: 3 };

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    const opts = { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false };
    let gl = canvas.getContext('webgl2', opts);
    this.isGL2 = Boolean(gl);
    if (!gl) gl = canvas.getContext('webgl', opts);
    if (!gl) throw new Error('你的瀏覽器不支援 WebGL');
    this.gl = gl;
    this.floatTargets = this.isGL2 && Boolean(gl.getExtension('EXT_color_buffer_float'));
    this.maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192);
    this.main = program(gl, MAIN_FRAG);
    this.local = program(gl, LOCAL_FRAG);
    this.blur = program(gl, BLUR_FRAG);
    this.copy = program(gl, COPY_FRAG);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.width = 0;
    this.height = 0;
    this.targets = [];
    this.work = null;
    this.maskTex = new Map(); // mask id -> { tex, key }
    this.emptyTex = this._tex(1, 1);
    this.highPrecision = false;
  }

  _setParams() {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  _tex(w, h, float = false) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    this._setParams();
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return t;
  }

  _target(w, h, track = true) {
    const gl = this.gl;
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const float = this.floatTargets && this.highPrecision;
    const tex = this._tex(w, h, float);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const t = { tex, fb, w, h };
    if (track) this.targets.push(t);
    return t;
  }

  _free(t) {
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fb);
  }

  _pass(prog, srcTex, dst, setup) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
    gl.viewport(0, 0, dst ? dst.w : this.canvas.width, dst ? dst.h : this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(prog.u.uTex, 0);
    if (setup) setup(prog.u);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _gauss(srcTex, w, h, spread, iterations) {
    const a = this._target(w, h);
    const b = this._target(w, h);
    let src = srcTex;
    for (let i = 0; i < iterations; i++) {
      this._pass(this.blur, src, a, (u) => this.gl.uniform2f(u.uDir, spread / a.w, 0));
      this._pass(this.blur, a.tex, b, (u) => this.gl.uniform2f(u.uDir, 0, spread / a.h));
      src = b.tex;
    }
    return b;
  }

  _downsample(srcTex, w, h, factor) {
    let tex = srcTex;
    let cw = w;
    let ch = h;
    while (factor > 1) {
      cw = Math.max(1, cw / 2);
      ch = Math.max(1, ch / 2);
      const t = this._target(cw, ch);
      this._pass(this.copy, tex, t);
      tex = t.tex;
      factor /= 2;
    }
    return { tex, w: Math.round(cw), h: Math.round(ch) };
  }

  _reset() {
    const gl = this.gl;
    for (const t of this.targets) this._free(t);
    this.targets = [];
    this._freeWork();
    if (this.srcTex) gl.deleteTexture(this.srcTex);
    this.srcTex = null;
  }

  _buildBlurs() {
    const { width: w, height: h } = this;
    const longSide = Math.max(w, h);
    const sFactor = longSide > 3000 ? 2 : 1;
    this.blurS = this._gauss(this.srcTex, w / sFactor, h / sFactor, 1.0, 1);
    const m = this._downsample(this.srcTex, w, h, longSide > 1500 ? 4 : 2);
    this.blurM = this._gauss(m.tex, m.w, m.h, 1.2, 1);
    const lf = Math.pow(2, Math.max(1, Math.round(Math.log2(longSide / 320))));
    const l = this._downsample(this.srcTex, w, h, lf);
    this.blurL = this._gauss(l.tex, l.w, l.h, 1.6, 3);
  }

  // 一般圖片（JPEG/PNG/WebP/HEIC、或 RAW 內嵌預覽）
  loadImage(source) {
    const gl = this.gl;
    this._reset();
    this.highPrecision = false;
    let w = source.naturalWidth || source.width;
    let h = source.naturalHeight || source.height;
    const scale = Math.min(1, this.maxTex / Math.max(w, h));
    // 一律先畫到 2D canvas 再上傳：ImageBitmap 會忽略 UNPACK_FLIP_Y，導致上下顛倒
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    const upload = document.createElement('canvas');
    upload.width = w;
    upload.height = h;
    upload.getContext('2d').drawImage(source, 0, 0, w, h);
    this.width = w;
    this.height = h;
    this.srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    this._setParams();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, upload);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this._buildBlurs();
    return upload;
  }

  // RAW 解碼結果：{ width, height, colors, bits, data: Uint8Array|Uint16Array }（RGB，左上角起）
  // 回傳一張 8 位元預覽 canvas（給取樣、縮圖用）
  loadRaw(img) {
    const gl = this.gl;
    this._reset();
    const { width: w, height: h, colors } = img;
    const data = img.data;
    const is16 = img.bits === 16 || data instanceof Uint16Array;
    this.width = w;
    this.height = h;
    this.highPrecision = this.isGL2 && is16;

    // 8 位元預覽（也是 WebGL1 時的上傳來源）
    const preview = document.createElement('canvas');
    preview.width = w;
    preview.height = h;
    const pctx = preview.getContext('2d');
    const id = pctx.createImageData(w, h);
    const out8 = id.data;
    const shift = is16 ? 8 : 0;
    for (let i = 0, j = 0, n = w * h; i < n; i++, j += colors) {
      out8[i * 4] = data[j] >> shift;
      out8[i * 4 + 1] = data[j + (colors > 1 ? 1 : 0)] >> shift;
      out8[i * 4 + 2] = data[j + (colors > 2 ? 2 : 0)] >> shift;
      out8[i * 4 + 3] = 255;
    }
    pctx.putImageData(id, 0, 0);

    this.srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    this._setParams();
    if (this.highPrecision) {
      // 16 位元 → 半浮點，同時上下翻轉（WebGL 原點在左下角）
      const half = new Uint16Array(w * h * 3);
      for (let y = 0; y < h; y++) {
        const srcRow = y * w * colors;
        const dstRow = (h - 1 - y) * w * 3;
        for (let x = 0; x < w; x++) {
          const s = srcRow + x * colors;
          const d = dstRow + x * 3;
          half[d] = HALF_LUT[data[s]];
          half[d + 1] = HALF_LUT[data[s + (colors > 1 ? 1 : 0)]];
          half[d + 2] = HALF_LUT[data[s + (colors > 2 ? 2 : 0)]];
        }
      }
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16F, w, h, 0, gl.RGB, gl.HALF_FLOAT, half);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    } else {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, preview);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }
    this._buildBlurs();
    return preview;
  }

  // 筆刷遮罩：只有內容改變（key 不同）時才重新上傳
  setMaskCanvas(id, key, canvas) {
    const gl = this.gl;
    let e = this.maskTex.get(id);
    if (e && e.key === key) return;
    if (!e) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      this._setParams();
      e = { tex, key: null };
      this.maskTex.set(id, e);
    }
    gl.bindTexture(gl.TEXTURE_2D, e.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    e.key = key;
  }

  dropMask(id) {
    const e = this.maskTex.get(id);
    if (e) this.gl.deleteTexture(e.tex);
    this.maskTex.delete(id);
  }

  _freeWork() {
    if (this.work) for (const t of this.work.t) this._free(t);
    this.work = null;
  }

  _ensureWork(w, h) {
    if (this.work && this.work.w === w && this.work.h === h) return this.work.t;
    this._freeWork();
    // 很大的輸出時改用 8 位元以節省顯示記憶體
    const keep = this.highPrecision;
    if (w * h > 16e6) this.highPrecision = false;
    this.work = { w, h, t: [this._target(w, h, false), this._target(w, h, false)] };
    this.highPrecision = keep;
    return this.work.t;
  }

  _bindSources(u) {
    const gl = this.gl;
    const texs = [this.srcTex, this.blurS.tex, this.blurM.tex, this.blurL.tex];
    ['uSrc', 'uBlurS', 'uBlurM', 'uBlurL'].forEach((name, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, texs[i]);
      gl.uniform1i(u[name], i);
    });
  }

  _basicUniforms(u, P) {
    const gl = this.gl;
    gl.uniform1f(u.uExposure, P.exposure);
    gl.uniform1f(u.uContrast, P.contrast / 100);
    gl.uniform1f(u.uHighlights, P.highlights / 100);
    gl.uniform1f(u.uShadows, P.shadows / 100);
    gl.uniform1f(u.uWhites, P.whites / 100);
    gl.uniform1f(u.uBlacks, P.blacks / 100);
    gl.uniform3fv(u.uWB, whiteBalanceGains(P.temp, P.tint));
    gl.uniform1f(u.uTexture, P.texture / 100);
    gl.uniform1f(u.uClarity, P.clarity / 100);
    gl.uniform1f(u.uDehaze, P.dehaze / 100);
    gl.uniform1f(u.uSaturation, P.saturation / 100);
    gl.uniform1f(u.uSharpen, P.sharpen / 100);
    gl.uniform1f(u.uAspect, this.width / this.height);
  }

  _drawMain(P, dst, original, cw, ch) {
    const gl = this.gl;
    const { u, p } = this.main;
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
    gl.viewport(0, 0, cw, ch);
    this._bindSources(u);
    this._basicUniforms(u, P);
    gl.uniform1f(u.uOriginal, original ? 1 : 0);
    gl.uniform1f(u.uVibrance, P.vibrance / 100);
    gl.uniform1f(u.uVignette, P.vignette / 100);
    gl.uniform1f(u.uGrain, P.grain / 100);
    gl.uniform2f(u.uRes, cw, ch);
    const tint = (hue, sat) => {
      const rgb = hueToRgb(hue);
      const l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      return rgb.map((x) => (x - l) * (sat / 100) * 0.35);
    };
    gl.uniform3fv(u.uShadowTint, tint(P.shadowHue, P.shadowSat));
    gl.uniform3fv(u.uHighlightTint, tint(P.highlightHue, P.highlightSat));
    gl.uniform1f(u.uBalance, P.gradingBalance / 100);
    const centers = HSL_BANDS.map((b) => b.hue);
    gl.uniform1fv(u.uCenter, centers);
    gl.uniform1fv(u.uLeftW, centers.map((c, i) => ((c - centers[(i + 7) % 8] + 360) % 360) || 360));
    gl.uniform1fv(u.uRightW, centers.map((c, i) => ((centers[(i + 1) % 8] - c + 360) % 360) || 360));
    gl.uniform1fv(u.uHslHue, HSL_BANDS.map((b) => P[`hue_${b.key}`] / 100));
    gl.uniform1fv(u.uHslSat, HSL_BANDS.map((b) => P[`sat_${b.key}`] / 100));
    gl.uniform1fv(u.uHslLum, HSL_BANDS.map((b) => P[`lum_${b.key}`] / 100));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _drawLocal(m, baseTex, dst, cw, ch, overlay) {
    const gl = this.gl;
    const { u, p } = this.local;
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
    gl.viewport(0, 0, cw, ch);
    this._bindSources(u);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, baseTex);
    gl.uniform1i(u.uBase, 4);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex.get(m.id)?.tex ?? this.emptyTex);
    gl.uniform1i(u.uMaskTex, 5);
    this._basicUniforms(u, m.adj);
    const s = m.shape;
    gl.uniform1f(u.uShapeType, SHAPE_TYPE[s.type] ?? 0);
    gl.uniform4f(u.uLine, s.ax, s.ay, s.bx, s.by);
    gl.uniform4f(u.uEllipse, s.cx, s.cy, s.rx, s.ry);
    gl.uniform1f(u.uFeather, s.feather / 100);
    gl.uniform1f(u.uInvert, m.invert ? 1 : 0);
    gl.uniform3f(u.uColorRange, m.color.on ? 1 : 0, m.color.hue, m.color.width);
    gl.uniform4f(u.uLumRange, m.lum.on ? 1 : 0, m.lum.min / 100, m.lum.max / 100, m.lum.feather / 100);
    gl.uniform1f(u.uAmount, m.visible ? m.amount / 100 : 0);
    gl.uniform1f(u.uOverlay, overlay ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // masks：要套用的遮罩（已過濾）；overlayId：要顯示紅色疊加的遮罩
  render(params, { masks = [], original = false, width, height, overlayId = null } = {}) {
    if (!this.srcTex) return;
    const cw = width ?? this.canvas.width;
    const ch = height ?? this.canvas.height;
    if (this.canvas.width !== cw) this.canvas.width = cw;
    if (this.canvas.height !== ch) this.canvas.height = ch;
    const list = original ? [] : masks;
    if (!list.length) {
      this._drawMain(params, null, original, cw, ch);
      return;
    }
    const work = this._ensureWork(cw, ch);
    this._drawMain(params, work[0], false, cw, ch);
    let src = work[0];
    list.forEach((m, i) => {
      const last = i === list.length - 1;
      const dst = last ? null : work[(i + 1) % 2];
      this._drawLocal(m, src.tex, dst, cw, ch, m.id === overlayId);
      src = dst;
    });
  }

  // 以原始解析度輸出
  async exportBlob(params, masks, type = 'image/jpeg', quality = 0.95) {
    const prevW = this.canvas.width;
    const prevH = this.canvas.height;
    this.render(params, { masks, width: this.width, height: this.height });
    const blob = await new Promise((res) => this.canvas.toBlob(res, type, quality));
    this._freeWork();
    this.render(params, { masks, width: prevW, height: prevH });
    return blob;
  }
}
