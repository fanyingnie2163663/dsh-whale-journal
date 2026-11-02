# 小肥鱼日记 · dsh-whale-notes

给陪伴型 agent 的**日记 / 叙事记忆**插件。它不是再存一份聊天记录，而是让 agent 每天写几句「自己视角」的话，并且每句话尽量能回指到当天的消息。

> 状态：v0.1（可用）——工具、存储、素材、接地审计已完成；Web 面板、定时任务、周检 LLM 对账在路线图里。

## 它是什么 / 不是什么

- 是：按天、按 scope（群/私聊）写日记；读、搜、归档；把当天消息整理成「写日记素材」；检查 refs 能否回查。
- 不是：不调用模型、不联网、不自动写、不替 agent 决定写什么；也不参与人设/prompt 注入。
- 和「事实卡」分开：事实卡记事（谁是谁、答应什么），日记记视角（今天注意到什么、明天想做什么）。

## 工具

| 工具 | 作用 | 写？ |
|---|---|---|
| `journal_write` | 写一条日记（正文 + scope + 可选 date/mood/refs/doodle/photos） | 是 |
| `journal_read` | 读最近的日记（按 scope/日期过滤） | 否 |
| `journal_search` | 按关键词搜日记 | 否 |
| `journal_digest` | 取某天某 scope 的素材：带 seq 的消息 + 最近日记 + 写作规则 | 否 |
| `journal_audit` | 接地审计：refs 能否在消息归档里回查、重复、数字 token | 否 |
| `journal_peek` | 读取「被偷看」的只读事实（次数 / 按天 / 上次时间） | 否 |
| `journal_archive` | 归档（软删除，可回滚） | 是 |

`journal_digest` 是给「夜间写日记」用的：拿到素材 → agent 写 3–5 句 → `journal_write`，`refs` 填素材里的 `[数字]`（消息 seq）。

## 偷看页面（只读）

Web profile 里会挂一个只读页面（headless / SDK profile 没有这个路由）：

- 地址：`http://127.0.0.1:3080/journal`（本机或 SSH 隧道；不要暴露公网）
- 没有编辑 / 上传 / 删除，只读 `$DSH_HOME/journal`
- 打开某天记一次偷看（同一页 10 分钟内不重复），聊天里的 AI 用 `journal_peek` 读事实
- 简笔画 / 照片按 `anchor` 跟着句子；锚点找不到就不画

页面由 DSH 的 Web 服务直接提供，不额外起进程。

字体：页面自带「悠哉字体」子集（OFL 1.1，见 `assets/FONT-NOTICE.md`）；如果本机装了「贤二体」，字体会优先用它。贤二体免费商用，但授权不允许修改/嵌入，所以仓库不打包它。

## 存储

`$DSH_HOME/journal/entries.jsonl`，一行一条 JSON。编辑/归档不会覆盖历史：追加一条同 `id` 的新记录，读取时按 `id` 折叠（后写胜出）。

```json
{"v":1,"id":"j_...","date":"2026-11-01","scope":"group:100000001","text":"...","mood":"安静","refs":[1,2,3],"status":"active","createdAt":1793537000000,"updatedAt":1793537000000}
```

- 单条正文默认上限 600 字（超出截断并标 `truncated`）；
- 每个 scope 每天默认最多 3 条（先归档再写）；
- 归档条目默认不读、不搜、不审计，可 `includeArchived` 读回；
- 坏行跳过，不影响整本日记。

`samples/transcript/` 和 `samples/journal/` 是合成的归档与日记，可以直接把 `transcriptDir` / `dir`
指过去跑通：`journal_digest` 能读出当天消息，`journal_audit` 能显示 `grounded`。

## 配置（cordis）

| 键 | 默认 | 说明 |
|---|---|---|
| `dir` | `''` | 日记目录；空 = `$DSH_HOME/journal` |
| `transcriptDir` | `''` | 消息归档目录（qq-bridge 的 `state/transcript`）；空 = digest/audit 不可用 |
| `timezone` | `Asia/Shanghai` | 按哪个时区切天 |
| `maxEntryChars` | `600` | 单条上限 |
| `maxEntriesPerDay` | `3` | 每个 scope 每天上限 |
| `retentionDays` | `365` | 归档保留天数 |
| `scopes` | `[]` | 允许的 scope 白名单；空 = 不限制 |

配置由 `lib/index.js` 里的 Schemastery `Config` 校验，非法值加载期直接失败。

## 安装

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-whale-notes-0.1.0.tgz
dsh --profile <name> --dump-config | grep dsh-whale-notes
```

或按官方插件流程：工作区写 bundle → `plugin_manager` 的 `install_bundle`（绝对目录）→ `cordis_inspect_query` 核对。**不要手写 profile 的 `package.json`，也不要在 profile 目录里跑 pnpm。**

## 与 qq-bridge 集成（服务器）

1. 桥接把消息按天写到 `state/transcript/YYYY-MM-DD.jsonl`（`seq/sender/userId/text/isSelf/scope`）；
2. 本插件 `transcriptDir` 指向该目录；
3. 夜间内部会话：`journal_digest(group:…)` → 写 3–5 句 → `journal_write(refs=[...])`；
4. 周检会话：`journal_audit()` 出确定性指标 → 独立审计会话拿聊天记录逐句判真假（不在本插件里）。

桥接侧的接线与部署在大肥鱼工作区的记忆方案里，本仓库只负责插件。

## 隐私

- 只写本地 DSH 目录，不外发；不调用任何网络/模型 API。
- 日记按 `scope` 分开存；群日记不会读私聊内容（由调用方传 scope 保证）。
- 提示词规则要求不写 QQ 号、隐私、真名；本插件不做号码替换（出站守卫在桥接侧）。
- 仓库里的 `samples/` 全部是合成数据，不含真实聊天记录。

## 开发

```sh
npm test                                   # 存储 / 素材 / 审计
node scripts/test-store.mjs                # 单个
node "<dsh-plugin-guide>/bin/dsh-plugin-dev.js" check --cwd .
```

## 路线图

- v0.2：Web 面板（按天浏览、diff、手工编辑/归档）；
- v0.3：`/journal` 斜杠命令 + 定时任务（由宿主调度，不内置 cron）；
- v1.0：周检报告（LLM 逐句对账）与「日记 → 自卡候选」的显式提议通道。

## License

Apache-2.0。
