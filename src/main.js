// 指尖皮影剧场 — 主循环接线
import { HandTracker } from './tracking/hand.js';
import { MockHand } from './tracking/mock.js';
import { ControlMapper } from './tracking/control.js';
import { loadPuppetArt } from './puppet/art.js';
import { PuppetRig } from './puppet/rig.js';
import { Director } from './game/director.js';
import { StageRenderer } from './render/stage.js';
import { HudRenderer } from './render/hud.js';
import { computeLayout } from './render/layout.js';
import { events, clock } from './core/events.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('app');
const ctx = canvas.getContext('2d');
const video = document.getElementById('cam');
const notice = document.getElementById('notice');

const tracker = new HandTracker({ video });
const mapper = new ControlMapper();
const director = new Director();
const playerRig = new PuppetRig({ character: 'hero', facing: 1 });
const cpuRig = new PuppetRig({ character: 'rival', facing: -1 });
const stage = new StageRenderer();
const hud = new HudRenderer();

let layout = null;
let control = null;
let mock = null;

function showNotice(text, ms = 4000) {
  notice.textContent = text;
  notice.style.display = 'block';
  clearTimeout(showNotice.timer);
  if (ms) showNotice.timer = setTimeout(() => (notice.style.display = 'none'), ms);
}

function resize() {
  clearTimeout(resize.timer);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  layout = computeLayout(w, h);
  stage.resize(layout.stage, dpr);
  hud.resize(layout, dpr);
}
// 戏台背景重建约 150ms：拖动窗口时防抖，停下后再重排
window.addEventListener('resize', () => {
  clearTimeout(resize.timer);
  resize.timer = setTimeout(resize, 150);
});

// why：自定义原因文案（不传按 reason 取默认）；ms=0 提示不自动消失
function enableMock(reason, why = null, ms = 8000) {
  if (mock) return;
  mock = new MockHand(canvas);
  tracker.setMock(mock);
  events.push(`mock input (${reason})`);
  why ||= { 'no camera': '未检测到摄像头，已切到模拟手：', 'no model': '手部模型加载失败，已切到模拟手：' }[reason] || '模拟手：';
  showNotice(`${why}鼠标=手掌，按住左键=挥拍，Q/A=小拇指，E=甩剑，B=武斗`, ms);
}

// 摄像头中途断开（拔线 / 睡眠唤醒 / 撤销权限）：提示并每 2s 重连；模型还在，不用重新加载
tracker.onCameraLost = () => {
  events.push('camera lost');
  if (!tracker.mock) showNotice('摄像头已断开，正在重连…（请检查 USB 线）', 0);
  const retry = async () => {
    try {
      await tracker.startCamera();
      events.push('camera back');
      if (!tracker.mock) showNotice('摄像头已恢复', 3000);
    } catch {
      setTimeout(retry, 2000);
    }
  };
  setTimeout(retry, 2000);
};

// M 键：摄像头 / 模拟手互相切换（摄像头拍不到手或现场演示时用）；复用同一个 MockHand，不重复绑定事件
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'm' || e.repeat) return;
  if (tracker.mock && tracker.landmarker && tracker.cameraOn) {
    tracker.setMock(null);
    events.push('camera input');
    showNotice('已切回摄像头（按 M 切到模拟手）', 3000);
  } else if (mock && !tracker.mock) {
    tracker.setMock(mock);
    events.push('mock input (key)');
    showNotice('模拟手：鼠标=手掌，按住左键=挥拍，Q/A=小拇指，E=甩剑，B=武斗（再按 M 回摄像头）', 8000);
  } else enableMock('key', '模拟手（再按 M 回摄像头）：');
});

async function boot() {
  resize();
  await loadPuppetArt();
  requestAnimationFrame(frame);   // 先开演（等待状态），模型与摄像头在后台加载
  if (params.has('mock')) {
    enableMock('url');
    return;
  }
  // 先开摄像头（没有就立即回退，也不用加载模型——模型预热会卡主线程几秒），再加载手部模型
  try {
    showNotice('正在打开摄像头…', 0);
    await tracker.startCamera();
  } catch (err) {
    console.warn('camera failed', err);
    // 按原因提示（都切到模拟手）：非安全上下文 / 权限被拒 / 被占用要人去处理，提示不自动消失；其余才是「未检测到摄像头」
    const why = !window.isSecureContext || !navigator.mediaDevices
      ? '请用 http://localhost:8765 打开（局域网 IP 或直接打开文件无法用摄像头），已切到模拟手：'
      : err.name === 'NotAllowedError'
        ? '摄像头权限被拒绝：点地址栏左侧图标改为允许后刷新（仍不行查 Windows 设置-隐私-相机），已切到模拟手：'
        : err.name === 'NotReadableError' || err.name === 'AbortError'
          ? '摄像头被其他程序占用（微信/会议/OBS），关闭后刷新；已切到模拟手：'
          : null;
    enableMock('no camera', why, why ? 0 : 8000);
    return;
  }
  try {
    showNotice('正在加载手部模型…', 0);
    await tracker.init({ wasmBase: 'vendor/mediapipe/wasm', modelPath: 'vendor/models/hand_landmarker.task' });
    if (mock) return;
    events.push('camera ready');
    showNotice('举起左手：大拇指控制球拍，小拇指控制宝剑（按 M 切换模拟手）', 5000);
  } catch (err) {
    console.warn('hand model failed', err);
    enableMock('no model');
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
  last = now;

  tracker.update(now);
  control = mapper.update(tracker.state, dt);
  director.update(dt, { control, playerRig, cpuRig });

  const t = clock();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  stage.draw(ctx, { t, dt, director, playerRig, cpuRig, hand: tracker.state });
  hud.draw(ctx, { t, dt, video, hand: tracker.state, control, director, events, layout });

  requestAnimationFrame(frame);
}

// 调试/自动化测试钩子
window.__app = {
  tracker, mapper, director, playerRig, cpuRig, events,
  get control() { return control; },
  get layout() { return layout; },
  mock: () => mock,
  enableMock,
  debug: () => ({
    mode: director.mode,
    status: director.status,
    stats: director.stats,
    ball: director.ball && { x: Math.round(director.ball.x), y: Math.round(director.ball.y), visible: director.ball.visible },
    hand: { tracked: tracker.state.tracked, source: tracker.state.source },
    control: control && { active: control.active, px: +control.px?.toFixed(2), paddleArm: +control.paddleArm?.toFixed(2), swordArm: +control.swordArm?.toFixed(2) },
    paddle: playerRig.paddle && { x: Math.round(playerRig.paddle.x), y: Math.round(playerRig.paddle.y) },
    events: events.latest(6).map((e) => `${e.t.toFixed(1)}s ${e.text}`),
  }),
};

boot();
