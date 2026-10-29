// 手 → 控制量映射（区间用假摄像头实测标定，见 tests/tracking.html、tests/stubs/tracking_replay.mjs）
import { clamp, damp, lerp, remap, wrapAngle } from '../core/math.js';

const DEG = 180 / Math.PI;

// ---- 标定区间（角度均按「左手掌心朝镜头」口径；右手 / 手背朝镜头时按手性镜像）
export const THUMB_RANGE = [40, 85];    // 拇指 MCP→TIP 相对掌轴外展角（deg）：内收压下 → 向外抬平
export const PINKY_RANGE = [-15, -60];  // 小拇指 MCP→TIP 相对掌轴（deg，偏向画面左侧为负）：并拢 → 外展
const PINKY_EXT = [0.35, 0.75];         // 小拇指伸直度：弯下去时剑放下
const POS_X = [0.2, 0.8];               // 掌心 → px 0..1（掌心本身够不到画面边缘）
const POS_Y = [0.3, 0.85];
const ROLL_FULL = 0.8;                  // 掌轴偏离竖直该角度（rad）时 lean 满幅
const LEAN_MAX = 0.35;
const CHIR_FLIP = 0.15;                 // 手性翻转门限（叉积 / 掌长²，平摊手掌约 0.6）

// ---- 甩剑：窗口内小拇指屏幕方向的累计转角 / 时长；摆幅不够视为抖动
const SPIN_WIN = 0.4;                   // s
const SPIN_RANGE = 45;                  // deg，窗口内摆幅门限（正常打球时 p98 ≈ 46°）
const SPIN_ATTACK = 10, SPIN_RELEASE = 2.5;
// ---- 调转：小拇指屏幕方向在 FLIP_WIN 内持续转过 FLIP_DEG
const FLIP_DEG = 120, FLIP_WIN = 0.35, FLIP_COOLDOWN = 2.5;
const FLIP_EXT = 0.5;                   // 小拇指伸直度门限（弯曲时方向不可信）
const FLIP_OPEN = 0.5;                  // 食/中/无名指至少两根伸直（容许侧手时一根被挡）：握拳不算
const FLIP_EXT_DROP = 0.3;              // 窗口内四指平均伸直度下降超过此值 = 正在握拳
const FLIP_CONFIRM = 0.1;               // 转够后再观察这么久（s），手仍张开才触发
const FLIP_MIN_SAMPLES = 4;             // 转角至少跨这么多个样本（排除单步跳变被滤波摊开）
const FLIP_GAP = 0.15;                  // 样本间隔超过此值（s）打断窗口
const FLIP_STEP = 100;                  // 单样本跳变超过此角度视为追踪错位
const FLIP_JUMP = 1.2;                  // 单样本掌心位移超过此倍掌长视为换手

const NEUTRAL = { px: 0.5, py: 0.5, lean: 0, paddleArm: -0.3, swordArm: 0 };
const map11 = (v, [a, b]) => remap(v, a, b, -1, 1);

export class ControlMapper {
  constructor() {
    this.control = {
      active: false, px: NEUTRAL.px, py: NEUTRAL.py, lean: 0,
      paddleArm: NEUTRAL.paddleArm, paddleSwing: 0, swordArm: NEUTRAL.swordArm, swordSpin: 0, swordFlip: false,
      fingers: { T: 0, I: 0, M: 0, R: 0, L: 0 }, position: NEUTRAL.px, motion: 0,
    };
    this.t = 0;
    this._lm = null;          // 上一样本（引用变化 = 新样本）
    this._target = { ...NEUTRAL };
    this._chir = 1;           // +1 = 左手掌心朝镜头；-1 = 镜像（右手或手背）
    this._pinky = null;       // 小拇指屏幕方向（展开成连续角，deg）
    this._palm = null;
    this._spinHist = [];      // {t, a}
    this._spinRaw = 0;
    this._spinDir = 1;
    this._spinEnv = 0;
    this._flipHist = [];      // {t, a, ext}
    this._flipPending = null; // 转够了、等待确认
    this._flipLastT = -Infinity;
    this._coolUntil = -Infinity;
  }

