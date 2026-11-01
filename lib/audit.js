// 日记接地审计（确定性部分）：检查每条日记的 refs 能不能在消息归档里找到，
// 顺带算重复、数字 token、长度分布。
//
// 它**不判断语义真假**——「他今天很累」对不对，只有拿聊天记录逐句对账（LLM 周检）才知道。
// 这里先回答一个更基础的问题：这条日记有没有留下可回查的证据。

import fs from 'node:fs';
import path from 'node:path';
import { readTranscriptDay } from './digest.js';
import { isDateKey } from './store.js';

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const NUMERIC_RE = /(?<!\d)(\d{5,11})(?!\d)/g;

export function listTranscriptDays(dir) {
  let names;
  try {
    names = fs.readdirSync(String(dir));
  } catch {
    return [];
  }
  return names.map((n) => DAY_FILE_RE.exec(n)?.[1]).filter(Boolean).sort();
}

export function readTranscriptRange(dir, fromDay, toDay) {
  const days = listTranscriptDays(dir).filter(
    (day) => (!fromDay || day >= fromDay) && (!toDay || day <= toDay)
  );
  return days.flatMap((day) => readTranscriptDay(dir, day));
}

/** 按 seq 建索引（QQ 的 seq 是会话内递增；私聊/群各自独立，所以索引按 scope 分开）。 */
export function buildSeqIndex(messages) {
  const byScope = new Map();
  for (const msg of messages) {
    const scope = String(msg.scope ?? '');
    if (!byScope.has(scope)) byScope.set(scope, new Map());
    const seq = Number(msg.seq);
    if (Number.isSafeInteger(seq)) byScope.get(scope).set(seq, msg);
  }
  return byScope;
}

function bigrams(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * 审计一组日记。
 * entries 为 store.loadEntries() 的形状；transcriptDir 为空则只做重复/数字/长度检查。
 */
export function auditEntries(entries = [], {
  transcriptDir = '',
  from = '',
  to = '',
  scope = '',
  duplicateThreshold = 0.8
} = {}) {
  const list = entries.filter((e) => {
    if (!e || e.status === 'archived') return false;
    if (scope && e.scope !== scope) return false;
    if (from && (!isDateKey(e.date) || e.date < from)) return false;
    if (to && (!isDateKey(e.date) || e.date > to)) return false;
    return true;
  });

  const messages = transcriptDir
    ? readTranscriptRange(transcriptDir, from || '0000-00-00', to || '9999-99-99')
    : [];
  const index = buildSeqIndex(messages);

  const rows = [];
  let refsTotal = 0;
  let refsResolved = 0;
  for (const entry of list) {
    const refs = Array.isArray(entry.refs) ? entry.refs.map(Number).filter(Number.isSafeInteger) : [];
    const scopedIndex = index.get(String(entry.scope)) ?? new Map();
    const resolved = refs.filter((seq) => scopedIndex.has(seq));
    const missing = refs.filter((seq) => !scopedIndex.has(seq));
    refsTotal += refs.length;
    refsResolved += resolved.length;
    const numeric = [...String(entry.text ?? '').matchAll(NUMERIC_RE)].map((m) => m[1]);
    rows.push({
      id: entry.id,
      date: entry.date,
      scope: entry.scope,
      chars: String(entry.text ?? '').length,
      refs: refs.length,
      resolved: resolved.length,
      missing,
      numeric,
      status: refs.length === 0 ? 'no-refs' : resolved.length === 0 ? 'refs-unresolved' : 'grounded'
    });
  }

  const duplicates = [];
  const textById = new Map(list.map((e) => [String(e.id), String(e.text ?? '')]));
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (rows[i].scope !== rows[j].scope) continue;
      const sim = jaccard(bigrams(textById.get(rows[i].id)), bigrams(textById.get(rows[j].id)));
      if (sim >= duplicateThreshold) {
        duplicates.push({ a: rows[i].id, b: rows[j].id, similarity: Number(sim.toFixed(3)) });
      }
    }
  }

  const grounded = rows.filter((r) => r.status === 'grounded').length;
  const noRefs = rows.filter((r) => r.status === 'no-refs').length;
  const unresolved = rows.filter((r) => r.status === 'refs-unresolved').length;
  const avgChars = rows.length ? Math.round(rows.reduce((n, r) => n + r.chars, 0) / rows.length) : 0;
  return {
    summary: {
      entries: rows.length,
      grounded,
      noRefs,
      refsUnresolved: unresolved,
      refsTotal,
      refsResolved,
      duplicatePairs: duplicates.length,
      avgChars,
      hasTranscript: Boolean(transcriptDir),
      note: '这里只验证 refs 能否回查；语义真假要周检拿聊天记录逐句对账。'
    },
    rows,
    duplicates
  };
}
