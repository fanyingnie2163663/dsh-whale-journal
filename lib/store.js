// 日记存储：一天一条/几条，按 scope 分开；JSONL 追加 + 按 id 折叠（后写覆盖前写）。
//
// 为什么不是数据库：一天最多几条、一年几百条，读全量也就几百 KB。
// 追加写 + 折叠能让「编辑/归档」变成追加一条同 id 的新记录，不破坏历史。
//
// 边界：
//  - 只写本地 DSH_HOME，不外发；
//  - 单条正文有上限（默认 600 字），超了截断并标 truncated；
//  - 每个 scope 每天有条数上限，防止 agent 刷屏；
//  - 读坏行跳过，不让一条坏数据毁掉整本日记。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { sanitizeDoodle } from './sanitize.js';

export const ENTRY_VERSION = 1;
export const DEFAULT_MAX_CHARS = 600;
export const DEFAULT_MAX_PER_DAY = 3;
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';
export const DEFAULT_RETENTION_DAYS = 365;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SCOPE_RE = /^[a-z][a-z0-9:_-]{1,79}$/i;

export function resolveJournalDir(dir) {
  if (dir && String(dir).trim()) return path.resolve(String(dir).trim());
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'journal');
}

export function entriesPath(dir) {
  return path.join(resolveJournalDir(dir), 'entries.jsonl');
}

/** 本地时区的 YYYY-MM-DD（默认 Asia/Shanghai，和 QQ 消息时间一致）。 */
export function dayKey(ts = Date.now(), timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(ts));
}

export function isDateKey(value) {
  const text = String(value ?? '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function normalizeScope(scope) {
  const value = String(scope ?? '').trim();
  if (!SCOPE_RE.test(value)) {
    throw new Error('scope 不合法：用 group:100000001 / private:100000002 / global 这类形式');
  }
  return value;
}

export function normalizeText(text, maxChars = DEFAULT_MAX_CHARS) {
  const value = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (!value) throw new Error('日记正文不能为空');
  const truncated = value.length > maxChars;
  return { text: truncated ? value.slice(0, maxChars) : value, truncated };
}

function normalizeRefs(refs) {
  if (!Array.isArray(refs)) return [];
  const out = [];
  const seen = new Set();
  for (const value of refs) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= 50) break;
  }
  return out;
}

export const MAX_PHOTOS = 3;
const PHOTO_FILE_RE = /^media\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{12}\.(jpg|png|webp)$/;
const ART_SIDES = ['left', 'right', 'inline'];

/** store 是第二道边界：任何调用方写进来的 SVG 都必须过净化，而不只是 writeJournal。 */
export function normalizeDoodleMeta(input) {
  const result = sanitizeDoodle(input);
  if (!result.ok) throw new Error(`doodle 非法：${result.reason}`);
  return result.value;
}

/** 校验已经导入到 media/ 的照片引用。 */
export function normalizePhotoMeta(input) {
  if (!input || typeof input !== 'object') throw new Error('photo 必须是对象');
  const file = String(input.file ?? '').trim();
  if (!PHOTO_FILE_RE.test(file)) throw new Error('photo.file 非法');
  const anchor = String(input.anchor ?? '').trim();
  if (!anchor || anchor.length > 80) throw new Error('photo.anchor 需要 1–80 字');
  const side = input.side === undefined ? 'right' : String(input.side);
  if (!ART_SIDES.includes(side)) throw new Error('photo.side 只能是 left/right/inline');
  const caption = String(input.caption ?? '').trim().slice(0, 40);
  return { file, anchor, side, caption };
}

export function normalizePhotos(input) {
  if (!Array.isArray(input)) throw new Error('photos 必须是数组');
  if (input.length > MAX_PHOTOS) throw new Error(`photos 最多 ${MAX_PHOTOS} 张`);
  return input.map(normalizePhotoMeta);
}

/**
 * 归一化写入参数。date 缺省为今天；mood 截断到 20 字；refs 去重、上限 50。
 */
export function normalizeEntryInput(input = {}, {
  timeZone = DEFAULT_TIMEZONE,
  maxChars = DEFAULT_MAX_CHARS,
  now = Date.now()
} = {}) {
  const date = input.date ? String(input.date).trim() : dayKey(now, timeZone);
  if (!isDateKey(date)) throw new Error('date 必须是 YYYY-MM-DD');
  const scope = normalizeScope(input.scope);
  const { text, truncated } = normalizeText(input.text, maxChars);
  const mood = String(input.mood ?? '').trim().slice(0, 20);
  const doodle = input.doodle === undefined || input.doodle === null ? null : normalizeDoodleMeta(input.doodle);
  const photos = input.photos === undefined ? [] : normalizePhotos(input.photos);
  return {
    date,
    scope,
    text,
    truncated,
    mood,
    refs: normalizeRefs(input.refs),
    ...(doodle ? { doodle } : {}),
    ...(photos.length ? { photos } : {})
  };
}

