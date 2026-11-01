// 日记素材（digest）自检：读归档、scope 过滤、带 seq、预算裁剪、空天/缺配置。
// 运行：node scripts/test-digest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTranscriptDay, formatDigest, buildDigest } from '../lib/digest.js';

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-digest-'));
const GROUP = 'group:100000001';
const PRIVATE = 'private:100000002';
const base = new Date(2026, 10, 1, 22, 0, 0).getTime();

function line(seq, sender, text, extra = {}) {
  return JSON.stringify({
    v: 1,
    day: '2026-11-01',
    ts: base + seq * 60000,
    at: new Date(base + seq * 60000).toISOString(),
    seq,
    messageId: `m${seq}`,
    sender,
    userId: String(10000 + seq),
    text,
    isSelf: false,
    scope: GROUP,
    ...extra
  });
}

try {
  fs.writeFileSync(
    path.join(dir, '2026-11-01.jsonl'),
    [
      line(1, '阿宁', '今天好累，不想动'),
      line(2, '小克', '摸摸，早点睡'),
      line(3, '我', '[图片]', { isSelf: true, userId: '' }),
      line(4, '阿宁', '私聊说晚安', { scope: PRIVATE }),
      '{bad json}'
    ].join('\n') + '\n',
    'utf8'
  );

  console.log('## 读归档');
  {
    const day = readTranscriptDay(dir, '2026-11-01');
    ok(day.length === 4, '坏行跳过，读回 4 条');
    ok(readTranscriptDay(dir, '2026-10-31').length === 0, '不存在的一天返回空');
  }

  console.log('\n## 格式化');
  {
    const messages = readTranscriptDay(dir, '2026-11-01').filter((m) => m.scope === GROUP);
    const entries = [{ date: '2026-10-31', text: '昨天我说想早点睡。' }];
    const d = formatDigest({ date: '2026-11-01', scope: GROUP, messages, entries });
    ok(d.stats.messages === 3, '统计消息数');
    ok(d.stats.participants === 3, '统计发言者（含我）');
    ok(d.text.includes('[1]') && d.text.includes('阿宁'), '带 seq 和名字');
    ok(d.text.includes('【你最近写的】') && d.text.includes('昨天我说想早点睡'), '带最近日记');
    ok(d.text.includes('journal_write') && d.text.includes('refs'), '带写作规则');
    ok(d.text.indexOf('[1]') < d.text.indexOf('[2]'), '按 seq 排序');
    ok(!d.text.includes('私聊说晚安'), '不串 scope');
  }

  console.log('\n## 预算裁剪');
  {
    const messages = readTranscriptDay(dir, '2026-11-01').filter((m) => m.scope === GROUP);
    const one = formatDigest({ date: '2026-11-01', scope: GROUP, messages, maxMessages: 1 });
    ok(one.stats.included === 1 && one.text.includes('[3]'), 'maxMessages 只留最新一条');
    const tight = formatDigest({ date: '2026-11-01', scope: GROUP, messages, maxChars: 260 });
    ok(tight.text.length <= 900, 'maxChars 生效（允许规则本身超出一点）');
    ok(tight.stats.omitted > 0, '记录省略条数');
  }

  console.log('\n## 构建（读文件）');
  {
    const d = buildDigest({ transcriptDir: dir, scope: GROUP, date: '2026-11-01', entries: [] });
    ok(!d.empty && d.text.includes('今天好累'), 'buildDigest 读出当天');
    const empty = buildDigest({ transcriptDir: dir, scope: GROUP, date: '2026-10-30' });
    ok(empty.empty === true && typeof empty.hint === 'string', '没有消息时 empty=true + hint');
    let threw = false;
    try { buildDigest({ transcriptDir: '', scope: GROUP }); } catch { threw = true; }
    ok(threw, '未配置 transcriptDir 时抛错');
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
