// 端到端验收：无头 Chrome 打开 tests/e2e_bot.html?mock=1（模拟手 + 自动玩家），按玩法闭环等关键状态截图并汇总统计
// 用法：node tests/e2e_run.mjs [--size 720x1280] [--out tools/out/integration] [--rally 90]
//   --rally  乒乓阶段最长秒数（双方都 ≥2 分且 ≥5 个回合后提前进入武斗）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(path.join(ROOT, 'tools', 'package.json'))('playwright-core');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, []),
);
const [W, H] = String(args.size || '720x1280').split('x').map(Number);
const OUT = path.resolve(ROOT, args.out || path.join('tools', 'out', 'integration'));
const RALLY_MAX = Number(args.rally || 90);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.task': 'application/octet-stream',
};
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.log(`[pageerror] ${e.stack || e}`); });
page.on('console', (m) => { if (m.type() === 'error') console.log(`[console.error] ${m.text()}`); });

fs.mkdirSync(OUT, { recursive: true });
const T0 = Date.now();
const sec = () => ((Date.now() - T0) / 1000).toFixed(1);
const results = [];
const shot = async (name, note) => {
  const file = path.join(OUT, `${name}.png`);
  const st = await page.evaluate(() => {
    const a = window.__app, d = a.director;
    return { status: d.status, mode: d.mode, stats: { ...d.stats }, tableAlpha: +d.tableAlpha.toFixed(2), tongue: +a.cpuRig.pose.tongue.toFixed(2), fallen: +a.cpuRig.pose.fallen.toFixed(2), cpuX: Math.round(a.cpuRig.pose.x), playerX: Math.round(a.playerRig.pose.x) };
  });
  await page.screenshot({ path: file });
  await page.evaluate(() => (window.__freeze = false));
  results.push({ name, at: +sec(), ...st, note });
  console.log(`[shot ${sec()}s] ${path.relative(ROOT, file)} ${JSON.stringify(st)}`);
};
// 条件满足（每帧轮询）；超时记一条失败继续往下走。freeze=true：满足的那一帧冻结画面，截图后再放开
const until = async (label, fn, timeout = 60000, arg, freeze = false) => {
  try {
    await page.waitForFunction(`(() => { const ok = (${fn})(${JSON.stringify(arg ?? null)}); if (ok && ${freeze}) window.__freeze = true; return ok; })()`, null, { timeout, polling: 'raf' });
    return true;
  } catch {
    console.log(`[timeout] ${label}`);
    results.push({ name: label, timeout: true, at: +sec() });
    return false;
  }
};

await page.goto(`http://127.0.0.1:${server.address().port}/tests/e2e_bot.html?mock=1`);
await until('bot ready', () => window.__bot && window.__app.director.status === 'SERVE', 20000);
await page.waitForTimeout(500);
await shot('serve', '玩家发球前：球在拍子上方');

await until('rally', () => ['FLIGHT', 'RECEIVE'].includes(window.__app.director.status) && window.__app.director.stats.returns >= 4 && window.__app.director.ball.x < 760, 60000, null, true);
await shot('rally', '对打中（≥4 次回球）');

await until('celebrating', () => window.__app.director.status === 'CELEBRATING' && window.__app.director.pp.timer < 1.9 && window.__app.cpuRig.pose.tongue > 0.75, 120000, null, true);
await shot('celebrating', '电脑得分：嘲讽吐舌头');

await until('scored', () => window.__app.director.status === 'SCORED' && window.__app.director.pp.timer < 1.0, 120000, null, true);
await shot('scored', '玩家得分：电脑沮丧');

// 乒乓阶段：双方都 ≥2 分、≥5 个回合，或到时间上限
await until('rally phase', (max) => {
  const s = window.__app.director.stats, b = window.__bot;
  return (s.scorePlayer >= 2 && s.scoreCpu >= 2 && b.stats.rallies >= 5) || b.t > max;
}, (RALLY_MAX + 10) * 1000, RALLY_MAX);
await until('serve before battle', () => window.__app.director.status === 'SERVE', 15000);
await shot('hud_score', '乒乓阶段结束时 HUD（score / returns / rally time）');
const rallyStats = await page.evaluate(() => JSON.parse(JSON.stringify({ bot: window.__bot.stats, t: window.__bot.t, director: window.__app.director.stats })));

