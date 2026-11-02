// dsh-whale-notes —— 小肥鱼日记：给陪伴型 agent 的叙事记忆插件。
//
// 它不是「再存一份聊天记录」，而是四件事：
//   1) 按天、按场景写日记（journal_write），正文可带消息 seq 作为证据；
//   2) 按天/场景读、按关键词搜（journal_read / journal_search）；
//   3) 把某天的消息整理成可直接写日记的素材（journal_digest）；
//   4) 接地审计：refs 能不能在消息归档里回查（journal_audit）。
//
// 纯逻辑在 ./store.js、./digest.js、./audit.js，可脱离 dsh 单独测试。
// 插件本身不调用模型、不联网：写什么由 agent 决定，这里只负责存、查、给素材、对账。

import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import {
  archiveEntry,
  listEntries,
  loadEntries,
  searchEntries
} from './store.js';
import { buildDigest } from './digest.js';
import { auditEntries } from './audit.js';
import { writeJournal } from './write.js';
import { readPeekFacts } from './peek.js';
import { createJournalHandler } from './webserver.js';

export const name = 'dsh-whale-notes';
export const inject = ['tools'];

const DEFAULTS = {
  dir: '',
  transcriptDir: '',
  timezone: 'Asia/Shanghai',
  maxEntryChars: 600,
  maxEntriesPerDay: 3,
  retentionDays: 365,
  scopes: []
};

// 所有可调参数都走 Schemastery：宿主在加载期校验，非法配置响亮失败（guide §3.6）。
export const Config = Schema.object({
  dir: Schema.string().default('').description('日记目录；留空 = $DSH_HOME/journal'),
  transcriptDir: Schema.string()
    .default('')
    .description('消息归档目录（qq-bridge 的 state/transcript）；留空则 digest/audit 不可用'),
  timezone: Schema.string().default('Asia/Shanghai').description('按哪个时区切天'),
  maxEntryChars: Schema.natural().default(600).description('单条日记最多多少字，超出截断'),
  maxEntriesPerDay: Schema.natural().default(3).description('每个 scope 每天最多几条'),
  retentionDays: Schema.natural().default(365).description('归档条目的保留天数'),
  scopes: Schema.array(Schema.string())
    .default([])
    .description('允许的 scope 白名单（如 group:100000001）；留空 = 不限制')
});

function cfgOf(config = {}) {
  const merged = { ...DEFAULTS };
  for (const [key, value] of Object.entries(config ?? {})) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function checkScope(scope, cfg) {
  if (Array.isArray(cfg.scopes) && cfg.scopes.length > 0 && !cfg.scopes.includes(scope)) {
    throw new Error(`scope ${scope} 不在白名单里（允许：${cfg.scopes.join(', ')}）`);
  }
}

const ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    date: { type: 'string' },
    scope: { type: 'string' },
    text: { type: 'string' },
    mood: { type: 'string' },
    refs: { type: 'array', items: { type: 'integer' } },
    doodle: { type: 'object', additionalProperties: true },
    photos: { type: 'array', items: { type: 'object', additionalProperties: true } },
    status: { type: 'string' },
    createdAt: { type: 'number' }
  }
};

function entryLine(entry) {
  const mood = entry.mood ? `（${entry.mood}）` : '';
  return `[${entry.date}] ${entry.scope}${mood}\n${entry.text}`;
}

