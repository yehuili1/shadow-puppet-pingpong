# 指尖皮影剧场 — 技术契约（所有模块必须遵守）

纯前端，原生 ES Modules，无构建、无框架、无外部依赖（MediaPipe 已放在 `vendor/`，离线可用）。
Canvas 2D 单画布渲染。入口 `index.html` → `src/main.js`。本地运行：`start.bat`（python http.server 8765）。

产品参考：`产品分析.md`、`参考素材/抽帧/*.jpg`（务必看 `full_04.5.jpg`、`full_36.0.jpg`、`sheet_*.jpg`）。

## 目录与归属（每个模块只改自己的文件）

| 文件 | 归属 | 说明 |
|---|---|---|
| `src/core/world.js` `events.js` `math.js` | 共享（只读） | 世界常量、事件日志、数学工具 |
| `src/puppet/skeleton.js` | 共享（只读） | 皮影骨骼尺寸与部件约定 |
| `src/tracking/hand.js` `mock.js` `control.js` | A 手部追踪 | 摄像头 + MediaPipe + 模拟手 + 手→控制量映射 |
| `src/puppet/art.js` `assets/puppets/manifest.json` | B 皮影美术 | 代码绘制部件贴图 + PNG 覆盖 |
| `src/puppet/rig.js` | C 皮影骨骼 | 姿态弹簧、正/逆运动学、绘制编排、碰撞查询 |
| `src/game/*.js` | D 玩法 | 乒乓物理、电脑 AI、武斗、导演（模式状态机） |
| `src/render/stage.js` | E 戏台渲染 | 羊皮纸背景、远山、灯光、手影、桌子球网、球与拖尾、提线 |
| `src/render/hud.js` `layout.js` | F HUD | 布局、摄像头画面、骨架、彩色小皮影、AGENT 面板、终端面板 |
| `src/main.js` `index.html` | 集成 | 主循环接线 |
| `tests/e2e_bot.html` `e2e_bot.js` `e2e_run.mjs`、`README.md`、`start.bat` | 集成 | 端到端自动玩家与验收、使用说明、本地运行 |

## 坐标系

**世界坐标（戏台）**：`WORLD.W × WORLD.H = 1600 × 1000`，y 向下，原点左上。渲染时按 contain 等比缩放居中，背景铺满整个戏台视口（超出部分也要有羊皮纸）。
玩家皮影在左、面朝右（facing=+1）；电脑皮影在右、面朝左（facing=-1）。常量见 `src/core/world.js`。

**手部归一化坐标**：0..1，**已镜像**（与屏幕上镜像显示的自拍画面一致：用户左手出现在画面左侧，x 向右增大），y 向下。

**皮影局部空间（facing-local）**：一律按「面朝右」定义，单位与世界单位相同（scale=1 时）。y 向下。
角度：canvas 约定，正角度 = 屏幕上顺时针。肢体 0 rad = 自然下垂（沿 +y），`-PI/2` = 指向前方（+x），`-PI` = 举过头顶。
facing=-1 时 rig 自行水平镜像，调用方永远用 facing-local 角度。

## 共享数据结构

```js
// A: HandTracker.state
HandState = {
  tracked: bool, source: 'camera'|'mock'|'none',
  handedness: 'Left'|'Right'|null,
  landmarks: [{x,y,z}]×21 | null,   // 归一化、已镜像、One-Euro 平滑后
  palm: {x,y},                      // 0,5,9,13,17 均值
  palmSize: number,                 // wrist→middle_mcp 归一化距离
  fingers: { T,I,M,R,L: { ext:0..1, angle:rad, tip:{x,y} } },  // ext 伸直度；angle 手指方向相对掌轴
  motion: number,                   // 掌心速度，像素/秒（按 640 宽视频像素计）
  stats: { renderHz, trackHz, inferenceMs, sampleAgeMs },
  aspect: number,                   // 画面宽/高（关键点 y 换算到宽度单位；手影等按它校正）
}

// A: ControlMapper.update(handState, dt) -> Control
Control = {
  active: bool,
  px, py,              // 0..1 掌心位置（平滑）
  lean,                // rad，手掌滚转 → 身体倾斜（±0.35 内）
  paddleArm,           // -1..1 大拇指外展角 40°→85°：+1 = 抬起/向前，-1 = 收进掌心（右手/手背朝镜头时按手性镜像）
  paddleSwing,         // 大拇指角速度 1/s（带符号，挥拍力度）
  swordArm,            // -1..1 小拇指外展角 -15°→-60°：+1 = 举起，-1 = 放下（小拇指弯下去也往 -1）
  swordSpin,           // deg/s 小拇指甩动：0.4s 窗口内累计转角/时长（来回甩也累积；摆幅 <45° 视为抖动）；单向转取净转向符号，来回甩保持上次方向；快起慢落
  swordFlip: bool,     // 本帧检测到「小拇指调转」手势（快速大幅翻转）→ 触发武斗
  fingers: {T,I,M,R,L},// 各指伸直度 0..1（HUD 条）
  position, motion,    // HUD 用：position=px，motion=像素/秒
}

// C: PuppetRig 的目标姿态（全部 facing-local）
Pose = {
  x, y,                       // 骨盆世界坐标
  lean,                       // 躯干旋转
  headTilt,                   // 头相对躯干
  frontShoulder, frontElbow,  // 前臂（持拍手）：上臂相对躯干、前臂相对上臂
  backShoulder, backElbow,    // 后臂（持剑手）
  swordAngle,                 // 剑相对后前臂（武斗时可持续累加 = 旋转）
  frontLeg, backLeg,          // 腿相对骨盆（站姿；走路摆腿由 rig 按骨盆速度自己加）
  tongue,                     // 0..1 吐舌头
  fallen,                     // -1..1 倒地（绕双脚中点旋转躺平）：>0 向后仰倒，<0 向前扑倒
  visible,                    // 0..1 整体透明度
}
```

