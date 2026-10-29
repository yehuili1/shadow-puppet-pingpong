// E 戏台渲染：做旧羊皮纸 + 水墨远山 + 幕后暖光 + 巨大手影 + 明式木桌/球网 + 皮影 + 球与毛笔拖尾 + 墨点粒子
// 世界 1600×1000 按 contain 等比缩放居中；背景铺满整个戏台视口。静态内容（背景、桌子）在 resize 时预渲染。
import { WORLD, TABLE, BALL_R, STRING_TOP_Y } from '../core/world.js';
import { events } from '../core/events.js';
import { clamp, damp } from '../core/math.js';

const CAM_ASPECT = 640 / 480;                         // 手部归一化坐标的 x:y 像素比（HandState.aspect 缺省时按 640×480）
const LIGHT = { u: 0.48, v: 0.47, rx: 0.5, ry: 0.38, halo: 0.8 }; // 幕后灯：戏台视口归一化位置，椭圆半径按视口高
const HAND = { height: 0.46, alpha: 0.5, rgb: [62, 66, 92], res: 0.25 }; // 手影：腕→中指尖占戏台高；偏冷灰（压低暖纸饱和度）
const SHADE = { dx: 10, dy: 8, alpha: 0.2, rgb: '42,32,24' };  // 皮影柔和投影：世界偏移、透明度
const TABLE_ALPHA = 0.82;
const MAX_PARTICLES = 240;
const INK = '30,20,12';

// ---------- 噪声（可复现） ----------
function hash(x, y, seed) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let u = x - xi, v = y - yi;
  u = u * u * (3 - 2 * u);
  v = v * v * (3 - 2 * v);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct, seed) {
  let s = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * vnoise(x, y, seed + i * 17);
    norm += amp;
    x *= 2.03; y *= 2.03; amp *= 0.5;
  }
  return s / norm;
}
const noise1 = (x, seed) => vnoise(x, 0.5, seed) * 2 - 1;
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// ---------- 羊皮纸 ----------
// 色调 tone 0..1 → 颜色（参考帧取色：角落 #764014 / 边中 #bc8650 / 中圈 #edc07f）
const RAMP = [
  [0.0, 60, 26, 4], [0.2, 98, 46, 8], [0.33, 130, 70, 22], [0.5, 194, 130, 62],
  [0.62, 218, 160, 90], [0.72, 232, 184, 114], [0.8, 240, 200, 134], [0.88, 246, 216, 158], [1.0, 252, 238, 196],
];
function ramp(t, out) {
  t = clamp(t, 0, 1);
  let i = 1;
  while (i < RAMP.length - 1 && RAMP[i][0] < t) i++;
  const a = RAMP[i - 1], b = RAMP[i], k = (t - a[0]) / (b[0] - a[0]);
  out[0] = a[1] + (b[1] - a[1]) * k;
  out[1] = a[2] + (b[2] - a[2]) * k;
  out[2] = a[3] + (b[3] - a[3]) * k;
}

