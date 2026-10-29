// 无头 Chrome 冒烟测试：起静态服务 → 打开页面（可用原视频当假摄像头）→ 收集报错 → 截图
// 用法：
//   node tools/check.mjs --url index.html --size 720x1280 --wait 8000 --shot tools/out/p.png
//   node tools/check.mjs --url "index.html?mock=1" --eval "window.__app.debug()" --shots 3 --every 1500
//   --nocam  不提供任何摄像头设备（getUserMedia 失败 → 测试回退到模拟手）
// 输出：控制台日志、页面错误、--eval 结果（JSON）。有页面错误时退出码 1。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, []),
);
// 注意：Git Bash 会把 /xxx 改写成 Windows 路径，--url 请写成不带前导斜杠的 index.html?mock=1
const url = '/' + String(args.url || 'index.html').replace(/^\/+/, '');
const [W, H] = String(args.size || '720x1280').split('x').map(Number);
const wait = Number(args.wait || 6000);
const shots = Number(args.shots || 1);
const every = Number(args.every || 1500);
const shot = args.shot || path.join('tools', 'out', 'shot.png');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.task': 'application/octet-stream',
};
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const chromeArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'];
if (!args.nocam) chromeArgs.push(`--use-file-for-fake-video-capture=${path.join(ROOT, 'tools', 'fake_cam.mjpeg')}`);

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: chromeArgs,
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
// --nocam：getUserMedia 直接报「找不到设备」（无头 Chrome 总会给一个假设备，这里模拟真的没摄像头）
if (args.nocam) {
  await page.addInitScript(() => {
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError'));
  });
}
const errors = [];
page.on('console', (m) => console.log(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => { errors.push(String(e)); console.log(`[pageerror] ${e.stack || e}`); });
page.on('requestfailed', (r) => console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));

await page.goto(`http://127.0.0.1:${port}${url}`);
await page.waitForTimeout(wait);
fs.mkdirSync(path.dirname(shot), { recursive: true });
for (let i = 0; i < shots; i++) {
  const out = shots === 1 ? shot : shot.replace(/(\.\w+)$/, `_${i + 1}$1`);
  await page.screenshot({ path: out });
  console.log(`[shot] ${out}`);
  if (args.eval) {
    try {
      const v = await page.evaluate(args.eval);
      console.log(`[eval] ${JSON.stringify(v)}`);
    } catch (e) { errors.push(String(e)); console.log(`[eval-error] ${e}`); }
  }
  if (i < shots - 1) await page.waitForTimeout(every);
}
await browser.close();
server.close();
console.log(errors.length ? `[FAIL] ${errors.length} page error(s)` : '[OK] no page errors');
process.exit(errors.length ? 1 : 0);
