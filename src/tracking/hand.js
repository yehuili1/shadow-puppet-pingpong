// 手部追踪：摄像头 + MediaPipe HandLandmarker（或注入的 MockHand）→ HandState
// 输出坐标已镜像到显示空间（x → 1-x），One-Euro 去抖；距离/角度按视频宽高比校正到「视频宽度」单位。
import { FilesetResolver, HandLandmarker } from '../../vendor/mediapipe/vision_bundle.mjs';
import { OneEuro, clamp, damp } from '../core/math.js';

// 每根手指的关节链：[根, 中, 中, 指尖]；拇指根用 CMC(1)
export const FINGER_CHAINS = {
  T: [1, 2, 3, 4],
  I: [5, 6, 7, 8],
  M: [9, 10, 11, 12],
  R: [13, 14, 15, 16],
  L: [17, 18, 19, 20],
};
const KEYS = Object.keys(FINGER_CHAINS);

// ext：比值 → 0..1 的归一化区间（假摄像头实测标定）
const EXT_RANGE = { T: [0.68, 0.95], I: [0.45, 0.92], M: [0.45, 0.92], R: [0.45, 0.92], L: [0.45, 0.92] };

const TRACK_INTERVAL = 1000 / 30; // 推理节流 ~30Hz
const HOLD_MS = 250;              // 丢手后保留最后状态
const SWITCH_MS = 1500;           // 刚追踪过一只手时，远处只出现另一只（右）手：这么久之内不切过去
const MOTION_W = 640;             // motion 按 640 宽像素计

const neutralFingers = () =>
  Object.fromEntries(KEYS.map((k) => [k, { ext: 0, angle: 0, tip: { x: 0.5, y: 0.5 } }]));

// 1 秒滑窗计数 → Hz
class RateMeter {
  constructor() { this.ts = []; }
  tick(now) { this.ts.push(now); this.trim(now); }
  trim(now) { while (this.ts.length && now - this.ts[0] > 1000) this.ts.shift(); }
  hz(now) { this.trim(now); return this.ts.length; }
}

export class HandTracker {
  constructor({ video } = {}) {
    this.video = video;
    this.landmarker = null;
    this.delegate = null;
    this.mock = null;
    this.cameraOn = false;
    this.aspect = 4 / 3;            // 视频宽/高
    this._filters = Array.from({ length: 21 }, () => [0, 1, 2].map(() => new OneEuro(1.6, 8, 1.0)));
    this._lastVideoTime = -1;
    this._lastDetect = -Infinity;   // 上次推理时刻
    this._lastTs = 0;               // detectForVideo 时间戳（必须递增）
    this._lastSample = 0;           // 上次有手样本时刻（滤波 dt / motion）
    this._lastSeen = -Infinity;     // 上次有效检测时刻
    this._lastPalm = null;
    this._render = new RateMeter();
    this._track = new RateMeter();
    this._state = {
      tracked: false, source: 'none', handedness: null, landmarks: null,
      palm: { x: 0.5, y: 0.5 }, palmSize: 0, fingers: neutralFingers(), motion: 0,
      stats: { renderHz: 0, trackHz: 0, inferenceMs: 0, sampleAgeMs: 0 },
      aspect: this.aspect, // 额外字段：画面宽/高（关键点 y 换算到宽度单位用）
    };
  }