## 模块接口

```js
// ---- A: src/tracking/hand.js
export class HandTracker {
  constructor({ video })                 // HTMLVideoElement（已在 index.html）
  async init({ wasmBase:'vendor/mediapipe/wasm', modelPath:'vendor/models/hand_landmarker.task' }) // GPU 失败回退 CPU
  async startCamera()                    // getUserMedia 640x480，失败抛错；8s 内不出帧也抛错（camera timeout）；可重复调用（重连时先停旧流）
  onCameraLost                           // 可选回调：摄像头中途断开（track ended）时调用，此时 cameraOn=false、停止推理
  update(nowMs)                          // 每帧调用；内部节流 ~30Hz 推理；无手时 tracked=false
  get state()                            // HandState
  get ready()                            // 模型+相机都就绪
  setMock(mock|null)                     // 注入 MockHand；mock 生效时 source='mock'
}
// ---- A: src/tracking/mock.js —— 无摄像头时的模拟手（生成完整 21 点，走同一套计算）
export class MockHand {
  constructor(canvasEl)                  // 绑定鼠标/键盘：鼠标=掌心位置；按住左键=拇指抬起挥拍；W/S=拇指；Q/A=小拇指；按住 E=甩剑（小拇指 5Hz 来回甩）；B=调转（整只手 0.2s 翻腕 ~150° 再转回）
  set({ palm:{x,y}, scale, thumb:-1..1, pinky:-1..1, roll, curl:0..1, visible:bool, spin:bool, flip:true })  // 供自动化测试（后四个：握拳/丢手/按住 E/按 B）
  landmarks(nowMs) -> [{x,y,z}]×21 | null // 已镜像归一化；visible=false 时 null
}
// ---- A: src/tracking/control.js
export class ControlMapper { update(handState, dt) -> Control }
export const THUMB_RANGE, PINKY_RANGE   // 标定区间（deg），mock.js 共用

// ---- B: src/puppet/art.js
export async function loadPuppetArt(manifestUrl?)  // 读 assets/puppets/manifest.json（可传别的地址，测试用），加载 PNG 覆盖；失败静默回退代码绘制；预热全部贴图
export function renderPart(character, style, part)  // 不走缓存直接绘制（测试/导出底稿用）
export function getPart(character, style, part)
  // character: 'hero'(玩家) | 'rival'(电脑)；style: 'shadow'(戏台) | 'color'(摄像头上的彩色小人)
  // part: 见 skeleton.js PARTS
  // -> { img: CanvasImageSource, ox, oy, s }   未知部件名直接抛错；不先调 loadPuppetArt 也能懒加载
  // 绘制方式（rig 负责）：已平移到关节并旋转后 ctx.scale(s,s); ctx.drawImage(img, -ox, -oy)
  // 即 (ox,oy) 是贴图像素坐标里的关节枢轴点，s = 1/分辨率倍数

// ---- C: src/puppet/rig.js
export class PuppetRig {
  constructor({ character, facing, style='shadow', scale=1, stiffness? })
  setPose(partialPose)                   // 目标姿态（合并）
  snap()                                 // 立即跳到目标（无弹簧）
  update(dt)                             // 弹簧 + 次级摆动（皮影提线的晃荡感）+ 计算世界关节
  draw(ctx, { alpha=1, strings=true, stringTopY=STRING_TOP_Y })  // ctx 已在世界坐标（或 HUD 自己的坐标）
  ikArm(arm:'front'|'back', tx, ty) -> { shoulder, elbow }  // 世界目标点 → facing-local 角度（两骨 IK）
  // update 后可读（世界坐标）：
  paddle   -> { x, y, r, vx, vy, angle }   // 拍面圆心
  swordTip -> { x, y, vx, vy }, swordBase -> { x, y }
  // paddle.angle = 握点→拍面圆心方向（世界 atan2）；swordBase = 护手处（剑刃起点）
  bodyHit  -> { x, y, r }[]               // 躯干 3 圆 + 头 1 圆
  controlPoints -> { head, frontHand, backHand, pelvis } 各 {x,y}  // 提线挂点（手 = 腕）
  joints   -> 全部世界关节（调试用）
  pose (当前平滑后姿态), target
  // ikArm 按 target 的 x/y/lean/fallen 求解（弹簧收敛后末端正好在目标上）；front 末端 = 拍面圆心，back 末端 = 腕
  // draw：每个皮影 11 次 drawImage（吐舌头 12 次）；后侧肢体压暗走缓存贴图。持拍臂绝对角只随 pose.lean，不吃躯干摆动
}

// ---- D: src/game/director.js（唯一对外入口；内部用 pingpong.js / ai.js / battle.js）
export class Director {
  constructor()
  update(dt, { control, playerRig, cpuRig })
    // 1) control → 玩家 Pose；AI → 电脑 Pose  2) rig.setPose + rig.update  3) 物理/判定
  mode   -> 'PINGPONG' | 'BATTLE'
  status -> 'WAITING'|'SERVE'|'FLIGHT'|'RECEIVE'|'CELEBRATING'|'SCORED'|'BATTLE / IDLE'|'BATTLE / ATTACK'|'BATTLE / HIT'|'BATTLE / GROUND'|'BATTLE / ESCAPE'
          // 电脑逃跑后走回来的那段仍是 'BATTLE / ESCAPE'
  ball   -> { x, y, r, visible, trail:[{x,y}], vx, vy }   // trail 新→旧
  tableAlpha -> 0..1（武斗时 0.8s 淡出）
  stats  -> { returns, rallyTime, scorePlayer, scoreCpu, hits }   // hits = 本场武斗命中数（进武斗时清零）
  paddleState -> 'follow'|'armed'|'swing'
  pp, ai, battle                         // 内部对象（自动化测试 / 调试读取）
  playerPose(control, dt, battle)        // control → 玩家 Pose（测试标定用，无副作用事件）
}
// 电脑 AI 用 ai.js 的 armIK（与 rig.ikArm 在可达范围内一致，差 <1e-14 rad），不调 cpuRig.ikArm
// 武斗：再调转一次小拇指（电脑戒备、开战 1s 后）可退出；电脑被砍 3 下 → 向前扑倒 → 逃跑出右侧（x>2300，超宽视口也看不到折返）→ 走回 → 回到乒乓
// 武斗中连续无手 5s（电脑戒备时）自动退出 → 同帧进入 WAITING；乒乓 WAITING 连续无手 >15s 比分清零
// 换发球时球先隐藏（newRally），hold / WAITING 定好位的同一帧才显示

// ---- E: src/render/stage.js
export class StageRenderer {
  resize(rect, dpr)                      // rect = 戏台视口（CSS 像素）
  draw(ctx, { t, dt, director, playerRig, cpuRig, hand })  // 负责自己的 save/clip/restore
}
// ---- F: src/render/layout.js
export function computeLayout(w, h) -> { mode:'portrait'|'landscape', title, camera, stage }  // 各为 {x,y,w,h}
  // 竖屏（h > 1.1w）：照参考视频上下分屏（720×1280：顶栏 77、摄像头 {5,102,710,533}、戏台 {5,637,710,533}）
  // 横屏：左侧栏 = 摄像头（宽 clamp(w*0.26,280,520)，4:3）+ 下方终端面板；戏台占右侧全部区域
  //       （画中画叠在戏台上会挡住玩家皮影的头，所以让开这一列）
// ---- F: src/render/hud.js
export class HudRenderer {
  resize(layout, dpr)
  draw(ctx, { t, dt, video, hand, control, director, events, layout })
}
```

