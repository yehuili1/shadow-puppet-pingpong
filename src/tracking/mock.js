// 模拟手：无摄像头时合成一只「掌心朝镜头、手指朝上」的左手 21 个关键点（显示空间已镜像：拇指在画面右侧）
// 鼠标移动=掌心；按住左键=拇指抬起（松开回落 → 挥拍）；W/S=拇指；Q/A=小拇指；按住 E=甩小拇指；B=调转（翻腕带小拇指转 ~150°）
import { clamp, damp, lerp } from '../core/math.js';
import { THUMB_RANGE, PINKY_RANGE } from './control.js';

const ASPECT = 4 / 3; // 假定 640×480 画面

// 手掌局部坐标（掌长 = 手腕→中指根 = 1；u 向右、v 向下）
const BASE = { 0: [0, 0], 1: [0.24, -0.2], 5: [0.3, -0.93], 9: [0, -1], 13: [-0.25, -0.94], 17: [-0.46, -0.8] };
const SEG = {
  T: [0.4, 0.32, 0.28],
  I: [0.46, 0.27, 0.22],
  M: [0.5, 0.3, 0.24],
  R: [0.46, 0.28, 0.23],
  L: [0.36, 0.22, 0.2],
};
const SPREAD = { I: 0.14, M: 0, R: -0.13 }; // 掌内方向（rad，0=沿掌轴向上，顺时针为正）

// 拇指：-1 内收压下 → +1 向外抬平；小拇指：-1 并拢 → +1 外展。
// 指骨方向直接取 control.js 的标定区间，保证 thumb/pinky 参数与 paddleArm/swordArm 线性对应
const RAD = Math.PI / 180;
const THUMB_META = [0.2, 0.95];                         // 掌骨方向（rad）
const THUMB_DIR = THUMB_RANGE.map((d) => d * RAD);      // 指骨方向（MCP→TIP 相对掌轴）
const THUMB_FLEX = [0.55, 0.05];                        // 每节朝镜头的弯曲（压下时更弯）
const PINKY_DIR = PINKY_RANGE.map((d) => d * RAD);

export class MockHand {
  constructor(canvasEl) {
    this.p = { palm: { x: 0.35, y: 0.62 }, scale: 0.16, thumb: 0, pinky: 0, roll: 0, curl: 0 };
    this.target = structuredClone(this.p);
    this.thumbBase = 0;      // 松开鼠标时拇指回落的位置（W/S 调）；0 = 拍子在桌面高度前伸
    this.pressed = false;
    this.visible = true;
    this.spinning = false;   // E
    this.flipT = -1;         // B：调转动画开始时刻（ms）
    this._last = null;
    this._now = 0;
    if (canvasEl) this._bind(canvasEl);
  }

