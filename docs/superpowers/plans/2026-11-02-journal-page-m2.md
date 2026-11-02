# 日记本页面 M2（只读页面 + 数据接口）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在服务器 DSH 的 Web 服务上开一个只读的 `/journal` 页面：按天翻页，手写正文、简笔画、照片跟着句子走；打开某天即记录一次「偷看」。

**Architecture:** 不做 DSH client 插件（会引入 React/打包链）；改为在 `ctx.webServer` 上注册 `/journal` 前缀路由，服务端出 HTML/CSS/JS，浏览器端原生 JS 渲染。数据层保持纯函数（`lib/page.js`），HTTP 层单独可测（`lib/webserver.js`），不新增依赖。

**Tech Stack:** Node 22/24 ESM、`node:http`、原生 DOM/CSS、仓库现有的 `ok()` 测试脚本。

**Spec:** `docs/notebook-page-design.md`（§4 页面、§5 偷看、§8 UI 集成）

## Global Constraints

- 插件保持确定性：不调用模型、不联网（页面只读本地 journal 目录）。
- 只读：页面没有任何写正文/上传/删除接口；唯一的写是 `POST /journal/api/peek`。
- 不新增运行时依赖；测试不引入 `@deepseek-ai/*`。
- 所有路径必须限制在 `journal/` 与 `assets/` 内；文本一律 `textContent` 渲染。
- 页面仅绑定在 DSH 的 Web 服务（默认 `127.0.0.1:3080`），不额外起公网服务。

## Review Focus

1. **路径穿越**：`/journal/media/*` 与 `/journal/assets/*` 必须拒绝 `..`、盘符、绝对路径、junction/symlink。
2. **畸形请求**：非法 `date`/`scope`/JSON、超大 body 必须返回 4xx，进程不崩。
3. **XSS**：日记正文、anchor、caption 只走 `textContent`；SVG 只从已净化的 entries 取，按白名单重建 DOM。
4. **空数据**：没有任何日记、某天没有条目、某 scope 没有条目时页面正常显示空状态。
5. **peek**：POST 只接受 `{date, scope}`，10 分钟去重；失败不写半条记录。

---

### Task 1: 页面数据纯函数

**Files:**
- Create: `lib/page.js`
- Create: `scripts/test-page.mjs`
- Modify: `package.json`（test 链追加）

**Interfaces:**
- `listDays(dir, { scope = '', limit = 60 }) -> [{ date, count, scopes: string[] }]`（按日期倒序）
- `buildDay(dir, { date, scope = '' }) -> { date, scope, entries }`（按 createdAt 升序；非法 date 抛错）

- [ ] **Step 1: 写失败测试**（`ok(cond, name)` 顺序）

```js
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { writeEntry } from '../lib/store.js';
import { listDays, buildDay } from '../lib/page.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-page-'));
writeEntry(dir, { text: '甲', scope: 'group:100000001', date: '2026-11-01' }, { now: 1 });
writeEntry(dir, { text: '乙', scope: 'group:100000001', date: '2026-11-02' }, { now: 2 });
writeEntry(dir, { text: '丙', scope: 'private:100000002', date: '2026-11-02' }, { now: 3 });
const days = listDays(dir);
ok(days[0].date === '2026-11-02' && days[0].count === 2, '按日期倒序并按天计数');
ok(days[0].scopes.length === 2, '一天里多个 scope');
ok(listDays(dir, { scope: 'private:100000002' }).length === 1, 'scope 过滤');
const day = buildDay(dir, { date: '2026-11-02' });
ok(day.entries.length === 2 && day.entries[0].text === '乙', '按 createdAt 升序');
ok(buildDay(dir, { date: '2026-11-02', scope: 'group:100000001' }).entries.length === 1, '单 scope');
let threw = false; try { buildDay(dir, { date: '2026/11/02' }); } catch { threw = true; }
ok(threw, '非法 date 抛错');
fs.rmSync(dir, { recursive: true, force: true });
```

- [ ] **Step 2: 跑失败** `node scripts/test-page.mjs` → `Cannot find module '../lib/page.js'`
- [ ] **Step 3: 实现 `lib/page.js`**（只用 `loadEntries`/`isDateKey`；跳过 archived 与坏日期）
- [ ] **Step 4: 跑通过** → `结果：6 通过，0 失败`
- [ ] **Step 5: 接入 `npm test` 并跑全套**
- [ ] **Step 6: 提交** `feat: add journal page data shaping`

---

### Task 2: `/journal` HTTP 处理器

**Files:**
- Create: `lib/webserver.js`
- Create: `scripts/test-webserver.mjs`
- Modify: `package.json`（test 链）

