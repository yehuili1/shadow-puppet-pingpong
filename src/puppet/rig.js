// 皮影骨骼：姿态弹簧 + 提线次级摆动 + 正/逆运动学 + 绘制编排 + 碰撞查询
// 局部空间一律 facing-local（面朝右，y 向下）；角度 canvas 约定（正 = 顺时针）：肢体 0 = 下垂、-PI/2 = 向前、-PI = 举过头顶。
// 世界 = 根变换（骨盆平移 · 镜像/缩放 · 倒地旋转）× 局部。
// 查询量（update 后，世界坐标）：paddle.angle = 握点→拍面圆心的 atan2；swordBase = 护手处（剑刃起点）；
// controlPoints.frontHand/backHand = 腕；joints = 全部关节（调试用）。
// 持拍手绝对角只随 pose.lean（不吃躯干摆动），次级摆动只给很小比例，拍子位置可预期。

import { SK, DRAW_ORDER } from './skeleton.js';
import { getPart } from './art.js';
import { PADDLE_R, STRING_TOP_Y, PELVIS_Y } from '../core/world.js';
import { clamp, damp, wrapAngle, Spring } from '../core/math.js';

const KEYS = ['x', 'y', 'lean', 'headTilt', 'frontShoulder', 'frontElbow', 'backShoulder', 'backElbow',
  'swordAngle', 'frontLeg', 'backLeg', 'tongue', 'fallen', 'visible'];

// 默认站姿：持拍手前伸，持剑手横剑胸前
const REST = {
  lean: 0, headTilt: 0,
  frontShoulder: -0.8, frontElbow: -0.6,
  backShoulder: 0.2, backElbow: -1.4,
  swordAngle: -1.2,
  frontLeg: -0.1, backLeg: 0.12,
  tongue: 0, fallen: 0, visible: 1,
};

// 各字段弹簧 [刚度, 阻尼比]；x/y 用构造参数 stiffness
const SPRING = {
  lean: [160, 0.8], headTilt: [140, 0.7],
  frontShoulder: [260, 0.9], frontElbow: [260, 0.9],   // 持拍手偏硬：拍子位置可预期
  backShoulder: [170, 0.7], backElbow: [170, 0.7],     // 其余肢体稍软
  swordAngle: [400, 0.9],
  frontLeg: [150, 0.75], backLeg: [150, 0.75],
  tongue: [3000, 1], fallen: [40, 1], visible: [60, 1],   // 舌头要跟得上 ~6Hz 的嘲讽伸缩
};
const WRAP = { frontShoulder: true, backShoulder: true }; // 肩关节走最短弧（肘不绕，免得前臂穿过上臂）

// 次级摆动（提线晃荡）：阻尼摆 [刚度, 阻尼, 加速度增益, 限幅]
// 驱动 = 增益 × 骨盆加速度在该部件上的力矩分量（ax·cos A + ay·sin A，A 为部件绝对角）
const SWAY = {
  torso: [70, 8, 0.0006, 0.2],
  head: [90, 6, 0.0015, 0.4],
  skirt: [45, 3.5, 0.0013, 0.5],
  armU: [45, 4, 0.0016, 0.6],
  armL: [60, 4, 0.0012, 0.6],
  legF: [110, 6, 0.0018, 0.6],
  legB: [110, 6, 0.0018, 0.6],
};
const ACC_MAX = 20000;   // 骨盆加速度限幅（防瞬移炸摆）
const FRONT_SWAY = 0.08; // 持拍手只吃很小的摆动，且不继承躯干摆动
const SUBSTEP = 1 / 120;
const V_MAX = 12000;     // 查询速度限幅

// 躯干碰撞圆（躯干局部）与头碰撞圆（头局部）
const TORSO_HIT = [[1, -35, 36], [2, -100, 40], [3, -162, 44]];
const HEAD_HIT = [6, -60, 44];

const JOINTS = ['pelvis', 'neck', 'headTop', 'mouth', 'fShoulder', 'fElbow', 'fWrist', 'paddle',
  'bShoulder', 'bElbow', 'bWrist', 'swordBase', 'swordTip', 'fHip', 'fAnkle', 'bHip', 'bAnkle'];

const ORIGIN = { x: 0, y: 0 };

