// 离线回放：把 tests/tracking.html?rec=1 录下的原始检测（window.__raw）喂给真实的 HandTracker + ControlMapper
// 用法：node tests/stubs/tracking_replay.mjs <raw.json> <out.json> [注入调转的视频时刻 s ...]
// 输出：逐帧（60Hz）Control 时间序列 + 统计，便于标定映射区间
// 注入：在指定时刻把真实检测到的手绕掌心 0.25s 内转 150°、0.4s 转回（模拟快速翻腕，带真实追踪噪声）
import fs from 'node:fs';
import { HandTracker } from '../../src/tracking/hand.js';
import { ControlMapper } from '../../src/tracking/control.js';

const [, , inPath, outPath, ...injectAt] = process.argv;
const injects = injectAt.map(Number);
const smooth = (x) => x * x * (3 - 2 * x);
const turnAngle = (t) => {
  for (const t0 of injects) {
    const u = t - t0;
    if (u >= 0 && u < 0.25) return -150 * smooth(u / 0.25);
    if (u >= 0.25 && u < 0.65) return -150 * (1 - smooth((u - 0.25) / 0.4));
  }
  return 0;
};
const rotateHand = (h, deg) => {
  if (!deg) return h;
  const r = (deg * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
  let cx = 0, cy = 0;
  for (const i of [0, 5, 9, 13, 17]) { cx += h[2 + i * 3] * 640 / 5; cy += h[3 + i * 3] * 480 / 5; }
  const out = h.slice();
  for (let i = 0; i < 21; i++) {
    const x = h[2 + i * 3] * 640 - cx, y = h[3 + i * 3] * 480 - cy;
    out[2 + i * 3] = (cx + x * c - y * sn) / 640;
    out[3 + i * 3] = (cy + x * sn + y * c) / 480;
  }
  return out;
};
const LOOP = 1343 / 30;
const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));

// 录制时间按视频时刻取模，展开成单调时间轴
let off = 0, prev = -1;
const recs = raw.map(([t, hands]) => {
  if (t + off < prev - 1) off += LOOP;
  prev = t + off;
  return { t: t + off, hands: hands.map((h) => rotateHand(h, turnAngle(t))) };
});

const video = { readyState: 4, currentTime: 0, videoWidth: 640, videoHeight: 480 };
const tracker = new HandTracker({ video });
let pending = null;
tracker.landmarker = {
  detectForVideo: () => ({
    landmarks: pending.hands.map((h) => {
      const pts = [];
      for (let i = 0; i < 21; i++) pts.push({ x: h[2 + i * 3], y: h[3 + i * 3], z: h[4 + i * 3] });
      return pts;
    }),
    handedness: pending.hands.map((h) => [{ categoryName: h[0], score: h[1] }]),
  }),
};
tracker.cameraOn = true;
tracker.aspect = 4 / 3;
const mapper = new ControlMapper();

const out = [];
const flips = [];
const dt = 1 / 60;
let k = 0;
const t0 = recs[0].t, t1 = recs[recs.length - 1].t;
for (let t = t0; t <= t1 + 0.5; t += dt) {
  const now = t * 1000;
  let fresh = null;
  while (k < recs.length && recs[k].t <= t) fresh = recs[k++];
  if (fresh) {
    pending = fresh;
    video.currentTime = fresh.t;
    tracker._lastDetect = -Infinity; // 回放：有新记录就检测
  }
  tracker.update(now);
  const c = mapper.update(tracker.state, dt);
  const s = tracker.state;
  if (c.swordFlip) flips.push(+(t % LOOP).toFixed(2));
  out.push([+(t % LOOP).toFixed(3), s.tracked ? 1 : 0, +c.px.toFixed(3), +c.py.toFixed(3), +c.lean.toFixed(3),
    +c.paddleArm.toFixed(3), +c.paddleSwing.toFixed(2), +c.swordArm.toFixed(3), Math.round(c.swordSpin), c.fingers.L.toFixed(2) * 1, Math.round(c.motion), mapper._chir, s.landmarks ? Math.round(s.fingers.T.angle * 57.3) : 0, s.landmarks ? Math.round(s.fingers.L.angle * 57.3) : 0, Math.round(mapper._spinRaw)]);
}

const fields = ['t', 'tracked', 'px', 'py', 'lean', 'paddleArm', 'paddleSwing', 'swordArm', 'swordSpin', 'extL', 'motion', 'chir', 'thumbDeg', 'pinkyDeg', 'spinRaw'];
const stats = {};
for (const [i, f] of fields.entries()) {
  if (i < 2 || i > 10) continue;
  const v = out.filter((r) => r[1]).map((r) => r[i]).sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  stats[f] = { min: v[0], p05: q(0.05), p50: q(0.5), p95: q(0.95), max: v[v.length - 1] };
}
fs.writeFileSync(outPath, JSON.stringify({ fields, rows: out, flips }));
console.log(JSON.stringify({ frames: out.length, tracked: out.filter((r) => r[1]).length, flips, stats }, null, 1));
