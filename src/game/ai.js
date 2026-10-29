// 电脑皮影 AI（预测拦截、反应延迟、失误与动态平衡、嘲讽/沮丧动作）+ 皮影动作小工具（两骨 IK、迈步）
import { SK } from '../puppet/skeleton.js';
import { TABLE, ZONES, PELVIS_Y } from '../core/world.js';
import { clamp, lerp, damp, rotate } from '../core/math.js';

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.4;

// ---- 动作工具（facing-local：面朝右，角度 0 = 下垂，-PI/2 = 向前）----

// 两骨 IK（躯干局部）：前臂末端 = 拍面圆心，后臂末端 = 手腕。肘向下、前臂往前上折
// -> { shoulder 相对躯干, elbow 相对上臂 }
export function armIK(tx, ty, arm = 'front') {
  const s = arm === 'front' ? SK.frontShoulder : SK.backShoulder;
  const L1 = SK.upperArmLen, L2 = SK.forearmLen + (arm === 'front' ? SK.paddleCenter : 0);
  const dx = tx - s.x, dy = ty - s.y;
  const d = clamp(Math.hypot(dx, dy), Math.abs(L1 - L2) + 1, L1 + L2 - 0.5);
  const phi = Math.atan2(-dx, dy);
  const a = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const b = Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
  return { shoulder: phi + a, elbow: b - Math.PI };
}

// 躯干局部 ↔ 世界
export const toWorld = (pose, facing, lx, ly) => {
  const p = rotate(lx, ly, pose.lean || 0);
  return { x: pose.x + facing * p.x, y: pose.y + p.y };
};
export const toTorso = (pose, facing, wx, wy) => rotate((wx - pose.x) * facing, wy - pose.y, -(pose.lean || 0));

// 站姿腿角。走路摆腿由 rig 按骨盆速度自己做（这里再摆会和 rig 的步相叠加成乱步）
export class Gait {
  update() {
    return { frontLeg: -0.2, backLeg: 0.16 };
  }
}

// ---- 电脑 AI ----

const HOME = { x: 1290, y: PELVIS_Y };
const READY = { x: 190, y: -8 };        // 待机拍位（躯干局部）
const SERVE_HOLD = { x: 172, y: -14 };
const REACH_DX = 205;                   // 拦截点 → 骨盆的水平距离

export class CpuAI {
  constructor() {
    this.t = 0;
    this.x = HOME.x;
    this.y = HOME.y;
    this.pad = toWorld(HOME, -1, READY.x, READY.y); // 拍子目标（世界）
    this.gait = new Gait();
    this.planId = -1;
    this.plan = null;
    this.serveId = -1;
  }

  // 预测：球落到电脑半台弹起后、二次落台前的可击打点；优先桌端外、高度合适的最早点
  intercept(pp) {
    let apex = null;
    for (const s of pp.predict(1.6)) {
      if (pp.bounces + s.n !== 1 || s.x < TABLE.netX) continue;
      if (!apex || s.y < apex.y) apex = s;
      if (s.x >= TABLE.x1 + 25 && s.y <= 680) return s;
    }
    return apex;
  }

  // 每个来球定一次计划：反应延迟、位置噪声、是否失误、回球飞行时间
  newPlan(pp) {
    const b = pp.ball, st = pp.stats;
    const speed = Math.hypot(b.vx, b.vy);
    const lead = st.scoreCpu - st.scorePlayer;
    // 失误率：球越快、回合越长越容易失误；动态平衡：领先 ≥2 分放水，落后时认真
    let pMiss = (lead <= -2 ? 0.02 : 0.06) + 0.08 * clamp((speed - 650) / 600, 0, 1);
    pMiss += Math.min(0.02 * Math.max(st.returns - 4, 0), 0.3);
    if (lead >= 2) pMiss += 0.12 * (lead - 1);
    pMiss = clamp(pMiss, 0.02, 0.6);
    const r = Math.random();
    const miss = Math.random() < pMiss ? (r < 0.55 ? 'whiff' : r < 0.78 ? 'net' : 'out') : null;
    this.plan = {
      react: rand(0.1, 0.15),
      nx: gauss() * 7, ny: gauss() * 7,
      miss,
      dy: (Math.random() < 0.5 ? -1 : 1) * rand(85, 115),
    };
    const T = lerp(0.95, 0.72, Math.min(st.returns, 14) / 14) + rand(-0.06, 0.06);
    pp.cpuShot = { T: clamp(T, 0.62, 1.05), error: miss };
  }

