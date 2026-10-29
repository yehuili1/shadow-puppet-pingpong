// 乒乓：侧视 2D 物理（固定子步）+ 简化规则 + 计分/统计/事件。常量全部来自 core/world.js
import { WORLD, TABLE, BALL_R, PADDLE_R } from '../core/world.js';
import { events } from '../core/events.js';
import { clamp, lerp, damp } from '../core/math.js';

export const SUBSTEP = 1 / 240;
const REST = 0.88;        // 桌面恢复系数
const FRICTION = 0.98;    // 桌面水平阻尼
const TRAIL = 14;
const LAND_Y = TABLE.topY - BALL_R;
// 命中半径：玩家一侧宽容，让手势也打得到
export const HIT_R = { player: PADDLE_R + BALL_R + 24, cpu: PADDLE_R + BALL_R + 8 };
const HOLD = { player: { x: 8, y: -38 }, cpu: { x: -8, y: -38 } };   // 发球时球在拍子上方
const other = (s) => (s === 'player' ? 'cpu' : 'player');
const rand = (a, b) => a + Math.random() * (b - a);

// 单步积分；返回本步接触 'table' | 'net' | 'floor' | 'away' | null（实际与预测共用）
export function stepBall(b, h) {
  const px = b.x, py = b.y;
  b.vy += WORLD.gravity * h;
  b.x += b.vx * h;
  b.y += b.vy * h;
  if (b.vy > 0 && py <= LAND_Y && b.y > LAND_Y && b.x >= TABLE.x0 && b.x <= TABLE.x1) {
    b.y = LAND_Y - (b.y - LAND_Y) * REST;
    b.vy = -b.vy * REST;
    b.vx *= FRICTION;
    return 'table';
  }
  // 球网：x = netX、y ∈ [netTopY, topY] 的竖线段
  const side = Math.sign(px - TABLE.netX) || 1;
  if (side * b.vx < 0 && side * (b.x - TABLE.netX) < BALL_R && b.y > TABLE.netTopY - BALL_R * 0.5 && b.y < TABLE.topY) {
    b.x = TABLE.netX + side * BALL_R;
    b.vx = -b.vx * 0.25;
    b.vy *= 0.5;
    return 'net';
  }
  if (b.y + BALL_R >= WORLD.floorY) return 'floor';
  if (b.x < -80 || b.x > WORLD.W + 80) return 'away';
  return null;
}

// 解抛物线：从 (x0,y0) 出发 T 秒后到 (x1,y1)；clearNet 时加长飞行时间直到过网有余量
export function aimTo(x0, y0, x1, y1, T, clearNet = true) {
  const g = WORLD.gravity;
  let vx = 0, vy = 0;
  for (let k = 0; k < 16; k++, T += 0.05) {
    vx = (x1 - x0) / T;
    vy = (y1 - y0 - 0.5 * g * T * T) / T;
    if (!clearNet) break;
    const tn = (TABLE.netX - x0) / vx;
    if (!(tn > 0 && tn < T) || y0 + vy * tn + 0.5 * g * tn * tn < TABLE.netTopY - BALL_R - 14) break;
  }
  return { vx, vy };
}

// 球与拍面圆的扫掠：相对运动线段到原点的最近距离
function sweep(rx0, ry0, rx1, ry1) {
  const dx = rx1 - rx0, dy = ry1 - ry0, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp(-(rx0 * dx + ry0 * dy) / l2, 0, 1) : 0;
  return Math.hypot(rx0 + dx * t, ry0 + dy * t);
}

// phase：hold（球在发球方手里）→ toss（抛球）→ play → over（得分后死球）→ hold；void = 武斗中
export class PingPong {
  constructor() {
    this.ball = { x: 400, y: 560, vx: 0, vy: 0, r: BALL_R, visible: true, trail: [] };
    this.stats = { returns: 0, rallyTime: 0, scorePlayer: 0, scoreCpu: 0, hits: 0 };
    this.server = 'player';
    this.holdSpot = { player: { x: 470, y: 600 }, cpu: { x: 1110, y: 600 } }; // 等待时球停的位置（director 设置）
    this.cpuShot = null;      // AI 给的回球计划 { T, error: null|'whiff'|'net'|'out' }
    this.time = 0;
    this.last = {};
    this.prev = {};
    this.inactive = 0;
    this.hitId = 0;
    this.hitT = 0;
    this.rallyId = 0;
    this.newRally();
  }

  get sinceHit() {
    return this.time - this.hitT;
  }

  // 同类事件节流（游戏时间）
  emit(text, gap = 0) {
    if (this.time - (this.last[text] ?? -1e9) < gap) return;
    this.last[text] = this.time;
    events.push(text);
  }

