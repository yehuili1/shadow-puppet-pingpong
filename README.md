# 指尖皮影剧场（皮影乒乓）

网页互动装置：摄像头识别你的**左手**，手指像提线一样操控皮影人，在皮影戏台上和电脑控制的皮影人打乒乓球。
电脑赢球后会吐舌头嘲讽你；文的不行就来武的——小拇指一调转，桌子消失，挥剑去砍对手。

纯前端、原生 ES Modules，无构建、无 npm 依赖；手部识别用 MediaPipe（已放在 `vendor/`，**离线可用**）。

## 运行

1. 双击 **`start.bat`**（需要 Python 3，到 python.org 安装时勾选 **Add python.exe to PATH**；没勾也行，会改用 `py` 启动器）。
   它会在 8765 端口起静态服务，约 1 秒后自动打开 `http://localhost:8765/index.html`。关闭黑色命令行窗口即停止服务。
   找不到 Python 或 8765 已被占用（之前的黑窗口没关）时，窗口会停住显示原因。
2. 浏览器弹出摄像头权限时点「允许」。推荐 Chrome / Edge。
3. 举起左手、掌心朝镜头，就可以开始了。

- 没有摄像头（或拒绝权限、被占用）时自动切到**模拟手**，用鼠标键盘玩，屏幕下方提示具体原因。
- 地址后加 `?mock=1` 强制用模拟手；游戏中按 **M** 在摄像头 / 模拟手之间切换。
- 摄像头中途断开（USB 线松了等）会提示并每 2 秒自动重连，插回去就恢复。
- 也可以手动起服务：`python -m http.server 8765`，再打开上面的地址（必须走 `http://localhost`，直接双击 html 打不开摄像头和模块）。

## 画面

竖屏（手机 / 竖放显示器）照原视频上下分屏：上半是摄像头画面 + 手骨架 + 挂在手指上的彩色小皮影（红线是提线），
左上 AGENT 面板、右侧终端面板；下半是皮影戏台。横屏时左侧栏放摄像头和终端面板，戏台占右边全部。

## 玩法手势（左手，掌心朝镜头）

| 手 | 皮影 |
|---|---|
| 手掌左右 / 上下移动 | 皮影走位（左右）、身体高低 |
| 手掌左右倾斜 | 身体前后倾 |
| **大拇指**外展抬起 / 收进掌心 | 持拍的手抬高前伸 / 放低贴身；快速一挑 = 发力挥拍 |
| 发球时抬大拇指 | 发球（不动的话 2.5 秒后自动发） |
| **小拇指**外展 / 并拢弯曲 | 持剑的手举起 / 放下 |
| 小拇指快速**调转**（翻腕带着小拇指转半圈） | 进入**武斗**：当前回合作废，桌子淡出（武斗中手离开 5 秒自动回到乒乓） |
| 武斗中**甩**小拇指 | 宝剑旋转；走到电脑跟前砍它，3 下打倒 → 它爬起来逃跑 → 走回来继续打乒乓 |
| 武斗中电脑戒备时再调转一次 | 提前退出武斗 |

状态（AGENT 面板 STATUS）：`WAITING` 等手 → `SERVE` 发球 → `FLIGHT` 球飞向电脑 / `RECEIVE` 球飞向你 →
`CELEBRATING` 电脑得分（嘲讽吐舌头）/ `SCORED` 你得分；武斗 `BATTLE / IDLE | ATTACK | HIT | GROUND | ESCAPE`。
终端面板里有回合数（returns）、对打时长（rally time）、比分（score）、五指伸直度和事件日志。没人玩超过 15 秒比分清零。

## 键盘鼠标（模拟手）

| 操作 | 作用 |
|---|---|
| 移动鼠标 | 掌心位置 |
| 按住鼠标左键 / 松开 | 大拇指抬起 / 回落（= 挥拍、发球） |
| W / S | 大拇指平时的高低 |
| Q / A | 小拇指外展 / 并拢（持剑手举起 / 放下） |
| 按住 E | 甩小拇指（宝剑旋转） |
| B | 小拇指调转（进入 / 退出武斗） |
| M | 摄像头 / 模拟手互相切换 |

## 目录结构

