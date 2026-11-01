// 日记素材（digest）：把某天某个 scope 的消息整理成一段「可以直接拿去写日记」的上下文。
//
// 它不调用模型、不写日记，只做三件事：
//  1) 读桥接按天归档的 transcript（JSONL）；
//  2) 过滤 scope、按 seq/时间排序、压缩成带 seq 的短行；
//  3) 附上写作规则与最近几篇日记，让写的人（agent）有连续性、有边界。
//
// 为什么要带 seq：日记正文里的每句「他说…」都能回指到具体消息，周检才能对账。

import fs from 'node:fs';
import path from 'node:path';
import { dayKey, DEFAULT_TIMEZONE } from './store.js';

const MAX_MESSAGE_CHARS = 300;

export function readTranscriptDay(dir, day) {
  const file = path.join(String(dir), `${day}.jsonl`);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object') out.push(rec);
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

function clean(value, max = MAX_MESSAGE_CHARS) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, max);
}

function timeOf(msg, timeZone) {
  const ts = Number(msg.ts ?? msg.time);
  if (!Number.isFinite(ts)) return '';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(ts));
  } catch {
    return '';
  }
}

function sortMessages(messages) {
  return [...messages].sort((a, b) => {
    const sa = Number(a.seq);
    const sb = Number(b.seq);
    if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb;
    return (Number(a.ts) || 0) - (Number(b.ts) || 0);
  });
}

/**
 * 纯格式化：给定消息与最近日记，产出 digest 文本。
 * 超预算时从最旧的消息开始丢，并注明省略条数。
 */
export function formatDigest({
  date,
  scope,
  messages = [],
  entries = [],
  maxMessages = 200,
  maxChars = 12000,
  timeZone = DEFAULT_TIMEZONE
} = {}) {
  const limit = Math.max(1, Math.min(500, Number(maxMessages) || 200));
  const picked = sortMessages(messages).slice(-limit);
  const omittedForCount = Math.max(0, messages.length - picked.length);
  const participants = new Set();
  for (const m of picked) {
    const name = m.isSelf ? '我' : clean(m.sender ?? m.userId ?? '未知', 40);
    if (name) participants.add(name);
  }

  const header = [
    `【${date} · ${scope}】共 ${messages.length} 条消息，${participants.size} 位发言者。`,
    '（[数字] 是消息 seq；写日记时把引用的 seq 填进 refs。）'
  ];
  if (omittedForCount) header.push(`（更早的 ${omittedForCount} 条已省略）`);

  const previous = entries.length
    ? ['', '【你最近写的】', ...entries.slice(0, 3).map((e) => `[${e.date}] ${clean(e.text, 200)}`)]
    : [];

  const rules = [
    '',
    '【写日记的规则】',
    '- 3–5 句，第一人称，口语；不要总结全部对话。',
    '- 只写真发生过的事，可以引用原话片段；不要编造。',
    '- 不要写 QQ 号、隐私、真名（用称呼）。',
    '- 结尾可选一句「明天想…」。',
    '- 写完调用 journal_write，refs 填你引用的消息 seq。'
  ];

  const prefix = [...header, ...previous, ...rules, '', '【聊天记录】'];
  const suffix = [];
  const lines = [];
  for (const m of picked) {
    const name = m.isSelf ? '我' : clean(m.sender ?? m.userId ?? '未知', 40);
    const t = timeOf(m, timeZone);
    const seq = Number.isFinite(Number(m.seq)) ? Number(m.seq) : '';
    lines.push(`[${seq}] ${t} ${name}：${clean(m.text ?? m.plain ?? '')}`);
  }

  let text = [...prefix, ...lines, ...suffix].join('\n');
  let dropped = 0;
  while (text.length > maxChars && lines.length > 0) {
    lines.shift();
    dropped += 1;
    text = [...prefix, `（更早的 ${dropped + omittedForCount} 条已省略）`, ...lines, ...suffix].join('\n');
  }
  return {
    text,
    stats: {
      messages: messages.length,
      included: lines.length,
      participants: participants.size,
      chars: text.length,
      omitted: dropped + omittedForCount
    }
  };
}

/**
 * 读文件 + 格式化。transcriptDir 为空时抛错（配置问题要显式暴露，不静默返回空）。
 */
export function buildDigest({
  transcriptDir,
  scope,
  date = '',
  entries = [],
  maxMessages = 200,
  maxChars = 12000,
  timeZone = DEFAULT_TIMEZONE,
  now = Date.now()
} = {}) {
  if (!transcriptDir) throw new Error('没有配置 transcriptDir：先在 cordis 配置里指向 qq-bridge 的 state/transcript');
  const day = date || dayKey(now, timeZone);
  const all = readTranscriptDay(transcriptDir, day);
  const scoped = all.filter((m) => !m.scope || m.scope === scope);
  if (scoped.length === 0) {
    return {
      text: '',
      empty: true,
      stats: { messages: 0, included: 0, participants: 0, chars: 0, omitted: 0 },
      hint: `${day} 的 ${scope} 没有消息；今天可以跳过日记，或确认 transcriptDir 是否配错`
    };
  }
  const result = formatDigest({ date: day, scope, messages: scoped, entries, maxMessages, maxChars, timeZone });
  return { ...result, empty: false };
}
