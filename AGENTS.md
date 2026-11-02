# 小肥鱼日记 workspace

**仓库根就是这个目录。** 这里只做一件事：把「小肥鱼日记」做成一个可安装的 DSH 插件
（`dsh-whale-journal`）。桥接、部署、隧道、其他插件不在这里。

## 先读

1. `docs/plugin-design.md` —— 插件的目标、数据模型、工具契约、与桥接的分工；
2. `docs/notebook-page-design.md` —— 日记本页面（只读、偷看、简笔画、照片）的设计稿。

## 目录

```
lib/            插件源码：index（工具）/ store（存储）/ digest（素材）/ audit（接地审计）
scripts/        单测（node，无框架）+ check.mjs（静态检查包装）
docs/           插件设计与页面设计
samples/        合成归档与日记示例
locale/         中英文展示元数据
cordis.patch.yml / package.json / icon.svg
```

本机另有一份 `reference/`（记忆内核参考，只读、不参与构建），不随仓库发布。

## 常用命令

```sh
npm test        # 存储 + 素材 + 审计
npm run check   # dsh-plugin-guide 静态检查（自动找本机 profile）
npm run verify  # 上面两个一起跑
```

## 边界（硬规则）

- **插件代码只在这里。** 桥接侧要改的东西（transcript 写入、夜间内部会话、发送前守卫）
  回桥接仓库做，别在本仓库改桥接。
- **不把真实聊天记录带进仓库。** `samples/`、测试、文档里的例子一律合成；真实数据只在
  部署机的 `state/` 里。
- **不手写 profile 的 `package.json` / `cordis.patch.yml`。** 安装走 `dsh plugin add` 或
  `plugin_manager` 的 `install_bundle`；发布/升级按 dsh-plugin-guide 的流程。
- **插件保持确定性。** 不调用模型/网络；写什么由 agent 决定，插件只负责存、查、给素材、对账。
- **部署前**：`git commit` + tag、备份服务器 `state/`、低峰窗口重启、健康检查、准备回滚。
  坏的插件代码会让 DSH 重启循环，机器人整体不可用。
- **peer 依赖只放 `peerDependencies` + `devDependencies`**，绝不能放 `dependencies`
  （profile 内副本会遮蔽宿主运行时版本）。

## 当前状态

- v0.1（已完成）：6 个工具、JSONL 存储（折叠/归档/上限/截断）、digest、接地审计、67 条单测。
- 下一步：日记本页面（见 `docs/notebook-page-design.md`，从 M1 数据与工具开始）。
- 待做：`/journal` 命令、定时任务交给宿主、周检（LLM 逐句对账）接入、服务器部署。
- 已知限制见 `docs/plugin-design.md` 最后一节。