// 武斗
await page.evaluate(() => window.__bot.startBattle());
await until('battle enter', () => window.__app.director.mode === 'BATTLE' && window.__app.director.tableAlpha < 0.6, 15000, null, true);
await shot('battle_enter', '小拇指调转 → 进入武斗，桌子淡出中');
await until('battle attack', () => window.__app.director.status === 'BATTLE / ATTACK' && window.__app.director.tableAlpha < 0.02, 30000, null, true);
await shot('battle', '桌子消失，靠近电脑甩剑（ATTACK）');
await until('battle hit', () => window.__app.director.status === 'BATTLE / HIT' && window.__app.director.battle.st > 0.08, 30000, null, true);
await shot('battle_hit', '剑砍中电脑（HIT）');
await until('ground', () => window.__app.director.status === 'BATTLE / GROUND' && Math.abs(window.__app.cpuRig.pose.fallen) > 0.85, 40000, null, true);
await shot('ground', '三次命中后电脑倒地（GROUND）');
await until('escape', () => window.__app.director.status === 'BATTLE / ESCAPE' && window.__app.director.battle.state === 'ESCAPE' && window.__app.director.battle.st > 1.0, 20000, null, true);
await shot('escape', '电脑爬起逃跑（ESCAPE）');
await until('back to pingpong', () => window.__app.director.mode === 'PINGPONG' && window.__app.director.tableAlpha > 0.99, 30000, null, true);
await shot('back_pingpong', '电脑走回，回到乒乓');

// 回到乒乓后再打一会儿，确认还能继续对打
const before = await page.evaluate(() => window.__bot.stats.playerReturns);
await until('after battle rally', (n) => window.__bot.stats.playerReturns > n, 45000, before);
const final = await page.evaluate(() => JSON.parse(JSON.stringify({ bot: window.__bot.stats, t: window.__bot.t, director: window.__app.director.stats, status: window.__app.director.status })));
await shot('after_battle', '武斗后继续乒乓');

await browser.close();
server.close();

const ok = (c) => (c ? 'ok  ' : 'FAIL');
const b = rallyStats.bot;
const checks = [
  [b.playerReturns > 0, `玩家接到球：player return ×${b.playerReturns}`],
  [b.rallies >= 3, `多回合：${b.rallies} 个回合`],
  [b.points.player > 0 && b.points.cpu > 0, `双方都得分：玩家 ${b.points.player} / 电脑 ${b.points.cpu}`],
  [b.celebrateTongue.max > 0.75 && b.celebrateTongue.min < 0.25, `嘲讽吐舌头：CELEBRATING 期间 tongue ${b.celebrateTongue.min.toFixed(2)}..${b.celebrateTongue.max.toFixed(2)}`],
  [final.bot.battle.some((s) => s.includes('cpu grounded')) && final.bot.battle.some((s) => s.includes('battle over')), `武斗闭环：${final.bot.battle.join(' | ')}`],
  [final.bot.playerReturns > before, `武斗后继续对打：player return ${before} → ${final.bot.playerReturns}`],
  [!results.some((r) => r.timeout), `关键状态全部到达（超时 ${results.filter((r) => r.timeout).length} 个）`],
  [errors.length === 0, `页面错误 ${errors.length} 个`],
];
console.log('\n== 乒乓阶段统计 ==');
console.log(JSON.stringify({ seconds: +rallyStats.t.toFixed(1), ...rallyStats.director, rallies: b.rallies, playerReturns: b.playerReturns, cpuReturns: b.cpuReturns, tableContacts: b.tableContacts, lapses: b.lapses, maxReturns: b.maxReturns, maxRallyTime: b.maxRallyTime, avgReturns: +(b.rallyLog.reduce((s, r) => s + r.returns, 0) / Math.max(1, b.rallyLog.length)).toFixed(2), reasons: b.reasons, statuses: Object.keys(b.statuses) }));
console.log('rallyLog', JSON.stringify(b.rallyLog));
console.log('\n== 检查 ==');
for (const [c, s] of checks) console.log(`${ok(c)} ${s}`);
fs.writeFileSync(path.join(OUT, 'e2e_result.json'), JSON.stringify({ results, rallyStats, final, errors }, null, 1));
const pass = checks.every(([c]) => c);
console.log(pass ? '\nE2E PASSED' : '\nE2E FAILED');
process.exit(pass ? 0 : 1);
