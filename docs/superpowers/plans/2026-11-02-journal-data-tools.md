# 日记本 M1（数据与工具）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一条日记可以携带经过净化的简笔画和导入的照片，并让聊天侧能读到「被偷看」的只读事实；不涉及 Web 页面。

**Architecture:** 把 SVG 净化、照片导入、写入编排、peek 记录拆成四个纯模块（`sanitize` / `media` / `write` / `peek`），`lib/index.js` 只做参数声明和工具注册；所有数据仍写进现有 JSONL，保持 v1 向后兼容。

**Tech Stack:** Node 22/24 ESM、`node:fs` / `node:crypto`、仓库自带的无框架 `ok()` 断言脚本。不新增依赖，测试不引入 `@deepseek-ai/*`。

**Spec:** `docs/notebook-page-design.md`

## Global Constraints

- 插件保持确定性：不调用模型、不联网。
- 测试只用临时目录与合成内容，不写入真实聊天数据。
- 不新增运行时依赖；peer 依赖规则不变（只放 `peerDependencies` + `devDependencies`）。
- `entries.jsonl` 仍是追加写 + 按 id 折叠；没有 `doodle` / `photos` 的旧记录必须照常读出。
- 工具名保持 `journal_*`；工具描述用中文。
- 每个任务结束时 `npm test` 必须全绿；提交信息用 `feat:` / `test:` / `docs:` 前缀。

## Review Focus

1. **恶意 SVG**（`<script>`、`on*=`、`href`、`url(...)`、`style`）——必须被丢弃，永远不进入 entries 或渲染路径。
2. **超限输入**：SVG 超过 8000 字符、照片超过 8 MiB——必须拒绝并给出原因，写入本身不崩溃。
3. **照片路径穿越**（`media/../../.credentials.yaml`）——`photoFile` 必须拒绝。
4. **非法锚点/位置**（空 anchor、`side: 'top'`）——写日记不能失败，画/照片被丢弃并在结果里说明。
5. **peek 去重边界**：同一页 9:59 后再看不算、10:01 再看算；不同日期/不同页不互相去重。

---

### Task 1: SVG 净化器

**Files:**
- Create: `lib/sanitize.js`
- Create: `scripts/test-sanitize.mjs`
- Modify: `package.json`（`test` 链追加 `node scripts/test-sanitize.mjs`）

**Interfaces:**
- Consumes: 无。
- Produces: `sanitizeDoodle(input) -> { ok: true, value: { svg, anchor, side } } | { ok: false, reason: string }`
- Produces: 常量 `DOODLE_MAX_CHARS = 8000`、`DOODLE_SIDES = ['left','right','inline']`

**规则（实现时按这些值写）**

- 允许标签：`path` / `circle` / `line` / `polyline` / `polygon` / `ellipse`；其余一律拒绝。
- 允许属性：`d cx cy r x1 y1 x2 y2 points fill stroke stroke-width stroke-linecap stroke-linejoin transform opacity`。
- `fill` 只允许 `none` 或 `#hex`；`stroke` 只允许 `#hex` 或 `currentColor`；`stroke-width` 必须在 `0.5–3`；`opacity` 在 `0–1`。
- 字符串里出现 `<script` / `<style` / `<image` / `<use` / `<foreignObject` / `on\w+\s*=` / `href\s*=` / `javascript:` / `url\s*\(` 直接拒绝。
- 整个 `svg` 必须由允许的标签和空白组成，任何游离的 `<` 或文本都拒绝。
- `anchor` 去空白后 1–80 字；`side` 缺省 `right`，只允许 `left/right/inline`。

- [ ] **Step 1: 写失败测试**

`scripts/test-sanitize.mjs` 复用现有测试的 `ok(name, cond)` 写法：

