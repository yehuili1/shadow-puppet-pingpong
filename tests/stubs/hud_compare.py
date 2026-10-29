# 截图与参考帧上半屏并排对比：python tests/stubs/hud_compare.py ours.png ref.jpg out.png [y0 y1]
import sys, cv2, numpy as np
rd = lambda p: cv2.imdecode(np.fromfile(p, np.uint8), 1)
a, b = rd(sys.argv[1]), rd(sys.argv[2])
y0, y1 = (int(sys.argv[4]), int(sys.argv[5])) if len(sys.argv) > 5 else (0, 640)
b = cv2.resize(b, (a.shape[1], a.shape[0]))
out = np.hstack([a[y0:y1], np.full((y1 - y0, 6, 3), 255, np.uint8), b[y0:y1]])
cv2.imencode('.png', out)[1].tofile(sys.argv[3])
