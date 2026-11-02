// 工具输出格式化自检：画/照片只出摘要，绝不把整段 SVG 塞回上下文。
// 运行：node scripts/test-format.mjs
import { entryLine, artSummary } from '../lib/format.js';

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

console.log('## 摘要');
{
  const line = entryLine({
    date: '2026-11-02',
    scope: 'group:100000001',
    text: '今天画了晚霞。',
    doodle: { svg: '<path d="M0 0"/>', anchor: '画了晚霞', side: 'right' },
    photos: [{ file: 'media/2026-11-02/a.png', caption: '她发的' }]
  });
  ok(line.includes('简笔画（锚点「画了晚霞」）'), '简笔画摘要');
  ok(line.includes('照片 1 张（她发的）'), '照片摘要');
  ok(!line.includes('<path'), '不返回 SVG');
}

console.log('\n## 无画无照片');
{
  ok(artSummary({ text: '只有字' }) === '', '没有画/照片时不加尾巴');
  const line = entryLine({ date: '2026-11-02', scope: 'global', text: '只有字' });
  ok(!line.includes('〔'), '普通条目保持干净');
}

console.log('\n## 长 caption 截断');
{
  const line = entryLine({
    date: '2026-11-02',
    scope: 'global',
    text: 'x',
    photos: [{ caption: '很'.repeat(50) }, { caption: '二' }]
  });
  ok(line.includes('照片 2 张'), '多张计数');
  ok(line.length < 200, '摘要不膨胀');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
