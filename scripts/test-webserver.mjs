// /journal HTTP 处理器自检：页面、数据、媒体、peek、路径与坏输入。
// 运行：node scripts/test-webserver.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { writeEntry } from '../lib/store.js';
import { createJournalHandler } from '../lib/webserver.js';

let pass = 0;
let fail = 0;
function ok(cond, name, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-web-'));
const assetsDir = path.join(dir, 'assets');
fs.mkdirSync(assetsDir, { recursive: true });
fs.writeFileSync(path.join(assetsDir, 'journal.html'), '<!doctype html><title>本子</title>');
fs.writeFileSync(path.join(assetsDir, 'journal.css'), 'body{}');
fs.writeFileSync(path.join(assetsDir, 'journal.js'), 'console.log(1)');
fs.mkdirSync(path.join(dir, 'media', '2026-11-02'), { recursive: true });
fs.writeFileSync(path.join(dir, 'media', '2026-11-02', 'a.jpg'), Buffer.from([0xff, 0xd8, 0xff]));

writeEntry(dir, { text: '今天画了晚霞。', scope: 'group:100000001', date: '2026-11-02' }, { now: 1 });

const server = http.createServer(createJournalHandler({ dir, assetsDir }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  console.log('## 页面与资产');
  {
    const page = await fetch(`${base}/journal`);
    const html = await page.text();
    ok(page.status === 200 && html.includes('本子'), '页面 200 且返回 HTML');
    const css = await fetch(`${base}/journal/assets/journal.css`);
    ok(css.status === 200 && (css.headers.get('content-type') ?? '').includes('text/css'), 'CSS 资源');
    ok((await fetch(`${base}/journal/assets/secret.txt`)).status === 404, '非白名单资产 404');
  }

  console.log('\n## 数据接口');
  {
    const days = await (await fetch(`${base}/journal/api/days`)).json();
    ok(days.days.length === 1 && days.days[0].date === '2026-11-02', 'days 汇总');
    const day = await (await fetch(`${base}/journal/api/day?date=2026-11-02`)).json();
    ok(day.entries.length === 1 && day.entries[0].text === '今天画了晚霞。', 'day 返回条目');
    ok((await fetch(`${base}/journal/api/day?date=bad`)).status === 400, '坏 date 400');
    ok((await fetch(`${base}/journal/nope`)).status === 404, '未知路径 404');
  }

  console.log('\n## 媒体');
  {
    const okImg = await fetch(`${base}/journal/media/2026-11-02/a.jpg`);
    ok(okImg.status === 200 && okImg.headers.get('content-type') === 'image/jpeg', '媒体 200 + 类型');
    const bad = await fetch(`${base}/journal/media/%2e%2e%2f%2e%2e%2fcredentials.yaml`);
    ok(bad.status === 404 || bad.status === 400, '媒体穿越被拒绝');
  }

  console.log('\n## peek');
  {
    const first = await fetch(`${base}/journal/api/peek`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-11-02' })
    });
    ok((await first.json()).recorded === true, '第一次记录');
    const second = await fetch(`${base}/journal/api/peek`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-11-02' })
    });
    ok((await second.json()).recorded === false, '10 分钟内去重');
    const badJson = await fetch(`${base}/journal/api/peek`, { method: 'POST', body: '{' });
    ok(badJson.status === 400, '坏 JSON 400');
    const badDate = await fetch(`${base}/journal/api/peek`, { method: 'POST', body: JSON.stringify({ date: 'x' }) });
    ok(badDate.status === 400, '坏 date 400');
  }
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