export function apply(ctx, config) {
  const cfg = cfgOf(config);

  // 有 Web 服务（web profile）时挂只读页面；headless/SDK profile 没有它，工具照常。
  const web = ctx.get('webServer');
  if (web) {
    const assetsDir = fileURLToPath(new URL('../assets', import.meta.url));
    ctx.effect(() => web.register({
      kind: 'prefix',
      path: '/journal',
      handler: createJournalHandler({ dir: cfg.dir, assetsDir })
    }));
  }

  ctx.tools.register(
    defineTool({
      name: 'journal_write',
      description:
        '写一条日记（叙事记忆，不是事实卡）：3–5 句第一人称，只写今天真实发生/注意到的事，可引用原话片段。正文里不要写 QQ 号、隐私、真名。refs 填你引用的消息 seq（来自 journal_digest 的 [数字]），方便以后对账。',
      parameters: {
        text: { type: 'string', required: true, description: '日记正文，3–5 句，第一人称' },
        scope: { type: 'string', required: true, description: '场景，如 group:100000001 / private:100000002' },
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天（按配置时区）' },
        mood: { type: 'string', description: '一个词的心情，可空' },
        refs: { type: 'array', items: { type: 'integer' }, description: '引用的消息 seq 列表' },
        doodle: {
          type: 'json',
          description: '可选简笔画对象 {svg, anchor, side}：120×80 线条图元，跟着 anchor 那句走；不合规会被丢弃，不影响正文'
        },
        photos: {
          type: 'json',
          description: '可选照片数组 [{path, anchor, side, caption}]，最多 3 张；从当天素材里自己挑，不合规的会被丢弃'
        }
      },
      output: {
        schema: ENTRY_SCHEMA,
        render: (_args, v) => {
          const notes = [];
          if (v.dropped?.doodle) notes.push('（简笔画没通过检查，已跳过）');
          if (v.dropped?.photos?.length) notes.push(`（${v.dropped.photos.length} 张照片被跳过）`);
          return [{
            type: 'text',
            text: `${v.truncated ? '（超长已截断）' : ''}已记下 ${v.date} · ${v.scope}：\n${v.text}${notes.length ? `\n${notes.join('')}` : ''}`
          }];
        }
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        checkScope(args.scope, cfg);
        const { entry, remaining, dropped } = writeJournal(cfg, args);
        return { ...entry, remaining, charCount: entry.text.length, dropped };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: 'journal_read',
      description: '读最近的日记（默认每个 scope 最新 5 条）。用于回忆「我昨天/上周怎么想的」，不要每轮都读。',
      parameters: {
        scope: { type: 'string', description: '只看某个场景；不传=全部' },
        date: { type: 'string', description: '只看某天 YYYY-MM-DD' },
        limit: { type: 'integer', description: '条数 1–100，默认 5' },
        includeArchived: { type: 'boolean', description: '是否包含已归档，默认 false' }
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { count: { type: 'integer' }, entries: { type: 'array', items: ENTRY_SCHEMA } } },
        render: (_args, v) =>
          [{ type: 'text', text: v.count ? v.entries.map(entryLine).join('\n\n') : '还没有日记。' }]
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const entries = listEntries(cfg.dir, {
          scope: args.scope ?? '',
          date: args.date ?? '',
          includeArchived: args.includeArchived === true,
          limit: args.limit ?? 5
        });
        return { count: entries.length, entries };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: 'journal_search',
      description: '按关键词搜日记（正文/心情）。想问「我以前是不是写过…」时用，不要全量读。',
      parameters: {
        query: { type: 'string', required: true, description: '关键词' },
        scope: { type: 'string', description: '限定场景' },
        limit: { type: 'integer', description: '条数 1–50，默认 10' }
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { count: { type: 'integer' }, entries: { type: 'array', items: ENTRY_SCHEMA } } },
        render: (_args, v) =>
          [{ type: 'text', text: v.count ? v.entries.map((e) => `${entryLine(e)}\n(命中 ${e.score} 次)`).join('\n\n') : '没搜到相关日记。' }]
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const entries = searchEntries(cfg.dir, args.query, { scope: args.scope ?? '', limit: args.limit ?? 10 });
        return { count: entries.length, entries };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: 'journal_digest',
      description:
        '取某天某个场景的「写日记素材」：带 seq 的聊天记录 + 最近几篇日记 + 写作规则。写完用 journal_write 落库。没有消息时返回 empty=true，可以跳过。',
      parameters: {
        scope: { type: 'string', required: true, description: '场景，如 group:100000001' },
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        maxMessages: { type: 'integer', description: '最多带多少条消息，默认 200' }
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, v) => [{ type: 'text', text: v.empty ? v.hint ?? '今天没有消息。' : v.text }]
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        checkScope(args.scope, cfg);
        const entries = listEntries(cfg.dir, { scope: args.scope, limit: 3 });
        return buildDigest({
          transcriptDir: cfg.transcriptDir,
          scope: args.scope,
          date: args.date ?? '',
          entries,
          maxMessages: args.maxMessages ?? 200,
          timeZone: cfg.timezone
        });
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: 'journal_audit',
      description:
        '日记接地审计（确定性部分）：检查每条日记的 refs 能否在消息归档里找到，统计无 refs/refs 失效/重复/数字 token。语义真假要周检拿聊天记录逐句对账，这里只回答「有没有留下可回查的证据」。',
      parameters: {
        scope: { type: 'string', description: '限定场景' },
        from: { type: 'string', description: '起始日期 YYYY-MM-DD' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD' }
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, v) => {
          const s = v.summary;
          const head = `日记 ${s.entries} 条：有据 ${s.grounded} / 无 refs ${s.noRefs} / refs 失效 ${s.refsUnresolved}；重复 ${s.duplicatePairs} 对；平均 ${s.avgChars} 字`;
          const bad = v.rows.filter((r) => r.status !== 'grounded').slice(0, 10);
          const lines = bad.map((r) => `- ${r.date} ${r.scope}：${r.refs ? `refs ${r.missing.join(',')} 找不到` : '没有 refs'}`);
          return [{ type: 'text', text: [head, ...lines, s.hasTranscript ? '' : '（未配置 transcriptDir，refs 无法校验）'].filter(Boolean).join('\n') }];
        }
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const entries = loadEntries(cfg.dir);
        return auditEntries(entries, {
          transcriptDir: cfg.transcriptDir,
          scope: args.scope ?? '',
          from: args.from ?? '',
          to: args.to ?? ''
        });
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: 'journal_peek',
      description:
        '读取「被偷看」的只读事实：总次数、按天次数、上次时间、最近 7 天。只给聊天会话用；写日记时不要提，也不要写进日记。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, v) => {
          const last = v.lastAt ? new Date(v.lastAt).toISOString() : '还没被看过';
          return [{ type: 'text', text: `被看过 ${v.total} 次（今天 ${v.today} 次，最近 7 天 ${v.last7} 次）；上次：${last}` }];
        }
      },
      isConcurrencySafe: () => true,
      async execute() {
        return readPeekFacts(cfg.dir);
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: 'journal_archive',
      description: '归档一条日记（软删除，可回滚）：内容留在文件里，但不再参与读取/搜索/审计。',
      parameters: {
        id: { type: 'string', required: true, description: '日记 id' },
        reason: { type: 'string', description: '归档原因' }
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { id: { type: 'string' }, status: { type: 'string' } } },
        render: (_args, v) => [{ type: 'text', text: `已归档 ${v.id}` }]
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const next = archiveEntry(cfg.dir, args.id, { reason: args.reason ?? '' });
        return { id: next.id, status: next.status, archivedAt: next.archivedAt };
      }
    })
  );
}
