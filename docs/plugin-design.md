# 小肥鱼日记 · 插件设计

> 目标：把「日记」从桥接里的一段临时逻辑，做成一个可独立安装、可测试、可演进的 DSH 插件。
> 本文是契约；实现以 `lib/` 为准，测试以 `scripts/test-*.mjs` 为准。

## 1. 背景

小肥鱼（QQ 陪伴型 agent）需要一层**叙事记忆**：不是「谁是谁」的事实卡，而是「今天注意到了什么、在意什么、明天想做什么」。它给三件事提供连续性：

- 会话轮换/压缩后，她还记得自己的视角；
- 主动搭话有真实来源（昨天写下的「想问问他比赛看了没」）；
- 人设不被事实卡淹没。

这件事不适合塞进桥接：桥接负责 QQ I/O，日记需要存储、检索、接地审计、未来的 UI 和定时任务——这些是 DSH 插件的地盘。

## 2. 目标 / 非目标

**目标（v0.1）**

- 按天、按 scope（`group:<id>` / `private:<id>` / `global`）写日记；
- 读最近、按日期读、按关键词搜、软删除（归档）；
- 把某天某 scope 的消息整理成「写日记素材」，带消息 `seq`；
- 接地审计：`refs` 能否在消息归档里回查，重复/数字 token/长度分布。

**非目标（v0.1）**

- 不调用模型、不联网、不自动写——写什么由 agent 决定；
- 不做 prompt 注入（注入属于桥接/预设层）；
- 不做周检的语义判真假（那是独立审计会话的事）；
- 不做 UI（v0.2）、不做内置 cron（交给宿主调度）。

## 3. 角色分工

| 角色 | 做什么 | 在哪 |
|---|---|---|
| 桥接 | 收 QQ 消息、按天写 transcript、夜间起内部会话、发送前守卫 | `../大肥鱼/qq-bridge` |
| 插件 | 存日记、给素材、搜、接地审计 | 本仓库 |
| agent（内部会话） | 读 digest、写 3–5 句、填 refs | DSH 会话 |
| 周检（独立会话） | 拿聊天记录逐句判「有据/无据/矛盾/错配」 | 桥接侧编排 |

**关键边界**：插件不生成日记正文。它只保证「写的时候有素材、写完了能对账」。

## 4. 数据模型

```jsonc
{
  "v": 1,
  "id": "j_<uuid>",
  "date": "2026-11-01",           // 本地日（默认 Asia/Shanghai）
  "scope": "group:100000001",     // 群/私聊/global
  "text": "……",                   // 3–5 句，≤ maxEntryChars
  "truncated": false,
  "mood": "安静",                 // 可选，≤20 字
  "refs": [1, 2, 3],              // 引用的消息 seq，≤50 个
  "source": "agent",              // agent | manual
  "status": "active",             // active | archived
  "createdAt": 1793537000000,
  "updatedAt": 1793537000000
}
```

- `refs` 是**消息 seq**，不是 QQ messageId（QQ messageId 不连续、不好排序；seq 是桥接本地的读水位）。
- 一条日记可以引用 0 个 refs，但审计会把它标成 `no-refs`（不是错，只是不可对账）。
- `text` 里不允许出现 QQ 号/隐私/真名——这条由写作 prompt 约束，插件不做替换。

## 5. 存储与生命周期

- 文件：`$DSH_HOME/journal/entries.jsonl`（或配置的 `dir`）。
- 追加写；编辑/归档 = 追加同 `id` 的新记录，读取时按 `id` 折叠（后写胜出）。
- 读取：坏行跳过；默认排除 `archived`。
- 上限：每个 `scope` 每天 `maxEntriesPerDay` 条；超了报错，要求先归档。
- 截断：正文超过 `maxEntryChars` 截断并标 `truncated`。
- 清理：`pruneArchived()` 只删「归档且超过 retentionDays」的条目；活跃条目永不自动删。
- 并发：单进程追加写是安全的；工具标 `isConcurrencySafe: false` 交给宿主串行化写。

## 6. 工具契约

| 工具 | 参数 | 返回 | 备注 |
|---|---|---|---|
| `journal_write` | `text`(必填)、`scope`(必填)、`date?`、`mood?`、`refs?` | 条目 + `remaining`、`charCount` | 超上限/超条数抛错 |
| `journal_read` | `scope?`、`date?`、`limit?=5`、`includeArchived?` | `{count, entries}` | 最新在前 |
| `journal_search` | `query`(必填)、`scope?`、`limit?=10` | `{count, entries(带 score)}` | 子串匹配，正文×2 + 心情×1 |
| `journal_digest` | `scope`(必填)、`date?`、`maxMessages?=200` | `{text, stats, empty?, hint?}` | 无消息返回 `empty:true`，不算错 |
| `journal_audit` | `scope?`、`from?`、`to?` | `{summary, rows, duplicates}` | 只验证 refs 可回查 |
| `journal_archive` | `id`(必填)、`reason?` | `{id, status}` | 软删除 |

工具描述一律中文（agent 的上下文是中文），并且明确「不要每轮都读日记」——避免把日记变成新的刷屏源。

## 7. 配置

Schemastery `Config`（`lib/index.js`），所有可调参数不硬编码：

