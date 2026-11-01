// 写入编排自检：净化简笔画、导入照片、坏素材只丢弃不阻断正文。
// 运行：node scripts/test-write.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJournal } from '../lib/write.js';

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-write-'));
const cfg = { dir, timezone: 'Asia/Shanghai', maxEntryChars: 600, maxEntriesPerDay: 3 };

try {
  const src = path.join(dir, 'p.jpg');
  fs.writeFileSync(src, Buffer.from([0xff, 0xd8, 0xff, 0, 0]));

  const r1 = writeJournal(cfg, {
    text: '今天画了晚霞。',
    scope: 'group:100000001',
    date: '2026-11-02',
    doodle: { svg: '<path d="M0 0 L9 9"/>', anchor: '晚霞', side: 'right' },
    photos: [{ path: src, anchor: '晚霞', side: 'right', caption: '她发的' }]
  }, { now: 1793592000000 });
  ok(r1.entry?.doodle?.anchor === '晚霞', '写入成功并带 doodle');
  ok(
    /^media\/2026-11-02\/[a-f0-9]{12}\.jpg$/.test(r1.entry?.photos?.[0]?.file ?? ''),
    '照片被导入'
  );

  const r2 = writeJournal(cfg, {
    text: '第二篇。',
    scope: 'group:100000001',
    date: '2026-11-02',
    doodle: { svg: '<script>x</script>', anchor: '晚霞' }
  }, { now: 1793592010000 });
  ok(r2.entry && r2.dropped.doodle && !r2.entry.doodle, '坏 doodle 被丢弃但正文写入');

  const r3 = writeJournal(cfg, {
    text: '第三篇。',
    scope: 'group:100000001',
    date: '2026-11-02',
    photos: [{ path: path.join(dir, 'nope.jpg'), anchor: 'x' }]
  }, { now: 1793592020000 });
  ok(r3.entry && r3.dropped.photos.length === 1 && !r3.entry.photos, '坏照片被丢弃');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
