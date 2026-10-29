// 测试替身：一只张开的左手（显示空间已镜像：拇指朝画面右侧），21 点归一化坐标，缓慢移动
const ASPECT = 640 / 480;
// 掌局部坐标（掌长 腕→中指根 = 1；x 向右，y 向下）
const TEMPLATE = [
  [0, 0],
  [0.26, -0.18], [0.5, -0.38], [0.72, -0.52], [0.9, -0.62],
  [0.3, -0.93], [0.4, -1.32], [0.46, -1.57], [0.51, -1.8],
  [0.05, -1.0], [0.07, -1.44], [0.08, -1.72], [0.09, -1.97],
  [-0.19, -0.94], [-0.27, -1.33], [-0.32, -1.58], [-0.36, -1.8],
  [-0.4, -0.8], [-0.53, -1.07], [-0.61, -1.25], [-0.68, -1.42],
];

export function stubHand(t, { visible = true } = {}) {
  if (!visible) return { tracked: false, source: 'none', handedness: null, landmarks: null };
  const palm = { x: 0.27 + 0.1 * Math.sin(t * 0.35), y: 0.66 + 0.05 * Math.sin(t * 0.6 + 1) };
  const size = 0.17 + 0.01 * Math.sin(t * 0.5);
  const roll = 0.12 * Math.sin(t * 0.4);
  const c = Math.cos(roll), s = Math.sin(roll);
  const thumb = 0.15 * Math.sin(t * 1.3);   // 拇指上下摆
  // 掌心 = 0,5,9,13,17 均值（模板里约在 (−0.01, −0.73)）
  const cx = -0.01, cy = -0.73;
  const landmarks = TEMPLATE.map(([x, y], i) => {
    if (i >= 1 && i <= 4) { const k = i / 4; y -= thumb * k; }
    const dx = x - cx, dy = y - cy;
    const rx = dx * c - dy * s, ry = dx * s + dy * c;
    return { x: palm.x + (rx * size) / ASPECT, y: palm.y + ry * size, z: 0 };
  });
  return {
    tracked: true, source: 'mock', handedness: 'Left', landmarks, palm, palmSize: size,
    fingers: null, motion: 0, stats: { renderHz: 60, trackHz: 30, inferenceMs: 0, sampleAgeMs: 0 },
  };
}
