// HUD：顶栏标题、镜像摄像头画面、手骨架、挂在手上的彩色小皮影 + 红提线、AGENT 面板、终端面板
// 尺寸以参考帧为准（摄像头区宽 711 时 fs=1），所有字号/间距按 fs 缩放
import { PuppetRig } from '../puppet/rig.js';
import { clamp, damp, lerp, angleDamp } from '../core/math.js';

const MINT = '#5CF2B8';
const MAGENTA = '#FF4FD8';
const RED = '#FF4D6D';
const WHITE = '#EDEDED';
const GRAY = '#A9AFB3';
const BG = '#141414';
const MONO = 'ui-monospace, Consolas, Menlo, monospace';
const CJK = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

// MediaPipe 21 点标准连线
const LINKS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
const TIPS = [4, 8, 12, 16, 20];
const FINGER_KEYS = ['T', 'I', 'M', 'R', 'L'];
const TITLE = '指尖皮影剧场';
const SAMPLE_HZ = 30;      // 波形采样率
const WAVE_N = 90;         // 波形长度（3 秒）
const PUPPET_H = 700;      // 皮影全高（世界单位，头饰顶 → 靴底）

// 固定长度环形缓冲
class Ring {
  constructor(n) { this.a = new Float32Array(n); this.i = 0; }
  push(v) { this.a[this.i] = v; this.i = (this.i + 1) % this.a.length; }
  at(k) { return this.a[(this.i + k) % this.a.length]; } // k=0 最旧
  get length() { return this.a.length; }
}

export class HudRenderer {
  constructor() {
    this.layout = null;
    this.dpr = 1;
    this.g = null;                 // 预计算的几何与字体
    this.rig = new PuppetRig({ character: 'hero', facing: 1, style: 'color', scale: 1 });
    this.puppet = { k: 0, alpha: 0, swordAngle: 0, shown: false, tx: 0, ty: 0 };
    this.motionWave = new Ring(WAVE_N);
    this.hitWave = new Ring(WAVE_N);
    this.sampleAcc = 0;
    this.hitEnv = 0;
    this.lastEventT = null;        // 已处理到的事件时间（首帧只对齐，不补脉冲）
    this.lastHits = null;
    this.charW = new Map();        // font → 等宽字符宽（只量一次）
    this.lmPx = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
    // 等宽字体的字宽/字号比（Consolas 比 SF Mono 窄）：字号按「字宽」反推，各平台面板排版一致
    const m = document.createElement('canvas').getContext('2d');
    m.font = `100px ${MONO}`;
    this.monoRatio = m.measureText('0').width / 100 || 0.6;
  }

  resize(layout, dpr = 1) {
    this.layout = layout;
    this.dpr = dpr;
    const cam = layout.camera;
    const portrait = layout.mode === 'portrait';
    const fs = portrait ? cam.w / 711 : clamp(cam.w / 470, 0.6, 1.1);
    const px = (v, min = 0) => Math.max(min, v * fs);
    // 参数为参考帧实测字宽（px/字符），换算成当前字体的字号
    const mono = (cw, k, bold = false) => `${bold ? 'bold ' : ''}${Math.max(6, (cw * k) / this.monoRatio).toFixed(1)}px ${MONO}`;

    // AGENT 面板（摄像头区左上）
    const agent = { x: cam.x + px(23), y: cam.y + px(16), w: px(177), h: px(139) };
    // 终端面板：竖屏压在摄像头区右下（参考帧）；横屏放在摄像头下方，与之同宽
    let tf = fs, term;
    if (portrait) {
      term = { x: cam.x + cam.w - px(14) - 249 * fs, y: cam.y + cam.h - px(14) - 359 * fs, w: 249 * fs, h: 359 * fs };
    } else {
      const top = cam.y + cam.h + 16, avail = layout.stage.y + layout.stage.h - 16 - top;
      tf = Math.max(0.5, Math.min(cam.w / 249, avail / 359, fs * 1.35));
      term = { x: cam.x, y: top, w: cam.w, h: Math.min(359 * tf, Math.max(60, avail)) };   // 矮窗口：面板收在窗口内，放不下的行裁掉
    }
    const tpx = (v, min = 0) => Math.max(min, v * tf);

    this.g = {
      fs, px, tf, tpx, portrait, agent, term,
      f: {
        agent: mono(7.3, fs), agentBold: mono(7.3, fs, true), input: mono(5.9, fs), label: mono(5.3, fs),
        term: mono(6.3, tf), termBold: mono(6.3, tf, true), finger: mono(5.7, tf), hit: mono(5.4, tf, true), event: mono(5.65, tf),
        mock: mono(6.5, fs), hint: `${px(18, 12).toFixed(1)}px ${CJK}`,
      },
    };
  }

