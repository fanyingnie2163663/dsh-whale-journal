// 照片导入：把当天被选中的图片复制进 journal/media/<date>/，内容寻址命名。
// 只负责存储与路径安全，不判断「哪张照片值得留」——那是写日记的 AI 的事。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDateKey, resolveJournalDir } from './store.js';

export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const PHOTO_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

const EXT_ALIAS = { '.jpg': 'jpg', '.jpeg': 'jpg', '.png': 'png', '.webp': 'webp' };

export function importPhoto(dir, srcPath, { date } = {}) {
  if (!isDateKey(date)) throw new Error('date 必须是 YYYY-MM-DD');

  const src = path.resolve(String(srcPath ?? ''));
  const ext = EXT_ALIAS[path.extname(src).toLowerCase()];
  if (!ext) throw new Error('照片只支持 jpg / png / webp');

  const stat = fs.statSync(src);
  if (!stat.isFile()) throw new Error('照片必须是普通文件');
  if (stat.size > PHOTO_MAX_BYTES) throw new Error('照片超过 8MiB');

  const buf = fs.readFileSync(src);
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12);
  const file = path.posix.join('media', date, `${hash}.${ext}`);
  const dest = path.join(resolveJournalDir(dir), file);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
  return { file, bytes: buf.length };
}

export function photoFile(dir, file) {
  const journalRoot = path.resolve(resolveJournalDir(dir));
  const mediaRoot = path.join(journalRoot, 'media');
  const abs = path.resolve(journalRoot, String(file ?? ''));

  const lexical = path.relative(mediaRoot, abs);
  if (!lexical || lexical.startsWith('..') || path.isAbsolute(lexical)) {
    throw new Error('照片路径越界');
  }

  // 词法检查挡不住 junction/symlink：解析真实路径后必须仍在真实 media 根内。
  let realRoot;
  let realFile;
  try {
    realRoot = fs.realpathSync(mediaRoot);
    realFile = fs.realpathSync(abs);
  } catch {
    throw new Error('照片不存在');
  }
  const realRelative = path.relative(realRoot, realFile);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error('照片路径越界');
  }

  const stat = fs.lstatSync(realFile);
  if (!stat.isFile()) throw new Error('照片不是普通文件');
  return realFile;
}
