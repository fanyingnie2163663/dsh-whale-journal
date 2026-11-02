// 偷看记录：只追加，不改日记；同一页 10 分钟内重复打开不重复计数。
// 这里只提供事实（次数 / 按天 / 上次时间），怎么反应由聊天里的 agent 决定。

import fs from 'node:fs';
import path from 'node:path';
import { dayKey, isDateKey, normalizeScope, resolveJournalDir } from './store.js';

export const PEEK_DEDUPE_MS = 10 * 60 * 1000;

export function peekPath(dir) {
  return path.join(resolveJournalDir(dir), 'peek.jsonl');
}

function readPeeks(dir) {
  let raw;
  try {
    raw = fs.readFileSync(peekPath(dir), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object' && isDateKey(rec.date)) out.push(rec);
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

export function recordPeek(dir, { date, scope = 'all', source = 'web', now = Date.now() } = {}) {
  if (!isDateKey(date)) throw new Error('date 必须是 YYYY-MM-DD');
  const normalizedScope = normalizeScope(scope);

  let last = null;
  for (const rec of readPeeks(dir)) {
    if (rec.date === date && rec.scope === normalizedScope) last = rec;
  }
  if (last && now - Number(last.ts) < PEEK_DEDUPE_MS) {
    return { recorded: false };
  }

  const record = { v: 1, ts: now, date, scope: normalizedScope, source: String(source) };
  const file = peekPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');

  // 软上限：超过 1MB 时只留最近 2000 条，避免异常来源把文件写爆。
  try {
    if (fs.statSync(file).size > 1024 * 1024) {
      const kept = readPeeks(dir).slice(-2000);
      fs.writeFileSync(file, kept.map((rec) => JSON.stringify(rec)).join('\n') + (kept.length ? '\n' : ''));
    }
  } catch {
    // 清理失败不影响这次记录
  }

  return { recorded: true, ts: now };
}

export function readPeekFacts(dir, { now = Date.now() } = {}) {
  const all = readPeeks(dir);
  const byDay = new Map();
  let lastAt = 0;

  for (const rec of all) {
    const count = byDay.get(rec.date) ?? 0;
    byDay.set(rec.date, count + 1);
    const ts = Number(rec.ts);
    if (Number.isFinite(ts) && ts > lastAt) lastAt = ts;
  }

  const today = dayKey(now);
  const since = dayKey(now - 6 * 24 * 3600 * 1000);
  return {
    total: all.length,
    today: byDay.get(today) ?? 0,
    lastAt,
    byDay: [...byDay.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => b.date.localeCompare(a.date)),
    last7: all.filter((rec) => rec.date >= since).length
  };
}