| 键 | 默认 | 说明 |
|---|---|---|
| `dir` | `''` | 空 = `$DSH_HOME/journal` |
| `transcriptDir` | `''` | 空 = digest/audit 不可用（显式报错） |
| `timezone` | `Asia/Shanghai` | 切天 |
| `maxEntryChars` | 600 | 单条上限 |
| `maxEntriesPerDay` | 3 | 每 scope 每天 |
| `retentionDays` | 365 | 归档保留 |
| `scopes` | `[]` | 白名单；空 = 不限 |

## 8. digest 规格

`journal_digest` 的输出是给 agent 的**写作素材**，不是给用户看的：

1. 头部：日期、scope、消息数、发言者数；
2. 最近 3 篇日记（保持语气/话题连续）；
3. 写作规则（3–5 句、第一人称、只写真实发生、不写号码、可选「明天想…」、refs 用 seq）；
4. 聊天记录：`[seq] HH:MM 名字：正文`，按 seq 排序；
5. 预算：默认 200 条 / 12,000 字符；超了从最旧丢，并注明「更早的 N 条已省略」。

不做的事：不摘要、不判断重要性、不删敏感词——这些是写作会话和桥接守卫的事。

## 9. 审计规格

**确定性部分（本插件）**

- refs 是否能在对应 scope 的消息归档里找到；
- 每条的状态：`grounded` / `no-refs` / `refs-unresolved`；
- 重复：同 scope 内 3-gram Jaccard ≥ 0.8 的日记对；
- 数字 token：正文里的 5–11 位数字（给隐私检查用）；
- 长度分布。

**语义部分（不在本插件）**

周检独立会话拿「日记 + 当天 transcript」逐句判：有据 / 推断 / 无据 / 矛盾 / 错配 / 过期 / 无法核实。插件只提供 `journal_audit` 的确定性指标作为输入。

## 10. 与桥接的集成

### 10.1 transcript 契约（桥接写）

`state/transcript/YYYY-MM-DD.jsonl`，一行一条：

```json
{"v":1,"day":"2026-11-01","ts":1793534400000,"at":"...","seq":1,"messageId":"...","sender":"阿宁","userId":"10001","text":"...","isSelf":false,"scope":"group:100000001"}
```

- `seq` 必须稳定；`scope` 必须和日记一致；`text` 已经过桥接的入库清洗。
- 只保留 90 天；超过就删（周检只回看一周，足够）。

### 10.2 夜间流程（桥接编排）

1. 凌晨低峰，桥接起一个内部会话（复用 `internal:黑话学习` 的模式，不碰 QQ 会话）；
2. 调 `journal_digest(scope)`；
3. 模型写 3–5 句 → `journal_write(text, scope, refs)`；
4. 没有消息就跳过；失败重试一次，仍失败则只记日志，不影响消息收发。

### 10.3 读取时机

- 当天第一次唤醒：读最近 1 篇（≤200 字）注入；
- 主动唤醒：可读最近一篇的「明天想…」当话题种子；
- 其余时候不注入——**读的频率比写的频率更危险**。

## 11. 隐私与安全

- 只写本地 DSH 目录；无网络、无模型调用。
- 日记按 scope 分文件行；群日记不会读到私聊（调用方传 scope，插件按 scope 过滤）。
- 正文不写 QQ 号/隐私/真名（prompt 约束）；号码守卫在桥接出站侧，不在插件里重复做。
- 仓库/示例/测试全部合成，不含真实数据。
- 归档可回滚；清理只删归档且过期的条目。

## 12. 测试与验收

- `npm test`：存储（写入/上限/截断/折叠/归档/搜索/清理）、digest（过滤/seq/预算/空天/缺配置）、审计（refs/重复/数字/过滤）。
- 验收：67 条断言全绿；`dsh-plugin-dev check` 通过；装进干净 profile 后 6 个工具可见。
- 集成验收：拿 `samples/` 跑 digest → 人工写一条 → `journal_audit` 显示 grounded。

## 13. 部署与回滚

1. `git commit` + tag；
2. 服务器备份 `state/`、`~/.dsh/profiles/web/`；
3. `pnpm pack` → 安装到 web profile（或 `plugin_manager`）；
4. 低峰重启 DSH；`cordis_inspect_query` 确认行挂上；
5. 失败：撤销安装/恢复备份，重启；插件本身无状态写入（除了 `entries.jsonl`），回滚风险低。

## 14. 路线图与已知限制

**路线**

- v0.2：Web 面板（按天浏览、编辑、归档、diff）；
- v0.3：`/journal` 命令 + 宿主调度；
- v1.0：周检 LLM 对账报告、日记 → 自卡候选的提议通道。

**已知限制**

- `refs` 只保证「能回查」，不保证「引用得对」；语义真假仍要靠周检。
- 审计的重复检测是字符级，措辞差异大的重复抓不到（和记忆库一样，得靠语义/人卡）。
- 没有加密；依赖 DSH_HOME 的文件权限（服务器上是 700）。
- 没有跨文件事务；极端断电可能丢最后一行（追加写 + 坏行跳过可接受）。
- 没有内置调度；夜间写日记必须由桥接/宿主触发。
