# dsh-workbench（WP0 基线）

DSH 智能日历与待办工作台插件的独立开发仓库。**当前状态：WP0 完成，仅基座与验证，未实现业务功能、未安装到任何 DSH profile。**

## 来源与锁定版本

| 上游 | 版本 | 锁定方式 | 快照 sha256 | 许可证 |
| --- | --- | --- | --- | --- |
| Dely0/dsh-personal-workbench | v1.17.2 | tag `v1.17.2` codeload tarball | `9158f87f8c6eac1574f9dab7afdbad6c1a5f2e9ebb4caaaf7bac2bc8a8c313ee` | MIT |
| STARDUSTLC666/dsh-calendar | 0.14.5 | release commit `29dc9ef3`（tag 名非 `v0.14.5`，改用 commit SHA） | `23f98a06c834b428a97779abc17347adaf0a9492954a39f18d2919bbce0c460d` | MIT |

npm pack 交叉校验产物：`@dely0/dsh-personal-workbench@1.17.2`（sha256 `42836eea…`）、`dsh-calendar@0.14.5`（sha256 `9f597a9f…`），详见 `evidence/wp0/00-artifact-sha256.txt`。

## 目录约定

```
upstream/dely0-v1.17.2/        # 只读参考快照（任务/AI 基座），不改业务代码
upstream/dsh-calendar-0.14.5/  # 只读参考快照（日历域模块源）
LICENSES/                      # 上游许可证原文 + 第三方署名（逐字复制）
docs/wp0/                      # WP0 验证报告、事件域结论、修订后 WP1 计划
evidence/wp0/                  # 命令原始输出、校验和、检查日志
src/                           # 未来实现代码（WP1 起），本包为空
```

## 署名与许可证

- 主项目 MIT：`LICENSES/Dely0-MIT.txt`（Copyright (c) 2026 Du Penglai）、`LICENSES/dsh-calendar-MIT.txt`（Copyright (c) 2026 stardustlc）。
- 内置角色库 MIT：`LICENSES/novotnyllc-dotnet-artisan-MIT.txt`、`LICENSES/K-Dense-scientific-agents-MIT.txt`。
- **`LICENSES/Dely0-THIRD_PARTY_NOTICES.md` 必须随任何 fork/再分发保留**：内含 `dsh-task-board`（BSD-3-Clause，全文内嵌）、`dsh-genui`（MIT）、`Guojing6/dsh-workbench`（MIT）、`SnowNight777/dsh-personal-workbench`（MIT）的署名与「改了什么」。
- 后续移植 dsh-calendar 模块时，逐文件保留其 MIT 头部与署名。

## 红线（本项目全程适用）

1. 不修改 `/Users/sylas/Developer/鲸鱼娘/plugin`（dsh-whale-gen）及鲸鱼娘工作区其他既有文件。
2. 不安装到正式 Desktop/Web profile；需要运行插件时只用独立隔离环境。
3. 不修改、迁移、清空 `~/.dsh` 下任何现有用户数据。
4. 不擅自 `git push` 到任何远程仓库；Git 仅本地基线。
5. 每个工作包完成后 STOP，等下一包授权。
