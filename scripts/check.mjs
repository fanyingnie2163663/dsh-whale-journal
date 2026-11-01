#!/usr/bin/env node
// 插件静态检查包装器：自动在 $DSH_HOME/profiles/*/node_modules 里找
// dsh-plugin-guide 自带的 CLI，再对本仓库跑 `check`。
//
// 运行：
//   npm run check                  # 等价于 node scripts/check.mjs
//   node scripts/check.mjs --json  # 额外参数原样透传给 dsh-plugin-dev
//
// 覆盖路径（按顺序）：
//   DSH_PLUGIN_GUIDE_BIN           显式指向 dsh-plugin-dev.js
//   DSH_PROFILE=desktop            只查指定 profile
//   <repo>/node_modules/...        仓库自己装了 dsh-plugin-guide 时
//   $DSH_HOME/profiles/<name>/...  常规 profile（desktop、web 优先）
//   pnpm 的 .pnpm 虚拟目录布局也认
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profilesDir = path.join(dshHome, 'profiles');
const relativeBin = path.join('node_modules', 'dsh-plugin-guide', 'bin', 'dsh-plugin-dev.js');

const candidates = [];
if (process.env.DSH_PLUGIN_GUIDE_BIN) candidates.push(process.env.DSH_PLUGIN_GUIDE_BIN);
candidates.push(path.join(root, relativeBin));

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

const profileNames = process.env.DSH_PROFILE
  ? [process.env.DSH_PROFILE]
  : listDirs(profilesDir).sort((a, b) => {
      const rank = (n) => (n === 'desktop' ? 0 : n === 'web' ? 1 : 2);
      return rank(a) - rank(b) || a.localeCompare(b);
    });

for (const name of profileNames) {
  if (!name || name.startsWith('.') || name === 'node_modules' || name === '__temp__') continue;
  const profile = path.join(profilesDir, name);
  candidates.push(path.join(profile, relativeBin));
  const pnpmDir = path.join(profile, 'node_modules', '.pnpm');
  for (const entry of listDirs(pnpmDir)) {
    if (!entry.startsWith('dsh-plugin-guide@')) continue;
    candidates.push(path.join(pnpmDir, entry, 'node_modules', 'dsh-plugin-guide', 'bin', 'dsh-plugin-dev.js'));
  }
}

const bin = candidates.find((p) => p && fs.existsSync(p));

if (!bin) {
  console.error('找不到 dsh-plugin-dev.js。');
  console.error(`已查找：${dshHome}/profiles/*/node_modules/dsh-plugin-guide/`);
  console.error('修复：在任一 profile 安装 dsh-plugin-guide，或设置 DSH_PLUGIN_GUIDE_BIN 指向该文件。');
  process.exit(1);
}

const result = spawnSync(process.execPath, [bin, 'check', '--cwd', root, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root
});

if (result.error) {
  console.error(`启动检查失败：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
