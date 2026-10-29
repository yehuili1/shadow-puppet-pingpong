// 测试替身：按 SPEC 契约的简化 PuppetRig（只用于 tests/stage.html）
// 画简单的透光皮影形状 + 提线；提供 setPose/snap/update/draw/controlPoints/paddle/swordTip/bodyHit
import { SK } from '../../src/puppet/skeleton.js';
import { PADDLE_R, PELVIS_Y, STRING_TOP_Y } from '../../src/core/world.js';
import { damp } from '../../src/core/math.js';

const DEFAULT = {
  x: 0, y: PELVIS_Y, lean: 0, headTilt: 0,
  frontShoulder: -1.2, frontElbow: -0.3, backShoulder: 0.4, backElbow: 0.5, swordAngle: -1.2,
  frontLeg: -0.2, backLeg: 0.25, tongue: 0, fallen: 0, visible: 1,
};

export class StubRig {
  constructor({ character = 'hero', facing = 1, scale = 1 } = {}) {
    this.character = character;
    this.facing = facing;
    this.scale = scale;
    this.target = { ...DEFAULT, x: facing > 0 ? 330 : 1270 };
    this.pose = { ...this.target };
    this.update(0);
  }
  setPose(p) { Object.assign(this.target, p); }
  snap() { Object.assign(this.pose, this.target); this.update(0); }

  // facing-local 点（相对某关节，已旋转 a）→ 世界
  _pt(ox, oy, lx, ly, a) {
    const c = Math.cos(a), s = Math.sin(a), f = this.facing, k = this.scale;
    return { x: ox + f * (lx * c - ly * s) * k, y: oy + (lx * s + ly * c) * k };
  }

  update(dt) {
    const P = this.pose, T = this.target;
    for (const key in T) P[key] = dt > 0 ? damp(P[key], T[key], 10, dt) : T[key];
    const pel = { x: P.x, y: P.y };
    const L = P.lean;
    const neck = this._pt(pel.x, pel.y, SK.neck.x, SK.neck.y, L);
    const fs = this._pt(pel.x, pel.y, SK.frontShoulder.x, SK.frontShoulder.y, L);
    const bs = this._pt(pel.x, pel.y, SK.backShoulder.x, SK.backShoulder.y, L);
    const fe = this._pt(fs.x, fs.y, 0, SK.upperArmLen, L + P.frontShoulder);
    const fw = this._pt(fe.x, fe.y, 0, SK.forearmLen, L + P.frontShoulder + P.frontElbow);
    const be = this._pt(bs.x, bs.y, 0, SK.upperArmLen, L + P.backShoulder);
    const bw = this._pt(be.x, be.y, 0, SK.forearmLen, L + P.backShoulder + P.backElbow);
    const fa = L + P.frontShoulder + P.frontElbow, sa = L + P.backShoulder + P.backElbow + P.swordAngle;
    const pc = this._pt(fw.x, fw.y, 0, SK.paddleCenter, fa);
    const tip = this._pt(bw.x, bw.y, 0, SK.swordLen, sa);
    const headTop = this._pt(neck.x, neck.y, SK.headTop.x, SK.headTop.y, L + P.headTilt);
    const fh = this._pt(pel.x, pel.y, SK.frontHip.x, SK.frontHip.y, 0);
    const bh = this._pt(pel.x, pel.y, SK.backHip.x, SK.backHip.y, 0);
    const fk = this._pt(fh.x, fh.y, 0, SK.legLen, P.frontLeg);
    const bk = this._pt(bh.x, bh.y, 0, SK.legLen, P.backLeg);
    const prev = this.paddle;
    const vdt = dt > 0 ? dt : 1;
    this.j = { pel, neck, fs, bs, fe, fw, be, bw, pc, tip, headTop, fh, bh, fk, bk, fa, sa };
    this.paddle = { x: pc.x, y: pc.y, r: PADDLE_R, vx: prev ? (pc.x - prev.x) / vdt : 0, vy: prev ? (pc.y - prev.y) / vdt : 0, angle: fa };
    const ptip = this.swordTip;
    this.swordTip = { x: tip.x, y: tip.y, vx: ptip ? (tip.x - ptip.x) / vdt : 0, vy: ptip ? (tip.y - ptip.y) / vdt : 0 };
    this.swordBase = { x: bw.x, y: bw.y };
    const mid = this._pt(pel.x, pel.y, 0, -100, L);
    const head = this._pt(neck.x, neck.y, 0, -60, L);
    this.bodyHit = [{ x: mid.x, y: mid.y, r: 55 }, { x: head.x, y: head.y, r: 45 }];
    this.controlPoints = { head: headTop, frontHand: fw, backHand: bw, pelvis: pel };
  }