  update(hand, dt) {
    const c = this.control;
    this.t += dt;
    c.swordFlip = false;

    if (hand && hand.tracked && hand.landmarks) {
      if (hand.landmarks !== this._lm) this._sample(hand);
      c.active = true;
      for (const k in c.fingers) c.fingers[k] = damp(c.fingers[k], hand.fingers[k].ext, 15, dt);
      c.motion = hand.motion;
    } else {
      if (c.active) this._resetDynamics();
      c.active = false;
      this._lm = null;
      Object.assign(this._target, NEUTRAL);
      for (const k in c.fingers) c.fingers[k] = damp(c.fingers[k], 0, 2, dt);
      c.motion = damp(c.motion, 0, 4, dt);
    }

    const tg = this._target;
    const lam = c.active ? 16 : 1.5; // 丢手后缓慢回中
    c.px = damp(c.px, tg.px, lam, dt);
    c.py = damp(c.py, tg.py, lam, dt);
    c.lean = damp(c.lean, tg.lean, lam * 0.6, dt);
    const prevPaddle = c.paddleArm;
    c.paddleArm = damp(c.paddleArm, tg.paddleArm, c.active ? 22 : 1.5, dt);
    c.swordArm = damp(c.swordArm, tg.swordArm, lam, dt);
    c.position = c.px;

    // 挥拍角速度：paddleArm 的平滑导数（1/s）
    c.paddleSwing = damp(c.paddleSwing, (c.paddleArm - prevPaddle) / dt, 15, dt);

    // 甩剑：包络快起慢落，无输入衰减到 0
    const raw = c.active ? this._spinRaw : 0;
    this._spinEnv = damp(this._spinEnv, raw, raw > this._spinEnv ? SPIN_ATTACK : SPIN_RELEASE, dt);
    c.swordSpin = this._spinEnv < 1 ? 0 : this._spinDir * this._spinEnv;

    return c;
  }

  _resetDynamics() {
    this._pinky = this._palm = null;
    this._spinHist.length = this._flipHist.length = 0;
    this._spinRaw = 0;
    this._flipPending = null;
  }

  _sample(hand) {
    this._lm = hand.landmarks;
    const lm = hand.landmarks, f = hand.fingers, tg = this._target;
    const AY = 1 / (hand.aspect || 4 / 3); // 归一化 y → 画面宽度单位
    tg.px = remap(hand.palm.x, POS_X[0], POS_X[1], 0, 1);
    tg.py = remap(hand.palm.y, POS_Y[0], POS_Y[1], 0, 1);

    // 掌轴（手腕→中指根）偏离竖直的滚转
    const ax = lm[9].x - lm[0].x, ay = (lm[9].y - lm[0].y) * AY;
    tg.lean = clamp((Math.atan2(ax, -ay) / ROLL_FULL) * LEAN_MAX, -LEAN_MAX, LEAN_MAX);

    // 手性（带滞回）：左手掌心朝镜头时 食指根×小指根 叉积为负
    const ps2 = Math.max(1e-6, hand.palmSize * hand.palmSize);
    const cross = ((lm[5].x - lm[0].x) * (lm[17].y - lm[0].y) - (lm[5].y - lm[0].y) * (lm[17].x - lm[0].x)) * AY / ps2;
    if (cross < -CHIR_FLIP) this._chir = 1;
    else if (cross > CHIR_FLIP) this._chir = -1;

    tg.paddleArm = map11(f.T.angle * DEG * this._chir, THUMB_RANGE);
    const sword = map11(f.L.angle * DEG * this._chir, PINKY_RANGE);
    tg.swordArm = lerp(-1, sword, clamp((f.L.ext - PINKY_EXT[0]) / (PINKY_EXT[1] - PINKY_EXT[0]), 0, 1));

    // 小拇指屏幕方向（展开成连续角）
    const a = Math.atan2((lm[20].y - lm[17].y) * AY, lm[20].x - lm[17].x) * DEG;
    const jump = this._palm ? Math.hypot(hand.palm.x - this._palm.x, (hand.palm.y - this._palm.y) * AY) / Math.max(1e-3, hand.palmSize) : 0;
    this._palm = { x: hand.palm.x, y: hand.palm.y };
    let trusted = true;
    if (this._pinky === null || jump > FLIP_JUMP) {
      this._pinky = a; // 首帧或疑似换手：重新起算
      trusted = false;
    } else {
      const step = wrapAngle((a - this._pinky) / DEG) * DEG;
      this._pinky += step;
      // 追踪跳变 / 小拇指弯曲时方向不可信
      if (Math.abs(step) > FLIP_STEP || f.L.ext < FLIP_EXT) trusted = false;
    }
    this._spin(this._pinky, trusted);
    const open = trusted && [f.I, f.M, f.R].filter((g) => g.ext >= FLIP_OPEN).length >= 2;
    this._detectFlip(this._pinky, open, (f.I.ext + f.M.ext + f.R.ext + f.L.ext) / 4);
  }

