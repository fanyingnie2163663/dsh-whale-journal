// 简笔画 SVG 自检：白名单、脚本/事件/href/style/url 拒绝、长度与元数据校验。
// 运行：node scripts/test-sanitize.mjs
import { sanitizeDoodle } from '../lib/sanitize.js';

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

console.log('## 合法输入');
{
  const good = sanitizeDoodle({ svg: '<path d="M10 10 L20 20"/>', anchor: '晚霞', side: 'right' });
  ok(good.ok === true && good.value.side === 'right', '合法 SVG 通过');
  ok(
    sanitizeDoodle({ svg: '<circle cx="10" cy="10" r="4" transform="rotate(10)"/>', anchor: 'a' }).ok === true,
    '允许 circle + transform'
  );
}

console.log('\n## 拒绝危险内容');
{
  ok(sanitizeDoodle({ svg: '<script>alert(1)</script>', anchor: 'a' }).ok === false, '拒绝 script');
  ok(sanitizeDoodle({ svg: '<path d="M0 0" onclick="x()"/>', anchor: 'a' }).ok === false, '拒绝事件属性');
  ok(sanitizeDoodle({ svg: '<path d="M0 0" href="javascript:1"/>', anchor: 'a' }).ok === false, '拒绝 href');
  ok(sanitizeDoodle({ svg: '<path d="M0 0" style="x"/>', anchor: 'a' }).ok === false, '拒绝 style');
  ok(
    sanitizeDoodle({ svg: '<circle cx="1" cy="1" r="1" fill="url(#x)"/>', anchor: 'a' }).ok === false,
    '拒绝 url() 填充'
  );
  ok(sanitizeDoodle({ svg: '<rect width="1" height="1"/>', anchor: 'a' }).ok === false, '拒绝未知标签');
}

console.log('\n## 边界');
{
  ok(
    sanitizeDoodle({ svg: '<path d="' + 'M0 0 '.repeat(1600) + '"/>', anchor: 'a' }).ok === false,
    '拒绝超长'
  );
  ok(sanitizeDoodle({ svg: '<path d="M0 0"/>', anchor: '' }).ok === false, '拒绝空 anchor');
  ok(sanitizeDoodle({ svg: '<path d="M0 0"/>', anchor: 'a', side: 'top' }).ok === false, '拒绝坏 side');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