```js
import { sanitizeDoodle } from '../lib/sanitize.js'

const good = sanitizeDoodle({ svg: '<path d="M10 10 L20 20"/>', anchor: '晚霞', side: 'right' })
ok('合法 SVG 通过', good.ok === true && good.value.side === 'right')
ok('允许 circle + transform', sanitizeDoodle({ svg: '<circle cx="10" cy="10" r="4" transform="rotate(10)"/>', anchor: 'a' }).ok === true)
ok('拒绝 script', sanitizeDoodle({ svg: '<script>alert(1)</script>', anchor: 'a' }).ok === false)
ok('拒绝事件属性', sanitizeDoodle({ svg: '<path d="M0 0" onclick="x()"/>', anchor: 'a' }).ok === false)
ok('拒绝 href', sanitizeDoodle({ svg: '<path d="M0 0" href="javascript:1"/>', anchor: 'a' }).ok === false)
ok('拒绝 style', sanitizeDoodle({ svg: '<path d="M0 0" style="x"/>', anchor: 'a' }).ok === false)
ok('拒绝 url() 填充', sanitizeDoodle({ svg: '<circle cx="1" cy="1" r="1" fill="url(#x)"/>', anchor: 'a' }).ok === false)
ok('拒绝未知标签', sanitizeDoodle({ svg: '<rect width="1" height="1"/>', anchor: 'a' }).ok === false)
ok('拒绝超长', sanitizeDoodle({ svg: '<path d="' + 'M0 0 '.repeat(1600) + '"/>', anchor: 'a' }).ok === false)
ok('拒绝空 anchor', sanitizeDoodle({ svg: '<path d="M0 0"/>', anchor: '' }).ok === false)
ok('拒绝坏 side', sanitizeDoodle({ svg: '<path d="M0 0"/>', anchor: 'a', side: 'top' }).ok === false)
```

- [ ] **Step 2: 运行确认失败**

Run: `node scripts/test-sanitize.mjs`
Expected: 报错 `Cannot find module '../lib/sanitize.js'`，退出码 1。

- [ ] **Step 3: 实现 `lib/sanitize.js`**

导出上面的接口与常量；内部用「整串匹配 + 逐标签解析」而不是宽松替换：先按标签正则切分并校验覆盖整串，再逐属性校验白名单和值格式，最后重新拼回 `<tag attr="..."/>`。任何一步失败返回 `{ ok:false, reason }`，不抛异常。

- [ ] **Step 4: 运行确认通过**

Run: `node scripts/test-sanitize.mjs`
Expected: 全部 ✅，`结果：11 通过，0 失败`。

- [ ] **Step 5: 接入测试链并跑全套**

`package.json` 的 `test` 末尾追加 `&& node scripts/test-sanitize.mjs`，然后：

Run: `npm test`
Expected: 四组测试全绿。

- [ ] **Step 6: 提交**

```bash
git add lib/sanitize.js scripts/test-sanitize.mjs package.json
git commit -m "feat: sanitize model-authored doodle svg"
```

---

### Task 2: 照片导入与路径校验

**Files:**
- Create: `lib/media.js`
- Create: `scripts/test-media.mjs`
- Modify: `package.json`（`test` 链追加 `node scripts/test-media.mjs`）

**Interfaces:**
- Consumes: `resolveJournalDir`、`isDateKey` from `lib/store.js`。
- Produces: `importPhoto(dir, srcPath, { date }) -> { file: string, bytes: number }`，`file` 形如 `media/2026-11-02/ab12cd34ef56.jpg`。
- Produces: `photoFile(dir, file) -> string`（绝对路径；越界抛错）。
- Produces: 常量 `PHOTO_MAX_BYTES = 8 * 1024 * 1024`、`PHOTO_EXTS = ['.jpg', '.jpeg', '.png', '.webp']`。

**规则**

- 源文件必须存在且是普通文件；扩展名只认 jpg/jpeg/png/webp（统一存成 `jpg` / `png` / `webp`）。
- 目标目录 `journal/media/<date>/`，文件名取 `sha256(buf).slice(0,12) + '.' + ext`；已存在则复用。
- `photoFile` 把 `media` 根解析后校验 `startsWith(root + sep)`，否则抛 `照片路径越界`。

- [ ] **Step 1: 写失败测试**

```js
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { importPhoto, photoFile } from '../lib/media.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-media-'))
const src = path.join(dir, 'a.jpg')
fs.writeFileSync(src, Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0, 0, 0]))
const one = importPhoto(dir, src, { date: '2026-11-02' })
ok('导入返回 media 相对路径', /^media\/2026-11-02\/[a-f0-9]{12}\.jpg$/.test(one.file))
ok('文件真的落盘', fs.existsSync(photoFile(dir, one.file)))
ok('同样内容复用同一文件', importPhoto(dir, src, { date: '2026-11-02' }).file === one.file)
ok('拒绝未知扩展名', throws(() => importPhoto(dir, path.join(dir, 'x.txt'), { date: '2026-11-02' })))
ok('拒绝不存在的文件', throws(() => importPhoto(dir, path.join(dir, 'nope.jpg'), { date: '2026-11-02' })))
const big = path.join(dir, 'big.jpg'); fs.writeFileSync(big, Buffer.alloc(8 * 1024 * 1024 + 1))
ok('拒绝超过 8MiB', throws(() => importPhoto(dir, big, { date: '2026-11-02' })))
ok('拒绝路径穿越', throws(() => photoFile(dir, 'media/../../.credentials.yaml')))
```