class Sway {
  constructor([k, c, gain, lim]) {
    this.k = k; this.c = c; this.gain = gain; this.lim = lim;
    this.v = 0; this.w = 0;
  }
  // 绝对角 abs 下受骨盆加速度 (ax, ay) 驱动，趋向 target
  step(ax, ay, abs, target, h) {
    const drive = this.gain * (ax * Math.cos(abs) + ay * Math.sin(abs));
    this.w += (this.k * (target - this.v) - this.c * this.w + drive) * h;
    this.v += this.w * h;
    if (this.v > this.lim) { this.v = this.lim; if (this.w > 0) this.w = 0; }
    else if (this.v < -this.lim) { this.v = -this.lim; if (this.w < 0) this.w = 0; }
  }
  reset() { this.v = this.w = 0; }
}

// 后侧肢体压暗 25%（每张贴图缓存一次，不占每帧 drawImage）
const DARK = new WeakMap();
function darkOf(img) {
  let d = DARK.get(img);
  if (d) return d;
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  if (!w || !h) return img; // 还没加载好
  d = document.createElement('canvas');
  d.width = w; d.height = h;
  const g = d.getContext('2d');
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'source-atop'; // 只改颜色不改透明度 = brightness(0.75)
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(0, 0, w, h);
  DARK.set(img, d);
  return d;
}

// o = p + 沿角 a 的肢体长度 len（0 = +y）
const limb = (o, p, len, a) => { o.x = p.x - Math.sin(a) * len; o.y = p.y + Math.cos(a) * len; };
// o = base + rot(v, a)
const rotAdd = (o, base, v, a) => {
  const c = Math.cos(a), s = Math.sin(a);
  o.x = base.x + v.x * c - v.y * s; o.y = base.y + v.x * s + v.y * c;
};
const apply = (M, p, o) => { o.x = M[0] * p.x + M[2] * p.y + M[4]; o.y = M[1] * p.x + M[3] * p.y + M[5]; };

export class PuppetRig {
  constructor({ character = 'hero', facing = 1, style = 'shadow', scale = 1, stiffness = 420 } = {}) {
    this.character = character;
    this.facing = facing < 0 ? -1 : 1;
    this.style = style;
    this.scale = scale;

    this.target = { x: this.facing > 0 ? 310 : 1290, y: PELVIS_Y, ...REST };
    this.pose = { ...this.target };
    this._sp = {};
    for (const k of KEYS) {
      const [kk, z] = k === 'x' || k === 'y' ? [stiffness, 0.85] : SPRING[k];
      this._sp[k] = new Spring(this.target[k], kk, 2 * z * Math.sqrt(kk));
    }
    this._sw = {};
    for (const k in SWAY) this._sw[k] = new Sway(SWAY[k]);
    this._walkAmp = 0;
    this._walkPhase = 0;
    this._t = 0;
    this._tilt = 0;

    // 局部/世界关节、绝对角、根变换（全部预分配）
    this._L = {};
    this.joints = {};
    for (const n of JOINTS) { this._L[n] = { x: 0, y: 0 }; this.joints[n] = { x: 0, y: 0 }; }
    this._ang = { torso: 0, head: 0, skirt: 0, fU: 0, fF: 0, bU: 0, bF: 0, sword: 0, fLeg: 0, bLeg: 0 };
    this._root = new Float64Array(6);
    this._ikM = new Float64Array(6);
    this._BR = new Float64Array(6);
    this._hitL = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];

    const J = this.joints;
    this.paddle = { x: 0, y: 0, r: PADDLE_R * scale, vx: 0, vy: 0, angle: 0 };
    this.swordTip = { x: 0, y: 0, vx: 0, vy: 0 };
    this.swordBase = J.swordBase;
    this.bodyHit = [{ x: 0, y: 0, r: 0 }, { x: 0, y: 0, r: 0 }, { x: 0, y: 0, r: 0 }, { x: 0, y: 0, r: 0 }];
    this.controlPoints = { head: J.headTop, frontHand: J.fWrist, backHand: J.bWrist, pelvis: J.pelvis };