// 低分辨率逐像素：椭圆暗角（按参考帧剖面拟合）+ 烧灼窄边 + 大块斑驳 + 水渍。坐标按视口归一化
function paintPaper(lw, lh, aspect) {
  const c = makeCanvas(lw, lh), g = c.getContext('2d');
  const img = g.createImageData(c.width, c.height), d = img.data;
  const col = [0, 0, 0];
  let k = 0;
  for (let j = 0; j < c.height; j++) {
    const v = (j + 0.5) / c.height, Y = v;
    for (let i = 0; i < c.width; i++, k += 4) {
      const u = (i + 0.5) / c.width, X = u * aspect;
      const burn = fbm(X * 4, Y * 4, 3, 11);
      const ex = (u - 0.5) * 2, ey = (v - 0.5) * 2;
      const r = Math.hypot(ex, ey * 1.06) * (1 + 0.04 * Math.max(0, ey) + 0.02 * Math.max(0, ex));   // 右下略旧
      const dv = Math.max(0, r - 0.72 + (burn - 0.5) * 0.14);
      let tone = 0.86 - (dv < 0.45 ? 1.15 * Math.pow(dv, 1.1) : 0.477 + 0.6 * (dv - 0.45));
      const edge = Math.min(u * aspect, (1 - u) * aspect, v, 1 - v);                        // 到边距离（视口高为单位）
      tone -= 0.1 * Math.exp(-edge / (0.01 + 0.025 * burn));
      const big = fbm(X * 1.8, Y * 1.8, 4, 1);
      const mid = fbm(X * 7, Y * 7, 3, 5);
      const fine = fbm(X * 30, Y * 30, 2, 9);
      const grit = fbm(X * 16, Y * 16, 3, 13);
      tone += (big - 0.5) * 0.2 + (mid - 0.5) * 0.12 + (fine - 0.5) * 0.07 - smooth(0.6, 0.78, grit) * 0.07;
      const st = fbm(X * 3.2 + 4, Y * 3.2 - 2, 3, 21);                                      // 水渍：软边深圈 + 圈内略暗
      tone -= Math.exp(-(((st - 0.62) / 0.03) ** 2)) * 0.03 + smooth(0.56, 0.66, st) * 0.03;
      ramp(tone, col);
      const hue = fbm(X * 2.4 + 9, Y * 2.4, 2, 31) - 0.5;                                   // 偏黄 ↔ 偏灰褐
      d[k] = col[0] * (1 + hue * 0.05);
      d[k + 1] = col[1] * (1 + hue * 0.02);
      d[k + 2] = col[2] * (1 - hue * 0.14);
      d[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// 细纤维 + 颗粒（overlay 叠加，128 灰为中性；横竖短丝像粗纸/麻布纹）
function grainTile(size, rnd) {
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 128 + (rnd() - 0.5) * 22;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.lineCap = 'round';
  for (let i = 0; i < 1400; i++) {
    const x = rnd() * size, y = rnd() * size, len = 2 + rnd() * 8, dark = rnd() < 0.55;
    const a = (rnd() < 0.65 ? 0 : Math.PI / 2) + (rnd() - 0.5) * 0.4;
    g.strokeStyle = dark ? `rgba(60,60,60,${0.1 + rnd() * 0.22})` : `rgba(210,210,210,${0.1 + rnd() * 0.2})`;
    g.lineWidth = 0.6 + rnd() * 0.9;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    g.stroke();
  }
  // 小污点
  for (let i = 0; i < 160; i++) {
    g.fillStyle = `rgba(50,50,50,${0.08 + rnd() * 0.2})`;
    g.beginPath();
    g.arc(rnd() * size, rnd() * size, 0.6 + rnd() * 2, 0, Math.PI * 2);
    g.fill();
  }
  // 少量弯曲长纤维
  for (let i = 0; i < 60; i++) {
    const x = rnd() * size, y = rnd() * size, a = rnd() * Math.PI, len = 10 + rnd() * 30;
    g.strokeStyle = `rgba(80,80,80,${0.1 + rnd() * 0.15})`;
    g.lineWidth = 0.6;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(a + 0.5) * len * 0.5, y + Math.sin(a + 0.5) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len);
    g.stroke();
  }
  return c;
}

// 水墨远山：每层若干山峰（尖圆顶、陡腰、凹脚）+ 肩峰 + 嶙峋山脊；墨色自上而下渐隐入雾，坡面竖向皴笔
// dx = 距戏台左/右边缘的世界距离，top = 峰顶世界 y，hw = 半宽
const MOUNTAINS = [
  { side: 'L', base: 470, alpha: 0.2, blur: 3.5, cun: 0, peaks: [[40, 190, 170], [330, 215, 150], [560, 300, 160]] },
  { side: 'L', base: 450, alpha: 0.56, blur: 1.2, cun: 10, peaks: [[120, 95, 190], [340, 175, 140], [480, 245, 110]] },
  { side: 'R', base: 450, alpha: 0.14, blur: 3.5, cun: 0, peaks: [[60, 230, 150], [300, 270, 170]] },
  { side: 'R', base: 430, alpha: 0.38, blur: 1.5, cun: 6, peaks: [[160, 262, 120], [330, 300, 100]] },
  { side: 'L', base: 860, alpha: 0.1, blur: 5, cun: 0, peaks: [[60, 650, 260], [380, 700, 240]] },
  { side: 'R', base: 870, alpha: 0.08, blur: 5, cun: 0, peaks: [[120, 675, 280]] },
];
const INK_MTN = '138,88,34';
const peakShape = (t) => Math.pow(1 - t, 1.15) * (1 + 0.8 * t);   // 尖圆顶、外凸陡坡

// 竖向皴擦纹理（destination-out 用的 alpha 图）：x 高频、y 低频 → 竖条斑驳
function streakTile(w, h) {
  const c = makeCanvas(w, h), g = c.getContext('2d');
  const img = g.createImageData(w, h), d = img.data;
  for (let j = 0, k = 0; j < h; j++) {
    for (let i = 0; i < w; i++, k += 4) {
      const n = fbm((i / w) * 70, (j / h) * 6, 3, 41), m = fbm((i / w) * 14, (j / h) * 10, 2, 43);
      d[k + 3] = 255 * clamp(smooth(0.45, 0.72, n) * 0.28 + smooth(0.5, 0.75, m) * 0.3, 0, 0.5);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// 远山先画进两张独立图层（近：细模糊；远山+皴笔：粗模糊），墨色 alpha 累积，擦出竖向皴纹后整层模糊 multiply 到纸上
// （按层整体模糊，避免逐笔 filter 拖慢 resize）
function paintMountains(g, view, px, rnd, bw, bh) {
  const layers = [1.3, 3.2].map((blur) => {
    const c = makeCanvas(bw, bh), cg = c.getContext('2d');
    cg.setTransform(g.getTransform());
    cg.lineCap = 'round';
    return { c, g: cg, blur };
  });
  const [near, soft] = layers;
  const mists = new Path2D();
  MOUNTAINS.forEach((m, li) => {
    const mg = m.blur < 2 ? near.g : soft.g;
    const dir = m.side === 'L' ? 1 : -1, edge = m.side === 'L' ? view.L : view.R;
    const peaks = [];
    for (const [dx, top, hw] of m.peaks) {
      const x = edge + dir * dx;
      peaks.push({ x, top, hl: hw * (0.75 + rnd() * 0.5), hr: hw * (0.75 + rnd() * 0.5), main: true });
      // 肩峰：主峰一侧较矮的小峰
      if (rnd() < 0.6) {
        const sd = rnd() < 0.5 ? -1 : 1, k = 0.45 + rnd() * 0.25;
        peaks.push({ x: x + sd * hw * (0.5 + rnd() * 0.3), top: m.base - (m.base - top) * k, hl: hw * 0.5, hr: hw * 0.5 });
      }
    }
    const x0 = Math.min(...peaks.map((p) => p.x - p.hl)) - 30, x1 = Math.max(...peaks.map((p) => p.x + p.hr)) + 30;
    const top = Math.min(...peaks.map((p) => p.top)), fade = m.base + 60;
    const H = (x) => {
      let h = 0;
      for (const p of peaks) {
        const t = x < p.x ? (p.x - x) / p.hl : (x - p.x) / p.hr;
        if (t < 1) h = Math.max(h, (m.base - p.top) * peakShape(t));
      }
      return h * (1 + noise1(x * 0.03, li * 7 + 1) * 0.15 + noise1(x * 0.11, li * 7 + 2) * 0.07 + noise1(x * 0.4, li * 7 + 3) * 0.025);
    };
    const ridge = [];
    for (let x = x0; x <= x1; x += 2) ridge.push([x, m.base - H(x)]);
    const body = new Path2D();
    body.moveTo(x0, fade);
    for (const [x, y] of ridge) body.lineTo(x, y);
    body.lineTo(x1, fade);
    body.closePath();
    const grad = mg.createLinearGradient(0, top, 0, fade);
    grad.addColorStop(0, `rgba(${INK_MTN},${m.alpha})`);
    grad.addColorStop(0.5, `rgba(${INK_MTN},${m.alpha * 0.6})`);
    grad.addColorStop(1, `rgba(${INK_MTN},0)`);
    mg.fillStyle = grad;
    mg.fill(body);
    // 山脊积墨：沿山脊的软粗线
    mg.strokeStyle = grad;
    mg.lineWidth = 9;
    mg.globalAlpha = 0.4;
    mg.beginPath();
    let pen = false;
    for (const [x, y] of ridge) {
      if (y < m.base - 30) { pen ? mg.lineTo(x, y) : mg.moveTo(x, y); pen = true; } else pen = false;
    }
    mg.stroke();
    // 皴笔：峰顶附近沿坡向下的宽软墨痕（画在粗模糊层）
    const cg = soft.g;
    cg.strokeStyle = `rgb(${INK_MTN})`;
    for (const p of peaks) {
      const n = p.main ? m.cun : m.cun >> 1;
      for (let i = 0; i < n; i++) {
        const side = rnd() < 0.5 ? -1 : 1, t = 0.04 + rnd() * 0.5;
        const sx = p.x + side * t * (side < 0 ? p.hl : p.hr);
        const sy = m.base - H(sx) + 4;
        const len = (m.base - p.top) * (0.1 + rnd() * 0.3);
        cg.globalAlpha = m.alpha * (0.2 + rnd() * 0.35);
        cg.lineWidth = 5 + rnd() * 10;
        cg.beginPath();
        cg.moveTo(sx, sy);
        cg.quadraticCurveTo(sx + side * len * 0.1, sy + len * 0.5, sx + side * len * (0.05 + rnd() * 0.2), sy + len);
        cg.stroke();
      }
    }
    mg.globalAlpha = cg.globalAlpha = 1;
    for (let i = 0; i < 6; i++) {
      const x = x0 + rnd() * (x1 - x0), y = m.base - 20 - rnd() * (m.base - top) * 0.35, rx = 50 + rnd() * 90;
      mists.moveTo(x + rx, y);
      mists.ellipse(x, y, rx, 12 + rnd() * 20, 0, 0, Math.PI * 2);
    }
  });
  // 擦出竖向皴纹，再整层模糊 multiply 到纸上
  const streak = streakTile(384, 160);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  for (const L of layers) {
    L.g.setTransform(1, 0, 0, 1, 0, 0);
    L.g.globalCompositeOperation = 'destination-out';
    L.g.drawImage(streak, 0, 0, bw, bh);
    g.globalCompositeOperation = 'multiply';
    g.filter = `blur(${(L.blur * px).toFixed(2)}px)`;
    g.drawImage(L.c, 0, 0);
  }
  g.restore();

  g.save();
  g.globalCompositeOperation = 'screen';
  // 山脚雾：亮斑把山脚打散（一条路径一次模糊）
  g.filter = `blur(${(14 * px).toFixed(2)}px)`;
  g.fillStyle = 'rgba(255,240,210,0.1)';
  g.fill(mists);
  g.filter = 'none';
  // 云雾带：山腰、山脚横向的亮雾
  for (const [side, dx, y, rx, a] of [['L', 260, 455, 460, 0.13], ['R', 220, 435, 360, 0.1], ['L', 200, 860, 420, 0.08]]) {
    const x = side === 'L' ? view.L + dx : view.R - dx;
    g.save();
    g.translate(x, y);
    g.scale(1, 0.22);
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, rx);
    rg.addColorStop(0, `rgba(255,244,222,${a})`);
    rg.addColorStop(1, 'rgba(255,244,222,0)');
    g.fillStyle = rg;
    g.fillRect(-rx, -rx, rx * 2, rx * 2);
    g.restore();
  }
  g.restore();
}

// 幕后暖光（screen）：近白核心 → 淡黄 → 融进纸色（按参考帧亮度剖面拟合：核心半径 ≈ 0.2H）+ 外圈宽淡暖晕
function paintGlow(g, bw, bh) {
  const R = LIGHT.rx * bh;
  g.save();
  g.globalCompositeOperation = 'screen';
  g.translate(bw * LIGHT.u, bh * LIGHT.v);
  g.scale(1, LIGHT.ry / LIGHT.rx);
  const rg = g.createRadialGradient(0, 0, 0, 0, 0, R);
  const stops = [[0, '255,255,250', 1], [0.35, '255,255,240', 0.97], [0.5, '255,251,210', 0.86], [0.65, '255,240,170', 0.56],
    [0.8, '255,228,140', 0.26], [0.92, '255,220,130', 0.08], [1, '255,218,130', 0]];
  for (const [o, c, a] of stops) rg.addColorStop(o, `rgba(${c},${a})`);
  g.fillStyle = rg;
  g.fillRect(-R, -R, R * 2, R * 2);
  // 外圈宽而淡的暖晕，让光斑边缘自然融进纸色
  const R2 = LIGHT.halo * bh;
  g.setTransform(1, 0, 0, 0.85, bw * LIGHT.u, bh * LIGHT.v);
  const hg = g.createRadialGradient(0, 0, 0, 0, 0, R2);
  hg.addColorStop(0, 'rgba(255,236,170,0.3)');
  hg.addColorStop(0.5, 'rgba(255,232,160,0.16)');
  hg.addColorStop(1, 'rgba(255,228,150,0)');
  g.fillStyle = hg;
  g.fillRect(-R2, -R2, R2 * 2, R2 * 2);
  g.restore();
}

// 折痕 + 霉斑
function paintWear(g, view, px, rnd) {
  g.save();
  g.lineCap = 'round';
  const creases = [
    [[view.L, 585], [view.R, 545]],
    [[470, view.T], [430, view.B]],
  ];
  for (const [[ax, ay], [bx, by]] of creases) {
    const segs = 24;
    for (const [off, style, op] of [[0, 'rgba(70,40,15,0.05)', 'multiply'], [3, 'rgba(255,240,215,0.05)', 'screen']]) {
      g.globalCompositeOperation = op;
      g.filter = `blur(${(2.5 * px).toFixed(2)}px)`;
      g.strokeStyle = style;
      g.lineWidth = 2.2;
      g.beginPath();
      for (let i = 0; i <= segs; i++) {
        const t = i / segs, w = noise1(t * 5, 77 + Math.round(ax)) * 14;
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        const nx = -(by - ay), ny = bx - ax, nl = Math.hypot(nx, ny);
        const qx = x + (nx / nl) * (w + off), qy = y + (ny / nl) * (w + off);
        i ? g.lineTo(qx, qy) : g.moveTo(qx, qy);
      }
      g.stroke();
    }
  }
  // 霉斑：只在边缘一圈，按深浅分三组各一次模糊
  g.globalCompositeOperation = 'multiply';
  g.filter = `blur(${(1.5 * px).toFixed(2)}px)`;
  for (const a of [0.1, 0.17, 0.25]) {
    g.fillStyle = `rgba(110,60,20,${a})`;
    g.beginPath();
    for (let i = 0; i < 14; i++) {
      const near = rnd() ** 3 * 0.4, along = rnd(), side = Math.floor(rnd() * 4);
      const fx = side === 0 ? near : side === 1 ? 1 - near : along, fy = side === 2 ? near : side === 3 ? 1 - near : along;
      const x = view.L + (view.R - view.L) * fx, y = view.T + (view.B - view.T) * fy, r = 1 + rnd() * 3;
      g.moveTo(x + r, y);
      g.arc(x, y, r, 0, Math.PI * 2);
    }
    g.fill();
  }
  g.restore();
}

// ---------- 桌子 + 球网（世界坐标，不透明绘制，整体 alpha 在 blit 时乘） ----------
const TABLE_BOX = { x: TABLE.x0 - 14, y: TABLE.netTopY - 8, w: TABLE.x1 - TABLE.x0 + 28, h: WORLD.floorY - TABLE.netTopY + 14 };

function paintTable(g) {
  const { x0, x1, topY: y0, thickness: th, netX, netTopY } = TABLE;
  const F = WORLD.floorY, inset = 36, legW = 13, apronH = 14;
  const lxL = x0 + inset, lxR = x1 - inset - legW;
  const wood = '#724c27', woodBack = '#9a6f40', edge = '#2e1b0b';
  g.lineJoin = 'round';
  g.lineCap = 'round';

  // 腿：dir=+1 左腿（马蹄足向右内收），-1 右腿
  const leg = (x, dir, top) => {
    const outer = dir > 0 ? x : x + legW, inner = dir > 0 ? x + legW : x;
    const p = new Path2D();
    p.moveTo(outer, top);
    p.lineTo(outer + dir * 1.5, F - 4);
    p.quadraticCurveTo(outer + dir * 2, F, outer + dir * 6, F);
    p.lineTo(inner + dir * 7, F);
    p.quadraticCurveTo(inner + dir * 8, F - 6, inner + dir * 1, F - 24);
    p.lineTo(inner, top);
    p.closePath();
    return p;
  };
  // 后腿（更远、更淡）
  g.fillStyle = woodBack;
  g.strokeStyle = 'rgba(36,21,10,0.6)';
  g.lineWidth = 1.2;
  for (const p of [leg(lxL + 20, 1, y0 + th), leg(lxR - 20, -1, y0 + th)]) { g.fill(p); g.stroke(p); }
  g.fillStyle = woodBack;
  g.fillRect(lxL + 20 + legW, F - 66, lxR - lxL - 40 - legW, 5);

  g.fillStyle = wood;
  g.strokeStyle = edge;
  g.lineWidth = 1.6;
  // 横枨
  const str = new Path2D();
  str.rect(lxL + legW - 1, F - 58, lxR - lxL - legW + 2, 7);
  g.fill(str); g.stroke(str);
  // 前腿
  for (const p of [leg(lxL, 1, y0 + th - 2), leg(lxR, -1, y0 + th - 2)]) { g.fill(p); g.stroke(p); }
  // 牙板（中段壶门下垂）+ 牙头
  const ay = y0 + th, ab = ay + apronH, ax0 = lxL + legW, ax1 = lxR;
  const apron = new Path2D();
  apron.moveTo(ax0, ay);
  apron.lineTo(ax1, ay);
  apron.lineTo(ax1, ab + 22);
  apron.quadraticCurveTo(ax1 - 4, ab + 2, ax1 - 34, ab);
  apron.lineTo(netX + 74, ab);
  apron.bezierCurveTo(netX + 50, ab, netX + 40, ab + 13, netX, ab + 13);
  apron.bezierCurveTo(netX - 40, ab + 13, netX - 50, ab, netX - 74, ab);
  apron.lineTo(ax0 + 34, ab);
  apron.quadraticCurveTo(ax0 + 4, ab + 2, ax0, ab + 22);
  apron.closePath();
  g.fill(apron); g.stroke(apron);
  // 面板（两端微翘）
  const top = new Path2D();
  top.moveTo(x0 - 6, y0 - 5);
  top.quadraticCurveTo(x0 + 4, y0, x0 + 22, y0);
  top.lineTo(x1 - 22, y0);
  top.quadraticCurveTo(x1 - 4, y0, x1 + 6, y0 - 5);
  top.quadraticCurveTo(x1 + 5, y0 + 3, x1 - 2, y0 + th);
  top.lineTo(x0 + 2, y0 + th);
  top.quadraticCurveTo(x0 - 5, y0 + 3, x0 - 6, y0 - 5);
  top.closePath();
  g.fill(top); g.stroke(top);

  // 木纹高光 / 线脚
  g.strokeStyle = 'rgba(210,165,105,0.55)';
  g.lineWidth = 1.1;
  g.beginPath();
  g.moveTo(x0 + 16, y0 + 3.5); g.lineTo(x1 - 16, y0 + 3.5);
  g.moveTo(ax0 + 6, ay + 4); g.lineTo(ax1 - 6, ay + 4);
  for (const x of [lxL + 4, lxR + legW - 4]) { g.moveTo(x, ay + 6); g.lineTo(x, F - 30); }
  g.moveTo(lxL + legW + 4, F - 55); g.lineTo(lxR - 4, F - 55);
  g.stroke();
  g.strokeStyle = 'rgba(30,16,6,0.8)';
  g.beginPath();
  g.moveTo(x0 + 6, y0 + th - 4.5); g.lineTo(x1 - 6, y0 + th - 4.5);
  g.stroke();

  // 镂空：牙板云纹孔、牙头圆孔
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = '#000';
  for (const x of [netX - 24, netX + 24]) {
    g.beginPath();
    g.ellipse(x, ay + apronH * 0.55, 7, 1.6, 0, 0, Math.PI * 2);
    g.fill();
  }
  for (const x of [ax0 + 9, ax1 - 9]) {
    g.beginPath();
    g.arc(x, ab + 7, 2.6, 0, Math.PI * 2);
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';

  // 球网：细竖脊 + 小横刺（鱼骨）
  g.strokeStyle = '#1f140b';
  g.lineWidth = 2.4;
  g.beginPath();
  g.moveTo(netX, netTopY - 2); g.lineTo(netX, y0);
  g.stroke();
  g.lineWidth = 1.2;
  g.beginPath();
  for (let y = netTopY + 2; y < y0 - 2; y += 4.4) {
    const hw = 5.2 - ((y - netTopY) / (y0 - netTopY)) * 1.2;
    g.moveTo(netX - hw, y + 0.6); g.lineTo(netX + hw, y - 0.6);
  }
  g.stroke();
  g.fillStyle = '#1f140b';
  g.beginPath();
  g.arc(netX, netTopY - 2, 2.4, 0, Math.PI * 2);
  g.fill();
}

// ---------- 手影 ----------
const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const FINGER_W = [0.3, 0.22, 0.23, 0.22, 0.19];   // 相对掌长（腕→中指根）

export class StageRenderer {
  constructor() {
    this.rect = { x: 0, y: 0, w: 1, h: 1 };
    this.dpr = 1;
    this.s = 1; this.ox = 0; this.oy = 0;
    this.bg = null;
    this.table = null;
    this.particles = [];
    this.pending = [];
    this.shake = 0;
    this.hand = { vis: 0, lm: null, cx: 0, cy: 0, k: 0, init: false };
    this.lastBgMs = 0;
    events.on((e) => this._onEvent(e));
  }

  resize(rect, dpr = 1) {
    const r = { x: rect.x, y: rect.y, w: Math.max(1, rect.w), h: Math.max(1, rect.h) };
    if (this.bg && r.x === this.rect.x && r.y === this.rect.y && r.w === this.rect.w && r.h === this.rect.h && dpr === this.dpr) return;
    this.rect = r;
    this.dpr = dpr;
    this.s = Math.min(r.w / WORLD.W, r.h / WORLD.H);
    this.ox = r.x + (r.w - WORLD.W * this.s) / 2;
    this.oy = r.y + (r.h - WORLD.H * this.s) / 2;
    const t0 = performance.now();
    this._buildBackground();
    this._buildTable();
    this._buildHandCanvases();
    this.lastBgMs = performance.now() - t0;
  }

  // 戏台视口边缘对应的世界坐标
  _view() {
    const { x, y, w, h } = this.rect, s = this.s;
    return { L: (x - this.ox) / s, T: (y - this.oy) / s, R: (x + w - this.ox) / s, B: (y + h - this.oy) / s };
  }

  _buildBackground() {
    const { w, h } = this.rect, dpr = this.dpr, s = this.s;
    const view = this._view();
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    const c = makeCanvas(bw, bh), g = c.getContext('2d');
    const rnd = mulberry32(20240617);
    // 1) 纸底（低分辨率逐像素，平滑放大）
    const k = Math.min(1, 300 / h);
    const paper = paintPaper(w * k, h * k, w / h);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(paper, 0, 0, bw, bh);
    // 2) 远山 + 暖光 + 折痕霉斑（世界坐标）
    const px = s * dpr;   // 1 世界单位 = px 设备像素
    g.setTransform(px, 0, 0, px, (this.ox - this.rect.x) * dpr, (this.oy - this.rect.y) * dpr);
    paintMountains(g, view, px, rnd, bw, bh);
    paintWear(g, view, px, rnd);
    g.setTransform(1, 0, 0, 1, 0, 0);
    paintGlow(g, bw, bh);
    // 3) 纤维颗粒（设备像素）
    const gk = Math.max(1, bh / 700);
    g.setTransform(gk, 0, 0, gk, 0, 0);
    g.globalCompositeOperation = 'overlay';
    g.globalAlpha = 0.6;
    g.fillStyle = g.createPattern(grainTile(384, rnd), 'repeat');
    g.fillRect(0, 0, bw / gk, bh / gk);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    this.bg = c;
  }

  _buildTable() {
    const px = this.s * this.dpr, b = TABLE_BOX;
    const c = makeCanvas(b.w * px, b.h * px), g = c.getContext('2d');
    g.setTransform(c.width / b.w, 0, 0, c.height / b.h, -b.x * (c.width / b.w), -b.y * (c.height / b.h));
    paintTable(g);
    this.table = c;
  }

  _buildHandCanvases() {
    const { w, h } = this.rect;
    const sh = clamp(Math.round(h * this.dpr * HAND.res), 120, 320), sw = Math.round((sh * w) / h);
    this.handA = makeCanvas(sw, sh);
    this.handB = makeCanvas(sw, sh);
    this.shadeA = makeCanvas(sw, sh);
    this.shadeB = makeCanvas(sw, sh);
  }

  _onEvent(e) {
    const text = e.text || '';
    if (this.pending.length > 8) return;
    if (text.includes('table contact')) this.pending.push('table');
    else if (text.includes('sword hit')) this.pending.push('sword');
  }

  draw(ctx, { t = 0, dt = 1 / 60, director, playerRig, cpuRig, hand } = {}) {
    if (!this.bg) return;
    const r = this.rect, s = this.s;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.drawImage(this.bg, r.x, r.y, r.w, r.h);
    this._drawHandShadow(ctx, hand, dt);

    // 事件 → 粒子（事件在 director.update 里同步触发，此时球/剑位置正好是本帧）
    for (const kind of this.pending) this._spawn(kind, director, playerRig, cpuRig);
    this.pending.length = 0;
    this._updateParticles(dt);
    this.shake *= Math.exp(-dt * 10);
    const sx = this.shake > 0.3 ? (Math.random() - 0.5) * 2 * this.shake * s : 0;
    const sy = this.shake > 0.3 ? (Math.random() - 0.5) * 2 * this.shake * s : 0;
    if (playerRig || cpuRig) this._drawPuppetShade(ctx, [cpuRig, playerRig], sx, sy);

    ctx.save();
    ctx.translate(this.ox + sx, this.oy + sy);
    ctx.scale(s, s);
    ctx.imageSmoothingQuality = 'high';   // 皮影贴图是 2 倍分辨率、戏台上缩小 4 倍以上：高质量缩小，纹样不闪
    const ta = director?.tableAlpha ?? 1;
    if (ta > 0.003) {
      ctx.globalAlpha = TABLE_ALPHA * ta;
      ctx.drawImage(this.table, TABLE_BOX.x, TABLE_BOX.y, TABLE_BOX.w, TABLE_BOX.h);
      ctx.globalAlpha = 1;
    }
    const stringTopY = Math.min(STRING_TOP_Y, (r.y - this.oy) / s - 8);
    cpuRig?.draw(ctx, { strings: true, stringTopY });
    playerRig?.draw(ctx, { strings: true, stringTopY });
    const ball = director?.ball;
    if (ball && ball.visible) this._drawBall(ctx, ball);
    this._drawParticles(ctx);
    ctx.restore();

    // 灯光闪烁：平滑噪声调制整体亮度（约 ±2.5%）
    const f = 0.5 * Math.sin(t * 2.3) + 0.3 * Math.sin(t * 5.7 + 1.3) + 0.2 * Math.sin(t * 13.1 + 0.4);
    const dim = 0.012 - f * 0.02;
    if (dim > 0.002) {
      ctx.fillStyle = `rgba(40,22,6,${dim.toFixed(4)})`;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    ctx.restore();
  }

  // 皮影柔和投影：低分辨率画一遍剪影 → 统一着色 → 模糊 → 偏移 multiply（像离幕稍远的部分投下的虚影）
  _drawPuppetShade(ctx, rigs, sx, sy) {
    const r = this.rect, A = this.shadeA, B = this.shadeB, a = A.getContext('2d'), b = B.getContext('2d');
    const k = A.width / r.w, s = this.s;
    a.setTransform(1, 0, 0, 1, 0, 0);
    a.globalCompositeOperation = 'source-over';
    a.clearRect(0, 0, A.width, A.height);
    a.setTransform(k * s, 0, 0, k * s, k * (this.ox - r.x + SHADE.dx * s), k * (this.oy - r.y + SHADE.dy * s));
    for (const rig of rigs) rig?.draw(a, { strings: false });
    a.setTransform(1, 0, 0, 1, 0, 0);
    a.globalCompositeOperation = 'source-in';
    a.fillStyle = `rgb(${SHADE.rgb})`;
    a.fillRect(0, 0, A.width, A.height);
    b.clearRect(0, 0, B.width, B.height);
    b.filter = `blur(${Math.max(1, A.height * 0.012).toFixed(2)}px)`;
    b.drawImage(A, 0, 0);
    b.filter = 'none';
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = SHADE.alpha;
    ctx.drawImage(B, r.x + sx, r.y + sy, r.w, r.h);
    ctx.restore();
  }

  // ---------- 手影 ----------
  _drawHandShadow(ctx, hand, dt) {
    const H = this.hand, r = this.rect;
    const lm = hand && hand.tracked && hand.landmarks && hand.landmarks.length >= 21 ? hand.landmarks : null;
    H.vis = damp(H.vis, lm ? 1 : 0, lm ? 4 : 2.5, dt);
    if (lm) {
      // 掌心（0,5,9,13,17 均值）与掌长（宽度按摄像头比例校正）
      let px = 0, py = 0;
      for (const i of [0, 5, 9, 13, 17]) { px += lm[i].x / 5; py += lm[i].y / 5; }
      H.asp = hand.aspect || CAM_ASPECT;
      const size = Math.max(0.05, Math.hypot((lm[9].x - lm[0].x) * H.asp, lm[9].y - lm[0].y));
      const k = (r.h * HAND.height) / (size * 2.05);
      const cx = r.x + r.w * clamp(1.25 * px - 0.12, -0.1, 1.1), cy = r.y + r.h * clamp(py - 0.27, -0.2, 0.9);
      if (!H.init) { H.cx = cx; H.cy = cy; H.k = k; H.init = true; }
      H.cx = damp(H.cx, cx, 8, dt); H.cy = damp(H.cy, cy, 8, dt); H.k = damp(H.k, k, 5, dt);
      H.px = px; H.py = py;
      H.lm = lm.map((p) => ({ x: p.x, y: p.y }));
    }
    if (H.vis < 0.01 || !H.lm) return;

    const A = this.handA, B = this.handB, a = A.getContext('2d'), b = B.getContext('2d');
    const sk = A.width / r.w;
    const pts = H.lm.map((p) => ({ x: (H.cx - r.x + (p.x - H.px) * H.asp * H.k) * sk, y: (H.cy - r.y + (p.y - H.py) * H.k) * sk }));
    const palmLen = Math.hypot(pts[9].x - pts[0].x, pts[9].y - pts[0].y);
    const [cr, cg, cb] = HAND.rgb;
    a.setTransform(1, 0, 0, 1, 0, 0);
    a.globalCompositeOperation = 'source-over';
    a.clearRect(0, 0, A.width, A.height);
    a.fillStyle = a.strokeStyle = `rgb(${cr},${cg},${cb})`;
    a.lineJoin = a.lineCap = 'round';
    a.beginPath();
    for (const [n, i] of [0, 1, 2, 5, 9, 13, 17].entries()) n ? a.lineTo(pts[i].x, pts[i].y) : a.moveTo(pts[i].x, pts[i].y);
    a.closePath();
    a.lineWidth = palmLen * 0.16;
    a.fill();
    a.stroke();
    FINGERS.forEach((chain, f) => {
      a.lineWidth = palmLen * FINGER_W[f];
      a.beginPath();
      chain.forEach((i, n) => (n ? a.lineTo(pts[i].x, pts[i].y) : a.moveTo(pts[i].x, pts[i].y)));
      a.stroke();
    });
    // 指尖实、掌根虚：沿 中指根→手腕 方向逐渐擦淡
    const w0 = pts[0], m9 = pts[9];
    const g = a.createLinearGradient(m9.x + (m9.x - w0.x) * 0.15, m9.y + (m9.y - w0.y) * 0.15, w0.x + (w0.x - m9.x) * 0.3, w0.y + (w0.y - m9.y) * 0.3);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    a.globalCompositeOperation = 'destination-out';
    a.fillStyle = g;
    a.fillRect(0, 0, A.width, A.height);

    b.setTransform(1, 0, 0, 1, 0, 0);
    b.clearRect(0, 0, B.width, B.height);
    b.filter = `blur(${Math.max(1, A.height * 0.009).toFixed(2)}px)`;
    b.drawImage(A, 0, 0);
    b.filter = 'none';

    // 只把手的包围盒（含模糊外扩）贴回主画布，省填充
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const pad = palmLen * 0.3 + A.height * 0.03;
    x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(A.width, Math.ceil(x1 + pad)); y1 = Math.min(A.height, Math.ceil(y1 + pad));
    if (x1 <= x0 || y1 <= y0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = HAND.alpha * H.vis;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(B, x0, y0, x1 - x0, y1 - y0, r.x + x0 / sk, r.y + y0 / sk, (x1 - x0) / sk, (y1 - y0) / sk);
    ctx.restore();
  }

  // ---------- 球 + 毛笔拖尾 ----------
  _drawBall(ctx, ball) {
    const br = ball.r || BALL_R;
    const pts = [{ x: ball.x, y: ball.y }];
    for (const p of ball.trail || []) {
      const q = pts[pts.length - 1];
      if (Math.hypot(p.x - q.x, p.y - q.y) > 1) pts.push(p);
      if (pts.length >= 26) break;
    }
    if (pts.length >= 3) this._drawTrail(ctx, pts, br);
    ctx.fillStyle = '#1a1410';
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, br, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(ball.x - br * 0.35, ball.y - br * 0.38, br * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawTrail(ctx, pts, br) {
    const n = pts.length, L = [], R = [], C = [];
    const onePx = 1 / this.s;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let tx = a.x - b.x, ty = a.y - b.y;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      const u = i / (n - 1);
      const hw = br * 1.05 * Math.pow(1 - u, 0.85) * (0.8 + 0.2 * Math.sin(Math.min(1, u * 3) * Math.PI * 0.5));
      C.push({ x: pts[i].x, y: pts[i].y, nx: -ty, ny: tx, hw });
      L.push([pts[i].x - ty * hw, pts[i].y + tx * hw]);
      R.push([pts[i].x + ty * hw, pts[i].y - tx * hw]);
    }
    const head = pts[0], tail = pts[n - 1];
    const grad = (rgb, a0) => {
      const g = ctx.createLinearGradient(head.x, head.y, tail.x, tail.y);
      g.addColorStop(0, `rgba(${rgb},${a0})`);
      g.addColorStop(0.7, `rgba(${rgb},${a0 * 0.45})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      return g;
    };
    ctx.save();
    ctx.lineJoin = ctx.lineCap = 'round';
    // 暖灰笔身 + 白色笔芯
    const ribbon = (k) => {
      ctx.beginPath();
      C.forEach((c, i) => (i ? ctx.lineTo(c.x + c.nx * c.hw * k, c.y + c.ny * c.hw * k) : ctx.moveTo(c.x + c.nx * c.hw * k, c.y + c.ny * c.hw * k)));
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(C[i].x - C[i].nx * C[i].hw * k, C[i].y - C[i].ny * C[i].hw * k);
      ctx.closePath();
    };
    ribbon(1);
    ctx.fillStyle = grad('96,84,72', 0.3);
    ctx.fill();
    ribbon(0.62);
    ctx.fillStyle = grad('255,254,250', 0.95);
    ctx.fill();
    // 笔锋墨边（一侧深一侧浅，亮底上也看得见）
    for (const [side, a] of [[L, 0.55], [R, 0.3]]) {
      ctx.strokeStyle = grad('62,48,36', a);
      ctx.lineWidth = Math.max(1, onePx);
      ctx.beginPath();
      side.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
    // 飞白：笔身内断续的干笔丝
    ctx.lineWidth = Math.max(0.7, onePx * 0.8);
    for (const [k, rgb, a] of [[-0.5, '110,95,80', 0.4], [0.15, '255,255,255', 0.9], [0.55, '120,105,90', 0.3]]) {
      ctx.strokeStyle = grad(rgb, a);
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < n; i++) {
        const c = C[i], x = c.x + c.nx * c.hw * k, y = c.y + c.ny * c.hw * k;
        if ((i * 7 + Math.round(k * 10) * 3) % 5 === 4) { pen = false; continue; }
        pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        pen = true;
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- 粒子 ----------
  _add(p) {
    this.particles.push(p);
  }

  _spawn(kind, director, playerRig, cpuRig) {
    const rnd = Math.random;
    if (kind === 'table') {
      const b = director?.ball;
      if (!b) return;
      const x = b.x, y = TABLE.topY;
      for (let i = 0; i < 12; i++) {
        const a = -Math.PI / 2 + (rnd() - 0.5) * 2.4, sp = 60 + rnd() * 220, ink = i < 7;
        this._add({ kind: ink ? 'ink' : 'dust', x: x + (rnd() - 0.5) * 6, y: y - 2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          g: ink ? 1100 : 160, drag: ink ? 0.6 : 3, life: 0, max: 0.35 + rnd() * 0.45, size: ink ? 1.2 + rnd() * 2 : 1 + rnd() * 2.2 });
      }
      this._add({ kind: 'smudge', x, y: y + 1, vx: 0, vy: 0, g: 0, drag: 0, life: 0, max: 0.7, size: 10 });
    } else {
      // 剑击：取剑尖离对方身体最近的一方
      let best = null;
      for (const [a, b] of [[playerRig, cpuRig], [cpuRig, playerRig]]) {
        const tip = a?.swordTip;
        if (!tip) continue;
        let d = Infinity;
        for (const c of b?.bodyHit || []) d = Math.min(d, Math.hypot(tip.x - c.x, tip.y - c.y) - c.r);
        if (!best || d < best.d) best = { d, tip };
      }
      const hit = best?.tip || cpuRig?.bodyHit?.[0] || { x: WORLD.W / 2, y: 500 };
      const vl = Math.hypot(hit.vx || 0, hit.vy || 0);
      const base = vl > 50 ? Math.atan2(hit.vy, hit.vx) : -Math.PI / 2;
      for (let i = 0; i < 34; i++) {
        const cone = vl > 50 ? 1.6 : Math.PI * 2;
        const a = base + (rnd() - 0.5) * cone, sp = 150 + rnd() * 650;
        this._add({ kind: 'ink', x: hit.x, y: hit.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 120,
          g: 1300, drag: 0.8, life: 0, max: 0.5 + rnd() * 0.7, size: 1.5 + rnd() * rnd() * 7 });
      }
      const blobs = [];
      for (let i = 0; i < 9; i++) {
        const a = rnd() * Math.PI * 2, d = rnd() * 16;
        blobs.push([Math.cos(a) * d, Math.sin(a) * d, 5 + rnd() * 11]);
      }
      this._add({ kind: 'blob', x: hit.x, y: hit.y, vx: 0, vy: 0, g: 0, drag: 0, life: 0, max: 0.9, size: 1, blobs });
      this.shake = 9;
    }
    if (this.particles.length > MAX_PARTICLES) this.particles.splice(0, this.particles.length - MAX_PARTICLES);
  }

  _updateParticles(dt) {
    const ps = this.particles;
    let j = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life += dt;
      if (p.life >= p.max) continue;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vy = p.vy * k + p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      ps[j++] = p;
    }
    ps.length = j;
  }

  _drawParticles(ctx) {
    if (!this.particles.length) return;
    ctx.save();
    ctx.lineCap = 'round';
    for (const p of this.particles) {
      const u = p.life / p.max, a = 1 - u * u;
      if (p.kind === 'ink') {
        ctx.strokeStyle = `rgba(${INK},${(0.85 * a).toFixed(3)})`;
        ctx.lineWidth = p.size * 2;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.018, p.y - p.vy * 0.018);
        ctx.stroke();
      } else if (p.kind === 'dust') {
        ctx.fillStyle = `rgba(120,88,52,${(0.55 * a).toFixed(3)})`;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      } else if (p.kind === 'smudge') {
        ctx.fillStyle = `rgba(${INK},${(0.28 * (1 - u)).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.size * (1 + u * 1.5), p.size * 0.22, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'blob') {
        const grow = 0.6 + 0.4 * Math.min(1, u * 6);
        ctx.fillStyle = `rgba(${INK},${(0.7 * (1 - u)).toFixed(3)})`;
        ctx.beginPath();
        for (const [bx, by, br] of p.blobs) {
          ctx.moveTo(p.x + bx * grow + br * grow, p.y + by * grow);
          ctx.arc(p.x + bx * grow, p.y + by * grow, br * grow, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }
    ctx.restore();
  }
}