  _bind(el) {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      this.target.palm.x = clamp((e.clientX - r.left) / r.width, 0.08, 0.92);
      this.target.palm.y = clamp((e.clientY - r.top) / r.height, 0.15, 0.92);
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.pressed = true;
      this.target.thumb = 1;
    });
    window.addEventListener('pointerup', () => {
      this.pressed = false;
      this.target.thumb = this.thumbBase;
    });
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 's') {
        this.thumbBase = clamp(this.thumbBase + (k === 'w' ? 0.15 : -0.15), -1, 1);
        if (!this.pressed) this.target.thumb = this.thumbBase;
      } else if (k === 'q' || k === 'a') {
        this.target.pinky = clamp(this.target.pinky + (k === 'q' ? 0.15 : -0.15), -1, 1);
      } else if (k === 'e') this.spinning = true;
      else if (k === 'b' && !e.repeat) this.flip();
    });
    window.addEventListener('keyup', (e) => { if (e.key.toLowerCase() === 'e') this.spinning = false; });
  }

  // 自动化测试：palm/scale/roll 立即生效；thumb/pinky/curl 设目标（~40ms 跟上）
  // 额外：visible=false 模拟丢手；spin=true/false 模拟按住 E；flip=true 模拟按 B
  set(o = {}) {
    const { palm, scale, thumb, pinky, roll, curl, visible, spin, flip } = o;
    if (palm) { Object.assign(this.target.palm, palm); Object.assign(this.p.palm, palm); }
    if (scale !== undefined) this.target.scale = this.p.scale = scale;
    if (roll !== undefined) this.target.roll = this.p.roll = roll;
    if (thumb !== undefined) this.target.thumb = this.thumbBase = clamp(thumb, -1, 1);
    if (pinky !== undefined) this.target.pinky = clamp(pinky, -1, 1);
    if (curl !== undefined) this.target.curl = clamp(curl, 0, 1);
    if (visible !== undefined) this.visible = visible;
    if (spin !== undefined) this.spinning = spin;
    if (flip) this.flip();
  }

  flip() {
    this.flipT = this._now;
  }

  landmarks(now = performance.now()) {
    this._now = now;
    const dt = this._last === null ? 0 : Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    const p = this.p, tg = this.target, s = now / 1000;
    p.palm.x = damp(p.palm.x, tg.palm.x, 25, dt);
    p.palm.y = damp(p.palm.y, tg.palm.y, 25, dt);
    p.thumb = damp(p.thumb, tg.thumb, 25, dt);
    p.pinky = damp(p.pinky, tg.pinky, 25, dt);
    p.curl = damp(p.curl, tg.curl, 12, dt);
    p.scale = tg.scale;
    p.roll = tg.roll;
    if (!this.visible) return null;

    // 呼吸般的微抖动
    const breath = Math.sin(s * 1.7) * 0.004, sway = Math.sin(s * 0.9 + 1) * 0.004;
    const wig = (k) => Math.sin(s * (2.1 + k) + k * 1.7) * 0.02;

    // E：小拇指来回快速甩（±34°，5Hz）
    const pinkyAdd = this.spinning ? Math.sin(s * Math.PI * 2 * 5) * 0.6 : 0;
    // B：调转——整只手 0.2s 内带着小拇指转 ~150°，0.35s 转回（真人做法是翻腕，小拇指单独转不了这么多）
    let flipRoll = 0;
    if (this.flipT >= 0) {
      const ft = (now - this.flipT) / 1000;
      if (ft < 0.2) flipRoll = -2.6 * smooth(ft / 0.2);
      else if (ft < 0.55) flipRoll = -2.6 * (1 - smooth((ft - 0.2) / 0.35));
      else this.flipT = -1;
    }
    const roll = p.roll + flipRoll + Math.sin(s * 1.3) * 0.02;

    const u = (p.thumb + 1) / 2;
    const v = (p.pinky + 1) / 2;
    const pts = new Array(21);
    const set3 = (i, x, y, z) => (pts[i] = [x, y, z]);
    for (const [i, [x, y]] of Object.entries(BASE)) set3(+i, x, y, 0);

    // 沿手指链生长：dir 为掌内方向，flex 为每节朝镜头弯曲量
    const grow = (idx, segs, dir, flex) => {
      let [x, y, z] = pts[idx[0]];
      let bend = 0;
      for (let j = 0; j < segs.length; j++) {
        bend += flex[j];
        const c = Math.cos(bend);
        x += Math.sin(dir[j]) * c * segs[j];
        y += -Math.cos(dir[j]) * c * segs[j];
        z += -Math.sin(bend) * segs[j];
        set3(idx[j + 1], x, y, z);
      }
    };
    const fc = p.curl * 1.2;
    const tm = lerp(THUMB_META[0], THUMB_META[1], u), td = lerp(THUMB_DIR[0], THUMB_DIR[1], u) + wig(0);
    const tf = lerp(THUMB_FLEX[0], THUMB_FLEX[1], u) + p.curl * 0.3;
    // 拇指：CMC→MCP 用掌骨方向，MCP→IP→TIP 用指骨方向
    grow([1, 2], [SEG.T[0]], [tm], [0]);
    grow([2, 3, 4], SEG.T.slice(1), [td, td], [tf, tf]);
    grow([5, 6, 7, 8], SEG.I, [SPREAD.I + wig(1), SPREAD.I, SPREAD.I], [fc, fc, fc]);
    grow([9, 10, 11, 12], SEG.M, [SPREAD.M + wig(2), SPREAD.M, SPREAD.M], [fc, fc, fc]);
    grow([13, 14, 15, 16], SEG.R, [SPREAD.R + wig(3), SPREAD.R, SPREAD.R], [fc, fc, fc]);
    const pd = lerp(PINKY_DIR[0], PINKY_DIR[1], v) + wig(4) + pinkyAdd;
    grow([17, 18, 19, 20], SEG.L, [pd, pd, pd], [fc, fc, fc]);

    // 旋转 + 缩放 + 平移到「掌心 = palm」
    const c = Math.cos(roll), sn = Math.sin(roll), k = p.scale;
    const out = pts.map(([x, y, z]) => ({ x: (x * c - y * sn) * k, y: (x * sn + y * c) * k * ASPECT, z: z * k }));
    let cx = 0, cy = 0;
    for (const i of [0, 5, 9, 13, 17]) { cx += out[i].x / 5; cy += out[i].y / 5; }
    const ox = p.palm.x + breath - cx, oy = p.palm.y + sway - cy;
    for (const q of out) { q.x += ox; q.y += oy; }
    return out;
  }
}

const smooth = (t) => t * t * (3 - 2 * t);
