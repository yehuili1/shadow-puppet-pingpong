// 皮影美术：代码绘制部件贴图（离屏 canvas，RES 倍分辨率，缓存）+ PNG 覆盖
// 部件尺寸、枢轴、静止朝向以 skeleton.js 的 SK 为准；贴图里 (ox,oy) = 关节枢轴像素坐标，s = 1/RES。
// 绘制坐标一律用皮影局部单位（面朝右，y 向下，枢轴在原点），由 renderPart() 统一换算到像素。
import { SK, PARTS, CHARACTERS, STYLES } from './skeleton.js';
import { PADDLE_R } from '../core/world.js';

const RES = 2;
const TAU = Math.PI * 2;
const MANIFEST_URL = new URL('../../assets/puppets/manifest.json', import.meta.url);

const cache = new Map();      // 'hero/shadow/torso' -> { img, ox, oy, s }
const overrides = new Map();  // PNG 覆盖
const keyOf = (c, s, p) => `${c}/${s}/${p}`;

// ---------- 调色 ----------
// shadow：同一种深褐皮面，按色调给不同不透明度，形成透光层次
const LEATHER = '43,26,15';
const INK = '22,12,6';
const SHADOW_A = {
  main: 0.9, second: 0.8, trim: 0.94, accent: 0.72, dark: 0.95, light: 0.36,
  skin: 0.1, face: 0.88, wood: 0.9, metal: 0.55, black: 0.96, tongue: 0.9,
};
// color：彩绘皮影（红/橙黄/金/绿 + 黑描边）
const COLOR = {
  hero: {
    main: '#c0392b', second: '#1f8a4c', trim: '#e8b02a', accent: '#ef8a1f', dark: '#2a1712', light: '#f6dc8a',
    skin: '#f7e8c8', face: '#f7e8c8', wood: '#9c6434', metal: '#dfe4e6', black: '#151515', tongue: '#b0161c', ink: '#150c08',
    red: '#d8261b',
  },
  rival: {
    main: '#18714c', second: '#c0392b', trim: '#e8b02a', accent: '#ef8a1f', dark: '#2a1712', light: '#f6dc8a',
    skin: '#f7e8c8', face: '#c4372a', wood: '#9c6434', metal: '#dfe4e6', black: '#151515', tongue: '#b0161c', ink: '#150c08',
    red: '#d8261b',
  },
};

// ---------- 对外接口 ----------
// 读 manifest，加载 PNG 覆盖；失败静默回退代码绘制。可传自定义 manifest 地址（测试用）。
export async function loadPuppetArt(manifestUrl = MANIFEST_URL) {
  const url = new URL(manifestUrl, location.href);
  let manifest = {};
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (r.ok) manifest = (await r.json()) || {};
  } catch { /* 无 manifest = 全部代码绘制 */ }
  overrides.clear();
  const jobs = [];
  for (const [ch, styles] of Object.entries(manifest)) {
    for (const [st, parts] of Object.entries(styles || {})) {
      for (const [part, e] of Object.entries(parts || {})) {
        if (!e || !e.src) continue;
        jobs.push(loadImage(new URL(e.src, url)).then((img) => {
          const num = (v, d) => (Number.isFinite(+v) ? +v : d);
          overrides.set(keyOf(ch, st, part), { img, ox: num(e.ox, img.naturalWidth / 2), oy: num(e.oy, 0), s: num(e.s, 1 / RES) });
        }, () => {}));
      }
    }
  }
  await Promise.all(jobs);
  // 预热全部代码贴图，避免第一帧卡顿
  for (const c of CHARACTERS) for (const s of STYLES) for (const p of PARTS) getPart(c, s, p);
  return { overrides: [...overrides.keys()] };
}

export function getPart(character, style, part) {
  const key = keyOf(character, style, part);
  const o = overrides.get(key);
  if (o) return o;
  let v = cache.get(key);
  if (!v) cache.set(key, (v = renderPart(character, style, part)));
  return v;
}

// 不走缓存直接绘制一张部件贴图（测试/工具用）
export function renderPart(character, style, part) {
  const def = PART_DEFS[part];
  if (!def) throw new Error(`art: unknown part "${part}"`);
  const [x0, y0, x1, y1] = typeof def.box === 'function' ? def.box(character) : def.box;
  const cv = document.createElement('canvas');
  cv.width = Math.ceil((x1 - x0) * RES);
  cv.height = Math.ceil((y1 - y0) * RES);
  const g = cv.getContext('2d');
  g.setTransform(RES, 0, 0, RES, -x0 * RES, -y0 * RES);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  const k = new Kit(g, character, style, rngOf(`${character}/${style}/${part}`));
  def.draw(k);
  if (k.shadow) k.mottle([x0, y0, x1, y1]);
  return { img: cv, ox: -x0 * RES, oy: -y0 * RES, s: 1 / RES };
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = url;
  });
}

// ---------- 工具 ----------
function rngOf(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 点列 → 平滑路径（Catmull-Rom）；点 [x,y] 平滑，[x,y,1] 尖角
function curve(pts, closed = true, path = new Path2D()) {
  const n = pts.length;
  const at = (i) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1 = p1[2] ? p1 : [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = p2[2] ? p2 : [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    path.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p2[0], p2[1]);
  }
  if (closed) path.closePath();
  return path;
}
const bbox = (pts) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of pts) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
  return b;
};
const shape = (pts) => ({ path: curve(pts), box: bbox(pts) });
const rect = (x0, y0, x1, y1) => { const p = new Path2D(); p.rect(x0, y0, x1 - x0, y1 - y0); return { path: p, box: [x0, y0, x1, y1] }; };
const circle = (x, y, r) => { const p = new Path2D(); p.arc(x, y, r, 0, TAU); return { path: p, box: [x - r, y - r, x + r, y + r] }; };
const ellipse = (x, y, rx, ry, rot = 0) => {
  const p = new Path2D(); p.ellipse(x, y, rx, ry, rot, 0, TAU);
  const m = Math.max(rx, ry); return { path: p, box: [x - m, y - m, x + m, y + m] };
};
const line = (pts) => curve(pts, false);

// Catmull-Rom 采样（飘带、翎子用）
function sample(pts, n) {
  const out = [], segs = pts.length - 1;
  for (let i = 0; i <= n; i++) {
    const u = (i / n) * segs, k = Math.min(segs - 1, Math.floor(u)), t = u - k;
    const p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(segs, k + 2)];
    const f = (a, b, c, d) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
    out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
  }
  return out;
}
// 沿中心线的带状轮廓：左右两侧点列
function strip(c, w0, w1) {
  const L = [], R = [];
  for (let i = 0; i < c.length; i++) {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(c.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1;
    const w = (w0 + (w1 - w0) * (i / (c.length - 1))) / 2;
    L.push([c[i][0] - (dy / d) * w, c[i][1] + (dx / d) * w]);
    R.push([c[i][0] + (dy / d) * w, c[i][1] - (dx / d) * w]);
  }
  return { L, R };
}
const polyPath = (pts) => { const p = new Path2D(); pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y))); p.closePath(); return p; };

