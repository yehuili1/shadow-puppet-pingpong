// 测试替身：PuppetRig（rig.js 未就绪时由 tests/hud.html 的 import map 重定向到这里）
// 只实现 HUD 用到的接口：setPose/snap/update/draw/controlPoints，画一个简化的彩色小人
import { SK } from '../../src/puppet/skeleton.js';
import { PADDLE_R } from '../../src/core/world.js';
import { Spring, rotate } from '../../src/core/math.js';

const KEYS = ['x', 'y', 'lean', 'headTilt', 'frontShoulder', 'frontElbow', 'backShoulder', 'backElbow',
  'swordAngle', 'frontLeg', 'backLeg', 'tongue', 'fallen', 'visible'];

export class PuppetRig {
  constructor({ character = 'hero', facing = 1, style = 'shadow', scale = 1 } = {}) {
    this.character = character; this.facing = facing; this.style = style; this.scale = scale;
    this.target = { x: 0, y: 0, lean: 0, headTilt: 0, frontShoulder: -0.3, frontElbow: -0.3, backShoulder: 0.3,
      backElbow: 0.2, swordAngle: 0, frontLeg: -0.1, backLeg: 0.1, tongue: 0, fallen: 0, visible: 1 };
    this.sp = Object.fromEntries(KEYS.map((k) => [k, new Spring(this.target[k], k === 'x' || k === 'y' ? 200 : 140, k === 'x' || k === 'y' ? 22 : 16)]));
    this.pose = { ...this.target };
    this.j = {};
    this._joints();
  }
  setPose(p) { Object.assign(this.target, p); }
  snap() { for (const k of KEYS) { this.sp[k].snap(this.target[k]); this.pose[k] = this.target[k]; } this._joints(); }
  update(dt) {
    for (const k of KEYS) { const s = this.sp[k]; s.target = this.target[k]; this.pose[k] = s.update(dt); }
    this._joints();
  }
  _joints() {
    const p = this.pose, f = this.facing, s = this.scale;
    const W = (l) => ({ x: p.x + f * s * l.x, y: p.y + s * l.y });
    const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
    const seg = (o, len, a) => add(o, rotate(0, len, a));
    const tor = (v) => rotate(v.x, v.y, p.lean);
    const neck = tor(SK.neck);
    const head = add(neck, rotate(SK.headTop.x, SK.headTop.y, p.lean + p.headTilt));
    const arm = (sh, a1, a2) => {
      const o = tor(sh), e = seg(o, SK.upperArmLen, p.lean + a1), w = seg(e, SK.forearmLen, p.lean + a1 + a2);
      return { o, e, w, a: p.lean + a1 + a2 };
    };
    const fa = arm(SK.frontShoulder, p.frontShoulder, p.frontElbow);
    const ba = arm(SK.backShoulder, p.backShoulder, p.backElbow);
    const fk = seg(SK.frontHip, SK.legLen, p.frontLeg), bk = seg(SK.backHip, SK.legLen, p.backLeg);
    const L = { pelvis: { x: 0, y: 0 }, neck, head, faceC: add(neck, rotate(0, -70, p.lean)),
      fo: fa.o, fe: fa.e, fw: fa.w, bo: ba.o, be: ba.e, bw: ba.w,
      pad: seg(fa.w, SK.paddleCenter, fa.a), sword: seg(ba.w, SK.swordLen, ba.a + p.swordAngle),
      fh: SK.frontHip, bh: SK.backHip, fk, bk };
    this.j = Object.fromEntries(Object.entries(L).map(([k, v]) => [k, W(v)]));
    const j = this.j;
    this.controlPoints = { head: j.head, frontHand: j.fw, backHand: j.bw, pelvis: j.pelvis };
    this.paddle = { x: j.pad.x, y: j.pad.y, r: PADDLE_R * s, vx: 0, vy: 0, angle: fa.a };
    this.swordTip = { x: j.sword.x, y: j.sword.y, vx: 0, vy: 0 };
    this.swordBase = j.bw;
    this.bodyHit = [{ x: j.faceC.x, y: j.faceC.y, r: 50 * s }];
  }
  draw(ctx, { alpha = 1 } = {}) {
    const j = this.j, s = this.scale, color = this.style === 'color';
    const C = color ? { a: '#C8202E', b: '#1E8C5A', c: '#E3A92B', d: '#2B2B6E', skin: '#F0C9A0' }
      : { a: '#3a2a1c', b: '#3a2a1c', c: '#3a2a1c', d: '#3a2a1c', skin: '#3a2a1c' };
    ctx.save();
    ctx.globalAlpha *= alpha * (this.pose.visible ?? 1);
    ctx.lineCap = 'round';
    const line = (a, b, w, c) => { ctx.strokeStyle = c; ctx.lineWidth = w * s; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
    line(j.bw, j.sword, 8, '#D8D8D8');
    line(j.bo, j.be, SK.upperArmW, C.d); line(j.be, j.bw, SK.forearmW, C.b);
    line(j.bh, j.bk, SK.legW, C.d); line(j.fh, j.fk, SK.legW, C.a);
    // 下摆 + 躯干
    ctx.fillStyle = C.b;
    ctx.beginPath(); ctx.moveTo(j.pelvis.x - 55 * s, j.pelvis.y); ctx.lineTo(j.pelvis.x + 55 * s, j.pelvis.y);
    ctx.lineTo(j.pelvis.x + 85 * s, j.pelvis.y + SK.skirtLen * s); ctx.lineTo(j.pelvis.x - 85 * s, j.pelvis.y + SK.skirtLen * s); ctx.fill();
    line(j.pelvis, j.neck, 80, C.a);
    ctx.fillStyle = C.c; ctx.beginPath(); ctx.arc(j.faceC.x, j.faceC.y, 46 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.skin; ctx.beginPath(); ctx.arc(j.faceC.x + this.facing * 8 * s, j.faceC.y + 6 * s, 30 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.d; ctx.beginPath(); ctx.moveTo(j.head.x, j.head.y); ctx.lineTo(j.faceC.x - 40 * s, j.faceC.y - 30 * s); ctx.lineTo(j.faceC.x + 30 * s, j.faceC.y - 34 * s); ctx.fill();
    line(j.fo, j.fe, SK.upperArmW, C.c); line(j.fe, j.fw, SK.forearmW, C.a);
    line(j.fw, j.pad, 6, '#222');
    ctx.fillStyle = color ? '#E0202A' : '#111'; ctx.beginPath(); ctx.arc(j.pad.x, j.pad.y, PADDLE_R * s, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ikArm() { return { shoulder: 0, elbow: 0 }; }
}