`throws` 用 `try { fn(); return false } catch { return true }` 的本地小工具。

- [ ] **Step 2: 运行确认失败**

Run: `node scripts/test-media.mjs`
Expected: `Cannot find module '../lib/media.js'`。

- [ ] **Step 3: 实现 `lib/media.js`**

读文件 → 校验大小/扩展名 → 计算 hash → `mkdir` → 不存在才写入 → 返回相对路径（用 `path.posix.join`，保证在 Windows 上也是 `/`）。

- [ ] **Step 4: 运行确认通过**

Run: `node scripts/test-media.mjs`
Expected: `结果：7 通过，0 失败`。

- [ ] **Step 5: 接入测试链并跑全套**

Run: `npm test`（已追加 media 测试）
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add lib/media.js scripts/test-media.mjs package.json
git commit -m "feat: import journal photos into media dir"
```

---

### Task 3: Store 支持 doodle / photos 字段

**Files:**
- Modify: `lib/store.js`
- Modify: `scripts/test-store.mjs`

**Interfaces:**
- Produces: `normalizeDoodleMeta(input) -> { svg, anchor, side }`（非法抛错）
- Produces: `normalizePhotoMeta(input) -> { file, anchor, side, caption }`（非法抛错）
- `normalizeEntryInput` 新增可选出参 `doodle` / `photos`：有值才写入，`photos` 最多 3 张。
- `writeEntry` / `loadEntries` 原样往返这些字段；旧记录不受影响。

- [ ] **Step 1: 写失败测试（追加到 `scripts/test-store.mjs`，放在最终汇总之前；`throws` 用 Task 2 里的小工具，复制到文件顶部）**

```js
const artDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-art-'))
const withArt = writeEntry(artDir, {
  text: '今天画了晚霞。', scope: 'group:100000001', date: '2026-11-02',
  doodle: { svg: '<path d="M0 0 L10 10"/>', anchor: '晚霞', side: 'right' },
  photos: [{ file: 'media/2026-11-02/ab12cd34ef56.jpg', anchor: '晚霞', side: 'right', caption: '她发的' }]
}, { now: Date.now(), maxEntriesPerDay: 3 })
const back = loadEntries(artDir).find((e) => e.id === withArt.entry.id)
ok('doodle 往返', back.doodle.anchor === '晚霞' && back.doodle.side === 'right')
ok('photos 往返', back.photos.length === 1 && back.photos[0].file === 'media/2026-11-02/ab12cd34ef56.jpg')
ok('非法 photo.file 抛错', throws(() => writeEntry(artDir, { text: 'x', scope: 'global', photos: [{ file: '../x.jpg' }] })))
ok('photos 超过 3 张抛错', throws(() => writeEntry(artDir, { text: 'x', scope: 'global', photos: Array(4).fill({ file: 'media/2026-11-02/ab12cd34ef56.jpg' }) })))
const plain = writeEntry(artDir, { text: '没有画也没有照片。', scope: 'global', date: '2026-11-03' }, { now: Date.now(), maxEntriesPerDay: 3 })
const plainBack = loadEntries(artDir).find((e) => e.id === plain.entry.id)
ok('没有画/照片时不写这两个字段', !('doodle' in plainBack) && !('photos' in plainBack))
```

- [ ] **Step 2: 运行确认失败**

Run: `node scripts/test-store.mjs`
Expected: `doodle 往返` / `photos 往返` 失败（字段被丢掉）。

- [ ] **Step 3: 实现**

在 `lib/store.js` 增加两个 normalize 函数和 `PHOTO_FILE_RE = /^media\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{12}\.(jpg|png|webp)$/`；`normalizeEntryInput` 末尾按「有值才加字段」合并，保证旧测试的深比较不被打断。

- [ ] **Step 4: 运行确认通过**

Run: `node scripts/test-store.mjs`
Expected: 原 33 条 + 新增 5 条全绿。

- [ ] **Step 5: 提交**

```bash
git add lib/store.js scripts/test-store.mjs
git commit -m "feat: store doodle and photo metadata on entries"
```

---

### Task 4: 写入编排（净化 + 导入 + 落库）

**Files:**
- Create: `lib/write.js`
- Create: `scripts/test-write.mjs`
- Modify: `package.json`（`test` 链追加 `node scripts/test-write.mjs`）

**Interfaces:**
- Consumes: `sanitizeDoodle`（Task 1）、`importPhoto`（Task 2）、`writeEntry` / `normalizePhotoMeta` / `dayKey` / `isDateKey`（Task 3）。
- Produces: `writeJournal(cfg, args, { now = Date.now() } = {}) -> { entry, remaining, dropped }`
  - `cfg`: `{ dir, timezone, maxEntryChars, maxEntriesPerDay }`
  - `args`: `{ text, scope, date?, mood?, refs?, doodle?, photos?: [{ path, anchor, side, caption }] }`
  - `dropped`: `{ doodle: string|null, photos: [{ path, reason }] }`

**行为**

- 坏 doodle / 坏照片只记录到 `dropped`，不阻断正文写入。
- 照片先导入再 `normalizePhotoMeta`；超过 3 张的部分记 `最多 3 张`。
- `date` 缺省按 `cfg.timezone` 取今天；非法 date 直接抛错（这是调用方的错，不该静默）。

- [ ] **Step 1: 写失败测试**

```js
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeJournal } from '../lib/write.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-write-'))
const cfg = { dir, timezone: 'Asia/Shanghai', maxEntryChars: 600, maxEntriesPerDay: 3 }
const src = path.join(dir, 'p.jpg'); fs.writeFileSync(src, Buffer.from([0xff, 0xd8, 0xff, 0, 0]))