  draw(ctx, { t = 0, dt = 1 / 60, video, hand, control, director, events, layout }) {
    if (layout && layout !== this.layout) this.resize(layout, this.dpr);
    if (!this.g) return;
    const L = this.layout, g = this.g;
    hand = hand || {};
    control = control || {};
    director = director || {};

    this._sampleWaves(dt, control, director, events);

    ctx.save();
    ctx.textBaseline = 'middle';
    this._drawFrame(ctx, L);
    this._drawTitle(ctx, L.title, L.mode);

    // 摄像头区（裁切）：画面 → 面板 → 骨架 → 小皮影 → 提线（参考帧里小人压在面板上面）
    const cam = L.camera;
    const vf = this._videoFrame(cam, video, hand);
    ctx.save();
    ctx.beginPath();
    ctx.rect(cam.x, cam.y, cam.w, cam.h);
    ctx.clip();
    if (vf.live) this._drawVideo(ctx, video, vf);
    else this._drawMockBg(ctx, cam);
    this._drawAgent(ctx, director, control);
    if (g.portrait) this._drawTerm(ctx, t, hand, control, director, events);
    const lm = hand.tracked && hand.landmarks ? this._mapLandmarks(hand.landmarks, vf) : null;
    if (lm) this._drawSkeleton(ctx, lm);
    this._drawPuppet(ctx, t, dt, lm, control, cam);
    if (!hand.tracked) this._drawHint(ctx, cam, t);
    ctx.restore();

    if (!g.portrait) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(cam.x - 0.5, cam.y - 0.5, cam.w + 1, cam.h + 1);
      this._drawTerm(ctx, t, hand, control, director, events);
    }
    ctx.restore();
  }

  // ---------- 背景与标题

  // 戏台以外的区域铺近黑底（竖屏的上下留黑；横屏的顶栏与左侧栏）
  _drawFrame(ctx, L) {
    const W = ctx.canvas.width / this.dpr, H = ctx.canvas.height / this.dpr;
    const s = L.stage;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, s.y);
    ctx.fillRect(0, s.y + s.h, W, H - s.y - s.h);
    ctx.fillRect(0, s.y, s.x, s.h);
    ctx.fillRect(s.x + s.w, s.y, W - s.x - s.w, s.h);
    if (L.mode === 'landscape') {
      // 画中画底板 + 淡投影
      const c = L.camera;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 18;
      ctx.fillStyle = '#0c0c0c';
      ctx.fillRect(c.x, c.y, c.w, c.h);
      ctx.restore();
    }
  }

  _drawTitle(ctx, r, mode) {
    const size = clamp(r.h * (mode === 'portrait' ? 0.15 : 0.36), 9, 16);
    const step = size * 2.05;
    const cy = r.y + r.h * (mode === 'portrait' ? 0.4 : 0.52);
    let x = r.x + r.w - Math.max(8, size * 0.8) - size / 2;
    ctx.font = `${size.toFixed(1)}px ${CJK}`;
    ctx.fillStyle = '#A7A7A1';
    ctx.textAlign = 'center';
    for (let i = TITLE.length - 1; i >= 0; i--, x -= step) ctx.fillText(TITLE[i], x, cy);
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1);
  }

  // ---------- 摄像头画面

  // cover 适配：视频帧在屏幕上的位置（裁切到 camera 区），landmark 用同一映射
  _videoFrame(cam, video, hand) {
    const live = !!(video && video.readyState >= 2 && video.videoWidth > 0 && hand.source !== 'mock');
    const vw = live ? video.videoWidth : 640, vh = live ? video.videoHeight : 480;
    const s = Math.max(cam.w / vw, cam.h / vh);
    const w = vw * s, h = vh * s;
    return { live, x: cam.x + (cam.w - w) / 2, y: cam.y + (cam.h - h) / 2, w, h };
  }

  _drawVideo(ctx, video, f) {
    ctx.save();
    ctx.translate(f.x + f.w, f.y);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, f.w, f.h);
    ctx.restore();
  }

  _drawMockBg(ctx, cam) {
    const { px, f } = this.g;
    ctx.fillStyle = '#1B1D1F';
    ctx.fillRect(cam.x, cam.y, cam.w, cam.h);
    const step = px(36, 16);
    ctx.beginPath();
    for (let x = cam.x + (cam.w % step) / 2; x < cam.x + cam.w; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, cam.y);
      ctx.lineTo(Math.round(x) + 0.5, cam.y + cam.h);
    }
    for (let y = cam.y + (cam.h % step) / 2; y < cam.y + cam.h; y += step) {
      ctx.moveTo(cam.x, Math.round(y) + 0.5);
      ctx.lineTo(cam.x + cam.w, Math.round(y) + 0.5);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = f.mock;
    ctx.fillStyle = 'rgba(200,205,210,0.45)';
    ctx.fillText('MOCK INPUT', cam.x + px(14), cam.y + cam.h - px(18));
  }

  _drawHint(ctx, cam, t) {
    const a = 0.6 + 0.18 * Math.sin(t * 2.4);
    ctx.save();
    ctx.font = this.g.f.hint;
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.fillText('举起左手开始', cam.x + cam.w / 2, cam.y + cam.h * 0.72);
    ctx.restore();
  }

  // ---------- 手骨架

  _mapLandmarks(lms, f) {
    const out = this.lmPx;
    for (let i = 0; i < 21; i++) {
      out[i].x = f.x + lms[i].x * f.w;
      out[i].y = f.y + lms[i].y * f.h;
    }
    return out;
  }

  _drawSkeleton(ctx, p) {
    const { px } = this.g;
    ctx.lineWidth = px(1.6, 1);
    ctx.strokeStyle = MINT;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    for (const [a, b] of LINKS) {
      ctx.moveTo(p[a].x, p[a].y);
      ctx.lineTo(p[b].x, p[b].y);
    }
    ctx.stroke();
    // 关节小点
    ctx.fillStyle = MINT;
    const jr = px(1.8, 1);
    ctx.beginPath();
    for (let i = 0; i < 21; i++) {
      if (TIPS.includes(i)) continue;
      ctx.moveTo(p[i].x + jr, p[i].y);
      ctx.arc(p[i].x, p[i].y, jr, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // 指尖空心圆 + 拇指尖红点（画在小人和提线之上）
  _drawTips(ctx, p) {
    const { px } = this.g;
    const r = px(6, 3);
    ctx.lineWidth = px(1.6, 1);
    ctx.strokeStyle = MINT;
    ctx.beginPath();
    for (const i of TIPS) {
      ctx.moveTo(p[i].x + r, p[i].y);
      ctx.arc(p[i].x, p[i].y, r, 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.fillStyle = RED;
    ctx.beginPath();
    ctx.arc(p[4].x, p[4].y, px(4.2, 2.5), 0, Math.PI * 2);
    ctx.fill();
  }

  // ---------- 彩色小皮影（挂在手前）

  _drawPuppet(ctx, t, dt, lm, control, cam) {
    const P = this.puppet, rig = this.rig;
    if (lm) {
      // 掌长取「手腕→中指根」与「掌宽×1.3」较大者，手掌前倾透视缩短时小人不会突然变小
      const palmPx = Math.max(Math.hypot(lm[9].x - lm[0].x, lm[9].y - lm[0].y), 1.3 * Math.hypot(lm[17].x - lm[5].x, lm[17].y - lm[5].y));
      const k = clamp((palmPx * 2.2) / PUPPET_H, (cam.h * 0.3) / PUPPET_H, (cam.h * 0.85) / PUPPET_H); // 小人全高 ≈ 2.2 倍掌长
      P.k = P.shown ? damp(P.k, k, 6, dt) : k;
      // 骨盆在掌心偏下，头靠近中指根
      let cx = 0;
      for (const i of [0, 5, 9, 13, 17]) cx += lm[i].x / 5;
      P.tx = cx - palmPx * 0.4;                     // 参考帧里小人偏小拇指一侧
      P.ty = lm[9].y + 265 * P.k;
    }
    P.alpha = damp(P.alpha, lm ? 1 : 0, lm ? 10 : 4, dt);
    if (!P.k || (P.alpha < 0.01 && !lm)) { P.shown = false; return; }

    // 局部坐标：以摄像头区中心为原点、除以 k（让弹簧在皮影自身尺度下工作）
    const ox = cam.x + cam.w / 2, oy = cam.y + cam.h / 2, k = P.k;
    const pa = clamp(((control.paddleArm ?? -0.3) + 1) / 2, 0, 1);
    const sa = clamp(((control.swordArm ?? 0) + 1) / 2, 0, 1);
    // 甩剑：按 swordSpin 累加旋转；停下后回到横剑胸前（-1.2）
    const spin = control.swordSpin || 0;
    if (Math.abs(spin) > 20) P.swordAngle += (spin * Math.PI / 180) * dt;
    else P.swordAngle = angleDamp(P.swordAngle, 0, 3, dt);
    const sway = clamp((control.motion || 0) / 300, 0, 1) * 0.22 * Math.sin(t * 9);
    rig.setPose({
      x: (P.tx - ox) / k, y: (P.ty - oy) / k,
      lean: (control.lean || 0) * 0.8, headTilt: 0,
      // 拇指：放下 → 拍贴身；抬起 → 前伸略高于水平（中立 -0.3 时接近 rig 默认站姿）
      frontShoulder: lerp(-0.4, -1.65, pa), frontElbow: lerp(-0.5, -0.25, pa),
      // 小拇指：放下 → 横剑胸前；举起 → 剑举到身后上方
      backShoulder: lerp(0.2, 2.5, sa), backElbow: lerp(-1.4, -0.3, sa),
      swordAngle: -1.2 * (1 - sa) + P.swordAngle,
      frontLeg: -0.12 + sway, backLeg: 0.12 - sway,
      tongue: 0, fallen: 0, visible: 1,
    });
    if (!P.shown) { rig.snap(); P.shown = true; }
    rig.update(dt);

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(k, k);
    ctx.imageSmoothingQuality = 'high';   // 小人缩得很小，高质量缩小免得纹样闪
    rig.draw(ctx, { alpha: P.alpha, strings: false });
    ctx.restore();

    if (!lm) return;
    // 红提线：拇指→持拍手，小拇指→持剑手，中指→头，食指/无名指→骨盆
    const cp = rig.controlPoints;
    if (cp) {
      const sx = (q) => ox + q.x * k, sy = (q) => oy + q.y * k;
      ctx.strokeStyle = RED;
      ctx.lineWidth = this.g.px(1.5, 1);
      ctx.globalAlpha = 0.9 * P.alpha;
      ctx.beginPath();
      for (const [tip, q] of [[4, cp.frontHand], [20, cp.backHand], [12, cp.head], [8, cp.pelvis], [16, cp.pelvis]]) {
        if (!q) continue;
        ctx.moveTo(lm[tip].x, lm[tip].y);
        ctx.lineTo(sx(q), sy(q));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    this._drawTips(ctx, lm);
  }

  // ---------- 面板

  // 面板底 + 描边；之后的文字带 1px 下投影（参考帧文字压在画面上靠投影保证可读）
  _panel(ctx, r, bgA, lineA) {
    ctx.fillStyle = `rgba(10,12,14,${bgA})`;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = `rgba(235,235,235,${lineA})`;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1);
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowOffsetY = 1;
  }

  _hline(ctx, x, y, w, a = 0.3) {
    ctx.fillStyle = `rgba(235,235,235,${a})`;
    ctx.fillRect(x, Math.round(y), w, 1);
  }

  _cw(ctx, font) {
    let w = this.charW.get(font);
    if (w === undefined) {
      ctx.font = font;
      w = ctx.measureText('0').width;
      this.charW.set(font, w);
    }
    return w;
  }

  // 多色片段一行：segs = [text, color, text, color, ...]（等宽字体，按字符数推进）
  _segs(ctx, x, y, font, segs) {
    const cw = this._cw(ctx, font);
    ctx.font = font;
    for (let i = 0; i < segs.length; i += 2) {
      ctx.fillStyle = segs[i + 1];
      ctx.fillText(segs[i], x, y);
      x += segs[i].length * cw;
    }
    return x;
  }

  _text(ctx, s, x, y, font, color, align = 'left') {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(s, x, y);
    if (align !== 'left') ctx.textAlign = 'left';
  }

  _wave(ctx, ring, x, y, w, amp, color, lw = this.g.px(1.2, 1)) {
    const n = ring.length;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const v = ring.at(i);
      const px = x + (w * i) / (n - 1), py = y - v * amp;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.stroke();
  }

  _drawAgent(ctx, director, control) {
    const { agent: r, px, f } = this.g;
    ctx.save();
    this._panel(ctx, r, 0.22, 0.75);
    const x = r.x + px(9), iw = r.w - px(18), y = r.y;
    this._segs(ctx, x, y + px(14), f.agentBold, ['AGENT:', MINT]);
    this._segs(ctx, x + this._cw(ctx, f.agentBold) * 7, y + px(14), f.agent, ['PINGPONG', WHITE]);
    this._segs(ctx, x, y + px(31.7), f.agent, ['STATUS: ', WHITE]);
    this._segs(ctx, x + this._cw(ctx, f.agent) * 8, y + px(31.7), f.agentBold, [String(director.status ?? 'WAITING'), MAGENTA]);
    this._text(ctx, 'INPUT / LEFT HAND', x, y + px(48.7), f.input, '#C4C8CB');
    this._hline(ctx, x, y + px(61.7), iw, 0.35);

    // POSITION：数值 + 细轨道上的游标
    const pos = clamp(control.position ?? control.px ?? 0, 0, 1);
    this._text(ctx, 'POSITION', x, y + px(72.7), f.label, '#D6D9DB');
    this._text(ctx, pos.toFixed(2), x + iw, y + px(72.7), f.label, '#D6D9DB', 'right');
    this._hline(ctx, x, y + px(85), iw, 0.28);
    ctx.fillStyle = MINT;
    ctx.fillRect(x + pos * iw - px(1.5, 1), y + px(81), px(3, 2), px(8, 4));

    // MOTION：px/s + 左起填充条
    const motion = Math.max(0, control.motion || 0);
    this._text(ctx, 'MOTION', x, y + px(98), f.label, '#D6D9DB');
    this._text(ctx, `${Math.round(motion)} px/s`, x + iw, y + px(98), f.label, '#D6D9DB', 'right');
    this._hline(ctx, x, y + px(110), iw, 0.28);
    ctx.fillStyle = MINT;
    ctx.fillRect(x, y + px(109), Math.max(px(2, 1), iw * motionLevel(motion)), px(2.5, 2));

    // 运动波形
    this._wave(ctx, this.motionWave, x, y + px(132), iw, px(13), MAGENTA);
    ctx.restore();
  }

  _drawTerm(ctx, t, hand, control, director, events) {
    const { term: r, tpx: px, f } = this.g;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);   // 面板被压矮时，下面的事件行裁掉不溢出
    ctx.clip();
    this._panel(ctx, r, 0.28, 0.5);
    const x = r.x + px(10), iw = r.w - px(20), y = r.y;
    const vx = r.x + Math.max(px(170), r.w * 0.6);
    const status = String(director.status ?? 'WAITING').toLowerCase();

    this._segs(ctx, x, y + px(16), f.term, ['puppet@local:~$', MAGENTA, ' watch', WHITE]);
    this._text(ctx, hand.tracked ? '[ok] left hand tracked' : '[..] waiting for hand', x, y + px(34), f.term, hand.tracked ? WHITE : GRAY);
    this._hline(ctx, r.x, y + px(47), r.w, 0.3);
    const ex = this._segs(ctx, x, y + px(58), f.termBold, ['status:', MINT]);
    const sx = this._segs(ctx, ex, y + px(58), f.term, [' ' + status, WHITE]);
    if ((t * 2.2) % 2 < 1.2) this._text(ctx, '_', sx + this._cw(ctx, f.term) * 0.2, y + px(58), f.term, WHITE);
    this._hline(ctx, r.x, y + px(71), r.w, 0.3);

    // 键值表
    const st = hand.stats || {};
    const ds = director.stats || {};
    const num = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '--');
    const rows = [
      ['render / track', `${num(st.renderHz)} / ${num(st.trackHz)} Hz`],
      ['inference', `${num(st.inferenceMs, 1)} ms`],
      ['sample age', `${num(st.sampleAgeMs)} ms`],
      ['weapon spin', `${num(Math.abs(control.swordSpin || 0))} deg/s`],
      ['paddle', String(director.paddleState ?? 'follow')],
      ['returns', num(ds.returns ?? 0)],
      ['rally time', `${num(ds.rallyTime ?? 0, 1)} s`],
      ['score', `${num(ds.scorePlayer ?? 0)} : ${num(ds.scoreCpu ?? 0)}`],
    ];
    ctx.font = f.term;
    for (let i = 0; i < rows.length; i++) {
      const ry = y + px(87 + 17.4 * i);
      ctx.fillStyle = GRAY;
      ctx.fillText(rows[i][0], x, ry);
      ctx.fillStyle = WHITE;
      ctx.fillText(rows[i][1], vx, ry);
    }

    // 五指伸直度
    const fy = y + px(231);
    this._segs(ctx, x, fy, f.finger, ['$ finger.input [T I M R L]', MINT]);
    const gap = px(5), sw = (iw - gap * 4) / 5, bh = px(3, 2), by = y + px(243);
    for (let i = 0; i < 5; i++) {
      const k = FINGER_KEYS[i];
      const fv = control.fingers?.[k];
      const ext = clamp(typeof fv === 'number' ? fv : hand.fingers?.[k]?.ext ?? 0, 0, 1);
      const bx = x + i * (sw + gap);
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fillRect(bx, by, sw, bh);
      ctx.fillStyle = MINT;
      ctx.fillRect(bx, by, sw * ext, bh);
    }

    // HIT 波形
    this._text(ctx, 'HIT', x, y + px(257), f.hit, MAGENTA);
    this._hline(ctx, x, y + px(264), iw, 0.22);
    this._wave(ctx, this.hitWave, x, y + px(284), iw, px(16), MAGENTA, px(1.2, 1));
    this._hline(ctx, x, y + px(290), iw, 0.22);

    // 最近 4 条事件
    const items = events?.items || [];
    const n = Math.min(4, items.length);
    const ecw = this._cw(ctx, f.event);
    const maxChars = Math.max(4, Math.floor((iw - ecw * 2) / ecw));
    for (let i = 0; i < n; i++) {
      const e = items[items.length - n + i];
      let s = `${e.t.toFixed(1)}s ${e.text}`;
      if (s.length > maxChars) s = s.slice(0, maxChars - 1) + '…';
      this._segs(ctx, x, y + px(302 + 13.6 * i), f.event, ['$ ', MAGENTA, s, '#C9CDD0']);
    }
    ctx.restore();
  }

  // ---------- 波形采样（固定 30Hz）

  _sampleWaves(dt, control, director, events) {
    // 命中脉冲：新事件 + stats.hits 增量
    const items = events?.items || [];
    if (this.lastEventT === null) this.lastEventT = items.length ? items[items.length - 1].t : -Infinity;
    for (let i = items.length - 1; i >= 0 && items[i].t > this.lastEventT; i--) {
      this.hitEnv = Math.max(this.hitEnv, hitStrength(items[i].text));
    }
    if (items.length) this.lastEventT = items[items.length - 1].t;
    const hits = director.stats?.hits;
    if (Number.isFinite(hits)) {
      if (this.lastHits !== null && hits > this.lastHits) this.hitEnv = 1;
      this.lastHits = hits;
    }
    this.hitEnv *= Math.exp(-5 * dt);

    this.sampleAcc += dt;
    if (this.sampleAcc > 0.5) this.sampleAcc = 0.5;
    while (this.sampleAcc >= 1 / SAMPLE_HZ) {
      this.sampleAcc -= 1 / SAMPLE_HZ;
      const swing = clamp(Math.abs(control.paddleSwing || 0) / 12, 0, 1) * 0.3;
      this.motionWave.push(motionLevel(Math.max(0, control.motion || 0)));
      this.hitWave.push(Math.min(1, this.hitEnv + swing));
    }
  }
}

// motion px/s → 0..1（饱和曲线：慢动作也看得见，快速挥手不爆表）
const motionLevel = (m) => m / (m + 60);

function hitStrength(text = '') {
  if (/miss/i.test(text)) return 0;
  if (/hit|player return/i.test(text)) return 1;
  if (/return/i.test(text)) return 0.7;
  if (/contact/i.test(text)) return 0.45;
  return 0;
}