    this.snap();
  }

  // 目标姿态（合并；忽略非有限值）
  setPose(p) {
    const T = this.target;
    for (const k in p) if (k in T && Number.isFinite(p[k])) T[k] = p[k];
    return this;
  }

  // 立即到位（无弹簧、无摆动、速度清零）
  snap() {
    for (const k of KEYS) { this._sp[k].snap(this.target[k]); this.pose[k] = this.target[k]; }
    for (const k in this._sw) this._sw[k].reset();
    this._walkAmp = 0;
    this._tilt = 0;
    this._solve(0, true);
    return this;
  }

  update(dt) {
    dt = dt > 0 ? Math.min(dt, 0.1) : 0;
    const sp = this._sp, T = this.target;
    for (const k of KEYS) {
      const s = sp[k];
      s.target = WRAP[k] ? s.value + wrapAngle(T[k] - s.value) : T[k];
    }
    const n = dt > 0 ? Math.ceil(dt / SUBSTEP) : 0, h = n ? dt / n : 0;
    const X = sp.x, Y = sp.y;
    const kx = this.facing / this.scale, ky = 1 / this.scale; // 世界 → facing-local
    for (let i = 0; i < n; i++) {
      const ax = X.k * (X.target - X.value) - X.c * X.velocity;
      const ay = Y.k * (Y.target - Y.value) - Y.c * Y.velocity;
      for (const k of KEYS) sp[k].update(h);
      this._secondary(ax * kx, ay * ky, X.velocity * kx, h);
    }
    for (const k of KEYS) this.pose[k] = sp[k].value;
    this._t += dt;
    this._tilt = damp(this._tilt, clamp(X.velocity * 0.05, -70, 70), 10, dt);
    this._solve(dt, false);
  }

  // 提线次级运动：骨盆加速度驱动各部件阻尼摆；水平移动驱动双腿交替
  _secondary(ax, ay, vx, h) {
    const m = 1 - clamp(Math.abs(this.pose.fallen), 0, 1);
    ax = clamp(ax, -ACC_MAX, ACC_MAX) * m;
    ay = clamp(ay, -ACC_MAX, ACC_MAX) * m;
    const W = this._sw, A = this._ang, t = this._t;
    const sp = Math.abs(vx);
    this._walkAmp = damp(this._walkAmp, clamp((sp - 25) / 280, 0, 1) * m, 8, h);
    this._walkPhase += sp * h * Math.PI / 190;
    const step = this._walkAmp * 0.3 * Math.sin(this._walkPhase);
    W.torso.step(ax, ay, A.torso + Math.PI, 0, h);
    W.head.step(ax, ay, A.head + Math.PI, 0.012 * Math.sin(t * 1.3 + 1) * m, h);
    W.skirt.step(ax, ay, A.skirt, 0.025 * Math.sin(t * 1.9) * m, h);
    W.armU.step(ax, ay, A.bU, 0, h);
    W.armL.step(ax, ay, A.bF, 0, h);
    W.legF.step(ax, ay, A.fLeg, step, h);
    W.legB.step(ax, ay, A.bLeg, -step, h);
  }

  // 正向运动学 → 世界坐标查询量
  _solve(dt, reset) {
    const P = this.pose, W = this._sw, L = this._L, A = this._ang, J = this.joints;

    const aT = P.lean + W.torso.v;
    A.torso = aT;
    A.head = aT + P.headTilt + W.head.v;
    A.skirt = 0.2 * aT + W.skirt.v;
    rotAdd(L.neck, ORIGIN, SK.neck, aT);
    rotAdd(L.fShoulder, ORIGIN, SK.frontShoulder, aT);
    rotAdd(L.bShoulder, ORIGIN, SK.backShoulder, aT);
    rotAdd(L.headTop, L.neck, SK.headTop, A.head);
    rotAdd(L.mouth, L.neck, SK.mouth, A.head);

    // 前臂（持拍）：绝对角只随 pose.lean，不吃躯干摆动
    A.fU = P.lean + P.frontShoulder + W.armU.v * FRONT_SWAY;
    A.fF = A.fU + P.frontElbow + W.armL.v * FRONT_SWAY;
    limb(L.fElbow, L.fShoulder, SK.upperArmLen, A.fU);
    limb(L.fWrist, L.fElbow, SK.forearmLen, A.fF);
    limb(L.paddle, L.fWrist, SK.paddleCenter, A.fF);

    // 后臂（持剑）
    A.bU = aT + P.backShoulder + W.armU.v;
    A.bF = A.bU + P.backElbow + W.armL.v;
    A.sword = A.bF + P.swordAngle;
    limb(L.bElbow, L.bShoulder, SK.upperArmLen, A.bU);
    limb(L.bWrist, L.bElbow, SK.forearmLen, A.bF);
    limb(L.swordBase, L.bWrist, SK.swordGuard, A.sword);
    limb(L.swordTip, L.bWrist, SK.swordLen, A.sword);

    // 腿（髋在骨盆局部，不随躯干倾斜）
    A.fLeg = P.frontLeg + W.legF.v;
    A.bLeg = P.backLeg + W.legB.v;
    L.fHip.x = SK.frontHip.x; L.fHip.y = SK.frontHip.y;
    L.bHip.x = SK.backHip.x; L.bHip.y = SK.backHip.y;
    limb(L.fAnkle, L.fHip, SK.legLen, A.fLeg);
    limb(L.bAnkle, L.bHip, SK.legLen, A.bLeg);

    // 根变换（倒地绕双脚中点）→ 世界关节
    const M = this._root;
    this._rootOf(M, P.x, P.y, P.fallen);
    for (const n of JOINTS) apply(M, L[n], J[n]);

    // 碰撞圆
    const s = this.scale, H = this._hitL, B = this.bodyHit;
    const cs = Math.cos(aT), sn = Math.sin(aT);
    for (let i = 0; i < 3; i++) {
      const c = TORSO_HIT[i];
      H[i].x = c[0] * cs - c[1] * sn; H[i].y = c[0] * sn + c[1] * cs;
      B[i].r = c[2] * s;
    }
    const ch = Math.cos(A.head), sh = Math.sin(A.head);
    H[3].x = L.neck.x + HEAD_HIT[0] * ch - HEAD_HIT[1] * sh;
    H[3].y = L.neck.y + HEAD_HIT[0] * sh + HEAD_HIT[1] * ch;
    B[3].r = HEAD_HIT[2] * s;
    for (let i = 0; i < 4; i++) apply(M, H[i], B[i]);

    // 拍 / 剑尖（有限差分速度）
    const pd = this.paddle, st = this.swordTip;
    const fresh = reset || this._lastFacing !== this.facing;
    this._lastFacing = this.facing;
    if (fresh) { pd.vx = pd.vy = st.vx = st.vy = 0; }
    else if (dt > 1e-4) {
      pd.vx = clamp((J.paddle.x - pd.x) / dt, -V_MAX, V_MAX);
      pd.vy = clamp((J.paddle.y - pd.y) / dt, -V_MAX, V_MAX);
      st.vx = clamp((J.swordTip.x - st.x) / dt, -V_MAX, V_MAX);
      st.vy = clamp((J.swordTip.y - st.y) / dt, -V_MAX, V_MAX);
    }
    pd.x = J.paddle.x; pd.y = J.paddle.y;
    pd.r = PADDLE_R * s;
    pd.angle = Math.atan2(J.paddle.y - J.fWrist.y, J.paddle.x - J.fWrist.x); // 世界：握点 → 拍面圆心方向
    st.x = J.swordTip.x; st.y = J.swordTip.y;
  }

  // 根变换 M（canvas 2x3 顺序 a b c d e f）：T(x,y) · S(facing·s, s) · [绕双脚中点旋转 -fallen·90°]
  // fallen > 0 向后仰倒，< 0 向前扑倒（-1..1）
  _rootOf(M, x, y, fallen) {
    const L = this._L;
    const pvx = (L.fAnkle.x + L.bAnkle.x) / 2, pvy = (L.fAnkle.y + L.bAnkle.y) / 2;
    const s = this.scale, fs = this.facing * s;
    const th = -clamp(fallen, -1, 1) * Math.PI / 2;
    const c = Math.cos(th), sn = Math.sin(th);
    M[0] = fs * c; M[1] = s * sn; M[2] = -fs * sn; M[3] = s * c;
    M[4] = x + fs * (pvx - pvx * c + pvy * sn);
    M[5] = y + s * (pvy - pvx * sn - pvy * c);
  }

  // 两骨 IK：世界目标 → facing-local {shoulder, elbow}。
  // 按目标姿态（target 的 x/y/lean/fallen）求解，弹簧收敛后末端正好落在目标上。
  // front 末端 = 拍面圆心，back 末端 = 腕；够不着时伸直指向目标；肘始终同向弯（向前够时肘朝下）。
  ikArm(arm, tx, ty) {
    const T = this.target, M = this._ikM;
    this._rootOf(M, T.x, T.y, T.fallen);
    const det = M[0] * M[3] - M[1] * M[2];
    const X = tx - M[4], Y = ty - M[5];
    const lx = (M[3] * X - M[2] * Y) / det, ly = (-M[1] * X + M[0] * Y) / det;

    const front = arm !== 'back';
    const sh = front ? SK.frontShoulder : SK.backShoulder;
    const c = Math.cos(T.lean), s = Math.sin(T.lean);
    const dx = lx - (sh.x * c - sh.y * s), dy = ly - (sh.x * s + sh.y * c);
    const l1 = SK.upperArmLen, l2 = front ? SK.forearmLen + SK.paddleCenter : SK.forearmLen;
    const d = clamp(Math.hypot(dx, dy), Math.abs(l1 - l2) + 1e-6, l1 + l2);
    const aim = Math.atan2(-dx, dy); // 肩 → 目标的绝对角（0 = 下垂）
    const alpha = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
    const beta = Math.acos(clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
    return { shoulder: wrapAngle(aim + alpha - T.lean), elbow: beta - Math.PI };
  }

  draw(ctx, { alpha = 1, strings = true, stringTopY = STRING_TOP_Y } = {}) {
    const a = alpha * clamp(this.pose.visible, 0, 1);
    if (!(a > 0.003)) return;
    const base = ctx.getTransform();
    const R = this._root, B = this._BR;
    B[0] = base.a * R[0] + base.c * R[1];
    B[1] = base.b * R[0] + base.d * R[1];
    B[2] = base.a * R[2] + base.c * R[3];
    B[3] = base.b * R[2] + base.d * R[3];
    B[4] = base.a * R[4] + base.c * R[5] + base.e;
    B[5] = base.b * R[4] + base.d * R[5] + base.f;

    const L = this._L, A = this._ang;
    const tongue = clamp(this.pose.tongue, 0, 1);
    ctx.save();
    ctx.globalAlpha *= a;
    for (const g of DRAW_ORDER) {
      switch (g) {
        case 'backArm': // 手压住剑柄
          this._part(ctx, 'upperArm', L.bShoulder, A.bU, 1, true);
          this._part(ctx, 'sword', L.bWrist, A.sword, 1, true);
          this._part(ctx, 'forearm', L.bElbow, A.bF, 1, true);
          break;
        case 'backLeg': this._part(ctx, 'leg', L.bHip, A.bLeg, 1, true); break;
        case 'frontLeg': this._part(ctx, 'leg', L.fHip, A.fLeg, 1, false); break;
        case 'skirt': this._part(ctx, 'skirt', ORIGIN, A.skirt, 1, false); break;
        case 'torso': this._part(ctx, 'torso', ORIGIN, A.torso, 1, false); break;
        case 'head':
          this._part(ctx, 'head', L.neck, A.head, 1, false);
          if (tongue > 0.01) this._part(ctx, 'tongue', L.mouth, A.head, tongue, false);
          break;
        case 'frontArm': // 手压住拍柄
          this._part(ctx, 'upperArm', L.fShoulder, A.fU, 1, false);
          this._part(ctx, 'paddle', L.fWrist, A.fF, 1, false);
          this._part(ctx, 'forearm', L.fElbow, A.fF, 1, false);
          break;
      }
    }
    ctx.restore();
    if (strings) this._strings(ctx, base, a, stringTopY);
  }

  // 部件：BR · T(关节) · R(角) · S(sx·s, s)，再 drawImage(img, -ox, -oy)
  _part(ctx, name, j, ang, sx, dark) {
    const p = getPart(this.character, this.style, name);
    if (!p || !p.img) return;
    const B = this._BR, c = Math.cos(ang), s = Math.sin(ang), k = p.s || 1;
    const e = B[0] * j.x + B[2] * j.y + B[4], f = B[1] * j.x + B[3] * j.y + B[5];
    ctx.setTransform(
      (B[0] * c + B[2] * s) * k * sx, (B[1] * c + B[3] * s) * k * sx,
      (B[2] * c - B[0] * s) * k, (B[3] * c - B[1] * s) * k, e, f);
    ctx.drawImage(dark ? darkOf(p.img) : p.img, -p.ox, -p.oy);
  }

  // 提线：从头顶/双手挂点竖直到 stringTopY，随骨盆速度略倾斜
  _strings(ctx, base, a, topY) {
    const cp = this.controlPoints, tilt = this._tilt;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    ctx.save();
    ctx.globalAlpha *= a * 0.6;
    ctx.strokeStyle = '#3a2414';
    ctx.lineWidth = (1.2 * dpr) / (Math.hypot(base.a, base.b) || 1);
    ctx.beginPath();
    ctx.moveTo(cp.head.x, cp.head.y); ctx.lineTo(cp.head.x + tilt, topY);
    ctx.moveTo(cp.frontHand.x, cp.frontHand.y); ctx.lineTo(cp.frontHand.x + tilt, topY);
    ctx.moveTo(cp.backHand.x, cp.backHand.y); ctx.lineTo(cp.backHand.x + tilt, topY);
    ctx.stroke();
    ctx.restore();
  }
}
