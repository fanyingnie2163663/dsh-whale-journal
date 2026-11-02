// 工具契约的静态守卫：装饰字段必须在工具层保持宽松，否则一个坏 side 会让整条日记写入失败。
// 运行：node scripts/test-tool-contract.mjs
import fs from 'node:fs';

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

const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

console.log('## journal_write 参数');
{
  ok(/doodle:\s*\{\s*type:\s*'json'/.test(src), 'doodle 是宽松 json（坏画不阻断正文）');
  ok(/photos:\s*\{\s*type:\s*'json'/.test(src), 'photos 是宽松 json（坏照片不阻断正文）');
  ok(!/side:\s*\{\s*type:\s*'string',\s*enum/.test(src), 'side 不在工具层用 enum 拒绝');
}

console.log('\n## 工具清单');
{
  for (const name of ['journal_write', 'journal_read', 'journal_search', 'journal_digest', 'journal_audit', 'journal_peek', 'journal_archive']) {
    ok(src.includes(`name: '${name}'`), `${name} 已注册`);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
