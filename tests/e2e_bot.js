// 端到端自动玩家：只通过 MockHand.set（掌心 / 拇指 / 小拇指 / 甩剑 / 调转）操作，
// 走完整链路 HandTracker → ControlMapper → Director → PuppetRig → 渲染。window.__bot 给 tests/e2e_run.mjs 读统计、切武斗。
import { Director } from '../src/game/director.js';
import { PuppetRig } from '../src/puppet/rig.js';
import { TABLE } from '../src/core/world.js';
import { clamp, damp } from '../src/core/math.js';

const POS_X = [0.2, 0.8], POS_Y = [0.3, 0.85];   // 与 control.js 一致：掌心 → px / py
const PY = 0.5;
const palmX = (px) => POS_X[0] + (POS_X[1] - POS_X[0]) * px;
const palmY = (py) => POS_Y[0] + (POS_Y[1] - POS_Y[0]) * py;
const READY = { x: 470, y: 610 };
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.4;

// 黑盒标定：离线 Director.playerPose + 真 PuppetRig 稳态正运动学，px × paddleArm → 拍心
function calibrate(nx = 40, na = 40) {
  const d = new Director(), rig = new PuppetRig({ character: 'hero', facing: 1 });
  const out = [];
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= na; j++) {
      const px = i / nx, arm = -1 + (2 * j) / na;
      rig.setPose(d.playerPose({ px, py: PY, lean: 0, paddleArm: arm, swordArm: -0.6, swordSpin: 0 }, 1 / 60, false));
      rig.snap();
      out.push({ px, arm, x: rig.paddle.x, y: rig.paddle.y });
    }
  }
  return out;
}

// 来球在玩家半台弹起后的击球点（偏好桌端左侧、高度合适）
function intercept(pp) {
  let apex = null;
  for (const s of pp.predict(1.8)) {
    if (pp.bounces + s.n !== 1 || s.x > TABLE.netX) continue;
    if (!apex || s.y < apex.y) apex = s;
    if (s.x <= 600 && s.y <= 690 && s.y >= 480) return s;
  }
  return apex;
}

class Bot {
  constructor(app, { lapse = 0.15, react = 0.16, noise = 10 } = {}) {
    this.app = app;
    this.opt = { lapse, react, noise };
    this.table = calibrate();
    this.px = 0.5;
    this.arm = 0;
    this.bias = 0;
    this.t = 0;
    this.hitId = -1;
    this.aim = null;
    this.phase = 'rally';          // rally | battle
    this.battle = null;
    const S = (this.stats = {
      lapses: 0, playerReturns: 0, cpuReturns: 0, tableContacts: 0, rallies: 0,
      points: { player: 0, cpu: 0 }, reasons: {}, rallyLog: [], statuses: {},
      celebrateTongue: { min: 1, max: 0, frames: 0 }, battle: [], maxReturns: 0, maxRallyTime: 0,
    });
    app.events.on((e) => {
      const tx = e.text, st = app.director.stats;
      if (tx === 'player return') S.playerReturns++;
      else if (tx === 'CPU return accepted') S.cpuReturns++;
      else if (tx === 'table contact') S.tableContacts++;
      else if (tx === 'rally ended / next serve') S.rallies++;
      else if (tx.startsWith('point ')) {
        const who = tx.slice(6);
        S.points[who]++;
        S.rallyLog.push({ t: +e.t.toFixed(1), winner: who, returns: st.returns, rallyTime: +st.rallyTime.toFixed(1), score: `${st.scorePlayer}:${st.scoreCpu}` });
        S.maxReturns = Math.max(S.maxReturns, st.returns);
        S.maxRallyTime = Math.max(S.maxRallyTime, +st.rallyTime.toFixed(1));
      } else if (['out', 'net', 'return missed'].includes(tx)) S.reasons[tx] = (S.reasons[tx] || 0) + 1;
      if (/battle|sword|cpu grounded|cpu escaped/.test(tx)) S.battle.push(`${e.t.toFixed(1)}s ${tx}`);
    });
  }

  inverse(tx, ty) {
    let best = null, bc = Infinity;
    for (const e of this.table) {
      const cost = (e.x - tx) ** 2 + (e.y - ty) ** 2 + 2000 * (e.px - this.px) ** 2 + 400 * (e.arm - this.arm) ** 2;
      if (cost < bc) { bc = cost; best = e; }
    }
    return best;
  }

