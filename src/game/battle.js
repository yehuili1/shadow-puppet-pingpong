// 武斗「文的不行武的来」：剑砍电脑 IDLE → HIT×3 → GROUND → ESCAPE（跑出画面再走回）→ battle over
import { ZONES, PELVIS_Y } from '../core/world.js';
import { events } from '../core/events.js';
import { clamp, lerp, damp } from '../core/math.js';
import { Gait } from './ai.js';

const HOME = 1290;
const HIT_TIME = 0.4, GROUND_TIME = 1.8, GETUP = 0.7;
const OFFSTAGE = 2300;   // 逃到这里才折返：前伸的手臂和拍约到骨盆前 ~425，超宽视口（右边界 ≤1875）也看不到它折返

// 线段到圆心距离 < r
function segHit(ax, ay, bx, by, c) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp(((c.x - ax) * dx + (c.y - ay) * dy) / l2, 0, 1) : 0;
  return Math.hypot(ax + dx * t - c.x, ay + dy * t - c.y) < c.r;
}

export class Battle {
  constructor() {
    this.state = 'OFF';
    this.gait = new Gait();
  }

  start(x) {
    this.state = 'IDLE';
    this.st = 0;          // 当前状态已持续时间
    this.time = 0;
    this.hp = 3;
    this.x = x;
    this.kx = x;
    this.attack = false;
    this.prev = null;
    events.push('battle engaged');
  }

  stop() {
    this.state = 'OFF';
    events.push('battle over');
  }

  get status() {
    if (this.state === 'HIT') return 'BATTLE / HIT';
    if (this.state === 'GROUND') return 'BATTLE / GROUND';
    if (this.state === 'ESCAPE' || this.state === 'RETURN') return 'BATTLE / ESCAPE';
    return this.attack ? 'BATTLE / ATTACK' : 'BATTLE / IDLE';
  }

  // 只有戒备状态下可以再次调转小拇指退出
  get canExit() {
    return this.state === 'IDLE' && this.time > 1;
  }

  set(state) {
    this.state = state;
    this.st = 0;
  }

  // 电脑姿态（rig 更新前）
  cpuPose(dt, playerX) {
    this.time += dt;
    this.st += dt;
    const t = this.time, st = this.st, wob = Math.sin(t * 2.4);
    const p = {
      x: this.x, y: PELVIS_Y + Math.sin(t * 2.1) * 3, lean: -0.05, headTilt: 0,
      frontShoulder: -1.0, frontElbow: -1.1, backShoulder: -2.0 + wob * 0.08, backElbow: -0.5, swordAngle: 0.35,
      tongue: 0, fallen: 0, visible: 1,
    };
    if (this.state === 'IDLE') {
      // 举剑戒备；玩家靠近后退半步
      const tx = playerX > HOME - 430 ? Math.min(HOME + 90, ZONES.battle.xMax) : HOME;
      this.x = damp(this.x, tx, 4, dt);
    } else if (this.state === 'HIT') {
      // 被击退、后仰
      this.x = damp(this.x, this.kx, 12, dt);
      const k = 1 - st / HIT_TIME;
      Object.assign(p, { lean: -0.55 * k - 0.05, headTilt: -0.4 * k, frontShoulder: -2.3, frontElbow: -0.4, backShoulder: -0.7, backElbow: -0.2 });
    } else if (this.state === 'GROUND') {
      // 向前扑倒（朝戏台中间）：被击退到右侧后若向后仰倒，身体会整个躺出画面
      Object.assign(p, { fallen: -0.92, headTilt: -0.2, frontShoulder: -2.9, frontElbow: -0.1, backShoulder: -2.6, backElbow: 0, swordAngle: 1.2 });
    } else if (this.state === 'ESCAPE') {
      // 爬起来，摇摇晃晃往右跑出画面（仍面朝左）
      const run = st > GETUP;
      if (run) this.x += 560 * dt;
      Object.assign(p, {
        lean: Math.sin(t * 14) * 0.28 + (run ? -0.12 : 0), headTilt: Math.sin(t * 9) * 0.3,
        frontShoulder: -2.4 + Math.sin(t * 11) * 0.5, frontElbow: -0.4,
        backShoulder: -0.4 + Math.sin(t * 11 + 1.5) * 0.6, backElbow: -0.3, swordAngle: 0,
      });
    } else if (this.state === 'RETURN') {
      // 从右侧走回
      this.x = Math.max(HOME, this.x - 300 * dt);
      Object.assign(p, { lean: 0.08, frontShoulder: -0.6, frontElbow: -0.8, backShoulder: 0.15, backElbow: -0.1, swordAngle: 0 });
    }
    p.x = this.x;
    const legs = this.gait.update(dt, this.x);
    p.frontLeg = this.state === 'GROUND' ? -0.1 : legs.frontLeg;
    p.backLeg = this.state === 'GROUND' ? 0.1 : legs.backLeg;
    return p;
  }

  // 判定与状态推进（rig 更新后）；返回 true = 武斗结束
  judge(dt, c, playerRig, cpuRig, stats) {
    const tip = playerRig.swordTip, base = playerRig.swordBase, body = cpuRig.bodyHit || [];
    const cur = { bx: base.x, by: base.y, tx: tip.x, ty: tip.y };
    const prev = this.prev || cur;
    this.prev = cur;
    const speed = Math.hypot(tip.vx || 0, tip.vy || 0), spin = Math.abs(c.swordSpin || 0);

    if (this.state === 'IDLE') {
      let near = Infinity;
      for (const b of body) near = Math.min(near, Math.hypot(tip.x - b.x, tip.y - b.y) - b.r);
      this.attack = (speed > 400 || spin > 120) && near < 260;
      // 剑身扫掠：上一帧与本帧剑段之间插值，避免快速旋转穿过
      let hit = false;
      if (this.st > 0.35 && (speed > 650 || spin > 180)) {
        for (let k = 1; k <= 4 && !hit; k++) {
          const f = k / 4;
          const ax = lerp(prev.bx, cur.bx, f), ay = lerp(prev.by, cur.by, f);
          const bx = lerp(prev.tx, cur.tx, f), by = lerp(prev.ty, cur.ty, f);
          hit = body.some((b) => segHit(ax, ay, bx, by, b));
        }
      }
      if (hit) {
        this.hp--;
        stats.hits++;
        this.kx = Math.min(this.x + 110, ZONES.battle.xMax);
        this.attack = false;
        this.set('HIT');
        events.push('sword hit');
      }
    } else if (this.state === 'HIT') {
      if (this.st > HIT_TIME) {
        if (this.hp > 0) this.set('IDLE');
        else {
          this.set('GROUND');
          events.push('cpu grounded');
        }
      }
    } else if (this.state === 'GROUND') {
      if (this.st > GROUND_TIME) this.set('ESCAPE');
    } else if (this.state === 'ESCAPE') {
      if (this.x > OFFSTAGE) {
        this.set('RETURN');
        events.push('cpu escaped');
      }
    } else if (this.state === 'RETURN' && this.x <= HOME) {
      this.stop();
      return true;
    }
    return false;
  }
}
