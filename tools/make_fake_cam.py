# 从参考视频生成无头 Chrome 的假摄像头文件 tools/fake_cam.mjpeg（tools/check.mjs 默认使用）
# 原视频不在仓库里：放到 参考素材/原视频.mp4 后运行 python tools/make_fake_cam.py
import os
import cv2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cap = cv2.VideoCapture(os.path.join(ROOT, '参考素材', '原视频.mp4'))
buf = bytearray()
n = 0
while True:
    ok, f = cap.read()
    if not ok:
        break
    # 截取上半屏摄像头区域，缩到 640x480，并水平翻转还原成未镜像的原始摄像头画面
    cam = cv2.flip(cv2.resize(f[104:634, 8:716], (640, 480)), 1)
    buf += cv2.imencode('.jpg', cam, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()
    n += 1
with open(os.path.join(ROOT, 'tools', 'fake_cam.mjpeg'), 'wb') as fp:
    fp.write(buf)
print('frames', n, 'MB', round(len(buf) / 1e6, 1))