  // 切到武斗：调转小拇指 → 走近电脑甩剑 → 打倒 → 等它逃跑回来
  startBattle() {
    this.phase = 'battle';
    this.battle = { flipT: -1, entered: false, done: false };
  }

  step(dt) {
    const app = this.app, d = app.director, mock = app.mock();
    if (!mock || !d) return;
    this.t += dt;
    const st = d.status;
    this.stats.statuses[st] = (this.stats.statuses[st] || 0) + 1;
    if (st === 'CELEBRATING') {
      const tg = app.cpuRig.pose.tongue, ct = this.stats.celebrateTongue;
      ct.min = Math.min(ct.min, tg); ct.max = Math.max(ct.max, tg); ct.frames++;
    }
    if (this.phase === 'battle') return this.stepBattle(dt, d, mock);
    this.stepRally(dt, d, mock);
  }

  stepRally(dt, d, mock) {
    const pp = d.pp, o = this.opt;
    let target = READY;
    if (d.mode === 'PINGPONG' && pp.phase === 'play' && pp.lastHitter === 'cpu') {
      if (pp.hitId !== this.hitId) {
        this.hitId = pp.hitId;
        this.reactAt = this.t + o.react + Math.random() * 0.08;
        this.err = { x: gauss() * o.noise, y: gauss() * o.noise };
        this.lapse = Math.random() < o.lapse;   // 失误：判断错高度，拍子举高后不再跟球
        if (this.lapse) this.stats.lapses++;
        this.aim = null;
      }
      if (this.t >= this.reactAt && !(this.lapse && this.aim)) {
        const s = intercept(pp);
        if (s) this.aim = { x: s.x + this.err.x, y: s.y + this.err.y - (this.lapse ? 210 : 0) };
      }
      if (this.aim) target = this.aim;
    } else this.aim = null;

    const cmd = this.inverse(target.x, target.y);
    let arm = cmd.arm;
    if (pp.phase === 'hold' && pp.server === 'player' && pp.timer > 0.8) arm = 0.7;   // 抬大拇指发球
    this.px = damp(this.px, cmd.px, 10, dt);
    this.arm = damp(this.arm, arm, 10, dt);
    // 拇指偏置反馈：mock 的拇指参数与 paddleArm 近似线性，积分校正残差
    const c = this.app.control;
    if (c?.active) this.bias = clamp(this.bias + (this.arm - c.paddleArm) * 3 * dt, -0.4, 0.4);
    mock.set({ palm: { x: palmX(this.px), y: palmY(PY) }, thumb: clamp(this.arm + this.bias, -1, 1), pinky: 0, spin: false });
  }

  stepBattle(dt, d, mock) {
    const B = this.battle;
    if (d.mode !== 'BATTLE') {
      if (B.entered) {
        // 武斗结束：回到乒乓
        B.done = true;
        this.phase = 'rally';
        mock.set({ spin: false, pinky: 0 });
        return;
      }
      // 手先稳住，再调转小拇指（mock 的 B 键：整只手快速翻腕再转回）；没进就过冷却后重试
      if (B.flipT < 0 || this.t - B.flipT > 3) {
        mock.set({ flip: true });
        B.flipT = this.t;
      }
      return;
    }
    B.entered = true;
    const st = d.status, cpuX = this.app.cpuRig.pose.x;
    const fighting = st === 'BATTLE / IDLE' || st === 'BATTLE / ATTACK' || st === 'BATTLE / HIT';
    const x = fighting ? cpuX - 300 : 520;   // 戒备时贴近砍；倒地/逃跑时退回
    const px = clamp(0.15 + (0.7 * (x - 150)) / 1300, 0, 1);
    this.px = damp(this.px, px, fighting ? 1.5 : 5, dt);   // 慢慢走过去（看得清武斗过程），打倒后快退
    mock.set({ palm: { x: palmX(this.px), y: palmY(PY) }, pinky: fighting ? 0.4 : -0.3, spin: fighting && d.battle.time > 0.6 });
  }
}

// 等 main.js 建好模拟手后启动
function start() {
  const app = window.__app;
  if (!app || !app.mock()) return requestAnimationFrame(start);
  const q = new URLSearchParams(location.search);
  const bot = new Bot(app, { lapse: q.has('lapse') ? +q.get('lapse') : 0.15 });
  let last = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    bot.step(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.__bot = bot;
}
start();