  // 甩剑：窗口内累计转角 / 时长（来回甩也能累积），摆幅不够视为抖动
  _spin(a, trusted) {
    const h = this._spinHist, t = this.t;
    if (!trusted) h.length = 0;
    h.push({ t, a });
    while (t - h[0].t > SPIN_WIN) h.shift();
    let travel = 0, lo = a, hi = a;
    for (let i = 1; i < h.length; i++) {
      travel += Math.abs(h[i].a - h[i - 1].a);
      lo = Math.min(lo, h[i].a);
      hi = Math.max(hi, h[i].a);
    }
    const span = t - h[0].t;
    this._spinRaw = hi - lo >= SPIN_RANGE && span > 0.08 ? travel / Math.max(span, 0.2) : 0;
    const net = a - h[0].a;
    if (Math.abs(net) >= SPIN_RANGE) this._spinDir = Math.sign(net); // 单向转动定方向；来回甩保持上次方向
  }

  // 调转：要求张开的手、连续样本、持续转动（非单步跳变），转够后再确认 FLIP_CONFIRM 秒
  _detectFlip(a, open, ext) {
    const h = this._flipHist, t = this.t;
    const broken = !open || t - this._flipLastT > FLIP_GAP;
    this._flipLastT = t;
    if (this._flipPending) {
      const p = this._flipPending;
      if (broken || p.ext - ext > FLIP_EXT_DROP) {
        this._flipPending = null; // 转完接着握拳 / 丢手：不算
        h.length = 0;
      } else if (t - p.t >= FLIP_CONFIRM) {
        this._flipPending = null;
        this.control.swordFlip = true;
        this._coolUntil = t + FLIP_COOLDOWN;
        h.length = 0;
      }
      return;
    }
    if (broken) {
      h.length = 0;
      return;
    }
    h.push({ t, a, ext });
    while (t - h[0].t > FLIP_WIN) h.shift();
    if (t < this._coolUntil) return;
    let i0 = 0;
    for (let i = 1; i < h.length; i++) if (Math.abs(a - h[i].a) > Math.abs(a - h[i0].a)) i0 = i;
    const total = Math.abs(a - h[i0].a);
    if (total < FLIP_DEG || h.length - 1 - i0 < FLIP_MIN_SAMPLES) return;
    let maxStep = 0, maxExt = 0;
    for (let i = i0; i < h.length; i++) {
      if (i > i0) maxStep = Math.max(maxStep, Math.abs(h[i].a - h[i - 1].a));
      maxExt = Math.max(maxExt, h[i].ext);
    }
    if (maxStep > total * 0.6 || maxExt - ext > FLIP_EXT_DROP) return;
    this._flipPending = { t, ext: maxExt };
  }
}