  newRally() {
    this.phase = 'hold';
    this.status = 'SERVE';
    this.timer = 0;
    this.lastHitter = null;
    this.bounces = 0;
    this.rallyId++;
    this.snapHold = true;
    this.stats.returns = 0;
    this.stats.rallyTime = 0;
    const b = this.ball;
    b.visible = false;   // hold / WAITING 把球放到位的同一帧才显示，免得在旧落点闪一帧
    b.vx = b.vy = 0;
    b.trail.length = 0;
  }

  // 武斗开始：当前回合作废，球隐藏
  voidRally() {
    this.phase = 'void';
    this.ball.visible = false;
    this.ball.trail.length = 0;
    this.stats.returns = 0;
    this.stats.rallyTime = 0;
  }

  // 武斗结束：同一发球方重新发球
  resume() {
    this.newRally();
    this.emit('rally ended / next serve');
  }

  // 从当前球状态往后预测（不含拍子）：[{ t, x, y, vx, vy, n=已落台次数 }]
  predict(tMax = 1.6, every = 2) {
    const b = { x: this.ball.x, y: this.ball.y, vx: this.ball.vx, vy: this.ball.vy };
    const out = [];
    let n = 0;
    for (let i = 1; i * SUBSTEP <= tMax; i++) {
      const c = stepBall(b, SUBSTEP);
      if (c === 'table') n++;
      else if (c) break;
      if (i % every === 0) out.push({ t: i * SUBSTEP, x: b.x, y: b.y, vx: b.vx, vy: b.vy, n });
    }
    return out;
  }

  // playerPad / cpuPad：rig 更新后的拍子 { x, y, vx, vy }
  update(dt, { active = true, playerPad, cpuPad, paddleArm = 0, swing = 0 }) {
    this.time += dt;
    this.inactive = active ? 0 : this.inactive + dt;
    const b = this.ball;
    if (this.phase === 'void') return;

    // 手不在：发球前立即等待；回合中 0.5s 后作废，球回到发球方手里不动
    if (!active && (this.phase === 'hold' || this.phase === 'toss' || (this.phase === 'play' && this.inactive > 0.5))) {
      if (this.phase !== 'hold') this.newRally();
      this.status = 'WAITING';
      this.timer = 0;
      if (this.inactive > 15) this.stats.scorePlayer = this.stats.scoreCpu = 0;   // 久无人：换下一位观众，比分清零
      const s = this.holdSpot[this.server];
      b.x = s.x;
      b.y = s.y;
      b.visible = true;
      b.vx = b.vy = 0;
      this.snapHold = false;
      this.savePads(playerPad, cpuPad);
      return;
    }

    if (this.phase === 'hold') this.hold(dt, playerPad, cpuPad, paddleArm);
    else if (this.phase === 'toss') {
      b.vy += WORLD.gravity * dt;
      b.y += b.vy * dt;
      if (b.vy > 0 && b.y >= this.tossY) {
        const T = this.server === 'cpu' ? this.cpuShot?.T ?? 0.9 : this.playerT(playerPad, swing);
        this.launch(this.server, T, null, true);
      }
    } else this.simulate(dt, playerPad, cpuPad, swing);

    if (b.visible && this.phase !== 'hold') {
      b.trail.unshift({ x: b.x, y: b.y });
      if (b.trail.length > TRAIL) b.trail.length = TRAIL;
    } else if (!b.visible) b.trail.pop();   // 球落地后拖尾逐帧收掉
    this.savePads(playerPad, cpuPad);
  }

  // 发球准备：球跟着发球方拍子；电脑 1s 后发，玩家抬拇指（paddleArm>0.3）或 2.5s 自动发
  hold(dt, playerPad, cpuPad, paddleArm) {
    const b = this.ball, pad = this.server === 'player' ? playerPad : cpuPad, o = HOLD[this.server];
    this.status = 'SERVE';
    this.timer += dt;
    if (!pad) return;
    const hx = pad.x + o.x;
    let hy = pad.y + o.y;
    if (hx > TABLE.x0 - 12 && hx < TABLE.x1 + 12) hy = Math.min(hy, TABLE.topY - 40);
    b.x = this.snapHold ? hx : damp(b.x, hx, 25, dt);
    b.y = this.snapHold ? hy : damp(b.y, hy, 25, dt);
    b.visible = true;
    this.snapHold = false;
    const armed = this.server === 'player' && paddleArm > 0.3 && this.timer > 0.6;
    if (this.server === 'cpu' ? this.timer > 1.0 : armed || this.timer > 2.5) {
      if (armed) this.emit('paddle armed', 0.8);
      this.phase = 'toss';
      this.tossY = b.y;
      b.vx = 0;
      b.vy = -360;
    }
  }

