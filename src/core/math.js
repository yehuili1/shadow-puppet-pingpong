// 通用数学工具

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d, clamped = true) => {
  const t = invLerp(a, b, v);
  return lerp(c, d, clamped ? clamp(t, 0, 1) : t);
};
export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

// 帧率无关的指数趋近：lambda 越大越快
export const damp = (cur, target, lambda, dt) => lerp(cur, target, 1 - Math.exp(-lambda * dt));

export const wrapAngle = (a) => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};
export const angleDamp = (cur, target, lambda, dt) => cur + wrapAngle(target - cur) * (1 - Math.exp(-lambda * dt));

// 临界阻尼弹簧（半隐式欧拉），用于皮影摆动
export class Spring {
  constructor(value = 0, stiffness = 120, damping = 14) {
    this.value = value;
    this.velocity = 0;
    this.target = value;
    this.k = stiffness;
    this.c = damping;
  }
  update(dt) {
    const a = this.k * (this.target - this.value) - this.c * this.velocity;
    this.velocity += a * dt;
    this.value += this.velocity * dt;
    return this.value;
  }
  snap(v = this.target) {
    this.value = this.target = v;
    this.velocity = 0;
  }
}

// One Euro Filter：手部关键点去抖（低速平滑、高速跟手）
export class OneEuro {
  constructor(minCutoff = 1.2, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(value, dt) {
    if (this.x === null || !(dt > 0)) {
      this.x = value;
      this.dx = 0;
      return value;
    }
    const dx = (value - this.x) / dt;
    this.dx = lerp(this.dx, dx, OneEuro.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x = lerp(this.x, value, OneEuro.alpha(cutoff, dt));
    return this.x;
  }
  reset() {
    this.x = null;
    this.dx = 0;
  }
}

// 点绕原点旋转（canvas 约定：正角度顺时针）
export const rotate = (x, y, a) => {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: x * c - y * s, y: x * s + y * c };
};