```
index.html            入口（单个 canvas）
start.bat             本地运行（python -m http.server 8765）
SPEC.md               技术契约：坐标系、数据结构、模块接口
产品分析.md            原视频玩法拆解
src/
  main.js             主循环接线：追踪 → 控制 → 导演 → 戏台 + HUD
  core/               世界常量 world.js、事件日志 events.js、数学工具 math.js
  tracking/           hand.js 摄像头 + MediaPipe；mock.js 模拟手；control.js 手 → 控制量
  puppet/             skeleton.js 骨骼尺寸；art.js 代码绘制部件贴图 + PNG 覆盖；rig.js 弹簧/提线摆动/IK/绘制
  game/               director.js 模式状态机；pingpong.js 物理与规则；ai.js 电脑；battle.js 武斗
  render/             stage.js 戏台；hud.js 摄像头区与面板；layout.js 屏幕布局
assets/puppets/       皮影 PNG 覆盖（manifest.json + 说明）
vendor/               MediaPipe 运行库与手部模型（离线）
tests/                各模块测试页、端到端自动玩家
tools/                无头 Chrome 测试工具（check.mjs、假摄像头素材）
参考素材/              原视频与抽帧
```

## 替换皮影 PNG

默认所有皮影部件由 `src/puppet/art.js` 用代码绘制。要换成美工出的图：

1. 把 PNG 放进 `assets/puppets/`（建议 `角色/风格/部件.png`，如 `hero/shadow/head.png`）。
2. 在 `assets/puppets/manifest.json` 登记：

   ```json
   { "hero": { "shadow": { "head": { "src": "hero/shadow/head.png", "ox": 336, "oy": 640, "s": 0.5 } } } }
   ```

   `ox, oy` = 关节枢轴在 PNG 里的像素坐标；`s` = 像素 → 世界单位（按 2 倍分辨率出图填 0.5）。
3. 刷新页面。没登记或加载失败的部件自动回退代码绘制，可以一次只换一个。

- 角色：`hero`（玩家）、`rival`（电脑）；风格：`shadow`（戏台透光皮影）、`color`（摄像头上的彩色小人）；
  部件：`torso head skirt upperArm forearm leg paddle sword tongue`。
- 一律画成**面朝右**的侧面，电脑那一侧由程序镜像。出图尺寸、枢轴、朝向详见 `assets/puppets/README.md`，
  换图后用 `tests/art.html?view=grid` 检查枢轴十字是否落在关节上。

## 测试（开发用）

测试工具需要 Node 和系统 Chrome，先在 `tools/` 下 `npm install`（只装 playwright-core）。

```bash
node tools/check.mjs --url index.html --size 720x1280 --wait 12000 --shots 4 --every 2500 --shot tools/out/p.png --eval "window.__app.debug()"
node tools/check.mjs --url "index.html?mock=1" --nocam      # --nocam：模拟没有摄像头
node tests/e2e_run.mjs        # 端到端：模拟手自动玩家打乒乓 + 武斗闭环，关键状态截图到 tools/out/integration/
node tests/game.test.mjs      # 玩法物理 / AI / 武斗单测
```

假摄像头默认用原视频画面（`tools/fake_cam.mjpeg`，45 秒循环），画面里自带原版 HUD，截图会有两层文字，属正常。
原视频和假摄像头文件体积大，不在仓库里：把原视频放到 `参考素材/原视频.mp4`，再运行 `python tools/make_fake_cam.py` 生成。

## 常见问题

- **提示「页面加载失败」、控制台说模块 MIME 类型不对**：个别 Windows 的注册表把 `.js` 关联成 `text/plain`，
  `python -m http.server` 会照着发。把注册表 `HKEY_CLASSES_ROOT\.js` 的 `Content Type` 改回 `text/javascript`，或换个静态服务器。
- **双击 index.html 只显示「请双击 start.bat 启动」**：必须用 `start.bat`（或 `http://localhost:8765`）打开。
- **提示「摄像头权限被拒绝」**：点地址栏左侧的摄像头 / 锁形图标，把摄像头改为「允许」后刷新；
  仍不行查 Windows「设置 → 隐私 → 相机」，打开「允许应用 / 桌面应用访问相机」。
- **提示「摄像头被其他程序占用」**：关掉微信视频、腾讯会议、OBS 等正在用摄像头的程序后刷新。
- **提示「请用 http://localhost:8765 打开」**：用局域网 IP（如 `http://192.168.x.x:8765`）打开时浏览器不给摄像头，
  在本机用 localhost 打开。
- **一直显示「举起左手开始」**：手离摄像头 0.5–1 米、掌心朝镜头、光线充足；或按 M 用模拟手。
- **皮影站在最左边不动**：掌心在画面左侧时皮影就在戏台左侧，手往画面中间移。