  async init({ wasmBase = 'vendor/mediapipe/wasm', modelPath = 'vendor/models/hand_landmarker.task' } = {}) {
    const fileset = await FilesetResolver.forVisionTasks(wasmBase);
    let lastErr = null;
    for (const delegate of ['GPU', 'CPU']) {
      try {
        this.landmarker = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: modelPath, delegate },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        this.delegate = delegate;
        this._warmup();
        return;
      } catch (err) {
        lastErr = err;
        console.warn(`HandLandmarker ${delegate} 初始化失败`, err);
      }
    }
    throw lastErr || new Error('HandLandmarker 初始化失败');
  }

  // 首次推理要编译 GPU 着色器（无头环境可达数秒），放到加载阶段做掉，避免开局卡顿
  _warmup() {
    try {
      const cv = document.createElement('canvas');
      cv.width = 640;
      cv.height = 480;
      cv.getContext('2d').fillRect(0, 0, 640, 480);
      this.landmarker.detectForVideo(cv, 1);
      this._lastTs = 1;
    } catch (err) {
      console.warn('HandLandmarker 预热失败', err);
    }
  }

  async startCamera() {
    const v = this.video;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    });
    v.srcObject?.getTracks().forEach((t) => t.stop());   // 重连：先停掉旧流
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    // 拔线 / 睡眠唤醒 / 撤销权限：track 结束后浏览器不会自己重开，通知上层重连
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (v.srcObject !== stream) return;
      this.cameraOn = false;
      this._lose();
      this.onCameraLost?.();
    });
    const loaded = v.readyState >= 2 ? Promise.resolve() : new Promise((res) => v.addEventListener('loadeddata', res, { once: true }));
    // 打开了却一直不出帧：8s 超时抛错，走调用方的回退
    let timer;
    try {
      await Promise.race([
        Promise.all([v.play(), loaded]),
        new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('camera timeout')), 8000))),
      ]);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (v.videoWidth && v.videoHeight) this.aspect = v.videoWidth / v.videoHeight;
    this.cameraOn = true;
  }

  get ready() {
    return !!(this.landmarker && this.cameraOn && this.video && this.video.readyState >= 2);
  }

  get state() {
    return this._state;
  }

  setMock(mock) {
    this.mock = mock || null;
    this._resetFilters();
    this._lastSeen = -Infinity;
    if (!this.mock) {
      this.aspect = this.video?.videoWidth ? this.video.videoWidth / this.video.videoHeight : 4 / 3;
      this._lose();
    } else {
      this.aspect = 4 / 3;
    }
  }

  update(now = performance.now()) {
    const st = this._state.stats;
    this._render.tick(now);

    let ran = false, raw = null, handedness = null;
    if (this.mock) {
      const t0 = performance.now();
      raw = this.mock.landmarks(now);
      handedness = 'Left';
      ran = true;
      st.inferenceMs = damp(st.inferenceMs, performance.now() - t0, 5, 1 / 60);
    } else if (this.ready && now - this._lastDetect >= TRACK_INTERVAL * 0.9) {
      const v = this.video;
      if (v.currentTime !== this._lastVideoTime) {
        this._lastVideoTime = v.currentTime;
        this._lastDetect = now;
        const ts = Math.max(Math.round(now), this._lastTs + 1);
        this._lastTs = ts;
        const t0 = performance.now();
        let res = null;
        try {
          res = this.landmarker.detectForVideo(v, ts);
        } catch (err) {
          if (!this._warned) console.warn('detectForVideo 失败', err);
          this._warned = true;
        }
        const ms = performance.now() - t0;
        st.inferenceMs = st.inferenceMs ? st.inferenceMs * 0.8 + ms * 0.2 : ms;
        ran = true;
        const pick = this._pick(res, now);
        if (pick) {
          raw = pick.landmarks.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })); // 镜像到显示空间
          handedness = pick.handedness;
        }
      }
    }

    if (ran) this._track.tick(now);
    if (raw) this._ingest(raw, now, handedness, this.mock ? 'mock' : 'camera');
    else if (this._state.tracked && now - this._lastSeen > HOLD_MS) this._lose();

    st.renderHz = this._render.hz(now);
    st.trackHz = this._track.hz(now);
    st.sampleAgeMs = Number.isFinite(this._lastSeen) ? Math.max(0, now - this._lastSeen) : 0;
  }

  // 选手：优先 Left（原始未镜像画面里用户真实左手报 Left）；只有一只就取它。
  // 多只时再参考手性（掌心朝镜头的左手）和离上次掌心的距离——假摄像头实测 Left/Right 标签会闪
  _pick(res, now) {
    const n = res?.landmarks?.length || 0;
    if (!n) return null;
    const cands = [];
    for (let i = 0; i < n; i++) {
      const h = res.handedness?.[i]?.[0];
      cands.push({ landmarks: res.landmarks[i], handedness: h?.categoryName || null });
    }
    // 未镜像空间里，左手掌心朝镜头时 食指根×小指根 叉积 > 0
    const cross = (L) => (L[5].x - L[0].x) * (L[17].y - L[0].y) - (L[5].y - L[0].y) * (L[17].x - L[0].x);
    if (n === 1) {
      // 只检测到一只：若它明确是右手（标签 + 手性都对）、离刚追踪的手很远，多半是用户另一只手在比划，
      // SWITCH_MS 内当这一帧没手，免得皮影瞬移；左手一直不回来才接受右手（只举右手也能玩）
      const L = cands[0].landmarks, lp = this._lastPalm;
      if (lp && now - this._lastSeen < SWITCH_MS && cands[0].handedness === 'Right' && cross(L) < 0 &&
        Math.hypot(1 - L[9].x - lp.x, L[9].y - lp.y) > 0.3) return null;
      return cands[0];
    }
    const last = this._state.tracked ? this._lastPalm : null;
    const score = ({ landmarks: L, handedness }) => {
      const cr = cross(L);
      let s = (handedness === 'Left' ? 1 : 0) + (cr > 0 ? 1 : 0);
      if (last) s += 0.8 * Math.max(0, 1 - Math.hypot(1 - L[9].x - last.x, L[9].y - last.y) / 0.25);
      return s;
    };
    return cands.reduce((a, b) => (score(b) > score(a) ? b : a));
  }

  _resetFilters() {
    for (const f of this._filters) for (const e of f) e.reset();
  }

  _lose() {
    const s = this._state;
    s.tracked = false;
    s.source = this.mock ? 'mock' : this.cameraOn ? 'camera' : 'none';
    s.motion = 0;
  }

  _ingest(raw, now, handedness, source) {
    const s = this._state;
    const reacquire = !s.tracked;
    if (reacquire) this._resetFilters();
    const dt = reacquire ? 0 : (now - this._lastSample) / 1000;
    this._lastSample = now;
    this._lastSeen = now;

    const lm = raw.map((p, i) => {
      const f = this._filters[i];
      return { x: f[0].filter(p.x, dt), y: f[1].filter(p.y, dt), z: f[2].filter(p.z || 0, dt) };
    });

    const palm = { x: 0, y: 0 };
    for (const i of [0, 5, 9, 13, 17]) { palm.x += lm[i].x / 5; palm.y += lm[i].y / 5; }

    // 视频宽度单位：y、z 按宽高比校正（MediaPipe 的 z 与 x 同尺度）
    const ay = 1 / this.aspect;
    const d2 = (a, b) => Math.hypot(b.x - a.x, (b.y - a.y) * ay);
    const d3 = (a, b) => Math.hypot(b.x - a.x, (b.y - a.y) * ay, b.z - a.z);
    const ang = (a, b) => Math.atan2((b.y - a.y) * ay, b.x - a.x);

    const wrist = lm[0];
    const palmAxis = ang(wrist, lm[9]);
    const fingers = {};
    for (const k of KEYS) {
      const [a, b, c, tip] = FINGER_CHAINS[k].map((i) => lm[i]);
      // 拇指从 CMC 量起；其余四指从掌根（手腕）量起，更不受指根前屈的透视影响
      const base = k === 'T' ? a : wrist;
      const chain = (k === 'T' ? 0 : d3(wrist, a)) + d3(a, b) + d3(b, c) + d3(c, tip);
      const ratio = chain > 1e-6 ? d3(base, tip) / chain : 0;
      const [r0, r1] = EXT_RANGE[k];
      let angle = ang(k === 'T' ? b : a, tip) - palmAxis;
      angle = Math.atan2(Math.sin(angle), Math.cos(angle));
      fingers[k] = { ext: clamp((ratio - r0) / (r1 - r0), 0, 1), angle, tip: { x: tip.x, y: tip.y } };
    }

    let motion = 0;
    if (!reacquire && dt > 0 && s.palm) {
      const v = Math.hypot(palm.x - s.palm.x, (palm.y - s.palm.y) * ay) * MOTION_W / dt;
      motion = s.motion * 0.6 + v * 0.4;
    }

    s.tracked = true;
    s.source = source;
    s.aspect = this.aspect;
    s.handedness = handedness;
    s.landmarks = lm;
    s.palm = palm;
    s.palmSize = d2(wrist, lm[9]);
    s.fingers = fingers;
    s.motion = motion;
    this._lastPalm = palm;
  }
}