const r1 = writeJournal(cfg, {
  text: '今天画了晚霞。', scope: 'group:100000001', date: '2026-11-02',
  doodle: { svg: '<path d="M0 0 L9 9"/>', anchor: '晚霞', side: 'right' },
  photos: [{ path: src, anchor: '晚霞', side: 'right', caption: '她发的' }]
}, { now: 1793600000000 })
ok('写入成功并带 doodle', r1.entry.doodle.anchor === '晚霞')
ok('照片被导入', /^media\/2026-11-02\/[a-f0-9]{12}\.jpg$/.test(r1.entry.photos[0].file))

const r2 = writeJournal(cfg, {
  text: '第二篇。', scope: 'group:100000001', date: '2026-11-02',
  doodle: { svg: '<script>x</script>', anchor: '晚霞' }
}, { now: 1793600100000 })
ok('坏 doodle 被丢弃但正文写入', r2.entry.id && r2.dropped.doodle && !r2.entry.doodle)

const r3 = writeJournal(cfg, {
  text: '第三篇。', scope: 'group:100000001', date: '2026-11-02',
  photos: [{ path: path.join(dir, 'nope.jpg'), anchor: 'x' }]
}, { now: 1793600200000 })
ok('坏照片被丢弃', r3.entry.id && r3.dropped.photos.length === 1 && !r3.entry.photos)
```

- [ ] **Step 2: 运行确认失败**

Run: `node scripts/test-write.mjs`
Expected: `Cannot find module '../lib/write.js'`。

- [ ] **Step 3: 实现 `lib/write.js`**

按 Interfaces 组装；`photos` 超过 3 张时只导入前 3 张，其余写入 `dropped`。`writeEntry` 调用时传 `source: 'agent'` 和 `now`。

- [ ] **Step 4: 运行确认通过**

Run: `node scripts/test-write.mjs`
Expected: `结果：4 通过，0 失败`。

- [ ] **Step 5: 接入测试链并跑全套**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add lib/write.js scripts/test-write.mjs package.json
git commit -m "feat: orchestrate doodle sanitizing and photo imports on write"
```

---

### Task 5: Peek 记录与只读事实

**Files:**
- Create: `lib/peek.js`
- Create: `scripts/test-peek.mjs`
- Modify: `package.json`（`test` 链追加 `node scripts/test-peek.mjs`）

**Interfaces:**
- Produces: `recordPeek(dir, { date, scope = 'all', source = 'web', now = Date.now() }) -> { recorded: boolean, ts?: number }`
- Produces: `readPeekFacts(dir, { now = Date.now() } = {}) -> { total, today, lastAt, byDay: [{ date, count }], last7 }`
- Produces: `peekPath(dir)` 与 `PEEK_DEDUPE_MS = 10 * 60 * 1000`

**行为**

- 追加写 `peek.jsonl`，一行一条 `{ v:1, ts, date, scope, source }`；坏行跳过。
- 去重：找同 `date + scope` 的最后一条，`now - ts < 10 分钟` 则不记。
- `today` = 页面日期等于今天（`dayKey(now)`）的次数；`last7` = 页面日期在最近 7 天内的次数；`lastAt` = 最大 ts。

