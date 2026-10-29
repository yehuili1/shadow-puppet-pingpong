// 玩法模块 D 无头测试：node tests/game.test.mjs
// 用替身 rig（tests/stubs/game_fake_rig.js）+ 自动玩家（tests/stubs/game_autoplay.js）驱动 Director
import { Director } from '../src/game/director.js';
import { events } from '../src/core/events.js';
import { PADDLE_R, BALL_R, ZONES } from '../src/core/world.js';
import { remap, wrapAngle } from '../src/core/math.js';
import { HIT_R } from '../src/game/pingpong.js';
import { armIK, toTorso } from '../src/game/ai.js';
import { SK } from '../src/puppet/skeleton.js';
import { FakeRig } from './stubs/game_fake_rig.js';
import { AutoPlayer, calibrate, makeControl } from './stubs/game_autoplay.js';

const DT = 1 / 60;
let fails = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`);
  if (!cond) fails++;
};
const finite = (...v) => v.every(Number.isFinite);
const poseOk = (r) => Object.values(r.pose).every(Number.isFinite);
const world = (rig = {}, Rig = FakeRig) => ({
  d: new Director(),
  pr: new Rig({ facing: 1, character: 'hero', ...rig }),
  cr: new Rig({ facing: -1, character: 'rival', ...rig }),
});
// 真 rig（模块 C）能在 node 里加载时顺带做集成验证
let RealRig = null;
try {
  ({ PuppetRig: RealRig } = await import('../src/puppet/rig.js'));
} catch (e) {
  console.log(`(skip real PuppetRig: ${e.message})`);
}
function capture() {
  const log = [];
  const off = events.on((e) => log.push(e.text));
  return { log, off };
}
const count = (log, text) => log.filter((t) => t === text).length;

console.log('calibrating player paddle map ...');
const CAL = calibrate();

// ---------------------------------------------------------------- 1) 自动对打
function rallySim(seconds, rig, label, Rig = FakeRig) {
  console.log(`\n[1] auto rally ${seconds}s (${label})`);
  const { d, pr, cr } = world(rig, Rig);
  const ap = new AutoPlayer(CAL);
  const { log, off } = capture();
  const rallies = [], seen = new Set();
  let nan = 0, maxPhase = 0, maxNoHit = 0, phaseT = 0, lastPhase = '', trailBad = 0;
  for (let i = 0; i < seconds / DT; i++) {
    const c = ap.update(DT, d, pr);
    const before = d.pp.phase;
    d.update(DT, { control: c, playerRig: pr, cpuRig: cr });
    const pp = d.pp, b = d.ball;
    seen.add(d.status);
    if (!finite(b.x, b.y, b.vx, b.vy, pr.paddle.x, pr.paddle.y, cr.paddle.x, cr.paddle.y) || !poseOk(pr) || !poseOk(cr)) nan++;
    if (b.trail.length > 14 || (b.trail.length && (b.trail[0].x !== b.x || b.trail[0].y !== b.y) && pp.phase === 'play')) trailBad++;
    if (pp.phase !== lastPhase) {
      lastPhase = pp.phase;
      phaseT = 0;
    }
    phaseT += DT;
    if (pp.phase !== 'play') maxPhase = Math.max(maxPhase, phaseT);
    if (pp.phase === 'play') maxNoHit = Math.max(maxNoHit, pp.sinceHit);
    if (before === 'play' && pp.phase === 'over') {
      rallies.push({ returns: d.stats.returns, time: d.stats.rallyTime, winner: pp.status === 'SCORED' ? 'player' : 'cpu' });
    }
  }
  off();
  const st = d.stats;
  const avg = rallies.reduce((s, r) => s + r.returns, 0) / Math.max(1, rallies.length);
  const maxTime = Math.max(...rallies.map((r) => r.time));
  const reasons = {};
  for (let i = 1; i < log.length; i++) if (log[i].startsWith('point ')) reasons[`${log[i]} <- ${log[i - 1]}`] = (reasons[`${log[i]} <- ${log[i - 1]}`] || 0) + 1;
  console.log(`  rallies=${rallies.length} score P${st.scorePlayer}:C${st.scoreCpu} avgReturns=${avg.toFixed(2)} maxReturns=${Math.max(...rallies.map((r) => r.returns))} maxRallyTime=${maxTime.toFixed(1)}s longestIdlePhase=${maxPhase.toFixed(1)}s maxNoHit=${maxNoHit.toFixed(2)}s lapses=${ap.lapses}`);
  console.log(`  statuses: ${[...seen].join(', ')}`);
  console.log(`  points by reason: ${JSON.stringify(reasons)}`);
  console.log(`  events: player return=${count(log, 'player return')} CPU return accepted=${count(log, 'CPU return accepted')} table contact=${count(log, 'table contact')} paddle armed=${count(log, 'paddle armed')} rally ended=${count(log, 'rally ended / next serve')}`);

  // 事件序列：得分前一条必是判定原因；得分后、下一次击球前必有 rally ended；同一回合击球双方交替
  let seqBad = 0, waitEnd = false, lastHit = null;
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (e.startsWith('point ')) {
      if (!['return missed', 'out', 'net'].includes(log[i - 1])) seqBad++;
      waitEnd = true;
    } else if (e === 'rally ended / next serve') {
      waitEnd = false;
      lastHit = null;
    } else if (e === 'player return' || e === 'CPU return accepted') {
      if (waitEnd || e === lastHit) seqBad++;
      lastHit = e;
    }
  }
  return { rallies, st, avg, maxTime, maxPhase, maxNoHit, nan, seqBad, seen, trailBad };
}

{
  const r = rallySim(180, {}, 'stiff rig');
  ok(r.rallies.length >= 6, `多个回合（${r.rallies.length}）`);
  ok(r.st.scorePlayer > 0 && r.st.scoreCpu > 0, `双方都得分（${r.st.scorePlayer}:${r.st.scoreCpu}）`);
  ok(r.avg >= 3, `平均回合击球数 ≥ 3（${r.avg.toFixed(2)}）`);
  ok(r.nan === 0, `无 NaN（${r.nan} 帧异常）`);
  ok(r.maxTime < 60 && r.maxNoHit < 3 && r.maxPhase < 3, `球不卡死（最长回合 ${r.maxTime.toFixed(1)}s，击球间隔最长 ${r.maxNoHit.toFixed(2)}s，发球/庆祝阶段最长 ${r.maxPhase.toFixed(1)}s）`);
  ok(r.seqBad === 0, `事件序列合理（异常 ${r.seqBad}）`);
  ok(r.trailBad === 0, '拖尾 ≤14 且新→旧');
  ok(['SERVE', 'FLIGHT', 'RECEIVE', 'CELEBRATING', 'SCORED'].every((s) => r.seen.has(s)), '经历 SERVE/FLIGHT/RECEIVE/CELEBRATING/SCORED');

  const soft = rallySim(90, { stiffness: 120, dampingRatio: 0.65 }, 'soft wobbly rig');
  ok(soft.nan === 0 && soft.seqBad === 0, '软弹簧 rig 下无 NaN、事件序列正常');
  ok(soft.avg >= 2, `软弹簧 rig 下仍能对打（平均 ${soft.avg.toFixed(2)}）`);

  if (RealRig) {
    const real = rallySim(120, {}, 'real PuppetRig', RealRig);
    ok(real.nan === 0 && real.seqBad === 0 && real.maxNoHit < 3, '真 rig：无 NaN、事件序列正常、不卡死');
    ok(real.avg >= 3 && real.rallies.length >= 3, `真 rig：能对打（${real.rallies.length} 回合，平均 ${real.avg.toFixed(2)}）`);
  }
}

// ---------------------------------------------------------------- 2) 手离开 → WAITING
{
  console.log('\n[2] control.active=false');
  const { d, pr, cr } = world();
  const off = makeControl({ active: false });
  for (let i = 0; i < 12; i++) d.update(DT, { control: off, playerRig: pr, cpuRig: cr });
  const b0 = { x: d.ball.x, y: d.ball.y };
  let still = true, waiting = true;
  for (let i = 0; i < 180; i++) {
    d.update(DT, { control: off, playerRig: pr, cpuRig: cr });
    if (d.status !== 'WAITING') waiting = false;
    if (d.ball.x !== b0.x || d.ball.y !== b0.y || !d.ball.visible) still = false;
  }
  ok(waiting, `开局无手 → status WAITING（${d.status}）`);
  ok(still, `球停在发球方手里不动（${b0.x.toFixed(0)}, ${b0.y.toFixed(0)}）`);
  const mid = remap(0.5, 0, 1, ZONES.player.xMin, ZONES.player.xMax);
  ok(Math.abs(pr.pose.x - mid) < 2, `玩家回到中位（x=${pr.pose.x.toFixed(1)}）`);

  // 回合中手离开：0.5s 宽限后作废，球回发球方
  const ap = new AutoPlayer(CAL, { lapse: 0 });
  let i = 0;
  while (i++ < 1200 && d.status !== 'RECEIVE') d.update(DT, { control: ap.update(DT, d, pr), playerRig: pr, cpuRig: cr });
  ok(d.status === 'RECEIVE', '进入回合（RECEIVE）');
  for (let k = 0; k < 15; k++) d.update(DT, { control: off, playerRig: pr, cpuRig: cr });
  const graceKept = d.status !== 'WAITING';
  // 0.5s 后作废；若宽限期内恰好得分，则等庆祝结束后进入等待
  for (let k = 0; k < 300 && d.status !== 'WAITING'; k++) d.update(DT, { control: off, playerRig: pr, cpuRig: cr });
  const b1 = { x: d.ball.x, y: d.ball.y };
  for (let k = 0; k < 60; k++) d.update(DT, { control: off, playerRig: pr, cpuRig: cr });
  ok(graceKept && d.status === 'WAITING', `回合中短暂丢手不打断，0.5s 后 WAITING（${d.status}）`);
  ok(d.ball.x === b1.x && d.ball.y === b1.y && d.ball.visible, '作废后球在发球方手里不动');
  for (let k = 0; k < 5; k++) d.update(DT, { control: makeControl(), playerRig: pr, cpuRig: cr });
  ok(d.status === 'SERVE', `手回来 → SERVE（${d.status}）`);
}

// ---------------------------------------------------------------- 3) 武斗
function battleSim(Rig, label) {
  console.log(`\n[3] battle (${label})`);
  const { d, pr, cr } = world({}, Rig);
  const { log, off } = capture();
  const c = makeControl();
  for (let i = 0; i < 60; i++) d.update(DT, { control: c, playerRig: pr, cpuRig: cr });
  c.swordFlip = true;
  d.update(DT, { control: c, playerRig: pr, cpuRig: cr });
  c.swordFlip = false;
  ok(d.mode === 'BATTLE' && log.includes('battle engaged'), `swordFlip → BATTLE（${d.mode} / ${d.status}）`);
  for (let i = 0; i < 50; i++) d.update(DT, { control: c, playerRig: pr, cpuRig: cr });
  ok(d.tableAlpha === 0 && !d.ball.visible, `0.8s 后桌子淡出（alpha=${d.tableAlpha}），球隐藏`);
  ok(d.stats.returns === 0 && d.stats.rallyTime === 0, '武斗中 returns / rally time 归零');

  // 冲到电脑跟前甩剑
  const seq = [];
  let t = 0, maxSpin = 0;
  while (t < 30 && d.mode === 'BATTLE') {
    const body = cr.bodyHit[0];
    const wantX = Math.min(body.x - 300, 1400);
    c.px = remap(wantX, ZONES.battle.xMin, ZONES.battle.xMax, 0.15, 0.85);
    c.swordArm = Math.sin(t * 5) * 0.5;
    c.swordSpin = 620;
    d.update(DT, { control: c, playerRig: pr, cpuRig: cr });
    maxSpin = Math.max(maxSpin, Math.abs(pr.pose.swordAngle));
    if (seq[seq.length - 1] !== d.status) seq.push(d.status);
    if (!finite(pr.swordTip.x, cr.pose.x, cr.pose.fallen) || !poseOk(cr)) seq.push('NaN');
    t += DT;
  }
  off();
  const hits = seq.filter((s) => s === 'BATTLE / HIT').length;
  const gi = seq.indexOf('BATTLE / GROUND'), ei = seq.indexOf('BATTLE / ESCAPE');
  console.log(`  status seq: ${seq.join(' → ')}`);
  console.log(`  events: ${log.join(' | ')}`);
  ok(hits === 3 && d.stats.hits === 3, `HIT ×3（${hits}，stats.hits=${d.stats.hits}）`);
  ok(gi > seq.lastIndexOf('BATTLE / HIT') && ei > gi, '之后 GROUND → ESCAPE');
  ok(seq.includes('BATTLE / ATTACK'), '靠近挥剑时出现 BATTLE / ATTACK');
  ok(d.mode === 'PINGPONG' && d.status === 'SERVE', `回到 PINGPONG（${d.mode} / ${d.status}），用时 ${t.toFixed(1)}s`);
  ok(t > 4 && t < 20, '武斗总时长合理（4~20s）');
  ok(maxSpin > Math.PI * 4, `剑随 swordSpin 持续旋转（累计 ${(maxSpin / Math.PI / 2).toFixed(1)} 圈）`);
  const order = ['battle engaged', 'sword hit', 'sword hit', 'sword hit', 'cpu grounded', 'cpu escaped', 'battle over', 'rally ended / next serve'];
  const got = log.filter((e) => order.includes(e));
  ok(JSON.stringify(got) === JSON.stringify(order), '事件顺序 engaged → hit×3 → grounded → escaped → over → next serve');
  ok(!seq.includes('NaN'), '武斗中无 NaN');
  for (let i = 0; i < 60; i++) d.update(DT, { control: c, playerRig: pr, cpuRig: cr });
  ok(d.tableAlpha === 1 && d.ball.visible, '桌子淡入、球重新出现');

  // 电脑戒备时再次调转 → 直接退出
  const w = world({}, Rig);
  const c2 = makeControl({ px: 0.2 });
  const cap = capture();
  c2.swordFlip = true;
  w.d.update(DT, { control: c2, playerRig: w.pr, cpuRig: w.cr });
  c2.swordFlip = false;
  for (let i = 0; i < 90; i++) w.d.update(DT, { control: c2, playerRig: w.pr, cpuRig: w.cr });
  ok(w.d.status === 'BATTLE / IDLE', `远离时电脑戒备（${w.d.status}）`);
  c2.swordFlip = true;
  w.d.update(DT, { control: c2, playerRig: w.pr, cpuRig: w.cr });
  cap.off();
  ok(w.d.mode === 'PINGPONG' && cap.log.includes('battle over'), 'IDLE 时再调转 → 退出武斗');

  // 武斗中丢手：短暂丢手不退出；5s 后回到乒乓 WAITING（下一位观众不会卡在武斗）
  const h = world({}, Rig);
  const c3 = makeControl({ px: 0.2, swordFlip: true });
  h.d.update(DT, { control: c3, playerRig: h.pr, cpuRig: h.cr });
  const lost = makeControl({ active: false });
  for (let i = 0; i < 60; i++) h.d.update(DT, { control: lost, playerRig: h.pr, cpuRig: h.cr });
  ok(h.d.mode === 'BATTLE', `武斗中丢手 1s 不退出（${h.d.mode}）`);
  for (let i = 0; i < 300; i++) h.d.update(DT, { control: lost, playerRig: h.pr, cpuRig: h.cr });
  ok(h.d.mode === 'PINGPONG' && h.d.status === 'WAITING', `武斗中丢手 6s → PINGPONG / WAITING（${h.d.mode} / ${h.d.status}）`);
}
battleSim(FakeRig, 'fake rig');
if (RealRig) battleSim(RealRig, 'real PuppetRig');

// ---------------------------------------------------------------- 4) 拍子覆盖击球区
{
  console.log('\n[4] paddle coverage (px∈[0,1] × paddleArm∈[-1,1], py=0.5)');
  let worst = 0, strict = 0, total = 0;
  const miss = [];
  for (let x = 440; x <= 620; x += 20) {
    for (let y = 520; y <= 720; y += 20) {
      let m = Infinity;
      for (const e of CAL) m = Math.min(m, Math.hypot(e.x - x, e.y - y));
      worst = Math.max(worst, m);
      total++;
      if (m <= PADDLE_R + BALL_R) strict++;
      else miss.push(`(${x},${y}):${m.toFixed(0)}`);
    }
  }
  const xs = CAL.map((e) => e.x), ys = CAL.map((e) => e.y);
  console.log(`  paddle range x ${Math.min(...xs).toFixed(0)}..${Math.max(...xs).toFixed(0)}, y ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)}`);
  for (const a of [-1, -0.5, 0, 0.5, 1]) {
    const e = CAL.find((q) => q.px === 0.5 && Math.abs(q.arm - a) < 1e-9);
    console.log(`  px=0.5 paddleArm=${a} → paddle (${e.x.toFixed(0)}, ${e.y.toFixed(0)})`);
  }
  console.log(`  beyond strict radius ${PADDLE_R + BALL_R}: ${miss.join(' ') || 'none'}`);
  ok(worst <= HIT_R.player, `击球区每点都在玩家命中半径 ${HIT_R.player} 内（最差 ${worst.toFixed(1)}）`);
  ok(strict / total >= 0.85, `≥85% 点在严格半径 ${PADDLE_R + BALL_R} 内（${strict}/${total}）`);

  // 用 rig.ikArm 反推：击球区内的点设成目标后拍心能到位
  const pr = new FakeRig({ facing: 1 });
  let ikErr = 0;
  for (const [x, y, px] of [[460, 540, 0.5], [600, 560, 0.85], [520, 680, 0.75], [600, 700, 0.85]]) {
    pr.setPose({ x: remap(px, 0.15, 0.85, ZONES.player.xMin, ZONES.player.xMax), y: 600, lean: 0 });
    const ik = pr.ikArm('front', x, y);
    pr.setPose({ frontShoulder: ik.shoulder, frontElbow: ik.elbow });
    pr.snap();
    pr.update(0);
    ikErr = Math.max(ikErr, Math.hypot(pr.paddle.x - x, pr.paddle.y - y));
  }
  ok(ikErr < HIT_R.player, `ikArm 反推击球区角点：拍心误差 ≤ ${ikErr.toFixed(1)}`);

  // 玩法内部的 armIK 与真 rig.ikArm 约定一致（同目标 → 同角度）
  if (RealRig) {
    const rr = new RealRig({ facing: -1 });
    let diff = 0;
    for (let k = 0; k < 200; k++) {
      const pose = { x: 1130 + Math.random() * 320, y: 560 + Math.random() * 80, lean: (Math.random() - 0.5) * 0.6 };
      const wx = pose.x - 60 - Math.random() * 260, wy = 380 + Math.random() * 330;
      const l = toTorso(pose, -1, wx, wy);
      // 只比可达环带：太远/贴着肩时两边的夹紧策略不同
      const L1 = SK.upperArmLen, L2 = SK.forearmLen + SK.paddleCenter;
      const dist = Math.hypot(l.x - SK.frontShoulder.x, l.y - SK.frontShoulder.y);
      if (dist > L1 + L2 - 2 || dist < L2 - L1 + 2) continue;
      rr.setPose(pose);
      const a = rr.ikArm('front', wx, wy);
      const b = armIK(l.x, l.y, 'front');
      diff = Math.max(diff, Math.abs(wrapAngle(a.shoulder - b.shoulder)), Math.abs(a.elbow - b.elbow));
    }
    ok(diff < 1e-3, `armIK 与真 rig.ikArm 一致（最大角差 ${diff.toExponential(1)} rad）`);
  }
}

console.log(fails ? `\n${fails} assertion(s) FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