**Interfaces:**
- `createJournalHandler({ dir, assetsDir }) -> (req, res) => Promise<void>`
- 路由：
  - `GET /journal` → `assets/journal.html`
  - `GET /journal/assets/<journal.css|journal.js>`（白名单）
  - `GET /journal/api/days?scope=&limit=` → `{ days }`
  - `GET /journal/api/day?date=&scope=` → `{ date, scope, entries }`；坏 date 400
  - `GET /journal/media/<rel>` → 文件字节（`photoFile` 校验）；不存在 404
  - `POST /journal/api/peek`（body ≤ 8KB，`{date, scope}`）→ `{ recorded }`；坏输入 400
  - 其余 404

- [ ] **Step 1: 写失败测试**（`http.createServer(handler).listen(0)` + `fetch`）

```js
// 造一个临时 journal：一条带照片的日记 + 一份最小 assets
const assets = { 'journal.html': '<!doctype html><title>本子</title>', 'journal.css': 'body{}', 'journal.js': 'console.log(1)' };
const server = http.createServer(createJournalHandler({ dir, assetsDir }));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
ok((await fetch(`${base}/journal`)).status === 200, '页面 200');
ok((await (await fetch(`${base}/journal/api/day?date=2026-11-02`)).json()).entries.length === 1, 'day JSON');
ok((await fetch(`${base}/journal/api/day?date=bad`)).status === 400, '坏 date 400');
ok((await fetch(`${base}/journal/media/../x`)).status === 404 || 400, '媒体穿越拒绝');
ok((await (await fetch(`${base}/journal/api/peek`, { method:'POST', body: JSON.stringify({date:'2026-11-02'}) })).json()).recorded === true, 'peek 记录');
ok((await fetch(`${base}/journal/api/peek`, { method:'POST', body: '{' })).status === 400, '坏 JSON 400');
```

- [ ] **Step 2: 跑失败** → module not found
- [ ] **Step 3: 实现 `lib/webserver.js`**（`URL` 解析 + `decodeURIComponent` 容错；body 读取限 8KB；`photoFile` 定位媒体；assets 白名单 + `text/css`/`text/javascript`）
- [ ] **Step 4: 跑通过** → `结果：6 通过，0 失败`
- [ ] **Step 5: 接入 `npm test` 并跑全套**
- [ ] **Step 6: 提交** `feat: serve read-only journal page and data api`

---

### Task 3: 页面资产（HTML/CSS/JS）

**Files:**
- Create: `assets/journal.html`、`assets/journal.css`、`assets/journal.js`
- Create: `scripts/preview-page.mjs`（临时数据 + 本地预览，开发用）
- Modify: `package.json`（`files` 增加 `assets`）

**要点**
- 版式：横线作业本；日期 + 手写正文 + 简笔画 + 拍立得照片 + 折角/正字。
- 抖动：`journal.js` 用 `entry.id` 做种子，逐字 `rotate/translate/scale`；`filter:url(#ink)` 纸面起伏。
- 简笔画：按 `anchor` 在正文里找片段，找不到/放不下就不画；SVG 白名单重建（`createElementNS`），不 `innerHTML`。
- 照片：`<img src="/journal/media/...">`，按 anchor 浮动。
- 翻页：前一天/后一天链接；scope 下拉；打开即 `POST /journal/api/peek`。
- 只读：没有输入框、没有保存按钮。

- [ ] **Step 1: 写 `assets/journal.html` + `journal.css` + `journal.js`**
- [ ] **Step 2: 写 `scripts/preview-page.mjs`**（生成临时数据并 `listen(4180)`，打印 URL）
- [ ] **Step 3: 跑预览 + Chrome 无头截图**，检查手写/画/照片/空状态
- [ ] **Step 4: 提交** `feat: add notebook page assets`

---

### Task 4: 挂到 DSH Web 服务 + 文档

**Files:**
- Modify: `lib/index.js`（`apply` 里可选注册）、`package.json`、`README.md`、`README.en.md`、`docs/plugin-design.md`

**Interfaces:**
- `const web = ctx.get('webServer'); if (web) ctx.effect(() => web.register({ kind: 'prefix', path: '/journal', handler: createJournalHandler({ dir: cfg.dir, assetsDir }) }));`
- `assetsDir = new URL('../assets', import.meta.url)`
- 没有 `webServer`（headless/SDK profile）时只少一个页面，工具照常。

- [ ] **Step 1: 改 `lib/index.js`**（`ctx.get` 可选，注册返回 disposer 放进 `ctx.effect`）
- [ ] **Step 2: `npm test` + `npm run check`**
- [ ] **Step 3: 文档**：README 加「偷看页面」段（URL、只读、隧道访问、不要公网暴露）；设计稿 §8 改成路由方案
- [ ] **Step 4: 提交** `feat: mount journal page on web profile`

---

## 验收

- `npm test` 全绿（新增 page/webserver 两组）。
- `npm run check` 通过。
- `node scripts/preview-page.mjs` 起临时页面，Chrome 截图能看到：手写正文、随句子的简笔画/照片、翻页、空状态。
- 在服务器 web profile 装上后，`http://127.0.0.1:3080/journal` 可打开；打开某天在 `peek.jsonl` 留一条记录（10 分钟内重复打开不重复）。