/** 读全量并按 id 折叠；坏行跳过。 */
export function loadEntries(dir) {
  const file = entriesPath(dir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const byId = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object' && rec.id) byId.set(String(rec.id), rec);
    } catch {
      // 坏行跳过
    }
  }
  return [...byId.values()].sort(
    (a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0)
  );
}

function appendRecord(dir, record) {
  const file = entriesPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * 写一条日记。超过当天条数上限会抛错（让 agent 先归档旧条目，而不是无限刷）。
 */
export function writeEntry(dir, input = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const normalized = normalizeEntryInput(input, { ...opts, now });
  const all = loadEntries(dir);
  const sameDay = all.filter(
    (e) => e.date === normalized.date && e.scope === normalized.scope && e.status !== 'archived'
  );
  const maxPerDay = opts.maxEntriesPerDay ?? DEFAULT_MAX_PER_DAY;
  if (sameDay.length >= maxPerDay) {
    throw new Error(`今天在 ${normalized.scope} 已经写了 ${sameDay.length} 条（上限 ${maxPerDay}），先归档一条再写`);
  }
  const entry = {
    v: ENTRY_VERSION,
    id: `j_${randomUUID()}`,
    ...normalized,
    source: String(opts.source ?? 'agent'),
    status: 'active',
    createdAt: now,
    updatedAt: now
  };
  appendRecord(dir, entry);
  return { entry, remaining: Math.max(0, maxPerDay - sameDay.length - 1) };
}

/** 归档（软删除）：追加一条同 id 的新记录，历史保留。 */
export function archiveEntry(dir, id, { reason = '', now = Date.now() } = {}) {
  const entry = loadEntries(dir).find((e) => String(e.id) === String(id));
  if (!entry) throw new Error(`找不到日记 ${id}`);
  const next = { ...entry, status: 'archived', archivedAt: now, archiveReason: String(reason).slice(0, 200), updatedAt: now };
  appendRecord(dir, next);
  return next;
}

export function listEntries(dir, { scope = '', date = '', includeArchived = false, limit = 20 } = {}) {
  const max = Math.max(1, Math.min(100, Number(limit) || 20));
  return loadEntries(dir)
    .filter((e) => (includeArchived ? true : e.status !== 'archived'))
    .filter((e) => (scope ? e.scope === scope : true))
    .filter((e) => (date ? e.date === date : true))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
    .slice(0, max);
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) return count;
    count += 1;
    from = idx + needle.length;
  }
}

export function searchEntries(dir, query, { scope = '', limit = 10 } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) throw new Error('query 不能为空');
  const max = Math.max(1, Math.min(50, Number(limit) || 10));
  const scored = [];
  for (const entry of loadEntries(dir)) {
    if (entry.status === 'archived') continue;
    if (scope && entry.scope !== scope) continue;
    const text = String(entry.text ?? '').toLowerCase();
    const mood = String(entry.mood ?? '').toLowerCase();
    const score = countOccurrences(text, q) * 2 + countOccurrences(mood, q);
    if (score > 0) scored.push({ entry, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || String(b.entry.date).localeCompare(String(a.entry.date)))
    .slice(0, max)
    .map((x) => ({ ...x.entry, score: x.score }));
}

export function journalStats(dir) {
  const all = loadEntries(dir);
  const scopes = {};
  let active = 0;
  let archived = 0;
  for (const entry of all) {
    scopes[entry.scope] = (scopes[entry.scope] ?? 0) + 1;
    if (entry.status === 'archived') archived += 1;
    else active += 1;
  }
  const dates = all.map((e) => e.date).filter(isDateKey).sort();
  return {
    total: all.length,
    active,
    archived,
    scopes,
    firstDate: dates[0] ?? '',
    lastDate: dates[dates.length - 1] ?? ''
  };
}

/** 保留期清理：只删归档且超过 retentionDays 的条目；返回剩余条数。 */
export function pruneArchived(dir, { retentionDays = DEFAULT_RETENTION_DAYS, now = Date.now() } = {}) {
  const cutoff = now - Math.max(1, retentionDays) * 24 * 3600 * 1000;
  const all = loadEntries(dir);
  const keep = all.filter((e) => !(e.status === 'archived' && Number(e.updatedAt) < cutoff));
  if (keep.length === all.length) return { removed: 0, remaining: all.length };
  const file = entriesPath(dir);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, file);
  return { removed: all.length - keep.length, remaining: keep.length };
}
