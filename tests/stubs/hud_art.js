// 测试替身：art.js（未就绪时由 tests/hud.html 的 import map 重定向到这里）
// 按 skeleton.js 的尺寸/枢轴约定画简化部件；color = 彩绘小人，shadow = 深褐透光
import { SK } from '../../src/puppet/skeleton.js';
import { PADDLE_R } from '../../src/core/world.js';

const cache = new Map();
const PAL = {
  color: { hero: ['#C8202E', '#1E8C5A', '#E3A92B', '#2B2B6E'], rival: ['#2B5FC8', '#8C1E6A', '#E3A92B', '#3A2B1E'] },
  shadow: { hero: ['#3a2a1c', '#46321f', '#2e2016', '#3a2a1c'], rival: ['#3a2a1c', '#46321f', '#2e2016', '#3a2a1c'] },
};

function make(w, h, ox, oy, fn) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.translate(ox, oy);
  fn(g);
  return { img: c, ox, oy, s: 1 };
}
const poly = (g, pts, fill) => { g.fillStyle = fill; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill(); };

function build(character, style, part) {
  const [a, b, c, d] = PAL[style]?.[character] || PAL.color.hero;
  const color = style === 'color';
  switch (part) {
    case 'torso': return make(130, 230, 65, 215, (g) => {
      poly(g, [[-35, 0], [35, 0], [46, -SK.torsoLen], [-46, -SK.torsoLen]], a);
      if (color) { g.fillStyle = c; g.fillRect(-30, -150, 60, 14); g.fillRect(-26, -90, 52, 10); }
    });
    case 'head': return make(170, 180, 85, 170, (g) => {
      g.fillStyle = d; g.beginPath(); g.arc(-18, -95, 58, 0, Math.PI * 2); g.fill();     // 头饰
      g.fillStyle = c; g.beginPath(); g.arc(8, -62, 38, 0, Math.PI * 2); g.fill();
      g.fillStyle = color ? '#F0C9A0' : b; g.beginPath(); g.arc(22, -56, 26, 0, Math.PI * 2); g.fill();
      poly(g, [[0, -150], [-30, -100], [26, -104]], b);
    });
    case 'skirt': return make(200, 190, 100, 8, (g) => {
      poly(g, [[-55, 0], [55, 0], [85, SK.skirtLen], [-85, SK.skirtLen]], b);
      if (color) { g.fillStyle = c; g.fillRect(-70, 120, 140, 12); }
    });
    case 'upperArm': return make(40, 150, 20, 12, (g) => { g.fillStyle = c; g.fillRect(-13, -6, 26, SK.upperArmLen + 12); });
    case 'forearm': return make(40, 160, 20, 10, (g) => {
      g.fillStyle = a; g.fillRect(-11, -6, 22, SK.forearmLen + 6);
      g.fillStyle = color ? '#F0C9A0' : b; g.beginPath(); g.arc(0, SK.forearmLen + 10, 11, 0, Math.PI * 2); g.fill();
    });
    case 'leg': return make(110, 380, 30, 12, (g) => {
      g.fillStyle = d; g.fillRect(-15, -6, 30, SK.legLen);
      poly(g, [[-16, SK.legLen - 10], [SK.bootLen, SK.legLen], [SK.bootLen, SK.legLen + 16], [-16, SK.legLen + 16]], color ? '#111' : a);
    });
    case 'paddle': return make(80, 100, 40, 4, (g) => {
      g.fillStyle = '#222'; g.fillRect(-3, 0, 6, SK.paddleHandle + 4);
      g.fillStyle = color ? '#E0202A' : '#111'; g.beginPath(); g.arc(0, SK.paddleCenter, PADDLE_R, 0, Math.PI * 2); g.fill();
    });
    case 'sword': return make(30, 236, 15, 8, (g) => {
      g.fillStyle = c; g.fillRect(-10, 12, 20, 6);
      poly(g, [[-4, 18], [4, 18], [0, SK.swordLen]], color ? '#D8D8D8' : '#2a1d12');
    });
    case 'tongue': return make(60, 24, 4, 12, (g) => { g.fillStyle = '#E2445C'; g.fillRect(0, -6, SK.tongueLen, 12); });
  }
  return null;
}

export async function loadPuppetArt() {}
export function getPart(character, style, part) {
  const key = `${character}/${style}/${part}`;
  if (!cache.has(key)) cache.set(key, build(character, style, part));
  return cache.get(key);
}
