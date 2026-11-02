// 页面数据自检：按天汇总、scope 过滤、单日排序、非法日期。
// 运行：node scripts/test-page.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeEntry } from '../lib/store.js';
import { listDays, buildDay } from '../lib/page.js';

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-page-'));

try {
  writeEntry(dir, { text: '甲', scope: 'group:100000001', date: '2026-11-01' }, { now: 1 });
  writeEntry(dir, { text: '乙', scope: 'group:100000001', date: '2026-11-02' }, { now: 2 });
  writeEntry(dir, { text: '丙', scope: 'private:100000002', date: '2026-11-02' }, { now: 3 });

  console.log('## listDays');
  {
    const days = listDays(dir);
    ok(days[0].date === '2026-11-02' && days[0].count === 2, '按日期倒序并按天计数');
    ok(days[0].scopes.length === 2, '一天里多个 scope');
    ok(listDays(dir, { scope: 'private:100000002' }).length === 1, 'scope 过滤');
  }

  console.log('\n## buildDay');
  {
    const day = buildDay(dir, { date: '2026-11-02' });
    ok(day.entries.length === 2 && day.entries[0].text === '乙', '按 createdAt 升序');
    ok(buildDay(dir, { date: '2026-11-02', scope: 'group:100000001' }).entries.length === 1, '单 scope');

    let threw = false;
    try { buildDay(dir, { date: '2026/11/02' }); } catch { threw = true; }
    ok(threw, '非法 date 抛错');
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