// 如意云头边：从 (x0,y0) 到 (x1,y1)，n 个下垂云头，深 d
function ruyiEdge(x0, y0, x1, y1, n, d) {
  const pts = [];
  const P = (t, dd) => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + dd];
  for (let i = 0; i < n; i++) {
    const a = i / n, w = 1 / n;
    pts.push([...P(a, 0), 1], P(a + w * 0.1, d * 0.5), P(a + w * 0.28, d * 0.86), [...P(a + w * 0.5, d * 1.12), 1], P(a + w * 0.72, d * 0.86), P(a + w * 0.9, d * 0.5));
  }
  pts.push([x1, y1, 1]);
  return pts;
}

// ---------- 纹样：返回 { lines, holes }（Path2D）在包围盒内平铺 ----------
function spiral(p, cx, cy, R, turns, dir, a0 = Math.PI / 2) {
  const N = Math.ceil(turns * 20);
  for (let i = 0; i <= N; i++) {
    const t = i / N, a = a0 + dir * t * turns * TAU, r = R * (1 - 0.78 * t);
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    i ? p.lineTo(x, y) : p.moveTo(x, y);
  }
}
const grid = (b, sx, sy, stagger, fn) => {
  for (let j = 0, y = b[1] - sy; y < b[3] + sy; j++, y += sy) {
    for (let x = b[0] - sx + (stagger && j % 2 ? sx / 2 : 0); x < b[2] + sx; x += sx) fn(x, y, j);
  }
};
const pat = {
  // 鳞甲纹
  scales: (r) => (b) => {
    const lines = new Path2D(), holes = new Path2D();
    grid(b, 2 * r, r * 0.9, true, (x, y) => {
      lines.moveTo(x + r, y); lines.arc(x, y, r, 0, Math.PI);
      holes.moveTo(x + r * 0.3, y + r * 0.22); holes.ellipse(x, y + r * 0.22, r * 0.3, r * 0.36, 0, 0, TAU);
    });
    return { lines, holes };
  },
  // 海水（向上的鳞弧）
  waves: (r) => (b) => {
    const lines = new Path2D(), holes = new Path2D();
    grid(b, 2 * r, r * 0.9, true, (x, y) => {
      lines.moveTo(x - r, y); lines.arc(x, y, r, Math.PI, TAU);
      lines.moveTo(x - r * 0.55, y); lines.arc(x, y, r * 0.55, Math.PI, TAU);
      holes.moveTo(x + r * 0.22, y - r * 0.05); holes.arc(x, y - r * 0.05, r * 0.22, 0, TAU);
    });
    return { lines, holes };
  },
  // 铜钱纹
  coins: (r) => (b) => {
    const lines = new Path2D(), holes = new Path2D(), s = r * 1.414;
    grid(b, s, s, false, (x, y) => {
      lines.moveTo(x + r, y); lines.arc(x, y, r, 0, TAU);
      const h = r * 0.2; holes.rect(x - h, y - h, 2 * h, 2 * h);
      holes.moveTo(x + s / 2 + r * 0.1, y); holes.ellipse(x + s / 2, y, r * 0.1, r * 0.4, 0, 0, TAU);
      holes.moveTo(x + r * 0.4, y + s / 2); holes.ellipse(x, y + s / 2, r * 0.4, r * 0.1, 0, 0, TAU);
    });
    return { lines, holes };
  },
  // 万字纹（格内卍）
  wan: (s) => (b) => {
    const lines = new Path2D(), holes = new Path2D(), h = s * 0.3, q = h * 0.5;
    grid(b, s, s, false, (x, y) => {
      lines.rect(x - s / 2, y - s / 2, s, s);
      lines.moveTo(x - h, y - h); lines.lineTo(x, y - h); lines.lineTo(x, y + h); lines.lineTo(x + h, y + h);
      lines.moveTo(x + h, y - h); lines.lineTo(x + h, y); lines.lineTo(x - h, y); lines.lineTo(x - h, y + h);
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) holes.rect(x + sx * q - q * 0.3, y + sy * q - q * 0.3, q * 0.6, q * 0.6);
    });
    return { lines, holes };
  },
  // 卷云纹
  clouds: (s) => (b) => {
    const lines = new Path2D(), holes = new Path2D();
    grid(b, s, s * 0.62, true, (x, y, j) => {
      const d = j % 2 ? 1 : -1;
      const ax = x - s * 0.17 * d, bx = x + s * 0.2 * d, by = y + s * 0.05;
      spiral(lines, ax, y, s * 0.27, 1.5, d);
      spiral(lines, bx, by, s * 0.17, 1.3, -d);
      lines.moveTo(ax, y + s * 0.27);
      lines.bezierCurveTo(ax + s * 0.18 * d, y + s * 0.36, bx - s * 0.1 * d, by + s * 0.3, bx, by + s * 0.17);
      lines.moveTo(ax - s * 0.27 * d, y);
      lines.quadraticCurveTo(ax - s * 0.4 * d, y + s * 0.3, ax - s * 0.62 * d, y + s * 0.26);
      holes.moveTo(ax + s * 0.06, y); holes.arc(ax, y, s * 0.06, 0, TAU);
      holes.moveTo(bx + s * 0.04, by); holes.arc(bx, by, s * 0.04, 0, TAU);
    });
    return { lines, holes };
  },
  // 梅花/团花（枝叶相连）
  flowers: (s) => (b) => {
    const lines = new Path2D(), holes = new Path2D();
    grid(b, s, s * 0.86, true, (x, y, j) => {
      const rot = j * 0.5;
      for (let i = 0; i < 5; i++) {
        const a = rot + (i * TAU) / 5, px = x + Math.cos(a) * s * 0.2, py = y + Math.sin(a) * s * 0.2;
        lines.moveTo(px + Math.cos(a) * s * 0.15, py + Math.sin(a) * s * 0.15);
        lines.ellipse(px, py, s * 0.15, s * 0.1, a, 0, TAU);
        holes.moveTo(px + Math.cos(a) * s * 0.1, py + Math.sin(a) * s * 0.1);
        holes.ellipse(px, py, s * 0.1, s * 0.05, a, 0, TAU);
      }
      lines.moveTo(x + s * 0.06, y); lines.arc(x, y, s * 0.06, 0, TAU);
      lines.moveTo(x + s * 0.33, y + s * 0.1);
      lines.quadraticCurveTo(x + s * 0.45, y + s * 0.5, x + s * 0.5, y + s * 0.86 - s * 0.33);
      holes.moveTo(x + s * 0.47, y + s * 0.32); holes.ellipse(x + s * 0.44, y + s * 0.32, s * 0.035, s * 0.09, 0.5, 0, TAU);
    });
    return { lines, holes };
  },
  // 菱格
  lattice: (s) => (b) => {
    const lines = new Path2D(), holes = new Path2D(), H = b[3] - b[1];
    for (let c = -H - s; c < b[2] - b[0] + s; c += s) {
      lines.moveTo(b[0] + c, b[1]); lines.lineTo(b[0] + c + H, b[3]);
      lines.moveTo(b[0] + c, b[3]); lines.lineTo(b[0] + c + H, b[1]);
    }
    grid(b, s, s / 2, true, (x, y) => {
      const r = s * 0.17;
      holes.moveTo(x, y - r); holes.lineTo(x + r, y); holes.lineTo(x, y + r); holes.lineTo(x - r, y); holes.closePath();
    });
    return { lines, holes };
  },
  // 斜线（立水、缠绳）
  stripes: (s, k = 1) => (b) => {
    const lines = new Path2D(), H = b[3] - b[1];
    for (let c = -H * Math.abs(k) - s; c < b[2] - b[0] + H * Math.abs(k) + s; c += s) {
      lines.moveTo(b[0] + c, b[1]); lines.lineTo(b[0] + c + H * k, b[3]);
    }
    return { lines };
  },
  // 衣褶：稀疏的竖向弧线 + 小孔
  folds: (s) => (b) => {
    const lines = new Path2D(), holes = new Path2D();
    for (let x = b[0] + s * 0.5; x < b[2]; x += s) {
      lines.moveTo(x, b[1]); lines.bezierCurveTo(x + s * 0.3, b[1] + (b[3] - b[1]) * 0.35, x - s * 0.3, b[1] + (b[3] - b[1]) * 0.65, x, b[3]);
    }
    grid(b, s, s * 1.6, true, (x, y) => { holes.moveTo(x + s * 0.12, y); holes.ellipse(x, y, s * 0.12, s * 0.3, 0, 0, TAU); });
    return { lines, holes };
  },
  // 回纹带（盒高 = 纹样高）
  meander: () => (b) => {
    const lines = new Path2D(), h = b[3] - b[1];
    const U = [[0.1, 0.9], [0.1, 0.1], [0.9, 0.1], [0.9, 0.68], [0.32, 0.68], [0.32, 0.32], [0.68, 0.32], [0.68, 0.5], [0.5, 0.5]];
    for (let x = b[0]; x < b[2]; x += h) {
      U.forEach(([u, v], i) => (i ? lines.lineTo(x + u * h, b[1] + v * h) : lines.moveTo(x + u * h, b[1] + v * h)));
      lines.moveTo(x + 0.1 * h, b[1] + 0.9 * h); lines.lineTo(x + 1.1 * h, b[1] + 0.9 * h);
    }
    return { lines };
  },
  // 一排连珠（盒中线）
  beads: (r, gap) => (b) => {
    const lines = new Path2D(), holes = new Path2D(), y = (b[1] + b[3]) / 2;
    for (let x = b[0] + gap / 2; x < b[2]; x += gap) {
      lines.moveTo(x + r, y); lines.arc(x, y, r, 0, TAU);
      holes.moveTo(x + r * 0.5, y); holes.arc(x, y, r * 0.5, 0, TAU);
    }
    return { lines, holes };
  },
  // 玉带板
  plates: (w) => (b) => {
    const lines = new Path2D(), holes = new Path2D(), h = b[3] - b[1];
    for (let x = b[0]; x < b[2]; x += w) {
      lines.moveTo(x, b[1]); lines.lineTo(x, b[3]);
      holes.rect(x + w * 0.24, b[1] + h * 0.3, w * 0.52, h * 0.4);
    }
    return { lines, holes };
  },
};
// 团花（中心对称，忽略包围盒）
const rosette = (cx, cy, R, n = 8) => () => {
  const lines = new Path2D(), holes = new Path2D();
  lines.moveTo(cx + R * 0.82, cy); lines.arc(cx, cy, R * 0.82, 0, TAU);
  lines.moveTo(cx + R * 0.3, cy); lines.arc(cx, cy, R * 0.3, 0, TAU);
  for (let i = 0; i < n; i++) {
    const a = (i * TAU) / n, px = cx + Math.cos(a) * R * 0.56, py = cy + Math.sin(a) * R * 0.56;
    lines.moveTo(px + Math.cos(a) * R * 0.24, py + Math.sin(a) * R * 0.24);
    lines.ellipse(px, py, R * 0.24, R * 0.12, a, 0, TAU);
    holes.moveTo(px + Math.cos(a) * R * 0.15, py + Math.sin(a) * R * 0.15);
    holes.ellipse(px, py, R * 0.15, R * 0.055, a, 0, TAU);
    const qa = a + Math.PI / n, qx = cx + Math.cos(qa) * R * 0.91, qy = cy + Math.sin(qa) * R * 0.91;
    holes.moveTo(qx + R * 0.06, qy); holes.arc(qx, qy, R * 0.06, 0, TAU);
  }
  holes.moveTo(cx + R * 0.12, cy); holes.arc(cx, cy, R * 0.12, 0, TAU);
  return { lines, holes };
};

