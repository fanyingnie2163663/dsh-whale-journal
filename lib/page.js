// 页面数据：把 entries.jsonl 折成「按天的目录」和「某一天的整页」。
// 纯函数、只读，不碰 HTTP 与渲染。

import { isDateKey, loadEntries } from './store.js';

/**
 * 按天汇总未归档的日记，日期倒序。
 * @returns {Array<{ date: string, count: number, scopes: string[] }>}
 */
export function listDays(dir, { scope = '', limit = 60 } = {}) {
  const max = Math.max(1, Math.min(365, Number(limit) || 60));
  const byDate = new Map();

  for (const entry of loadEntries(dir)) {
    if (entry.status === 'archived') continue;
    if (!isDateKey(entry.date)) continue;
    if (scope && entry.scope !== scope) continue;

    let day = byDate.get(entry.date);
    if (!day) {
      day = { date: entry.date, count: 0, scopes: new Set() };
      byDate.set(entry.date, day);
    }
    day.count += 1;
    day.scopes.add(entry.scope);
  }

  return [...byDate.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, max)
    .map((day) => ({ date: day.date, count: day.count, scopes: [...day.scopes].sort() }));
}

/**
 * 取某一天（可再按 scope 过滤）的条目，按写入时间升序。
 */
export function buildDay(dir, { date, scope = '' } = {}) {
  if (!isDateKey(date)) throw new Error('date 必须是 YYYY-MM-DD');

  const entries = loadEntries(dir)
    .filter((entry) => entry.status !== 'archived' && entry.date === date && (!scope || entry.scope === scope))
    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));

  return { date, scope, entries };
}