  draw(ctx, { alpha = 1, strings = true, stringTopY = STRING_TOP_Y } = {}) {
    const j = this.j, f = this.facing, L = this.pose.lean;
    ctx.save();
    ctx.globalAlpha = alpha * this.pose.visible;
    ctx.lineCap = ctx.lineJoin = 'round';
    const body = 'rgba(38,26,16,0.82)', back = 'rgba(38,26,16,0.6)', lace = 'rgba(215,180,125,0.45)';
    const limb = (a, b, w, col) => {
      ctx.strokeStyle = col; ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = lace; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    };
    const poly = (pts, col) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
    };
    // 后臂 + 剑
    limb(j.bs, j.be, SK.upperArmW, back);
    limb(j.be, j.bw, SK.forearmW, back);
    ctx.strokeStyle = 'rgba(25,18,12,0.9)'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(j.bw.x, j.bw.y); ctx.lineTo(j.tip.x, j.tip.y); ctx.stroke();
    // 腿
    limb(j.bh, j.bk, SK.legW, back);
    limb(j.fh, j.fk, SK.legW, body);
    for (const k of [j.bk, j.fk]) poly([k, { x: k.x + f * SK.bootLen, y: k.y + 4 }, { x: k.x + f * SK.bootLen, y: k.y + 18 }, { x: k.x - f * 10, y: k.y + 18 }], body);
    // 下摆
    const P = (lx, ly) => this._pt(j.pel.x, j.pel.y, lx, ly, L * 0.5);
    poly([P(-SK.skirtWTop / 2, -10), P(SK.skirtWTop / 2, -10), P(SK.skirtWBottom / 2, SK.skirtLen), P(-SK.skirtWBottom / 2, SK.skirtLen)], 'rgba(38,26,16,0.7)');
    // 躯干
    const Q = (lx, ly) => this._pt(j.pel.x, j.pel.y, lx, ly, L);
    poly([Q(-SK.torsoWBottom / 2, 0), Q(SK.torsoWBottom / 2, 0), Q(SK.torsoWTop / 2, -SK.torsoLen), Q(-SK.torsoWTop / 2, -SK.torsoLen)], body);
    // 镂空纹（浅色线条模拟透光）
    ctx.strokeStyle = lace; ctx.lineWidth = 1.4;
    for (let i = 1; i < 6; i++) {
      const a = Q(-SK.torsoWTop / 2 + 8, -i * 32), b = Q(SK.torsoWTop / 2 - 8, -i * 32 + 10);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo((a.x + b.x) / 2, a.y - 12, b.x, b.y); ctx.stroke();
    }
    // 头 + 头饰扇
    const H = (lx, ly) => this._pt(j.neck.x, j.neck.y, lx, ly, L + this.pose.headTilt);
    const hc = H(8, -55), fan = H(-48, -95);
    ctx.fillStyle = 'rgba(38,26,16,0.55)';
    ctx.beginPath(); ctx.arc(fan.x, fan.y, 50, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(hc.x, hc.y, SK.faceW / 2, 55, 0, 0, Math.PI * 2); ctx.fill();
    const crown = H(0, -SK.headH);
    poly([H(-30, -95), H(30, -95), crown], body);
    ctx.fillStyle = 'rgba(230,200,150,0.5)';
    const eye = H(26, -62);
    ctx.beginPath(); ctx.arc(eye.x, eye.y, 4, 0, Math.PI * 2); ctx.fill();
    // 前臂 + 拍
    limb(j.fs, j.fe, SK.upperArmW, body);
    limb(j.fe, j.fw, SK.forearmW, body);
    ctx.fillStyle = '#15100c';
    ctx.beginPath(); ctx.arc(j.pc.x, j.pc.y, PADDLE_R, 0, Math.PI * 2); ctx.fill();
    // 提线
    if (strings) {
      ctx.strokeStyle = 'rgba(45,32,22,0.55)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (const p of [j.headTop, j.fw, j.bw]) { ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, stringTopY); }
      ctx.stroke();
    }
    ctx.restore();
  }
}
