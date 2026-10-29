// 皮影骨骼约定（facing-local：面朝右，y 向下，单位 = 世界单位 @ scale 1）
// 每个部件贴图的「静止朝向」与关节枢轴见下方注释；art.js 按此绘制，rig.js 按此拼装。

export const SK = {
  // 躯干：枢轴 = 骨盆 (0,0)，向上延伸到脖子
  torsoLen: 200,
  torsoWTop: 92,
  torsoWBottom: 70,
  neck: { x: 4, y: -200 },              // 躯干局部

  // 头：枢轴 = 脖子，向上；含头饰。嘴 = 舌头枢轴（头局部）
  headH: 150,                           // 脖子到头饰顶
  faceW: 80,
  mouth: { x: 40, y: -42 },
  headTop: { x: 0, y: -150 },           // 提线挂点（头局部）

  // 肩（躯干局部）
  frontShoulder: { x: 12, y: -182 },
  backShoulder: { x: -6, y: -184 },

  // 上臂：枢轴 = 肩，静止沿 +y 下垂，肘在 (0, upperArmLen)
  upperArmLen: 120,
  upperArmW: 26,
  // 前臂：枢轴 = 肘，沿 +y，腕在 (0, forearmLen)，手画在腕下方约 20
  forearmLen: 110,
  forearmW: 22,
  handLen: 22,

  // 拍：枢轴 = 握点（前臂腕处），沿 +y：柄 0..paddleHandle，拍面圆心在 (0, paddleCenter)
  paddleHandle: 24,
  paddleCenter: 52,                     // 圆心距握点；半径用 world.PADDLE_R

  // 剑：枢轴 = 握点（后臂腕处），沿 +y：护手 ~18，剑尖在 (0, swordLen)
  swordLen: 210,
  swordGuard: 18,

  // 髋（骨盆局部，不随躯干倾斜）
  frontHip: { x: 10, y: 6 },
  backHip: { x: -10, y: 6 },
  // 腿：枢轴 = 髋，沿 +y 到脚踝，靴子朝 +x 前伸
  legLen: 330,
  legW: 30,
  bootLen: 46,

  // 下摆：枢轴 = 骨盆，向下延伸
  skirtLen: 170,
  skirtWTop: 110,
  skirtWBottom: 170,

  // 舌头：枢轴 = 嘴，沿 +x 前伸（tongue=1 时全长）
  tongueLen: 46,
};

// 部件名：前后肢共用同一贴图（rig 可给后侧肢体压暗）
export const PARTS = ['torso', 'head', 'skirt', 'upperArm', 'forearm', 'leg', 'paddle', 'sword', 'tongue'];

export const CHARACTERS = ['hero', 'rival'];   // hero = 玩家（左），rival = 电脑（右）
export const STYLES = ['shadow', 'color'];     // shadow = 戏台透光皮影；color = 摄像头上的彩绘小人

// 绘制顺序（后 → 前）
export const DRAW_ORDER = [
  'backArm',   // 后上臂 + 后前臂 + 剑
  'backLeg',
  'frontLeg',
  'skirt',
  'torso',
  'head',      // + 舌头
  'frontArm',  // 前上臂 + 前前臂 + 拍
];