## 共享模块（只读）

- `core/world.js`：WORLD、TABLE、BALL_R、PADDLE_R、ZONES、STRING_TOP_Y、PELVIS_Y
- `core/events.js`：`events.push(text)` 写事件日志，`events.items` 读（含 `t` 秒，显示成 `779.2s table contact`）
- `core/math.js`：clamp/lerp/remap/damp/wrapAngle/angleDamp/Spring/OneEuro
- `puppet/skeleton.js`：骨骼尺寸 SK、部件名 PARTS、关节位置

## 视觉基调（照参考视频）

- 顶栏近黑 `#141414`，右侧灰字「指 尖 皮 影 剧 场」字距拉开
- 摄像头区：镜像画面；手骨架薄荷绿 `#5CF2B8` 细线 + 指尖空心圆；提线红 `#FF4D6D`；拇指尖红色实心点
- HUD：等宽字体，深色半透明底 + 1px 浅色描边；标题薄荷绿，状态值洋红 `#FF4FD8`，数值白/灰
- 戏台：做旧羊皮纸（米黄→褐边暗角）、水墨远山（左右两侧淡褐）、中央暖光；皮影为深褐半透明镂空纹样（看得见纹理的「透光皮革」），竖直提线
- 球：小黑白球 + 白色毛笔拖尾；拍：黑色圆拍

