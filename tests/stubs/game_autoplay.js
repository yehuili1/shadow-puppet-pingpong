// 测试用自动玩家：看球的预测轨迹 → 反推 control（px / paddleArm），带反应延迟、跟手延迟、误差和偶发失误
import { Director } from '../../src/game/director.js';
import { TABLE } from '../../src/core/world.js';
import { damp } from '../../src/core/math.js';
import { FakeRig } from './game_fake_rig.js';

export const makeControl = (o = {}) => ({
  active: true, px: 0.5, py: 0.5, lean: 0, paddleArm: 0, paddleSwing: 0, swordArm: -0.5, swordSpin: 0, swordFlip: false,
  fingers: { T: 0.5, I: 1, M: 1, R: 1, L: 0.5 }, position: 0.5, motion: 0, ...o,
});

// 黑盒标定：扫 px × paddleArm，记录玩家拍子稳态位置（py=0.5、lean=0）
export function calibrate(nx = 40, na = 40) {
  const d = new Director(), pr = new FakeRig({ facing: 1 }), cr = new FakeRig({ facing: -1 });
  const table = [];
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= na; j++) {
      const px = i / nx, arm = -1 + (2 * j) / na;
      d.update(1 / 60, { control: makeControl({ px, paddleArm: arm }), playerRig: pr, cpuRig: cr });
      pr.snap();
      pr.update(0);
      table.push({ px, arm, x: pr.paddle.x, y: pr.paddle.y });
    }
  }
  return table;
}

const gauss = (rng) => (rng() + rng() + rng() - 1.5) * 1.4;
const READY = { x: 470, y: 600 };

// 来球在玩家半台弹起后、二次落台前的击球点（偏好桌端左侧、高度合适）
export function playerIntercept(pp) {
  let apex = null;
  for (const s of pp.predict(1.8)) {
    if (pp.bounces + s.n !== 1 || s.x > TABLE.netX) continue;
    if (!apex || s.y < apex.y) apex = s;
    if (s.x <= 600 && s.y <= 690 && s.y >= 480) return s;
  }
  return apex;
}

export class AutoPlayer {
  constructor(table, { lapse = 0.12, react = 0.16, noise = 10, rng = Math.random } = {}) {
    this.table = table;
    this.opt = { lapse, react, noise };
    this.rng = rng;
    this.c = makeControl();
    this.t = 0;
    this.hitId = -1;
    this.aim = null;
    this.lapses = 0;
  }

  inverse(tx, ty) {
    let best = null, bc = Infinity;
    for (const e of this.table) {
      const cost = (e.x - tx) ** 2 + (e.y - ty) ** 2 + 2000 * (e.px - this.c.px) ** 2 + 400 * (e.arm - this.c.paddleArm) ** 2;
      if (cost < bc) {
        bc = cost;
        best = e;
      }
    }
    return best;
  }

  update(dt, d, playerRig) {
    const pp = d.pp, c = this.c, rng = this.rng;
    this.t += dt;
    c.swordFlip = false;
    let target = READY;
    if (d.mode === 'PINGPONG' && pp.phase === 'play' && pp.lastHitter === 'cpu') {
      if (pp.hitId !== this.hitId) {
        this.hitId = pp.hitId;
        this.reactAt = this.t + this.opt.react + rng() * 0.08;
        this.err = { x: gauss(rng) * this.opt.noise, y: gauss(rng) * this.opt.noise };
        this.lapse = rng() < this.opt.lapse;   // 失误：判断错高度，拍子举高后就不再跟球
        if (this.lapse) this.lapses++;
        this.aim = null;
      }
      if (this.t >= this.reactAt && !(this.lapse && this.aim)) {
        const s = playerIntercept(pp);
        if (s) this.aim = { x: s.x + this.err.x, y: s.y + this.err.y - (this.lapse ? 210 : 0) };
      }
      if (this.aim) target = this.aim;
    } else this.aim = null;

    const cmd = this.inverse(target.x, target.y);
    let arm = cmd.arm;
    // 发球：拿稳 0.8s 后抬大拇指
    if (pp.phase === 'hold' && pp.server === 'player' && pp.timer > 0.8) arm = 0.6;
    c.px = damp(c.px, cmd.px, 10, dt);
    c.paddleArm = damp(c.paddleArm, arm, 10, dt);
    // 球快到拍子时挥一下
    const pad = playerRig.paddle, b = pp.ball;
    const near = pp.lastHitter === 'cpu' && Math.hypot(b.x - pad.x, b.y - pad.y) < 110;
    c.paddleSwing = near ? 3 + rng() * 5 : damp(c.paddleSwing, 0, 8, dt);
    return c;
  }
}
