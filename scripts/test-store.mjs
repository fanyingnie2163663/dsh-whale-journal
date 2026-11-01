// 日记存储自检：写入、上限、截断、读取、归档、搜索、折叠、清理。
// 运行：node scripts/test-store.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dayKey,
  writeEntry,
  listEntries,
  loadEntries,
  archiveEntry,
  searchEntries,
  journalStats,
  pruneArchived,
  normalizeScope,
  resolveJournalDir
} from '../lib/store.js';

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-store-'));
const SCOPE = 'group:100000001';
const t = new Date(2026, 10, 2, 10, 0, 0).getTime();

try {
  console.log('## 基础');
  {
    ok(dayKey(t) === '2026-11-02', 'dayKey 按本地日期');
    ok(dayKey(t, 'UTC') === '2026-11-02', 'dayKey 支持时区参数');
    ok(normalizeScope(SCOPE) === SCOPE, 'scope 归一化');
    let threw = false;
    try { normalizeScope('bad scope!'); } catch { threw = true; }
    ok(threw, '非法 scope 抛错');
    ok(resolveJournalDir(dir) === path.resolve(dir), '显式目录');
  }

  console.log('\n## 写入');
  const first = writeEntry(dir, { text: '今天群里聊了比赛，我跟着起哄了两句。', scope: SCOPE, date: '2026-11-02', mood: '松弛', refs: [1, 2, 2] }, { now: t });
  ok(first.entry.id.startsWith('j_'), '生成 id');
  ok(first.entry.text.includes('比赛'), '正文保存');
  ok(first.entry.refs.length === 2, 'refs 去重');
  ok(first.remaining === 2, '剩余条数');

  {
    const truncated = writeEntry(dir, { text: 'x'.repeat(700), scope: SCOPE, date: '2026-11-02' }, { now: t + 1, maxChars: 10 });
    ok(truncated.entry.truncated === true && truncated.entry.text.length === 10, '超长截断并标 truncated');
  }

  console.log('\n## 上限');
  {
    writeEntry(dir, { text: '第二条', scope: SCOPE, date: '2026-11-02' }, { now: t + 2, maxEntriesPerDay: 3 });
    let threw = false;
    try {
      writeEntry(dir, { text: '第四条', scope: SCOPE, date: '2026-11-02' }, { now: t + 3, maxEntriesPerDay: 3 });
    } catch (e) {
      threw = /上限/.test(String(e.message));
    }
    ok(threw, '超过每日上限抛错');
    ok(listEntries(dir, { date: '2026-11-02' }).length === 3, '当天 3 条');
  }

  console.log('\n## 读取与过滤');
  {
    writeEntry(dir, { text: '私聊里他说了晚安。', scope: 'private:100000002', date: '2026-11-01' }, { now: t - 86400000 });
    ok(listEntries(dir, { scope: SCOPE }).length === 3, '按 scope 过滤');
    ok(listEntries(dir, { scope: 'private:100000002' }).length === 1, '私聊单独');
    ok(listEntries(dir, { date: '2026-11-01' }).length === 1, '按日期过滤');
    ok(listEntries(dir, { limit: 2 }).length === 2, 'limit 生效');
    ok(listEntries(dir, { scope: SCOPE })[0].date === '2026-11-02', '最新在前');
  }

  console.log('\n## 归档（软删除）');
  {
    const target = first.entry.id;
    const archived = archiveEntry(dir, target, { reason: '写重了', now: t + 10 });
    ok(archived.status === 'archived', '归档状态');
    ok(listEntries(dir, { scope: SCOPE }).length === 2, '默认读不到归档');
    ok(listEntries(dir, { scope: SCOPE, includeArchived: true }).length === 3, 'includeArchived 能读到');
    const folded = loadEntries(dir).filter((e) => e.id === target);
    ok(folded.length === 1 && folded[0].status === 'archived', '同 id 折叠成最新一条');
    let threw = false;
    try { archiveEntry(dir, 'missing'); } catch { threw = true; }
    ok(threw, '归档不存在的 id 抛错');
  }

  console.log('\n## 搜索与统计');
  {
    const hits = searchEntries(dir, '晚安');
    ok(hits.length === 1 && hits[0].score > 0, '关键词搜索');
    ok(searchEntries(dir, '晚安', { scope: 'private:100000002' }).length === 1, 'scope 过滤命中');
    ok(searchEntries(dir, '晚安', { scope: SCOPE }).length === 0, 'scope 过滤不串台');
    let threw = false;
    try { searchEntries(dir, '  '); } catch { threw = true; }
    ok(threw, '空 query 抛错');
    const stats = journalStats(dir);
    ok(stats.total === 4 && stats.active === 3, '统计 active/total');
    ok(stats.scopes[SCOPE] === 3, '按 scope 统计');
  }

  console.log('\n## 保留期清理');
  {
    const removed = pruneArchived(dir, { retentionDays: 1, now: t + 3 * 86400000 });
    ok(removed.removed === 1, '只清理归档且过期的');
    ok(loadEntries(dir).length === 3, '剩余条数正确');
  }

  console.log('\n## 参数校验');
  {
    for (const [name, input] of [
      ['空正文', { text: '  ', scope: SCOPE }],
      ['非法日期', { text: 'x', scope: SCOPE, date: '2026/11/02' }],
      ['非法 scope', { text: 'x', scope: '坏 scope' }]
    ]) {
      let threw = false;
      try { writeEntry(dir, input); } catch { threw = true; }
      ok(threw, `${name} 抛错`);
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