## 集成后的实际约定（以代码为准）

- **启动**（`src/main.js`）：先渲染（WAITING），先开摄像头再加载手部模型（没摄像头就不加载模型，免得模型预热卡主线程）；`getUserMedia` 失败立即切模拟手，模型加载失败也切模拟手；`?mock=1` 强制模拟手；按 **M** 在摄像头 / 模拟手间切换（复用同一个 MockHand；摄像头和模型都就绪才能切回）。窗口 resize 150ms 防抖（戏台背景重建约 150ms）。
- **摄像头失败提示**：按原因区分——非安全上下文（局域网 IP / file://）、`NotAllowedError` 权限被拒、`NotReadableError`/`AbortError` 被占用，这三种提示不自动消失；其余才是「未检测到摄像头」（8s 消失）。中途断开（`onCameraLost`）提示并每 2s 重连 `startCamera()`，模型不重载。
- **兜底**（`index.html` 非模块脚本）：`file://` 打开直接提示用 start.bat；模块图加载失败（入口 script 的 error）或 8s 后仍无 `window.__app` 提示「页面加载失败」。`#notice` 自动换行，宽度不超过视口。
- **start.bat**：先找 `python`，不行试 `py -3`，都没有就提示安装并 pause；8765 已有服务在监听就提示关掉旧窗口并 pause（Windows 上 http.server 能重复绑定，会一直打开旧服务）。
- **横屏终端面板**：高度不超过摄像头下方剩余空间（矮窗口时放不下的事件行裁掉，面板不出窗口）。
- **控制 → 姿态**（`director.js`）：`px 0.15..0.85 → ZONES.player.x`（武斗时 `ZONES.battle`），`py 0.25..0.75 → ZONES.player.y`；大拇指走 `ARM_KEYS` 弧线（以前肩为圆心：-1 低位贴身，0 桌面高度前伸，+1 胸前略高，全程在击球区内——真人张手时拇指自然外展，paddleArm 常在 0.3~0.9）。
- **选手**（`hand.js`）：只有一只手就取它；多只时按 Left 标签 + 左手掌心手性 + 离上次掌心距离打分。例外：刚追踪过一只手（1.5s 内）而远处只出现一只明确的右手（标签 Right 且手性为右手掌心）时当这一帧没手，避免用户另一只手比划时皮影瞬移；左手一直不回来才接受右手。
- **走路摆腿只由 rig 做**：`ai.js` 的 `Gait` 只给静态站姿腿角（两边都摆会叠加成乱步）。
- **嘲讽吐舌头**：AI 输出 ~6Hz 近方波，rig 的 tongue 弹簧刚度 3000 才跟得上。
- **戏台**：手影随掌心移动、大小约为腕→中指尖占戏台高 0.46、multiply 冷灰 0.5；皮影与 HUD 小人绘制时 `imageSmoothingQuality='high'`（2 倍贴图缩小 4 倍以上，防纹样闪烁）。
- **彩绘小人**的拍面为红色（参考视频摄像头画面里的红点），戏台皮影的拍面为黑色。
- **测试工具**：`tools/check.mjs --nocam` = 模拟「没有摄像头」（`getUserMedia` 直接报 NotFoundError，验证回退）；端到端自动玩家 `node tests/e2e_run.mjs`（`tests/e2e_bot.html?mock=1`，只通过 `MockHand.set` 操作）。
