// /journal HTTP 处理器自检：页面、数据、媒体、peek、路径、来源与坏输入。
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

const outside = path.join(dir, 'outside');
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
let linked = false;
try {
  fs.symlinkSync(outside, path.join(dir, 'media', '2026-11-02', 'link'), 'junction');
  linked = true;
} catch {
  // 某些平台不允许建链接：跳过这一条
}

writeEntry(dir, { text: '今天画了晚霞。', scope: 'group:100000001', date: '2026-11-02' }, { now: 1 });

const server = http.createServer(createJournalHandler({ dir, assetsDir }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const jsonHeaders = { 'content-type': 'application/json' };

function rawRequest(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

try {
  console.log('## 页面与资产');
  {
    const page = await fetch(`${base}/journal`);
    const html = await page.text();
    ok(page.status === 200 && html.includes('本子'), '页面 200 且返回 HTML');
    const css = await fetch(`${base}/journal/assets/journal.css`);
    ok(css.status === 200 && (css.headers.get('content-type') ?? '').includes('text/css'), 'CSS 资源');
    ok((await fetch(`${base}/journal/assets/secret.txt`)).status === 404, '非白名单资产 404');
    const headPage = await rawRequest('/journal', { method: 'HEAD' });
    ok(headPage.status === 200 && headPage.body === '', 'HEAD 页面 200 且无 body');
    const postPage = await rawRequest('/journal', { method: 'POST' });
    ok(postPage.status === 405 && (postPage.headers.allow ?? '').includes('GET'), 'POST 页面 405 + Allow');
  }

  console.log('\n## 数据接口');
  {
    const days = await (await fetch(`${base}/journal/api/days`)).json();
    ok(days.days.length === 1 && days.days[0].date === '2026-11-02', 'days 汇总');
    const day = await (await fetch(`${base}/journal/api/day?date=2026-11-02`)).json();
    ok(day.entries.length === 1 && day.entries[0].text === '今天画了晚霞。', 'day 返回条目');
    ok((await fetch(`${base}/journal/api/day?date=bad`)).status === 400, '坏 date 400');
    ok((await fetch(`${base}/journal/nope`)).status === 404, '未知路径 404');
    const headDay = await rawRequest('/journal/api/day?date=2026-11-02', { method: 'HEAD' });
    ok(headDay.status === 200 && headDay.body === '', 'HEAD API 200 且无 body');
    const postDays = await rawRequest('/journal/api/days', { method: 'POST' });
    ok(postDays.status === 405 && postDays.headers.allow === 'GET, HEAD', 'POST API 405 + Allow');
  }

  console.log('\n## 媒体');
  {
    const okImg = await fetch(`${base}/journal/media/2026-11-02/a.jpg`);
    ok(okImg.status === 200 && okImg.headers.get('content-type') === 'image/jpeg', '媒体 200 + 类型');
    const headImg = await rawRequest('/journal/media/2026-11-02/a.jpg', { method: 'HEAD' });
    ok(headImg.status === 200 && headImg.body === '', 'HEAD 媒体 200 且无 body');
    const bad = await fetch(`${base}/journal/media/%2e%2e%2f%2e%2e%2fcredentials.yaml`);
    ok(bad.status === 404 || bad.status === 400, '媒体穿越被拒绝');
    if (linked) {
      const viaLink = await fetch(`${base}/journal/media/2026-11-02/link/secret.txt`);
      ok(viaLink.status === 404, 'junction 越界被拒绝');
    }
  }

  console.log('\n## 来源校验');
  {
    const evilHost = await rawRequest('/journal/api/days', { headers: { host: 'evil.example' } });
    ok(evilHost.status === 403, '非 loopback Host 403');
  }

  console.log('\n## peek');
  {
    const first = await rawRequest('/journal/api/peek', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ date: '2026-11-02' })
    });
    ok(JSON.parse(first.body).recorded === true, '第一次记录');
    const second = await rawRequest('/journal/api/peek', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ date: '2026-11-02' })
    });
    ok(JSON.parse(second.body).recorded === false, '10 分钟内去重');

    const badJson = await rawRequest('/journal/api/peek', { method: 'POST', headers: jsonHeaders, body: '{' });
    ok(badJson.status === 400, '坏 JSON 400');
    const badDate = await rawRequest('/journal/api/peek', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ date: 'x' })
    });
    ok(badDate.status === 400, '坏 date 400');

    const plain = await rawRequest('/journal/api/peek', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ date: '2026-11-03' })
    });
    ok(plain.status === 415, 'peek 要求 application/json');

    const evilOrigin = await rawRequest('/journal/api/peek', {
      method: 'POST',
      headers: { ...jsonHeaders, origin: 'https://evil.example' },
      body: JSON.stringify({ date: '2026-11-03' })
    });
    ok(evilOrigin.status === 403, '跨源 Origin 403');

    const badScope = await rawRequest('/journal/api/peek', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ date: '2026-11-03', scope: 'x'.repeat(200) })
    });
    ok(badScope.status === 400, '非法 scope 400');

    const huge = await rawRequest('/journal/api/peek', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ date: '2026-11-04', pad: 'x'.repeat(9000) })
    });
    ok(huge.status === 413, '超大 body 413');
  }
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
