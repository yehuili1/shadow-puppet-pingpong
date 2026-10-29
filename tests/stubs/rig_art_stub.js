// 测试替身：严格按 art.js 的 getPart 契约，用色块画各部件（facing-local 静止朝向），枢轴处画红十字。
// 分辨率倍数 2 → s = 0.5，顺带验证 rig 对 s 的处理。
import { SK } from '/src/puppet/skeleton.js';
import { PADDLE_R } from '/src/core/world.js';

const RES = 2;
const cache = new Map();

export async function loadPuppetArt() {}

export function getPart(character, style, part) {
  const key = `${character}/${style}/${part}`;
  let p = cache.get(key);
  if (!p) cache.set(key, (p = make(character, style, part)));
  return p;
}

const HUE = { torso: 210, head: 30, skirt: 280, upperArm: 120, forearm: 170, leg: 60, paddle: 0, sword: 0, tongue: 350 };

function poly(g, pts) {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.fill();
  g.stroke();
}

// 每个部件：包围盒（局部单位，枢轴 = 原点）+ 绘制
const DEFS = {
  torso: [[-52, -210, 52, 6], (g) => {
    poly(g, [[-SK.torsoWBottom / 2, 0], [SK.torsoWBottom / 2, 0], [SK.torsoWTop / 2, -SK.torsoLen], [-SK.torsoWTop / 2, -SK.torsoLen]]);
    g.fillStyle = '#fff'; poly(g, [[30, -120], [44, -110], [30, -100]]); // 前胸三角：标出朝前
  }],
  head: [[-46, -156, 52, 6], (g) => {
    g.beginPath(); g.arc(4, -48, 37, 0, Math.PI * 2); g.fill(); g.stroke();
    poly(g, [[-30, -80], [30, -80], [0, -SK.headH]]);                  // 头饰
    g.fillStyle = '#fff'; g.beginPath(); g.arc(22, -58, 6, 0, Math.PI * 2); g.fill(); // 眼睛（朝前）
    g.fillStyle = '#000'; g.fillRect(SK.mouth.x - 10, SK.mouth.y - 2, 10, 4);         // 嘴
  }],
  skirt: [[-88, -6, 88, SK.skirtLen + 6], (g) => {
    poly(g, [[-SK.skirtWTop / 2, 0], [SK.skirtWTop / 2, 0], [SK.skirtWBottom / 2, SK.skirtLen], [-SK.skirtWBottom / 2, SK.skirtLen]]);
  }],
  upperArm: [[-16, -10, 16, SK.upperArmLen + 10], (g) => {
    g.beginPath(); g.roundRect(-SK.upperArmW / 2, -8, SK.upperArmW, SK.upperArmLen + 16, 12); g.fill(); g.stroke();
  }],
  forearm: [[-14, -8, 14, SK.forearmLen + SK.handLen + 6], (g) => {
    g.beginPath(); g.roundRect(-SK.forearmW / 2, -6, SK.forearmW, SK.forearmLen + 6, 10); g.fill(); g.stroke();
    g.beginPath(); g.arc(0, SK.forearmLen + 8, 11, 0, Math.PI * 2); g.fill(); g.stroke();  // 手
  }],
  leg: [[-18, -10, 64, SK.legLen + 16], (g) => {
    g.beginPath(); g.roundRect(-SK.legW / 2, -8, SK.legW, SK.legLen + 8, 12); g.fill(); g.stroke();
    poly(g, [[-16, SK.legLen - 10], [SK.bootLen + 10, SK.legLen + 2], [SK.bootLen + 10, SK.legLen + 12], [-16, SK.legLen + 12]]); // 靴尖朝前
  }],
  paddle: [[-PADDLE_R - 2, -4, PADDLE_R + 2, SK.paddleCenter + PADDLE_R + 2], (g) => {
    g.fillRect(-3, 0, 6, SK.paddleHandle);
    g.fillStyle = '#111'; g.beginPath(); g.arc(0, SK.paddleCenter, PADDLE_R, 0, Math.PI * 2); g.fill(); g.stroke();
  }],
  sword: [[-14, -26, 14, SK.swordLen + 4], (g) => {
    g.fillStyle = '#6b4a2a'; g.fillRect(-3, -22, 6, 22);                           // 剑柄
    g.fillStyle = '#c9a14a'; g.fillRect(-12, SK.swordGuard - 3, 24, 6);            // 护手
    g.fillStyle = '#cfd6dc'; poly(g, [[-5, SK.swordGuard + 3], [5, SK.swordGuard + 3], [0, SK.swordLen]]); // 剑刃
  }],
  tongue: [[-2, -10, SK.tongueLen + 4, 10], (g) => {
    g.fillStyle = '#e0304a'; g.beginPath(); g.ellipse(SK.tongueLen / 2, 0, SK.tongueLen / 2, 7, 0, 0, Math.PI * 2); g.fill();
  }],
};

function make(character, style, part) {
  const [[x0, y0, x1, y1], draw] = DEFS[part];
  const c = document.createElement('canvas');
  c.width = Math.ceil((x1 - x0) * RES);
  c.height = Math.ceil((y1 - y0) * RES);
  const g = c.getContext('2d');
  g.scale(RES, RES);
  g.translate(-x0, -y0);
  const light = character === 'hero' ? 42 : 28;
  const a = style === 'shadow' ? 0.82 : 1;
  g.fillStyle = `hsla(${HUE[part]}, 55%, ${style === 'color' ? light + 18 : light}%, ${a})`;
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = 1.5;
  draw(g);
  // 枢轴红十字
  g.strokeStyle = '#ff2020';
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(-6, 0); g.lineTo(6, 0); g.moveTo(0, -6); g.lineTo(0, 6); g.stroke();
  return { img: c, ox: -x0 * RES, oy: -y0 * RES, s: 1 / RES };
}
