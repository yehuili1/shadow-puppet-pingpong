// 屏幕布局：竖屏照参考视频（720×1280）上下分屏；横屏左侧栏（摄像头 + 终端面板）+ 右侧戏台
// 返回各区域 {x,y,w,h}（CSS 像素）

import { clamp } from '../core/math.js';

const rect = (x, y, w, h) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });

export function computeLayout(w, h) {
  if (h > w * 1.1) return portrait(w, h);
  return landscape(w, h);
}

// 参考帧实测（720 宽）：顶栏 78、顶栏下留 25、左右边距 5、两块 4:3 之间 2、底部留黑约 110
function portrait(w, h) {
  const u = w / 720;
  const titleH = clamp(h * 0.06, 28, 96);
  const gapTop = Math.max(6, 25 * u);
  const gapMid = Math.max(2, 2 * u);
  const minBottom = Math.max(8, 16 * u);

  let bw = w - 2 * Math.max(2, 5 * u);
  let bh = (bw * 3) / 4;
  const fixed = titleH + gapTop + gapMid + minBottom;
  if (fixed + 2 * bh > h) {
    // 高度不够：两块等比缩小，水平居中
    bh = Math.max(40, (h - fixed) / 2);
    bw = (bh * 4) / 3;
  }
  // 屏幕更高时：多出来的高度（超过参考底部留黑的部分）一半给上面，内容整体下移居中
  const extra = h - (titleH + gapTop + 2 * bh + gapMid);
  const shift = Math.max(0, (extra - 110 * u) / 2);
  const x = (w - bw) / 2;
  const camY = titleH + gapTop + shift;

  return {
    mode: 'portrait',
    title: rect(0, 0, w, titleH),
    camera: rect(x, camY, bw, bh),
    stage: rect(x, camY + bh + gapMid, bw, bh),
  };
}

// 横屏：摄像头在左上（宽 clamp(w*0.26, 280, 520)，4:3，16px 边距），终端面板在它下方；
// 戏台占右侧全部区域。16:9 下世界(16:10)几乎占满宽度，画中画叠在戏台上会盖住玩家皮影的头，所以让开这一列。
function landscape(w, h) {
  const titleH = clamp(h * 0.036, 24, 40);
  const bodyH = h - titleH;
  let pw = clamp(w * 0.26, 280, 520);
  pw = Math.min(pw, w * 0.4, ((bodyH - 48) * 0.55 * 4) / 3); // 矮窗口：给下方终端面板留空间
  const ph = (pw * 3) / 4;
  const colW = pw + 32;
  return {
    mode: 'landscape',
    title: rect(0, 0, w, titleH),
    camera: rect(16, titleH + 16, pw, ph),
    stage: rect(colW, titleH, w - colW, bodyH),
  };
}
