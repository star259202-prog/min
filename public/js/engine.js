// WebGL 修圖引擎：所有運算都是逐像素的色彩／色調轉換與「同位置」的局部對比（模糊相減），
// 沒有任何像素位移、液化、變形或 AI 生成，所以臉部形狀不會被改變。

import { HSL_BANDS } from './params.js';

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// 9-tap 高斯模糊（單一方向）
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

const MAIN_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform sampler2D uBlurS;
uniform sampler2D uBlurM;
uniform sampler2D uBlurL;
uniform float uOriginal;
uniform float uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks;
uniform vec3 uWB;
uniform float uTexture, uClarity, uDehaze, uVibrance, uSaturation, uSharpen;
uniform float uVignette, uGrain, uAspect;
uniform vec2 uRes;
uniform vec3 uShadowTint, uHighlightTint;
uniform float uBalance;
uniform float uCenter[8];
uniform float uLeftW[8];
uniform float uRightW[8];
uniform float uHslHue[8];
uniform float uHslSat[8];
uniform float uHslLum[8];

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

// 依亮度變化調整顏色，同時避免暗部提亮時顏色過度飽和
vec3 applyLum(vec3 c, float L, float newL) {
  vec3 ratio = c * (newL / max(L, 1.0e-4));
  vec3 add = c + (newL - L);
  return mix(add, ratio, 0.5);
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec3 c = texture2D(uSrc, vUv).rgb;
  if (uOriginal > 0.5) { gl_FragColor = vec4(c, 1.0); return; }
  vec3 bS = texture2D(uBlurS, vUv).rgb;
  vec3 bM = texture2D(uBlurM, vUv).rgb;
  vec3 bL = texture2D(uBlurL, vUv).rgb;

  float fine = luma(c) - luma(bS);   // 細部（銳利化）
  float mid = luma(bS) - luma(bM);   // 中頻紋理（紋理）

  // 紋理：只對中頻細節做增減（負值可柔化皮膚紋理，但不改變五官形狀）
  c += vec3(mid * uTexture * 1.4);

  // 白平衡 + 曝光（在線性空間）
  vec3 lin = toLin(c) * uWB;
  vec3 linL = toLin(bL) * uWB;
  float ex = exp2(uExposure);
  lin *= ex; linL *= ex;
  // 柔和的亮部滾降，避免曝光增加時硬性過曝
  lin = lin / (1.0 + max(lin - 0.8, 0.0) * 0.6);
  c = toGam(lin);
  vec3 cL = toGam(linL);

  float L = luma(c);
  float Lb = luma(cL);
  float newL = L;
  float m = mix(L, Lb, 0.6);

  // 亮部 / 陰影
  float hMask = smoothstep(0.4, 1.0, m);
  float sMask = 1.0 - smoothstep(0.0, 0.55, m);
  newL += uHighlights * 0.45 * hMask * (uHighlights < 0.0 ? newL * 0.6 : (1.0 - newL));
  newL += uShadows * 0.5 * sMask * (uShadows > 0.0 ? (1.0 - newL) * 0.55 : newL);

  // 白色 / 黑色
  newL += uWhites * 0.22 * smoothstep(0.3, 1.0, newL);
  newL += uBlacks * 0.14 * (1.0 - smoothstep(0.0, 0.55, newL));
  newL = clamp(newL, 0.0, 1.2);

  // 對比（S 曲線，端點固定）
  float nl = clamp(newL, 0.0, 1.0);
  if (uContrast >= 0.0) nl = mix(nl, scurve(nl), uContrast);
  else nl = mix(nl, iscurve(nl), -uContrast);
  newL = nl + max(newL - 1.0, 0.0);

  // 清晰度：局部對比，只作用在中間調
  float midMask = 1.0 - pow(abs(newL * 2.0 - 1.0), 2.0);
  newL += uClarity * 0.8 * (L - Lb) * midMask;

  c = applyLum(c, L, max(newL, 0.0));

  // 去朦朧
  if (uDehaze > 0.0) {
    float w = smoothstep(0.15, 0.9, Lb);
    float k = uDehaze * 0.18 * w;
    c = (c - vec3(k)) / (1.0 - k);
    c = mix(vec3(luma(c)), c, 1.0 + uDehaze * 0.25);
  } else if (uDehaze < 0.0) {
    c = mix(c, vec3(0.78), -uDehaze * 0.35);
  }

  // HSL 分色調整
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
  // 保持原本亮度後再套用明度調整（避免改色相時亮度跳動）
  float Lh = luma(hc);
  float Lc = luma(clamp(c, 0.0, 1.0));
  hc *= Lc / max(Lh, 1.0e-4);
  hc *= 1.0 + lumShift * 0.45 * smoothstep(0.03, 0.3, chroma);
  c = mix(c, hc, step(1.0e-4, abs(hueShift) + abs(satMul) + abs(lumShift)));

  // 細節飽和度（保護膚色）與飽和度
  vec3 hsv2 = rgb2hsv(clamp(c, 0.0, 1.0));
  float hd = hsv2.x * 360.0;
  float skin = smoothstep(0.0, 15.0, hd) * (1.0 - smoothstep(40.0, 60.0, hd));
  float Lv = luma(c);
  float vib = uVibrance * (1.0 - hsv2.y) * (uVibrance > 0.0 ? (1.0 - 0.65 * skin) : 1.0);
  c = mix(vec3(Lv), c, 1.0 + vib);
  c = mix(vec3(luma(c)), c, 1.0 + uSaturation);

  // 色彩分級（分離色調）
  float Lg = clamp(luma(c), 0.0, 1.0);
  float pivot = 0.5 + uBalance * 0.3;
  float sw = 1.0 - smoothstep(0.0, pivot, Lg);
  float hw = smoothstep(pivot, 1.0, Lg);
  c += uShadowTint * sw + uHighlightTint * hw;

  // 銳利化（只加強原有邊緣）
  c += vec3(fine * uSharpen * 1.6);

  // 暗角
  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = length(q) / length(vec2(uAspect, 1.0) * 0.5);
  float v = smoothstep(0.35, 1.05, r);
  if (uVignette < 0.0) c *= 1.0 + uVignette * v * 0.85;
  else c = mix(c, vec3(1.0), uVignette * v * 0.7);

  // 顆粒
  if (uGrain > 0.0) {
    float n = hash(floor(vUv * uRes)) - 0.5;
    c += vec3(n * uGrain * 0.12 * (1.0 - abs(luma(c) * 2.0 - 1.0) * 0.5));
  }

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('Shader 編譯失敗：' + gl.getShaderInfoLog(s));
  }
  return s;
}