- [ ] **Step 1: 写失败测试**

```js
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recordPeek, readPeekFacts } from '../lib/peek.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-peek-'))
const t0 = 1793592000000 // 2026-11-02 12:00 +08:00
ok('第一次记录', recordPeek(dir, { date: '2026-11-02', now: t0 }).recorded === true)
ok('9:59 内不重复记', recordPeek(dir, { date: '2026-11-02', now: t0 + 599000 }).recorded === false)
ok('10:01 后重新记', recordPeek(dir, { date: '2026-11-02', now: t0 + 601000 }).recorded === true)
ok('不同日期不互相去重', recordPeek(dir, { date: '2026-11-01', now: t0 + 602000 }).recorded === true)
const facts = readPeekFacts(dir, { now: t0 + 602000 })
ok('总数 3', facts.total === 3)
ok('今天（11-02）2 次', facts.today === 2)
ok('lastAt 是最后一条', facts.lastAt === t0 + 602000)
ok('byDay 按天汇总', facts.byDay.find((d) => d.date === '2026-11-02').count === 2)
```

- [ ] **Step 2: 运行确认失败**

Run: `node scripts/test-peek.mjs`
Expected: `Cannot find module '../lib/peek.js'`。

- [ ] **Step 3: 实现 `lib/peek.js`**

读全部 → 找同 date+scope 的最后一条 → 判断间隔 → 追加；`readPeekFacts` 单遍扫描并跳过坏行。

- [ ] **Step 4: 运行确认通过**

Run: `node scripts/test-peek.mjs`
Expected: `结果：8 通过，0 失败`。

- [ ] **Step 5: 接入测试链并跑全套**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add lib/peek.js scripts/test-peek.mjs package.json
git commit -m "feat: record journal peeks and expose read-only facts"
```

---

### Task 6: 工具接线与文档

**Files:**
- Modify: `lib/index.js`
- Modify: `README.md`、`README.en.md`、`docs/plugin-design.md`

**Interfaces:**
- `journal_write` 新增参数：
  - `doodle`: `{ type: 'object', additionalProperties: false, properties: { svg: { type: 'string' }, anchor: { type: 'string' }, side: { type: 'string', enum: ['left','right','inline'] } } }`
  - `photos`: `{ type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, anchor: { type: 'string' }, side: { type: 'string', enum: ['left','right','inline'] }, caption: { type: 'string' } } } }`
- `execute` 改调 `writeJournal(cfg, args)`，返回值合并 `dropped`；`render` 里对 `dropped.doodle` / `dropped.photos` 各追加一行中文提示。
- 新增 `journal_peek`：无参数，`execute` 调 `readPeekFacts(cfg.dir)`，`render` 输出「共 N 次 / 今天 M 次 / 上次 …」。
- `ENTRY_SCHEMA` 增加 `doodle` / `photos` 的可选声明（`additionalProperties: true` 保持开放）。
- 文档：README 工具表加 `journal_peek`；`journal_write` 一行补 doodle/photos；`docs/plugin-design.md` §6 同步。

- [ ] **Step 1: 改 `lib/index.js`**

按上面签名改参数、`execute`、`render`，并 `import { writeJournal } from './write.js'`、`import { readPeekFacts } from './peek.js'`。

- [ ] **Step 2: 静态检查**

Run: `npm run check`
Expected: `result: OK`，无新增失败项（五语 README 警告保持原样）。

- [ ] **Step 3: 全量测试**

Run: `npm test`
Expected: 七组测试全绿（store / digest / audit / sanitize / media / write / peek）。

- [ ] **Step 4: 改文档**

README 中英工具表加 `journal_peek`，`journal_write` 的参数说明补 `doodle` / `photos`；`docs/plugin-design.md` §6 表格同步。

- [ ] **Step 5: 提交**

```bash
git add lib/index.js README.md README.en.md docs/plugin-design.md
git commit -m "feat: expose doodle, photos and peek facts through journal tools"
```

---

## 验收

- `npm test`：7 组测试全绿（原 67 条 + 新增 sanitize/media/write/peek/store 扩展）。
- `npm run check`：`result: OK`。
- 手工：在临时目录用 `writeJournal` 写一条带画和照片的日记，`journal_audit` 能正常读到该条目（字段不影响 refs 审计）。
- 不做：Web 页面、peek 的 HTTP 接口、照片从 digest 自动发现（M2/M3/M4）。