// ---------- 画笔：同一套几何，shadow / color 两种着色 ----------
class Kit {
  constructor(g, ch, st, rng) {
    this.g = g; this.ch = ch; this.st = st; this.rng = rng;
    this.shadow = st !== 'color';
    this.pal = COLOR[ch] || COLOR.hero;
    this.sil = null;              // 当前部件外轮廓（面板默认裁到它里面）
  }
  fs(tone, a = 1) {
    return this.shadow ? `rgba(${LEATHER},${Math.min(1, (SHADOW_A[tone] ?? 0.85) * a)})` : this.pal[tone] || tone;
  }
  inkStyle(tone) { return this.shadow ? `rgba(${INK},0.94)` : this.pal[tone || 'ink'] || tone; }
  clip(free) { if (this.sil && !free) this.g.clip(this.sil); }
  cut(path, a = 1) {
    const g = this.g;
    g.save(); g.globalCompositeOperation = 'destination-out'; g.globalAlpha = a; g.fill(path); g.restore();
  }
  // 区域换皮：先挖空再填，避免同一张皮叠色
  replace(path, tone, free) {
    const g = this.g;
    g.save(); this.clip(free);
    g.globalCompositeOperation = 'destination-out'; g.fill(path);
    g.globalCompositeOperation = 'source-over'; g.fillStyle = this.fs(tone); g.fill(path);
    g.restore();
  }
  base(sh, tone = 'main') { this.sil = null; this.replace(sh.path, tone, true); this.sil = sh.path; }
  // 纹样面板
  //   tone 底色；pat 纹样；open 整块透光程度（shadow）；fh 彩绘时孔里填的颜色（不填则镂空）
  //   frame 内框皮条宽；carve 纹样线刻成透光细线；free 不裁到部件外轮廓
  panel(sh, o = {}) {
    const g = this.g, tone = o.tone || 'main';
    this.replace(sh.path, tone, o.free);
    const p = o.pat ? o.pat(sh.box) : null;
    g.save(); this.clip(o.free); g.clip(sh.path);
    if (this.shadow && o.open) this.cut(sh.path, o.open);
    if (p?.holes && o.holes !== false && !(o.holes === 'color' && this.shadow)) {
      if (!this.shadow && o.fh) { g.fillStyle = this.pal[o.fh] || o.fh; g.fill(p.holes); }
      else this.cut(p.holes, 1);
    }
    if (p?.lines) {
      g.lineWidth = o.lw || 1.4;
      if (o.carve && this.shadow) {
        g.save(); g.globalCompositeOperation = 'destination-out'; g.globalAlpha = 0.68; g.stroke(p.lines); g.restore();
      } else {
        const dark = tone === 'dark' || tone === 'black' || tone === 'face';
        const ink = o.ink || (dark ? 'trim' : 'ink');
        g.strokeStyle = this.shadow ? this.fs('trim', 1.04) : this.pal[ink] || ink;
        g.stroke(p.lines);
      }
    }
    const fw = o.frame ?? (p ? 1.8 : 0);
    if (fw) {
      g.lineWidth = fw * 2;
      g.strokeStyle = this.shadow ? this.fs('trim', 1.04) : this.pal[o.frameTone || (tone === 'trim' ? 'dark' : 'trim')];
      g.stroke(sh.path);
    }
    g.restore();
    if (o.border !== 0) { g.save(); this.clip(o.free); this.edge(sh.path, o.border || 1.3); g.restore(); }
  }
  edge(path, w = 1.4, tone) {
    const g = this.g;
    g.save(); g.strokeStyle = this.inkStyle(tone); g.lineWidth = w; g.stroke(path); g.restore();
  }
  outline(sh, w = 1.8) { this.edge(sh.path, w); }
  fill(path, tone) { const g = this.g; g.save(); g.fillStyle = this.fs(tone); g.fill(path); g.restore(); }
  // 刻线：shadow 镂成透光细线；color 用 tone 色描
  carve(path, w = 1, tone = 'light', a = 0.85) {
    const g = this.g;
    g.save(); g.lineWidth = w;
    if (this.shadow) { g.globalCompositeOperation = 'destination-out'; g.globalAlpha = a; g.strokeStyle = '#000'; }
    else g.strokeStyle = this.pal[tone] || tone;
    g.stroke(path); g.restore();
  }
  // 粗带（领口、骨线）：墨边 + 色心
  band(path, w, tone) {
    const g = this.g;
    g.save();
    g.lineWidth = w + 2.4; g.globalCompositeOperation = 'destination-out'; g.stroke(path);
    g.globalCompositeOperation = 'source-over'; g.strokeStyle = this.inkStyle(); g.stroke(path);
    g.lineWidth = w; g.globalCompositeOperation = 'destination-out'; g.stroke(path);
    g.globalCompositeOperation = 'source-over'; g.strokeStyle = this.fs(tone); g.stroke(path);
    g.restore();
  }
  // 关节铆钉（皮影的“钉”）
  rivet(x, y, r = 3.6) {
    const c = circle(x, y, r);
    this.replace(c.path, 'trim', true);
    this.edge(c.path, 1);
    this.cut(circle(x, y, r * 0.42).path, 0.9);
  }
  medal(cx, cy, r, tone = 'trim', free = false) {
    this.panel(circle(cx, cy, r), { tone, pat: rosette(cx, cy, r, r > 16 ? 10 : 8), open: 0.5, free, border: 1.4, lw: 1.2, frame: 0, fh: tone === 'trim' ? 'red' : 'trim' });
  }
  // 皮面不匀：固定种子的淡斑（只减不加，透光更自然）
  mottle(b) {
    const g = this.g, w = b[2] - b[0], h = b[3] - b[1];
    g.save(); g.globalCompositeOperation = 'destination-out';
    const n = Math.ceil((w * h) / 700);
    for (let i = 0; i < n; i++) {
      const x = b[0] + this.rng() * w, y = b[1] + this.rng() * h, r = 6 + this.rng() * 18;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(0,0,0,${0.06 + this.rng() * 0.1})`);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    g.restore();
  }
}

// 飘带：沿中心线的带状物，末端燕尾
function ribbon(k, pts, w0, w1, tone, o = {}) {
  const c = sample(pts, 40), { L, R } = strip(c, w0, w1);
  const end = c[c.length - 1], prev = c[c.length - 4];
  const tail = o.tail === false ? [] : [[end[0] + (prev[0] - end[0]) * 0.6, end[1] + (prev[1] - end[1]) * 0.6]];
  const sh = { path: polyPath([...L, ...tail, ...[...R].reverse()]), box: bbox([...L, ...R]) };
  k.panel(sh, { tone, free: true, border: 1.1, ...o });
  return c;
}
// 雉鸡翎：带横纹（深浅相间），翎尖微卷
function feather(k, pts, w) {
  const n = 110, c = sample(pts, n), { L, R } = strip(c, w, w * 0.3);
  const all = polyPath([...L, ...[...R].reverse()]);
  k.replace(all, 'light', true);
  for (let i = 2; i < n; i += 7) {
    const j = Math.min(n, i + 4);
    k.replace(polyPath([...L.slice(i, j + 1), ...R.slice(i, j + 1).reverse()]), 'dark', true);
  }
  k.edge(all, 1);
  if (!k.shadow) k.edge(line(c.slice(0, n - 3)), 0.6, 'red');
}

// ---------- 部件 ----------
const TORSO_SIL = [
  [-35, 10, 1], [-36, -30], [-40, -100], [-44, -158], [-45, -176], [-38, -191], [-22, -200], [-4, -203], [12, -203],
  [28, -198], [41, -188], [48, -172], [50, -150], [47, -110], [41, -60], [37, -20], [36, 10, 1],
];

function torso(k) {
  const sil = shape(TORSO_SIL);
  k.base(sil, 'main');
  if (k.ch === 'hero') {
    // 鳞甲胸 + 腰封 + 下腹云纹
    k.panel(rect(-60, -175, 60, -60), { tone: 'main', pat: pat.scales(11), carve: true, lw: 1.7, frame: 0, fh: 'trim' });
    k.panel(rect(-60, -60, 60, -48), { tone: 'dark', pat: pat.meander(), carve: true, lw: 1.1, frame: 0 });
    k.panel(rect(-60, -32, 60, 14), { tone: 'second', pat: pat.clouds(26), open: 0.35, lw: 1.8, frame: 0, fh: 'trim' });
    // 云肩（如意云头垂边）
    const cape = shape([[-62, -222, 1], [64, -222, 1], [64, -142, 1], ...ruyiEdge(64, -142, -62, -156, 3, 20).slice(1)]);
    k.panel(cape, { tone: 'second', pat: pat.clouds(22), open: 0.45, lw: 2, frame: 3, border: 1.6, fh: 'trim' });
    k.medal(26, -112, 16);
    k.band(line([[-24, -201], [2, -185], [30, -197]]), 4.4, 'trim');
    // 玉带 + 带扣
    k.panel(shape([[-47, -49, 1], [51, -49, 1], [54, -40], [51, -31, 1], [-47, -31, 1], [-50, -40]]), { tone: 'trim', pat: pat.plates(11), free: true, border: 1.5, frame: 0, fh: 'red' });
    k.medal(48, -40, 9, 'accent', true);
  } else {
    // 蟒袍：万字地 + 铜钱下摆 + 后背菱格 + 团花 + 横出玉带
    k.panel(rect(-60, -205, 60, -52), { tone: 'main', pat: pat.wan(21), carve: true, lw: 1.7, frame: 0, fh: 'trim' });
    k.panel(rect(-60, -52, 60, 14), { tone: 'second', pat: pat.coins(12), carve: true, lw: 1.7, frame: 0, fh: 'trim' });
    k.panel(shape([[-48, -205, 1], [-28, -205, 1], [-24, -150], [-26, -52, 1], [-48, -52, 1]]), { tone: 'trim', pat: pat.lattice(12), open: 0.45, frame: 2.4, fh: 'red' });
    k.medal(20, -128, 23);
    k.band(line([[-26, -201], [4, -183], [34, -196]]), 5, 'trim');
    k.panel(shape([[-64, -56], [-54, -62, 1], [60, -60, 1], [70, -52], [68, -45], [58, -40, 1], [-54, -42, 1], [-64, -48]]), { tone: 'trim', pat: pat.plates(12), free: true, border: 1.5, frame: 0, fh: 'red' });
  }
  // 衣襟下沿（实心，枢轴落在皮面上）
  k.panel(rect(-60, -3, 60, 14), { tone: 'trim', pat: pat.beads(2.3, 7), border: 1.2, frame: 0, fh: 'red' });
  k.outline(sil, 2);
}

// 头部公用：脸前轮廓（脖子 → 下巴 → 嘴 → 鼻 → 额）
const HERO_FRONT = [[12, 14, 1], [11, -8], [16, -18], [26, -25], [33, -29], [36, -34], [38, -38], [36.5, -41, 1], [40.5, -44], [40, -48], [43, -51, 1], [47.5, -55], [44, -60], [40.5, -66], [41, -71], [39, -79], [37, -88]];
const RIVAL_FRONT = [[13, 14, 1], [12, -6], [18, -16], [29, -22], [37, -25], [40, -31], [42, -36.5], [35, -42, 1], [44.5, -46], [44, -50], [45, -52, 1], [48, -54], [49, -58], [46, -63], [44, -67], [46.5, -72], [43, -80], [40, -90]];
const EAR = () => {
  const ear = new Path2D();
  ear.moveTo(-1, -64); ear.bezierCurveTo(-10, -66, -11, -47, -2, -46);
  ear.moveTo(-3, -59); ear.quadraticCurveTo(-7, -56, -3, -51);
  return ear;
};

function head(k) {
  return k.ch === 'hero' ? headHero(k) : headRival(k);
}

function headHero(k) {
  // 雉鸡翎（根部被盔遮住）：高高扬起再向后弯垂
  feather(k, [[10, -128], [22, -182], [20, -232], [0, -276], [-40, -304], [-90, -312], [-134, -298], [-156, -276], [-160, -262]], 12.5);
  feather(k, [[-2, -128], [2, -176], [-6, -218], [-30, -254], [-70, -276], [-112, -276], [-144, -258], [-160, -236], [-160, -224]], 10.5);
  // 盔后飘带
  ribbon(k, [[-26, -102], [-40, -86], [-40, -60], [-46, -36], [-42, -10]], 10, 9, 'second', { pat: pat.flowers(10), open: 0.4, frame: 1.4, fh: 'trim' });
  ribbon(k, [[-30, -98], [-52, -82], [-56, -56], [-64, -34], [-62, -12]], 8, 7, 'accent', { pat: pat.stripes(4, 0.6), open: 0.35, frame: 1.2 });
  // 头型（后脑发髻深色，脸为空脸）
  const sil = shape([[-12, 14, 1], ...HERO_FRONT, [10, -94], [-20, -92], [-34, -76], [-35, -54], [-27, -35], [-17, -22], [-12, -6]]);
  k.panel(sil, { tone: 'dark', free: true, border: 0, pat: pat.stripes(3.4, 0.25), carve: true, lw: 0.7, frame: 0, ink: '#4a2e22' });
  const face = shape([...HERO_FRONT, [8, -90], [1, -78], [-3, -62], [-1, -42], [-6, -26], [-9, -10], [-10, 14, 1]]);
  k.panel(face, { tone: 'skin', free: true, border: 1.1 });
  // 鬓角
  k.fill(curve([[1, -82, 1], [6, -82], [6, -62], [3, -45, 1], [-1, -62]]), 'dark');
  // 剑眉、丹凤眼、鼻翼、嘴、耳
  k.fill(curve([[37.5, -69], [30, -71.6], [21, -73.4], [12, -77.6], [8.5, -80, 1], [12.5, -75.2], [22, -70.4], [30, -69]]), 'dark');
  const eye = new Path2D();
  eye.moveTo(36, -63); eye.quadraticCurveTo(27, -67.4, 16, -65.2); eye.lineTo(11.5, -68);
  eye.moveTo(36, -63); eye.quadraticCurveTo(27, -60.2, 17.5, -63.6);
  k.edge(eye, 1.3);
  k.fill(circle(28.5, -63.6, 2).path, 'dark');
  const det = new Path2D();
  det.moveTo(44, -52.6); det.quadraticCurveTo(40.6, -53.6, 40.4, -50.6);
  det.moveTo(36.6, -41); det.lineTo(31, -40.4);
  det.moveTo(33, -30); det.quadraticCurveTo(29, -31.5, 27, -29.5);
  k.edge(det, 1);
  k.edge(EAR(), 1.2);
  k.outline(sil, 2.1);
  if (!k.shadow) k.fill(curve([[37, -46], [34, -45], [37, -43.5]]), 'red');
  // 盔：后翅、盔身、额子、盔面、顶珠、绒球
  k.panel(shape([[-28, -122], [-50, -140], [-72, -134], [-79, -114], [-68, -100], [-54, -104], [-58, -116], [-46, -118], [-33, -102]]), { tone: 'accent', free: true, pat: pat.scales(4.5), open: 0.3, frame: 1.4, fh: 'trim' });
  k.panel(shape([[42, -96, 1], [40, -114], [30, -132], [10, -143], [-12, -141], [-30, -129], [-39, -111], [-38, -96, 1]]), { tone: 'main', free: true, pat: pat.clouds(19), open: 0.4, border: 1.7, lw: 1.6, frame: 2.2, fh: 'trim' });
  // 盔面：火焰顶的圆牌
  k.panel(shape([[8, -99, 1], [38, -99, 1], [40, -114], [34, -127], [28, -133], [24, -146, 1], [20, -133], [14, -127], [7, -114]]), { tone: 'trim', free: true, pat: pat.stripes(2.6, 0), carve: true, lw: 0.8, border: 1.3, frame: 0, ink: 'dark' });
  k.medal(23.5, -115, 10, 'accent', true);
  k.panel(shape([[45, -80, 1], [49, -89], [46, -99, 1], [-38, -101, 1], [-42, -90], [-38, -81, 1]]), { tone: 'trim', free: true, pat: pat.beads(2.7, 7), border: 1.5, frame: 0, fh: 'red' });
  k.panel(shape([[-9, -138, 1], [-7, -146], [-11, -151], [-5, -157], [2, -168, 1], [9, -157], [15, -151], [11, -146], [13, -138, 1]]), { tone: 'trim', free: true, border: 1.2 });
  k.cut(circle(2, -151, 2).path, 0.9);
  const ball = (x, y, r) => k.panel(circle(x, y, r), { tone: k.shadow ? 'black' : 'red', free: true, border: 1 });
  k.edge(line([[38, -100], [45, -105], [50, -109]]), 1.7);
  ball(53, -111, 8);
  k.edge(line([[32, -138], [35, -146], [37, -152]]), 1.5);
  ball(38, -156, 5.4);
  ball(-36, -128, 5.4);
}

// 背后大圆扇形头饰（孔雀扇 + 火焰边）
function fan(k, cx, cy, rx, ry, rot) {
  const E = (s, a) => {
    const x = Math.cos(a) * rx * s, y = Math.sin(a) * ry * s;
    return [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)];
  };
  // 火焰边：弯钩状的焰舌，长短交错
  const n = 60, flame = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU, len = [0.28, 0.13, 0.21, 0.1][i % 4];
    flame.push(E(0.97, a - (TAU / n) * 0.5), E(1.02 + len * 0.45, a - 0.015), [...E(1 + len, a + 0.085), 1], E(1.01 + len * 0.35, a + 0.045));
  }
  k.panel(shape(flame), { tone: 'dark', free: true, border: 0.9, pat: null });
  const ring = (s) => { const p = new Path2D(); p.ellipse(cx, cy, rx * s, ry * s, rot, 0, TAU); return { path: p, box: [cx - rx * s, cy - ry * s, cx + rx * s, cy + ry * s] }; };
  const beadRing = (s, m, r) => () => {
    const lines = new Path2D(), holes = new Path2D();
    for (let i = 0; i < m; i++) {
      const [x, y] = E(s, (i / m) * TAU);
      lines.moveTo(x + r, y); lines.arc(x, y, r, 0, TAU);
      holes.moveTo(x + r * 0.55, y); holes.arc(x, y, r * 0.55, 0, TAU);
    }
    return { lines, holes };
  };
  // 孔雀翎眼：沿放射方向排一圈
  const eyes = (m) => () => {
    const lines = new Path2D(), holes = new Path2D();
    for (let i = 0; i < m; i++) {
      const a = (i / m) * TAU, [x, y] = E(0.69, a), [x2, y2] = E(0.8, a);
      const ang = Math.atan2(y2 - y, x2 - x);
      lines.moveTo(x + Math.cos(ang) * 10, y + Math.sin(ang) * 10); lines.ellipse(x, y, 10, 6.5, ang, 0, TAU);
      lines.moveTo(x + Math.cos(ang) * 5.5, y + Math.sin(ang) * 5.5); lines.ellipse(x, y, 5.5, 3.6, ang, 0, TAU);
      holes.moveTo(x + 2, y); holes.arc(x, y, 2, 0, TAU);
      const [bx, by] = E(0.5, a); lines.moveTo(bx, by); lines.lineTo(x - Math.cos(ang) * 10, y - Math.sin(ang) * 10);
      const [ox, oy] = E(0.69, a + Math.PI / m);
      holes.moveTo(ox + 3.4, oy); holes.ellipse(ox, oy, 3.4, 2, ang, 0, TAU);
    }
    return { lines, holes };
  };
  k.panel(ring(1), { tone: 'trim', free: true, pat: beadRing(0.93, 42, 2.8), border: 1.3, frame: 0, fh: 'red' });
  k.panel(ring(0.86), { tone: 'main', free: true, pat: eyes(16), open: 0.42, border: 1.3, lw: 1.5, frame: 1.6, fh: 'trim' });
  k.panel(ring(0.5), { tone: 'second', free: true, pat: pat.clouds(16), open: 0.4, border: 1.3, frame: 1.6, fh: 'trim' });
  k.medal(...E(0, 0), Math.min(rx, ry) * 0.26, 'trim', true);
}

function headRival(k) {
  fan(k, -38, -114, 64, 84, -0.32);
  const sil = shape([[-13, 14, 1], ...RIVAL_FRONT, [12, -97], [-20, -97], [-35, -80], [-37, -56], [-29, -36], [-19, -22], [-14, -6]]);
  k.panel(sil, { tone: 'dark', free: true, border: 0, pat: pat.stripes(3.4, 0.25), carve: true, lw: 0.7, frame: 0, ink: '#4a2e22' });
  const face = shape([...RIVAL_FRONT, [10, -94], [2, -80], [-2, -62], [0, -42], [-6, -26], [-10, -10], [-11, 14, 1]]);
  k.panel(face, { tone: 'face', free: true, border: 1.1 });
  // 张开的嘴（舌头从这里伸出）
  k.fill(curve([[35.5, -42, 1], [43.5, -45.2], [42, -38.6]]), 'black');
  // 花脸：白眼窝、火焰眉、额心、腮纹、鼻卷
  const eyeS = ellipse(30, -62, 9, 5.6, -0.2);
  if (k.shadow) k.cut(eyeS.path, 0.8); else k.fill(eyeS.path, '#f5efe2');
  k.edge(eyeS.path, 1.1);
  k.fill(circle(32.5, -62.4, 2.8).path, 'black');
  const brow = curve([[44, -69, 1], [36, -73], [26, -75.5], [18, -80], [9, -89, 1], [13, -81], [5, -82, 1], [13, -76], [24, -70.5], [34, -68.4]]);
  k.fill(brow, 'black');
  if (k.shadow) k.carve(brow, 0.7, 'trim', 0.5);
  const sw = new Path2D();
  spiral(sw, 18, -47, 7, 1.4, 1, -Math.PI / 2);
  spiral(sw, 44.5, -55, 2.2, 1.1, -1, Math.PI);
  sw.moveTo(42.5, -51); sw.quadraticCurveTo(38, -50, 35.5, -45);
  sw.moveTo(34, -83); sw.quadraticCurveTo(29, -77, 33, -71); sw.quadraticCurveTo(37, -77, 34, -83);
  sw.moveTo(26, -26); sw.quadraticCurveTo(12, -30, 4, -40);
  k.carve(sw, 1.3, 'black', 0.85);
  if (!k.shadow) k.fill(curve([[34, -84], [30.5, -77], [33, -71.5], [36.5, -77]]), 'trim');
  k.edge(EAR(), 1.2);
  // 八字胡 + 山羊须（不挡嘴）
  ribbon(k, [[44, -49], [36, -51], [26, -49.5], [18, -45], [15, -39], [17, -35]], 3.4, 1.2, 'dark', { border: 0.8, tail: false });
  ribbon(k, [[36, -27], [36, -18], [32, -6], [26, 4], [22, 10]], 5, 1, 'dark', { border: 0.8, tail: false });
  k.outline(sil, 2.1);
  // 盔
  k.panel(shape([[42, -98, 1], [38, -112], [26, -125], [8, -132], [-10, -130], [-24, -121], [-32, -108], [-32, -99, 1]]), { tone: 'main', free: true, pat: pat.scales(8), open: 0.25, border: 1.6, lw: 1.3, frame: 1.8, fh: 'trim' });
  k.panel(shape([[44, -82, 1], [48, -90], [45, -100, 1], [-30, -102, 1], [-36, -92], [-32, -84, 1]]), { tone: 'trim', free: true, pat: pat.beads(2.6, 6.8), border: 1.4, frame: 0, fh: 'red' });
  k.panel(shape([[-6, -128, 1], [-3, -139], [-1, -147], [2, -156, 1], [6, -147], [8, -139], [11, -128, 1]]), { tone: 'trim', free: true, border: 1.2 });
  k.panel(shape([[12, -112, 1], [21, -112, 1], [23, -128, 1], [10, -128, 1]]), { tone: 'second', free: true, pat: pat.lattice(3.6), open: 0.4, border: 1.1, frame: 0 });
  k.edge(line([[38, -100], [44, -104], [49, -106]]), 1.6);
  k.panel(circle(51, -107, 7.4), { tone: k.shadow ? 'black' : 'red', free: true, border: 1 });
  k.panel(circle(-26, -130, 4.6), { tone: k.shadow ? 'black' : 'red', free: true, border: 1 });
}

// 袍摆：前后两片，向下张开，尖角外翻
// 比名义 skirtLen 长：袍摆盖到小腿，只露靴子（参考视频的比例）
const SKIRT_BACK = [[-44, 2, 1], [-2, 2, 1], [0, 150, 1], [-6, 190], [-16, 238, 1], [-62, 241], [-110, 235], [-152, 220], [-186, 200, 1], [-150, 178], [-112, 134], [-80, 76], [-55, 26]];
const SKIRT_FRONT = [[-2, 2, 1], [46, 2], [60, 70], [84, 130], [110, 180], [138, 202, 1], [104, 220], [64, 230], [28, 236], [10, 234, 1], [4, 190], [0, 150, 1]];

function skirt(k) {
  const hero = k.ch === 'hero';
  const sil = shape([[-42, -12, 1], [44, -12, 1], ...SKIRT_FRONT.slice(1), ...SKIRT_BACK.slice(3), [-44, 4]]);
  k.base(sil, 'main');
  const back = shape(SKIRT_BACK), front = shape(SKIRT_FRONT);
  k.panel(back, hero
    ? { tone: 'main', pat: pat.flowers(40), open: 0.32, lw: 2.2, frame: 3.4, border: 1.5, fh: 'trim' }
    : { tone: 'main', pat: pat.clouds(34), carve: true, lw: 2.3, frame: 3.4, border: 1.5, fh: 'trim' });
  k.panel(front, hero
    ? { tone: 'second', pat: pat.clouds(32), carve: true, lw: 2.3, frame: 3.4, border: 1.5, fh: 'trim' }
    : { tone: 'second', pat: pat.flowers(38), open: 0.32, lw: 2.2, frame: 3.4, border: 1.5, fh: 'trim' });
  // 底边纹带（沿下摆）
  const hemB = [[-18, 240], [-62, 243], [-110, 237], [-154, 222], [-190, 201]];
  const hemF = [[142, 203], [104, 222], [64, 232], [28, 238], [8, 236]];
  const band = (pts, d) => shape([...pts.map(([x, y]) => [x, y + 6, 1]), ...[...pts].reverse().map(([x, y]) => [x + d, y - 20])]);
  const hemPat = hero ? { pat: pat.scales(6.5), open: 0.25, fh: 'red' } : { pat: pat.stripes(4.5, 0.55), open: 0.4 };
  k.panel(band(hemB, 5), { tone: 'trim', border: 1.3, lw: 1.2, frame: 0, ...hemPat });
  k.panel(band(hemF, -3), { tone: 'trim', border: 1.3, lw: 1.2, frame: 0, ...hemPat });
  if (!hero) k.panel(shape([[-8, 180], [-14, 210], [-60, 217], [-106, 210], [-146, 196], [-128, 184], [-84, 190], [-40, 186]]), { tone: 'second', pat: pat.waves(6), open: 0.3, lw: 1.2, frame: 0, fh: 'trim' });
  // 腰头
  k.panel(rect(-60, -14, 60, 4), { tone: 'dark', pat: pat.meander(), carve: true, lw: 1.1, border: 1.3, frame: 0, ink: 'trim' });
  k.outline(sil, 2);
}

// 肢体：枢轴处圆头（与上一节重叠，转动无缝），末端圆头
function upperArm(k) {
  const L = SK.upperArmLen, hero = k.ch === 'hero';
  const sil = shape([[-15, 2], [-11, -11], [0, -16], [11, -11], [15, 2], [13.5, 60], [12, L - 8], [8, L + 7], [0, L + 12], [-8, L + 7], [-12, L - 8], [-13.5, 60]]);
  k.base(sil, 'main');
  if (hero) {
    k.panel(rect(-20, 30, 20, L - 6), { tone: 'main', pat: pat.scales(9), carve: true, holes: 'color', lw: 1.5, frame: 0, fh: 'trim' });
    k.panel(rect(-20, L - 6, 20, L + 16), { tone: 'trim', pat: pat.beads(2.4, 6.4), border: 1.2, frame: 0, fh: 'red' });
    k.outline(sil, 1.8);
    // 披膊（肩甲，如意云头下沿）
    const pad = shape([[-20, -2], [-13, -14], [0, -18], [13, -14], [20, -2], [21, 26], [19, 44, 1], ...ruyiEdge(19, 44, -19, 44, 2, 9).slice(1, -1), [-19, 44, 1], [-21, 26]]);
    k.panel(pad, { tone: 'accent', free: true, pat: pat.clouds(15), open: 0.35, lw: 1.4, border: 1.6, frame: 1.8, fh: 'trim' });
  } else {
    k.panel(rect(-20, -20, 20, L - 14), { tone: 'main', pat: pat.clouds(20), carve: true, lw: 1.6, frame: 0, fh: 'trim' });
    k.panel(rect(-20, L - 14, 20, L + 16), { tone: 'second', pat: pat.lattice(6), open: 0.3, border: 1.2, frame: 0, fh: 'trim' });
    k.outline(sil, 1.8);
    k.medal(0, 6, 13);
  }
  k.rivet(0, 0);
}

function forearm(k) {
  const L = SK.forearmLen, hero = k.ch === 'hero';
  const sil = shape([[-12, 2], [-8.5, -9], [0, -12.5], [8.5, -9], [12, 2], [11, 50], [10, L - 22, 1], [-10, L - 22, 1], [-11, 50]]);
  k.base(sil, 'main');
  k.panel(rect(-20, -20, 20, L - 20), hero
    ? { tone: 'main', pat: pat.scales(8), carve: true, holes: 'color', lw: 1.4, frame: 0, fh: 'trim' }
    : { tone: 'main', pat: pat.clouds(18), carve: true, lw: 1.5, frame: 0, fh: 'trim' });
  k.outline(sil, 1.8);
  // 护腕 / 袖口
  const cuff = shape([[-10, L - 24, 1], [10, L - 24, 1], [14, L - 13], [14, L - 2, 1], [-14, L - 2, 1], [-14, L - 13]]);
  k.panel(cuff, { tone: hero ? 'trim' : 'second', free: true, pat: pat.lattice(5), open: 0.3, border: 1.4, lw: 1.1, frame: 0, fh: hero ? 'red' : 'trim' });
  // 握拳的手
  const w = L;
  const fistS = shape([[-8, w - 4], [-10.5, w + 4], [-10, w + 14], [-6, w + 21.5], [2, w + 24.5], [9, w + 22], [12.5, w + 16], [13, w + 8], [10.5, w], [6, w - 4]]);
  k.panel(fistS, { tone: k.shadow ? 'light' : 'skin', free: true, border: 1.4 });
  const f = new Path2D();
  for (const y of [w + 7, w + 12.5, w + 18]) { f.moveTo(3.5, y); f.quadraticCurveTo(9, y - 1.2, 12.8, y + 0.6); }
  f.moveTo(-7, w + 1); f.bezierCurveTo(-3, w - 2.5, 6, w - 1.5, 8, w + 5);
  f.moveTo(3, w + 3); f.lineTo(3.5, w + 22);
  k.edge(f, 1);
  k.rivet(0, 0);
}

function leg(k) {
  const hero = k.ch === 'hero';
  const sil = shape([
    [-15, 2], [-11, -11], [0, -15.5], [11, -11], [15, 2], [16, 60], [17, 150], [17.5, 200], [15, 240], [13, 262, 1],
    [17, 269], [14, 280], [14, 316], [20, 326], [32, 331], [44, 332], [52, 328], [55, 321], [57, 314], [60, 310, 1],
    [63, 318], [62, 331], [56, 343], [44, 351], [30, 355], [-16, 355, 1], [-16, 338], [-14, 300], [-14, 280], [-17, 269],
    [-13, 262, 1], [-16, 240], [-18, 200], [-17.5, 150], [-16, 60],
  ]);
  k.base(sil, 'second');
  // 裤腿：衣褶 + 绑腿
  k.panel(rect(-24, -20, 24, 262), { tone: 'second', pat: hero ? pat.folds(11) : pat.coins(11), carve: true, lw: 1.3, frame: 0, fh: 'trim' });
  for (const y of [244]) k.panel(rect(-24, y, 24, y + 9), { tone: 'trim', pat: pat.stripes(3, 0.5), lw: 0.9, border: 1, frame: 0 });
  // 靴筒、靴面（深色刻云纹）、靴口、厚白底
  k.panel(rect(-24, 270, 70, 350), { tone: 'dark', pat: pat.clouds(16), carve: true, lw: 1.3, border: 1.2, frame: 0 });
  k.panel(rect(-24, 258, 24, 272), { tone: 'trim', pat: pat.beads(2.4, 6.2), border: 1.2, frame: 0, fh: 'red' });
  k.panel(shape([[-20, 343, 1], [30, 343], [46, 339], [57, 331], [64, 324], [66, 340], [50, 360], [-20, 360, 1]]), { tone: 'light', pat: pat.stripes(3, 0), open: 0.1, border: 1.2, lw: 0.7, frame: 0, ink: '#b9a77a' });
  k.outline(sil, 1.8);
  k.rivet(0, 0);
}

function paddle(k) {
  const R = PADDLE_R, C = SK.paddleCenter;
  const handle = shape([[-3.6, -8, 1], [3.6, -8, 1], [3.6, 20], [6.8, C - R + 4, 1], [-6.8, C - R + 4, 1], [-3.6, 20]]);
  k.panel(handle, { tone: 'wood', free: true, pat: pat.stripes(2.6, 0.08), lw: 0.6, ink: 'dark', border: 1.1, frame: 0 });
  const face = circle(0, C, R);
  k.panel(face, { tone: k.shadow ? 'black' : 'red', free: true, border: 1.2 });   // 彩绘小人的拍是红色（参考视频摄像头画面里的红点）
  const rim = new Path2D(); rim.arc(0, C, R - 2.4, 0, TAU);
  const hi = new Path2D(); hi.arc(0, C, R - 6, -2.6, -1.4);
  const g = k.g; g.save(); g.lineWidth = 1.1;
  g.strokeStyle = k.shadow ? 'rgba(120,90,60,0.35)' : 'rgba(255,255,255,0.22)'; g.stroke(rim);
  g.lineWidth = 2.2; g.strokeStyle = k.shadow ? 'rgba(150,120,90,0.18)' : 'rgba(255,255,255,0.3)'; g.stroke(hi);
  g.restore();
}

function sword(k) {
  const L = SK.swordLen, G = SK.swordGuard;
  // 剑穗：从剑首垂下（剑的 -y 方向）
  k.edge(line([[0, -12], [-3, -19], [-7, -25]]), 1.4, k.shadow ? undefined : 'red');
  const strands = new Path2D();
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    strands.moveTo(-8 + (t - 0.5) * 3, -30);
    strands.quadraticCurveTo(-10 + (t - 0.5) * 8, -40, -11 + (t - 0.5) * 12 - t * 2, -52 + Math.abs(t - 0.5) * 4);
  }
  const g = k.g; g.save(); g.lineWidth = 1.3; g.strokeStyle = k.shadow ? `rgba(${LEATHER},0.8)` : k.pal.red; g.stroke(strands); g.restore();
  k.panel(shape([[-8, -33, 1], [-4.2, -29], [-8, -24.5, 1], [-11.8, -29]]), { tone: 'trim', free: true, border: 1 });
  // 剑身：细长，中脊透光
  const blade = shape([[-4, G + 2, 1], [4, G + 2, 1], [3.6, L - 34], [2.5, L - 13], [0, L, 1], [-2.5, L - 13], [-3.6, L - 34]]);
  k.panel(blade, { tone: 'metal', free: true, border: 1.1 });
  k.carve(line([[0, G + 5], [0, L - 10]]), 1, '#8d979e', 0.7);
  // 柄（缠绳）+ 剑格 + 剑首环
  k.panel(shape([[-2.7, -7, 1], [2.7, -7, 1], [2.7, G - 2, 1], [-2.7, G - 2, 1]]), { tone: k.shadow ? 'dark' : 'red', free: true, pat: pat.stripes(2.4, 0.5), lw: 0.8, ink: 'dark', border: 1, frame: 0 });
  k.panel(shape([[-14, G - 3], [-10, G - 5.5], [-3, G - 3, 1], [3, G - 3, 1], [10, G - 5.5], [14, G - 3], [12, G + 2], [5, G + 3], [0, G + 6, 1], [-5, G + 3], [-12, G + 2]]), { tone: 'trim', free: true, border: 1.1 });
  k.cut(circle(-9.5, G - 1.5, 1.3).path, 0.9);
  k.cut(circle(9.5, G - 1.5, 1.3).path, 0.9);
  k.panel(circle(0, -10.5, 4), { tone: 'trim', free: true, border: 1 });
  k.cut(circle(0, -10.5, 1.8).path, 1);
}

// 舌头：从两唇之间伸出，向前略往下耷拉，舌尖圆、微下卷。
// rig 只沿 x 缩放（tongue 0..1），所以整体保持「沿 +x」，竖向起伏不大，缩短时也自然。
function tongue(k) {
  const sh = shape([[-3, -4, 1], [8, -3.6], [20, -1.8], [31, 1.6], [40, 5.6], [47, 9.2], [51.5, 13.5], [52, 19], [48.5, 22.5], [42, 22], [35, 18.5], [26, 13], [16, 8.6], [6, 5.6], [-3, 4, 1]]);
  k.panel(sh, { tone: 'tongue', free: true, border: 1.3 });
  // 舌面：shadow 下中间半透光，四周一圈深色
  if (k.shadow) k.cut(curve([[4, -1.2], [16, -0.2], [28, 3], [38, 7.4], [45, 11.4], [48.5, 15.5], [47.5, 19], [42.5, 19.2], [35, 15.6], [25, 10.8], [14, 6.4], [4, 2.4]]), 0.5);
  k.carve(line([[3, 0], [16, 2.4], [29, 6.6], [38, 11], [43, 14.5]]), 1.5, '#6a0b0e', 0.6);
  if (!k.shadow) k.edge(line([[6, -1.8], [19, -0.2], [30, 3], [40, 7.4], [46, 11]]), 1.4, '#e8606b');
}

// 部件表：包围盒（局部单位，含溢出的衣袖飘带）+ 绘制函数
const PART_DEFS = {
  torso: { box: [-66, -216, 72, 14], draw: torso },
  head: { box: (ch) => (ch === 'hero' ? [-168, -320, 60, 18] : [-130, -214, 62, 18]), draw: head },
  skirt: { box: [-194, -16, 146, 250], draw: skirt },
  upperArm: { box: [-24, -20, 24, 136], draw: upperArm },
  forearm: { box: [-18, -16, 18, 138], draw: forearm },
  leg: { box: [-24, -18, 68, 362], draw: leg },
  paddle: { box: [-33, -10, 33, 85], draw: paddle },
  sword: { box: [-20, -56, 18, 214], draw: sword },
  tongue: { box: [-5, -10, 58, 28], draw: tongue },
};
