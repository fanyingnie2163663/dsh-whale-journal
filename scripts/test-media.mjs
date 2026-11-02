// 照片导入自检：落盘位置、内容去重、扩展名/大小限制、路径穿越。
// 运行：node scripts/test-media.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importPhoto, photoFile } from '../lib/media.js';

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
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-media-'));

try {
  const src = path.join(dir, 'a.jpg');
  fs.writeFileSync(src, Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0, 0, 0]));

  const one = importPhoto(dir, src, { date: '2026-11-02' });
  ok(/^media\/2026-11-02\/[a-f0-9]{12}\.jpg$/.test(one.file), '导入返回 media 相对路径');
  ok(fs.existsSync(photoFile(dir, one.file)), '文件真的落盘');
  ok(importPhoto(dir, src, { date: '2026-11-02' }).file === one.file, '同样内容复用同一文件');

  console.log('\n## 拒绝');
  {
    ok(throws(() => importPhoto(dir, path.join(dir, 'x.txt'), { date: '2026-11-02' })), '拒绝未知扩展名');
    ok(throws(() => importPhoto(dir, path.join(dir, 'nope.jpg'), { date: '2026-11-02' })), '拒绝不存在的文件');

    const big = path.join(dir, 'big.jpg');
    fs.writeFileSync(big, Buffer.alloc(8 * 1024 * 1024 + 1));
    ok(throws(() => importPhoto(dir, big, { date: '2026-11-02' })), '拒绝超过 8MiB');
    ok(throws(() => photoFile(dir, 'media/../../.credentials.yaml')), '拒绝路径穿越');

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
    if (linked) ok(throws(() => photoFile(dir, 'media/2026-11-02/link/secret.txt')), '拒绝 junction 越界');
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
