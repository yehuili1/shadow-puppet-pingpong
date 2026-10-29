// 导演：唯一对外入口。control → 玩家姿态；AI/武斗 → 电脑姿态；驱动 rig 与物理判定；乒乓 ↔ 武斗 模式切换
import { SK } from '../puppet/skeleton.js';
import { ZONES, PELVIS_Y } from '../core/world.js';
import { clamp, lerp, remap, damp } from '../core/math.js';
import { PingPong } from './pingpong.js';
import { CpuAI, Gait, armIK, toWorld } from './ai.js';
import { Battle } from './battle.js';

const TAU = Math.PI * 2;
const NEUTRAL = { px: 0.5, py: 0.5, lean: 0, paddleArm: 0, paddleSwing: 0, swordArm: -0.6, swordSpin: 0 };

// 大拇指 → 拍面轨迹：以前肩为圆心，θ 从竖直向下往前转，r 为肩到拍心距离
// -1 低位靠近身体，0 桌面高度前伸（参考视频张手时的拍位），+1 胸前略高；全行程都在击球区内
// （真人张手时拇指自然外展，paddleArm 常在 0.3~0.9，所以上半段不能举太高）
const ARM_KEYS = [
  { a: -1, th: 0.4, r: 281 },
  { a: 0, th: 0.68, r: 276 },
  { a: 0.6, th: 0.95, r: 272 },
  { a: 1, th: 1.25, r: 266 },
];
function paddleTarget(a) {
  a = clamp(a, -1, 1);
  let i = 0;
  while (i < ARM_KEYS.length - 2 && a > ARM_KEYS[i + 1].a) i++;
  const k0 = ARM_KEYS[i], k1 = ARM_KEYS[i + 1];
  const f = (a - k0.a) / (k1.a - k0.a);
  const th = lerp(k0.th, k1.th, f), r = lerp(k0.r, k1.r, f);
  return { x: SK.frontShoulder.x + Math.sin(th) * r, y: SK.frontShoulder.y + Math.cos(th) * r };
}

export class Director {
  constructor() {
    this.mode = 'PINGPONG';
    this.pp = new PingPong();
    this.ai = new CpuAI();
    this.battle = new Battle();
    this.tableAlpha = 1;
    this.paddleState = 'follow';
    this.gait = new Gait();
    this.ctl = { ...NEUTRAL };
    this.swordAngle = 0;
    this.noHand = 0;          // 连续无手时长（武斗无手超时用）
    // 等待时球停在发球方中位拍子上方
    const pt = paddleTarget(NEUTRAL.paddleArm);
    const pl = toWorld({ x: remap(0.5, 0, 1, ZONES.player.xMin, ZONES.player.xMax), y: PELVIS_Y }, 1, pt.x, pt.y);
    this.pp.holdSpot = {
      player: { x: pl.x + 8, y: pl.y - 38 },
      cpu: { x: this.ai.pad.x - 8, y: this.ai.pad.y - 38 },
    };
  }

  get status() {
    return this.mode === 'BATTLE' ? this.battle.status : this.pp.status;
  }
  get ball() {
    return this.pp.ball;
  }
  get stats() {
    return this.pp.stats;
  }

  update(dt, { control, playerRig, cpuRig }) {
    if (!(dt > 0) || !playerRig || !cpuRig) return;
    const active = !!control?.active;
    this.noHand = active ? 0 : this.noHand + dt;
    const c = this.ctl;
    for (const k in NEUTRAL) {
      const v = active ? control[k] : NEUTRAL[k];
      if (!Number.isFinite(v)) c[k] = NEUTRAL[k];
      else c[k] = active ? v : damp(c[k], v, 4, dt);   // 手离开：平滑回中位待机
    }

    // 小拇指调转：进入武斗（当前回合作废）；电脑戒备时再调转退出
    if (active && control.swordFlip) {
      if (this.mode === 'PINGPONG') this.enterBattle();
      else if (this.battle.canExit) {
        this.battle.stop();
        this.exitBattle();
      }
    } else if (this.mode === 'BATTLE' && this.noHand > 5 && this.battle.state === 'IDLE') {
      // 武斗中人走了：5s 后回到乒乓（同帧 pp.update 进 WAITING，桌子淡回），免得下一位观众卡在武斗
      this.battle.stop();
      this.exitBattle();
    }
    const battle = this.mode === 'BATTLE';

    // 1) 姿态
    const pPose = this.playerPose(c, dt, battle);
    const cPose = battle ? this.battle.cpuPose(dt, pPose.x) : this.ai.update(dt, this.pp);
    // 2) 皮影
    playerRig.setPose(pPose);
    playerRig.update(dt);
    cpuRig.setPose(cPose);
    cpuRig.update(dt);
    // 3) 物理与判定（用 rig 更新后的拍子/剑/身体）
    if (battle) {
      if (this.battle.judge(dt, c, playerRig, cpuRig, this.pp.stats)) this.exitBattle();
    } else {
      this.pp.update(dt, { active, playerPad: playerRig.paddle, cpuPad: cpuRig.paddle, paddleArm: c.paddleArm, swing: c.paddleSwing });
    }
    this.tableAlpha = clamp(this.tableAlpha + (this.mode === 'BATTLE' ? -dt : dt) / 0.8, 0, 1);
    this.updatePaddleState(c, playerRig.paddle);
  }

  enterBattle() {
    this.mode = 'BATTLE';
    this.pp.voidRally();
    this.pp.stats.hits = 0;
    this.battle.start(this.ai.x);
  }

  exitBattle() {
    this.mode = 'PINGPONG';
    this.ai.x = this.battle.x;
    this.pp.resume();
  }

  // 玩家：掌心 → 骨盆；大拇指 → 持拍臂；小拇指 → 持剑臂；武斗时甩小拇指让剑旋转
  playerPose(c, dt, battle) {
    const zone = battle ? ZONES.battle : ZONES.player;
    const x = remap(c.px, 0.15, 0.85, zone.xMin, zone.xMax);
    const y = remap(c.py, 0.25, 0.75, ZONES.player.yMin, ZONES.player.yMax);
    const pt = paddleTarget(c.paddleArm);
    const front = armIK(pt.x, pt.y, 'front');
    const s = (clamp(c.swordArm, -1, 1) + 1) / 2;
    if (battle) this.swordAngle += ((c.swordSpin * Math.PI) / 180) * dt;
    else this.swordAngle = Math.round(this.swordAngle / TAU) * TAU;   // 回到最近的整圈，rig 弹簧转回去
    return {
      x, y, lean: clamp(c.lean, -0.35, 0.35), headTilt: 0,
      frontShoulder: front.shoulder, frontElbow: front.elbow,
      backShoulder: lerp(0.35, -2.6, s), backElbow: lerp(-0.15, -0.55, s), swordAngle: this.swordAngle,
      ...this.gait.update(dt, x),
      tongue: 0, fallen: 0, visible: 1,
    };
  }

  // follow / armed（球朝玩家来且距拍 < 260）/ swing（拇指快速挥动）
  updatePaddleState(c, pad) {
    const pp = this.pp, b = pp.ball;
    let s = 'follow';
    if (Math.abs(c.paddleSwing) > 4) s = 'swing';
    else if (this.mode === 'PINGPONG' && pp.phase === 'play' && pp.lastHitter === 'cpu' && pad && Math.hypot(b.x - pad.x, b.y - pad.y) < 260) s = 'armed';
    if (s === 'armed' && this.paddleState !== 'armed') pp.emit('paddle armed', 1.2);
    this.paddleState = s;
  }
}
