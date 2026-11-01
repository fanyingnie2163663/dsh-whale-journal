// 日记接地审计自检：refs 解析、无 refs、失效 refs、重复、数字 token、归档排除。
// 运行：node scripts/test-audit.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditEntries, buildSeqIndex, readTranscriptRange, listTranscriptDays } from '../lib/audit.js';

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-audit-'));
const GROUP = 'group:100000001';
const PRIVATE = 'private:100000002';

function msg(seq, scope, text, sender = '阿宁') {
  return { v: 1, day: '2026-11-01', ts: 1000 + seq, seq, sender, text, scope, isSelf: false };
}

const entries = [
  { id: 'e1', date: '2026-11-01', scope: GROUP, text: '今天群里聊比赛，他说明天还来。伤害 100000 那波笑死。', refs: [1, 2], status: 'active' },
  { id: 'e2', date: '2026-11-01', scope: GROUP, text: '他说要早睡。', refs: [99], status: 'active' },
  { id: 'e3', date: '2026-11-01', scope: GROUP, text: '今天没什么特别的。', refs: [], status: 'active' },
  { id: 'e4', date: '2026-11-01', scope: GROUP, text: '今天群里聊比赛，他说明天还来。伤害 100000 那波笑死。', refs: [3], status: 'active' },
  { id: 'e5', date: '2026-11-01', scope: GROUP, text: '归档的旧日记。', refs: [1], status: 'archived' },
  { id: 'e6', date: '2026-11-01', scope: PRIVATE, text: '私聊里他说了晚安。', refs: [1], status: 'active' }
];

try {
  fs.writeFileSync(
    path.join(dir, '2026-11-01.jsonl'),
    [
      msg(1, GROUP, '明天还来'),
      msg(2, GROUP, '那波伤害 100000 真离谱'),
      msg(3, GROUP, '晚安'),
      msg(1, PRIVATE, '晚安')
    ].map((m) => JSON.stringify(m)).join('\n') + '\n',
    'utf8'
  );

  console.log('## 索引与范围');
  {
    const messages = readTranscriptRange(dir, '2026-11-01', '2026-11-01');
    ok(messages.length === 4, '读出 4 条');
    ok(listTranscriptDays(dir).length === 1, '列出一天');
    const index = buildSeqIndex(messages);
    ok(index.get(GROUP)?.get(2)?.text.includes('100000'), '按 scope 建 seq 索引');
    ok(index.get(PRIVATE)?.has(1), '私聊 seq 独立');
  }

  console.log('\n## 审计');
  {
    const r = auditEntries(entries, { transcriptDir: dir });
    ok(r.summary.entries === 5, '归档条目被排除');
    ok(r.summary.grounded === 3, '有据 3 条（e1/e4/e6）');
    ok(r.summary.noRefs === 1, '无 refs 1 条（e3）');
    ok(r.summary.refsUnresolved === 1, 'refs 失效 1 条（e2）');
    ok(r.summary.refsTotal === 5 && r.summary.refsResolved === 4, 'refs 解析统计');
    ok(r.summary.duplicatePairs === 1, '重复 1 对');
    const e1 = r.rows.find((x) => x.id === 'e1');
    ok(e1.status === 'grounded' && e1.missing.length === 0, 'e1 grounded');
    ok(e1.numeric.includes('100000'), '记录数字 token');
    const e2 = r.rows.find((x) => x.id === 'e2');
    ok(e2.status === 'refs-unresolved' && e2.missing[0] === 99, '失效 refs 记下缺失 seq');
    const e3 = r.rows.find((x) => x.id === 'e3');
    ok(e3.status === 'no-refs', '无 refs 状态');
  }

  console.log('\n## 无归档时');
  {
    const r = auditEntries(entries, { transcriptDir: '' });
    ok(r.summary.hasTranscript === false, '标记没有 transcript');
    ok(r.summary.grounded === 0, '没有归档时不算有据');
    ok(r.summary.refsUnresolved === 4, '有 refs 的全部失效');
  }

  console.log('\n## 过滤');
  {
    const r = auditEntries(entries, { transcriptDir: dir, scope: PRIVATE });
    ok(r.summary.entries === 1 && r.rows[0].id === 'e6', '按 scope 过滤');
    const r2 = auditEntries(entries, { transcriptDir: dir, from: '2026-11-02' });
    ok(r2.summary.entries === 0, '按日期过滤');
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
