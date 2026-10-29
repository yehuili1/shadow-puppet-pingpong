// 戏台世界常量（单位：世界单位，y 向下）。详见 SPEC.md「坐标系」。

export const WORLD = { W: 1600, H: 1000, floorY: 965, gravity: 1500 };

// 乒乓桌（侧视）：桌面一条线，中间球网
export const TABLE = {
  x0: 540, x1: 1060,     // 桌面左右端
  topY: 720,             // 桌面高度
  thickness: 18,
  netX: 800,
  netTopY: 668,          // 网顶
};

export const BALL_R = 9;
export const PADDLE_R = 30;

// 骨盆默认高度（站立）
export const PELVIS_Y = 600;

// 骨盆活动范围
export const ZONES = {
  player: { xMin: 150, xMax: 470, yMin: 560, yMax: 640 },
  cpu: { xMin: 1130, xMax: 1450, yMin: 560, yMax: 640 },
  battle: { xMin: 150, xMax: 1450 },
};

// 提线顶端（戏台上沿之外）
export const STRING_TOP_Y = -20;