  update(dt, pp) {
    this.t += dt;
    if (pp.status === 'CELEBRATING') return this.celebrate(dt);
    if (pp.status === 'SCORED') return this.dejected(dt);

    let tx = HOME.x, ty = HOME.y, pad = null, local = READY;
    if (pp.phase === 'play' && pp.lastHitter === 'player') {
      // 来球：反应延迟后跑位 + 送拍到拦截点
      if (pp.hitId !== this.planId) {
        this.planId = pp.hitId;
        this.newPlan(pp);
      }
      const p = this.plan;
      const s = pp.sinceHit >= p.react ? this.intercept(pp) : null;
      if (s) {
        tx = clamp(s.x + REACH_DX, ZONES.cpu.xMin, ZONES.cpu.xMax);
        ty = clamp(s.y - 5, ZONES.cpu.yMin, ZONES.cpu.yMax);
        pad = { x: s.x + p.nx, y: s.y + p.ny + (p.miss === 'whiff' ? p.dy : 0) };
      } else {
        tx = this.x;
        ty = this.y;
      }
    } else if (pp.phase === 'play' && pp.lastHitter === 'cpu' && pp.sinceHit < 0.28) {
      // 随挥：拍子往前上方送
      tx = this.x;
      ty = this.y;
      local = { x: READY.x + 45, y: READY.y - 70 };
    } else if ((pp.phase === 'hold' || pp.phase === 'toss') && pp.server === 'cpu') {
      if (pp.rallyId !== this.serveId) {
        this.serveId = pp.rallyId;
        pp.cpuShot = { T: rand(0.85, 0.98), error: null };
      }
      local = pp.phase === 'toss' ? { x: SERVE_HOLD.x - 25, y: SERVE_HOLD.y + 20 } : SERVE_HOLD;
    }

    // 骨盆：平滑 + 限速
    const step = 1100 * dt;
    this.x += clamp(damp(this.x, tx, 9, dt) - this.x, -step, step);
    this.y = damp(this.y, ty, 6, dt);

    const breath = Math.sin(this.t * 2.1);
    const pose = {
      x: this.x, y: this.y + breath * 3, lean: Math.sin(this.t * 1.3) * 0.025,
      headTilt: Math.sin(this.t * 0.9) * 0.05,
      backShoulder: 0.12 + breath * 0.04, backElbow: -0.1, swordAngle: 0,
      tongue: 0, fallen: 0, visible: 1,
    };
    const want = pad || toWorld(pose, -1, local.x, local.y);
    this.pad.x = damp(this.pad.x, want.x, 14, dt);
    this.pad.y = damp(this.pad.y, want.y, 14, dt);
    const lt = toTorso(pose, -1, this.pad.x, this.pad.y);
    const ik = armIK(lt.x, lt.y, 'front');
    pose.frontShoulder = ik.shoulder;
    pose.frontElbow = ik.elbow;
    Object.assign(pose, this.gait.update(dt, this.x));
    return pose;
  }

  // 嘲讽：蹦跳、摇头、双臂上举、舌头 ~6Hz 疯狂伸缩（削顶正弦≈方波，rig 弹簧滤过后幅度仍够大）
  celebrate(dt) {
    const t = this.t, hop = Math.abs(Math.sin(t * Math.PI * 2.2));
    this.gait.update(dt, this.x);
    return {
      x: this.x, y: this.y - hop * 42, lean: Math.sin(t * 4.4) * 0.08,
      headTilt: Math.sin(t * TAU * 2) * 0.35,
      frontShoulder: -2.65 + Math.sin(t * TAU * 2.2) * 0.3, frontElbow: -0.35,
      backShoulder: -2.7 - Math.sin(t * TAU * 2.2) * 0.25, backElbow: -0.35, swordAngle: 0,
      frontLeg: -0.2 - hop * 0.35, backLeg: 0.16 + hop * 0.3,
      tongue: clamp(0.5 + 0.9 * Math.sin(t * TAU * 6), 0, 1), fallen: 0, visible: 1,
    };
  }

  // 沮丧：低头、手臂下垂
  dejected(dt) {
    this.y = damp(this.y, HOME.y + 14, 4, dt);
    const s = Math.sin(this.t * 1.6);
    return {
      x: this.x, y: this.y, lean: 0.14, headTilt: 0.42 + s * 0.04,
      frontShoulder: 0.12, frontElbow: -0.12, backShoulder: 0.18, backElbow: -0.05, swordAngle: 0,
      frontLeg: -0.08, backLeg: 0.08, tongue: 0, fallen: 0, visible: 1,
    };
  }
}
