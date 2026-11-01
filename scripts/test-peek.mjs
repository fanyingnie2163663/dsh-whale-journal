// 偷看记录自检：计数、10 分钟去重、按天汇总、只读事实。
// 运行：node scripts/test-peek.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordPeek, readPeekFacts } from '../lib/peek.js';

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-peek-'));
const t0 = 1793592000000; // 2026-11-02 12:00 +08:00

try {
  console.log('## 记录与去重');
  {
    ok(recordPeek(dir, { date: '2026-11-02', now: t0 }).recorded === true, '第一次记录');
    ok(recordPeek(dir, { date: '2026-11-02', now: t0 + 599000 }).recorded === false, '9:59 内不重复记');
    ok(recordPeek(dir, { date: '2026-11-02', now: t0 + 601000 }).recorded === true, '10:01 后重新记');
    ok(recordPeek(dir, { date: '2026-11-01', now: t0 + 602000 }).recorded === true, '不同日期不互相去重');
  }

  console.log('\n## 只读事实');
  {
    const facts = readPeekFacts(dir, { now: t0 + 602000 });
    ok(facts.total === 3, '总数 3');
    ok(facts.today === 2, '今天（11-02）2 次');
    ok(facts.lastAt === t0 + 602000, 'lastAt 是最后一条');
    ok(facts.byDay.find((d) => d.date === '2026-11-02')?.count === 2, 'byDay 按天汇总');
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
