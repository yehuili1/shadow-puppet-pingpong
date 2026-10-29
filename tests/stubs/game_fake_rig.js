// 测试替身：按 SPEC 的 PuppetRig 接口实现的简化皮影（弹簧平滑 + 正运动学 + 两骨 IK；draw 画火柴人）
import { SK } from '../../src/puppet/skeleton.js';
import { PADDLE_R, PELVIS_Y } from '../../src/core/world.js';
import { clamp, rotate } from '../../src/core/math.js';

const DEFAULT = {
  x: 800, y: PELVIS_Y, lean: 0, headTilt: 0, frontShoulder: 0, frontElbow: 0, backShoulder: 0, backElbow: 0,
  swordAngle: 0, frontLeg: 0, backLeg: 0, tongue: 0, fallen: 0, visible: 1,
};
const dir = (a, len) => ({ x: -Math.sin(a) * len, y: Math.cos(a) * len });
const add = (p, q) => ({ x: p.x + q.x, y: p.y + q.y });

export class FakeRig {
  // stiffness 越小越「软」；dampingRatio < 1 会晃
  constructor({ character = 'hero', facing = 1, scale = 1, stiffness = 260, dampingRatio = 1 } = {}) {
    this.character = character;
    this.facing = facing;
    this.scale = scale;
    this.k = stiffness;
    this.c = 2 * Math.sqrt(stiffness) * dampingRatio;
    this.target = { ...DEFAULT, x: facing > 0 ? 300 : 1300 };
    this.pose = { ...this.target };
    this.vel = Object.fromEntries(Object.keys(DEFAULT).map((k) => [k, 0]));
    this.update(0);
  }

  setPose(p) {
    for (const k in p) if (k in this.target && Number.isFinite(p[k])) this.target[k] = p[k];
  }

  snap() {
    Object.assign(this.pose, this.target);
    for (const k in this.vel) this.vel[k] = 0;
  }

  update(dt) {
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n && dt > 0; i++) {
      for (const k in this.pose) {
        const a = this.k * (this.target[k] - this.pose[k]) - this.c * this.vel[k];
        this.vel[k] += a * h;
        this.pose[k] += this.vel[k] * h;
      }
    }
    const prev = this.paddle && { p: this.paddle, s: this.swordTip };
    this.solve();
    if (prev && dt > 0) {
      this.paddle.vx = (this.paddle.x - prev.p.x) / dt;
      this.paddle.vy = (this.paddle.y - prev.p.y) / dt;
      this.swordTip.vx = (this.swordTip.x - prev.s.x) / dt;
      this.swordTip.vy = (this.swordTip.y - prev.s.y) / dt;
    } else if (prev) {
      Object.assign(this.paddle, { vx: prev.p.vx, vy: prev.p.vy });
      Object.assign(this.swordTip, { vx: prev.s.vx, vy: prev.s.vy });
    }
  }

  // 正运动学 → 世界关节
  solve() {
    const p = this.pose, f = this.facing, s = this.scale;
    const footY = SK.frontHip.y + SK.legLen;
    const W = (q) => {
      let { x, y } = q;
      if (p.fallen) {
        const r = rotate(x, y - footY, (-p.fallen * Math.PI) / 2); // 绕脚向后躺平
        x = r.x;
        y = r.y + footY;
      }
      return { x: p.x + f * x * s, y: p.y + y * s };
    };
    const T = (x, y) => rotate(x, y, p.lean);
    const arm = (sh, s1, s2, extra) => {
      const a1 = p.lean + s1, a2 = a1 + s2;
      const e = add(sh, dir(a1, SK.upperArmLen));
      const w = add(e, dir(a2, SK.forearmLen));
      return { e, w, a2, end: add(w, dir(a2, extra)) };
    };
    const fs = T(SK.frontShoulder.x, SK.frontShoulder.y), bs = T(SK.backShoulder.x, SK.backShoulder.y);
    const fa = arm(fs, p.frontShoulder, p.frontElbow, SK.paddleCenter);
    const ba = arm(bs, p.backShoulder, p.backElbow, 0);
    const tip = add(ba.w, dir(ba.a2 + p.swordAngle, SK.swordLen));
    const neck = T(SK.neck.x, SK.neck.y);
    const head = add(neck, rotate(0, -75, p.lean + p.headTilt));
    const headTop = add(neck, rotate(SK.headTop.x, SK.headTop.y, p.lean + p.headTilt));
    const pc = W(fa.end);
    this.paddle = { x: pc.x, y: pc.y, r: PADDLE_R * s, vx: 0, vy: 0, angle: f * (fa.a2 + p.lean) };
    this.swordBase = W(ba.w);
    this.swordTip = { ...W(tip), vx: 0, vy: 0 };
    this.bodyHit = [
      { ...W(T(0, -90)), r: 50 * s },
      { ...W(T(0, -160)), r: 44 * s },
      { ...W(head), r: 46 * s },
    ];
    this.controlPoints = { head: W(headTop), frontHand: W(fa.w), backHand: W(ba.w), pelvis: W({ x: 0, y: 0 }) };
    this.lines = [
      [W({ x: 0, y: 0 }), W(neck)], [W(neck), W(headTop)],
      [W(fs), W(fa.e)], [W(fa.e), W(fa.w)], [W(fa.w), pc],
      [W(bs), W(ba.e)], [W(ba.e), W(ba.w)], [W(ba.w), W(tip)],
      [W({ x: 10, y: 6 }), W(add({ x: 10, y: 6 }, dir(p.frontLeg, SK.legLen)))],
      [W({ x: -10, y: 6 }), W(add({ x: -10, y: 6 }, dir(p.backLeg, SK.legLen)))],
    ];
    if (p.tongue > 0.02) {
      const m = add(neck, rotate(SK.mouth.x, SK.mouth.y, p.lean + p.headTilt));
      this.lines.push([W(m), W(add(m, { x: SK.tongueLen * p.tongue, y: 4 }))]);
    }
  }

  // 世界目标点 → facing-local 肩/肘角（两骨 IK；前臂末端 = 拍心，后臂 = 手腕；按目标姿态的骨盆）
  ikArm(arm, tx, ty) {
    const p = this.target, sh = arm === 'front' ? SK.frontShoulder : SK.backShoulder;
    const L1 = SK.upperArmLen, L2 = SK.forearmLen + (arm === 'front' ? SK.paddleCenter : 0);
    const l = rotate(((tx - p.x) * this.facing) / this.scale, (ty - p.y) / this.scale, -p.lean);
    const dx = l.x - sh.x, dy = l.y - sh.y;
    const d = clamp(Math.hypot(dx, dy), Math.abs(L1 - L2) + 1, L1 + L2 - 0.5);
    const phi = Math.atan2(-dx, dy);
    const a = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
    const b = Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
    return { shoulder: phi + a, elbow: b - Math.PI };
  }

  // 调试用火柴人
  draw(ctx, { alpha = 1 } = {}) {
    ctx.save();
    ctx.globalAlpha = alpha * this.pose.visible;
    ctx.strokeStyle = this.facing > 0 ? '#3b2a1a' : '#5a2a2a';
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    for (const [a, b] of this.lines) {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(40,25,15,.5)';
    for (const c of this.bodyHit) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(this.paddle.x, this.paddle.y, this.paddle.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
