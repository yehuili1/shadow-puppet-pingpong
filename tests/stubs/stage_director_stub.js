// 测试替身：Director（球沿抛物线在两拍之间来回飞、触桌发 'table contact'；tableAlpha 周期淡出；定时 'sword hit'）
import { TABLE, BALL_R, PELVIS_Y } from '../../src/core/world.js';
import { events } from '../../src/core/events.js';

export class StubDirector {
  constructor({ swordEvery = 6, tableCycle = 14 } = {}) {
    this.mode = 'PINGPONG';
    this.status = 'FLIGHT';
    this.ball = { x: 470, y: 640, r: BALL_R, visible: true, trail: [] };
    this.tableAlpha = 1;
    this.stats = { returns: 0, rallyTime: 0, scorePlayer: 0, scoreCpu: 0, hits: 0 };
    this.paddleState = 'follow';
    this.t = 0;
    this.u = 0;            // 当前回合进度 0..1
    this.dir = 1;          // +1 玩家→电脑
    this.bounced = false;
    this.swordEvery = swordEvery;
    this.tableCycle = tableCycle;
    this.nextSword = swordEvery * 0.5;
  }

  // 一个回合：A（击球点）→ B（对方半桌弹点）→ C（对方拍）
  _path(u) {
    const A = { x: this.dir > 0 ? 480 : 1120, y: 640 };
    const C = { x: this.dir > 0 ? 1120 : 480, y: 645 };
    const B = { x: this.dir > 0 ? 905 : 695, y: TABLE.topY - BALL_R };
    const split = 0.52;
    if (u < split) {
      const k = u / split;
      return { x: A.x + (B.x - A.x) * k, y: A.y + (B.y - A.y) * k - 4 * 150 * k * (1 - k) };
    }
    const k = (u - split) / (1 - split);
    return { x: B.x + (C.x - B.x) * k, y: B.y + (C.y - B.y) * k - 4 * 170 * k * (1 - k) };
  }

  update(dt, { playerRig, cpuRig } = {}) {
    this.t += dt;
    this.u += dt / 1.15;
    if (!this.bounced && this.u >= 0.52) { this.bounced = true; events.push('table contact'); }
    if (this.u >= 1) {
      this.u -= 1;
      this.dir *= -1;
      this.bounced = false;
      this.stats.returns++;
      events.push(this.dir > 0 ? 'player return' : 'CPU return accepted');
    }
    const p = this._path(this.u);
    this.ball.x = p.x;
    this.ball.y = p.y;
    this.ball.trail.unshift({ x: p.x, y: p.y });
    if (this.ball.trail.length > 24) this.ball.trail.length = 24;
    this.stats.rallyTime = this.t;

    // 桌子周期淡出（模拟武斗）
    const c = (this.t % this.tableCycle) / this.tableCycle;
    this.tableAlpha = c < 0.7 ? 1 : c < 0.8 ? 1 - (c - 0.7) / 0.1 : c < 0.9 ? 0 : (c - 0.9) / 0.1;

    if (this.swordEvery > 0 && this.t >= this.nextSword) {
      this.nextSword += this.swordEvery;
      events.push('sword hit');
    }

    // 皮影姿态：轻微摆动 + 拍子迎球
    const sw = Math.sin(this.t * 1.7);
    playerRig?.setPose({ x: 320 + 40 * Math.sin(this.t * 0.6), y: PELVIS_Y + 10 * sw, lean: 0.06 * sw,
      frontShoulder: -1.25 + 0.25 * Math.sin(this.t * 3.1), frontElbow: -0.35, backShoulder: -0.6 + 0.3 * sw, swordAngle: -0.8 });
    cpuRig?.setPose({ x: 1280 - 30 * Math.sin(this.t * 0.5 + 1), y: PELVIS_Y - 6 * sw, lean: -0.05 * sw,
      frontShoulder: -1.2 + 0.25 * Math.sin(this.t * 2.6 + 1), frontElbow: -0.4, backShoulder: 0.5 });
    playerRig?.update(dt);
    cpuRig?.update(dt);
  }
}
