// 测试替身：合成手（21 点，已镜像归一化，缓慢动）+ 控制量 + 导演（状态循环）
import { clamp, damp, rotate } from '../../src/core/math.js';

// 掌长为单位的左手模板（显示空间：拇指在右，y 向上为正）
const TEMPLATE = [
  [0, 0],
  [0.3, 0.18], [0.52, 0.38], [0.68, 0.58], [0.82, 0.76],
  [0.32, 0.95], [0.36, 1.32], [0.38, 1.55], [0.4, 1.75],
  [0.08, 1.0], [0.08, 1.42], [0.08, 1.68], [0.08, 1.9],
  [-0.15, 0.95], [-0.17, 1.33], [-0.19, 1.56], [-0.2, 1.75],
  [-0.36, 0.85], [-0.42, 1.13], [-0.46, 1.3], [-0.5, 1.46],
];
const CHAINS = { T: [1, 2, 3, 4], I: [5, 6, 7, 8], M: [9, 10, 11, 12], R: [13, 14, 15, 16], L: [17, 18, 19, 20] };

export class SynthHand {
  constructor() {
    this.state = {
      tracked: false, source: 'camera', handedness: 'Left', landmarks: null,
      palm: { x: 0.5, y: 0.5 }, palmSize: 0, fingers: {}, motion: 0,
      stats: { renderHz: 60, trackHz: 30, inferenceMs: 11.7, sampleAgeMs: 17 },
    };
    this.thumb = 0; this.pinky = 0; this.roll = 0;
  }
  // t 秒；lostEvery：每隔多少秒丢手 2 秒（0 = 不丢）
  update(t, dt, { lostEvery = 0 } = {}) {
    const s = this.state;
    s.tracked = !(lostEvery && t % lostEvery > lostEvery - 2);
    const P = 0.2 + 0.03 * Math.sin(t * 0.7);                 // 掌长（按视频高度归一化）
    const wx = 0.3 + 0.07 * Math.sin(t * 0.45), wy = 0.8 + 0.04 * Math.sin(t * 0.6);
    this.roll = 0.18 * Math.sin(t * 0.5);
    this.thumb = Math.sin(t * 1.3);                            // -1..1
    this.pinky = Math.sin(t * 0.9 + 1);
    const lm = TEMPLATE.map(([u, v], i) => {
      let x = u, y = v;
      if (i >= 1 && i <= 4) { const r = rotate(x - 0.3, y - 0.18, -this.thumb * 0.35 * (i / 4)); x = r.x + 0.3; y = r.y + 0.18; }
      if (i >= 17) { const r = rotate(x + 0.36, y - 0.85, this.pinky * 0.3); x = r.x - 0.36; y = r.y + 0.85; }
      const r = rotate(x, -y, this.roll);
      return { x: wx + (r.x * P * 480) / 640, y: wy + r.y * P, z: 0 };
    });
    const palm = { x: 0, y: 0 };
    for (const i of [0, 5, 9, 13, 17]) { palm.x += lm[i].x / 5; palm.y += lm[i].y / 5; }
    const v = Math.hypot(palm.x - s.palm.x, (palm.y - s.palm.y) * 0.75) * 640 / Math.max(dt, 1e-3);
    s.motion = s.motion * 0.8 + v * 0.2;
    s.palm = palm;
    s.landmarks = lm;
    s.palmSize = Math.hypot(lm[9].x - lm[0].x, (lm[9].y - lm[0].y) * 0.75);
    for (const k in CHAINS) {
      const tip = lm[CHAINS[k][3]];
      const ext = k === 'T' ? 0.6 + 0.4 * this.thumb : k === 'L' ? 0.75 + 0.2 * this.pinky : 0.85 + 0.1 * Math.sin(t + k.charCodeAt(0));
      s.fingers[k] = { ext: clamp(ext, 0, 1), angle: 0, tip: { x: tip.x, y: tip.y } };
    }
    s.stats.renderHz = Math.round(1 / Math.max(dt, 1e-3));
    s.stats.sampleAgeMs = 12 + Math.round(10 * Math.abs(Math.sin(t * 3)));
    s.stats.inferenceMs = 11 + 1.5 * Math.abs(Math.sin(t * 1.7));
    return s;
  }
}

// 控制量替身：由合成手参数直接给出
export class FakeControl {
  constructor() {
    this.c = { active: false, px: 0.5, py: 0.5, lean: 0, paddleArm: -0.3, paddleSwing: 0, swordArm: 0, swordSpin: 0,
      swordFlip: false, fingers: { T: 0, I: 0, M: 0, R: 0, L: 0 }, position: 0.5, motion: 0 };
  }
  update(synth, dt, spin = 0) {
    const c = this.c, s = synth.state;
    c.active = s.tracked;
    const prev = c.paddleArm;
    c.px = clamp((s.palm.x - 0.2) / 0.6, 0, 1);
    c.position = c.px;
    c.lean = -synth.roll * 0.8;
    c.paddleArm = synth.thumb;
    c.paddleSwing = (c.paddleArm - prev) / Math.max(dt, 1e-3);
    c.swordArm = synth.pinky;
    c.swordSpin = damp(c.swordSpin, spin, 6, dt);
    for (const k in c.fingers) c.fingers[k] = s.tracked ? s.fingers[k].ext : damp(c.fingers[k], 0, 2, dt);
    c.motion = s.tracked ? s.motion : damp(c.motion, 0, 4, dt);
    return c;
  }
}

const STATES = ['SERVE', 'FLIGHT', 'RECEIVE', 'FLIGHT', 'CELEBRATING', 'BATTLE / IDLE', 'BATTLE / ATTACK', 'BATTLE / GROUND', 'BATTLE / ESCAPE'];
const EVENTS = ['table contact', 'paddle armed', 'player return', 'CPU return accepted', 'table contact', 'return missed', 'rally ended / next serve', 'sword hit'];

// 导演替身：状态每 period 秒切换（fixed 时固定），定时推事件
export class FakeDirector {
  constructor(events, { fixed = null, period = 2.5 } = {}) {
    this.events = events; this.fixed = fixed; this.period = period;
    this.mode = 'PINGPONG'; this.status = fixed || 'SERVE'; this.paddleState = 'follow';
    this.ball = { x: 800, y: 500, r: 9, visible: true, trail: [] };
    this.tableAlpha = 1;
    this.stats = { returns: 0, rallyTime: 0, scorePlayer: 0, scoreCpu: 0, hits: 0 };
    this.t = 0; this.nextEv = 0.4; this.ei = 0;
  }
  update(dt) {
    this.t += dt;
    this.status = this.fixed || STATES[Math.floor(this.t / this.period) % STATES.length];
    this.mode = this.status.startsWith('BATTLE') ? 'BATTLE' : 'PINGPONG';
    this.paddleState = ['follow', 'armed', 'swing'][Math.floor(this.t / 0.9) % 3];
    this.stats.rallyTime += dt;
    if (this.t >= this.nextEv) {
      const text = EVENTS[this.ei++ % EVENTS.length];
      this.events.push(text);
      if (/return|hit/.test(text) && !/miss/.test(text)) { this.stats.returns++; this.stats.hits++; }
      if (/missed/.test(text)) { this.stats.scoreCpu++; this.stats.rallyTime = 0; this.stats.returns = 0; }
      this.nextEv = this.t + 0.5 + (this.ei % 3) * 0.35;
    }
  }
}