  simulate(dt, playerPad, cpuPad, swing) {
    const b = this.ball;
    if (this.phase === 'play') this.stats.rallyTime += dt;
    const n = Math.max(1, Math.ceil(dt / SUBSTEP - 1e-6)), h = dt / n;
    for (let i = 1; i <= n && b.visible; i++) {
      const x0 = b.x, y0 = b.y;
      const c = stepBall(b, h);
      if (this.phase === 'play') {
        if (c) this.contact(c);
        else this.paddles(x0, y0, (i - 1) / n, i / n, playerPad, cpuPad, swing);
      } else if (c === 'floor' || c === 'away') b.visible = false;
    }
    if (this.phase === 'over') {
      if (!b.visible) b.vx = b.vy = 0;
      this.timer -= dt;
      if (!this.ended && this.timer < this.overDur - 0.2) {
        this.ended = true;
        this.emit('rally ended / next serve');
      }
      if (this.timer <= 0) this.newRally();
    }
  }

  // 拍子扫掠：拍子在本帧内从上一帧位置线性插值到当前位置
  paddles(x0, y0, f0, f1, playerPad, cpuPad, swing) {
    const b = this.ball;
    for (const side of ['player', 'cpu']) {
      if (side === this.lastHitter || (b.x < TABLE.netX) !== (side === 'player')) continue;
      if (side === 'cpu' && this.cpuShot?.error === 'whiff') continue;   // 电脑决定挥空
      const p = side === 'player' ? playerPad : cpuPad;
      if (!p) continue;
      const q = this.prev[side] || p;
      const ax0 = lerp(q.x, p.x, f0), ay0 = lerp(q.y, p.y, f0);
      const ax1 = lerp(q.x, p.x, f1), ay1 = lerp(q.y, p.y, f1);
      if (sweep(x0 - ax0, y0 - ay0, b.x - ax1, b.y - ay1) >= HIT_R[side]) continue;
      if (side === 'player') this.launch('player', this.playerT(p, swing));
      else this.launch('cpu', this.cpuShot?.T ?? 0.85, this.cpuShot?.error ?? null);
      return;
    }
  }

  // 玩家挥拍越快飞行时间越短
  playerT(pad, swing) {
    const v = pad ? Math.hypot(pad.vx || 0, pad.vy || 0) : 0;
    return lerp(1.0, 0.62, clamp(Math.max(Math.abs(swing) / 8, v / 1600), 0, 1));
  }

  // 击球：瞄准辅助在对方半台随机选落点；error 时故意下网 / 打到自己半台
  launch(side, T, error = null, serve = false) {
    const b = this.ball, dir = side === 'player' ? 1 : -1;
    let tx, ty = LAND_Y;
    if (error === 'net') {
      tx = TABLE.netX;
      ty = TABLE.netTopY + 26;
      T = 0.42;
    } else if (error === 'out') {
      tx = TABLE.netX - dir * rand(50, 140);
      T = 0.3;
    } else tx = dir > 0 ? rand(TABLE.netX + 70, TABLE.x1 - 30) : rand(TABLE.x0 + 30, TABLE.netX - 70);
    const v = aimTo(b.x, b.y, tx, ty, T, !error);
    b.vx = v.vx;
    b.vy = v.vy;
    this.lastHitter = side;
    this.bounces = 0;
    this.hitId++;
    this.hitT = this.time;
    this.phase = 'play';
    this.status = side === 'player' ? 'FLIGHT' : 'RECEIVE';
    if (serve) this.stats.rallyTime = 0;
    else {
      this.stats.returns++;
      if (!error) this.emit(side === 'player' ? 'player return' : 'CPU return accepted');
    }
  }

  // 判定：落台/碰网/落地/飞出
  contact(c) {
    const b = this.ball, hitter = this.lastHitter, recv = other(hitter);
    if (c === 'table') {
      this.emit('table contact', 0.08);
      if ((b.x < TABLE.netX ? 'player' : 'cpu') === hitter) this.point(recv, 'out');
      else if (++this.bounces >= 2) this.point(hitter, 'return missed');
    } else if (c === 'net') this.point(recv, 'net');
    else {
      if (this.bounces) this.point(hitter, 'return missed');
      else this.point(recv, 'out');
      b.visible = false;
    }
  }

  point(winner, reason) {
    this.emit(reason);
    if (winner === 'player') this.stats.scorePlayer++;
    else this.stats.scoreCpu++;
    this.emit(`point ${winner}`);
    this.phase = 'over';
    this.status = winner === 'cpu' ? 'CELEBRATING' : 'SCORED';
    this.timer = this.overDur = winner === 'cpu' ? 2.4 : 1.6;
    this.ended = false;
    this.server = other(this.server);   // 每分交替发球
  }

  savePads(playerPad, cpuPad) {
    if (playerPad) this.prev.player = { x: playerPad.x, y: playerPad.y };
    if (cpuPad) this.prev.cpu = { x: cpuPad.x, y: cpuPad.y };
  }
}