function program(gl, frag) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Shader 連結失敗：' + gl.getProgramInfoLog(p));
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u: uniforms };
}

function hueToRgb(h) {
  const k = (n) => (n + h / 30) % 12;
  const f = (n) => 0.5 - 0.5 * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

export function whiteBalanceGains(temp, tint) {
  const t = temp / 100;
  const m = tint / 100;
  let g = [1 + 0.22 * t + 0.06 * m, 1 + 0.03 * t - 0.16 * m, 1 - 0.3 * t + 0.06 * m];
  const l = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
  return g.map((x) => x / l);
}

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    const opts = { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false };
    const gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
    if (!gl) throw new Error('你的瀏覽器不支援 WebGL');
    this.gl = gl;
    this.maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192);
    this.main = program(gl, MAIN_FRAG);
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
  }

  _tex(w, h, data) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (data) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    return t;
  }

  _target(w, h) {
    const gl = this.gl;
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const tex = this._tex(w, h);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const t = { tex, fb, w, h };
    this.targets.push(t);
    return t;
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
      this._pass(this.blur, src, a, (u) => this.gl.uniform2f(u.uDir, spread / w, 0));
      this._pass(this.blur, a.tex, b, (u) => this.gl.uniform2f(u.uDir, 0, spread / h));
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

  loadImage(source) {
    const gl = this.gl;
    for (const t of this.targets) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fb);
    }
    this.targets = [];
    if (this.srcTex) gl.deleteTexture(this.srcTex);

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
    this.srcTex = this._tex(w, h, upload);

    // 所有模糊半徑都和影像尺寸成比例，因此預覽和輸出結果一致
    const longSide = Math.max(w, h);
    const sFactor = longSide > 3000 ? 2 : 1;
    this.blurS = this._gauss(this.srcTex, w / sFactor, h / sFactor, 1.0, 1);
    const m = this._downsample(this.srcTex, w, h, longSide > 1500 ? 4 : 2);
    this.blurM = this._gauss(m.tex, m.w, m.h, 1.2, 1);
    const lf = Math.pow(2, Math.max(1, Math.round(Math.log2(longSide / 320))));
    const l = this._downsample(this.srcTex, w, h, lf);
    this.blurL = this._gauss(l.tex, l.w, l.h, 1.6, 3);
  }

  render(params, { original = false, width, height } = {}) {
    if (!this.srcTex) return;
    const gl = this.gl;
    const cw = width ?? this.canvas.width;
    const ch = height ?? this.canvas.height;
    if (this.canvas.width !== cw) this.canvas.width = cw;
    if (this.canvas.height !== ch) this.canvas.height = ch;
    const P = params;
    const { u, p } = this.main;
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    const texs = [this.srcTex, this.blurS.tex, this.blurM.tex, this.blurL.tex];
    ['uSrc', 'uBlurS', 'uBlurM', 'uBlurL'].forEach((name, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, texs[i]);
      gl.uniform1i(u[name], i);
    });
    gl.uniform1f(u.uOriginal, original ? 1 : 0);
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
    gl.uniform1f(u.uVibrance, P.vibrance / 100);
    gl.uniform1f(u.uSaturation, P.saturation / 100);
    gl.uniform1f(u.uSharpen, P.sharpen / 100);
    gl.uniform1f(u.uVignette, P.vignette / 100);
    gl.uniform1f(u.uGrain, P.grain / 100);
    gl.uniform1f(u.uAspect, this.width / this.height);
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
    const left = centers.map((c, i) => ((c - centers[(i + 7) % 8] + 360) % 360) || 360);
    const right = centers.map((c, i) => ((centers[(i + 1) % 8] - c + 360) % 360) || 360);
    gl.uniform1fv(u.uCenter, centers);
    gl.uniform1fv(u.uLeftW, left);
    gl.uniform1fv(u.uRightW, right);
    gl.uniform1fv(u.uHslHue, HSL_BANDS.map((b) => P[`hue_${b.key}`] / 100));
    gl.uniform1fv(u.uHslSat, HSL_BANDS.map((b) => P[`sat_${b.key}`] / 100));
    gl.uniform1fv(u.uHslLum, HSL_BANDS.map((b) => P[`lum_${b.key}`] / 100));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // 以原始解析度輸出
  async exportBlob(params, type = 'image/jpeg', quality = 0.95) {
    const prevW = this.canvas.width;
    const prevH = this.canvas.height;
    this.render(params, { width: this.width, height: this.height });
    const blob = await new Promise((res) => this.canvas.toBlob(res, type, quality));
    this.render(params, { width: prevW, height: prevH });
    return blob;
  }
}
