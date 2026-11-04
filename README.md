# dsh-workbench

DSH 智能日历与待办工作台插件的独立开发仓库。

**当前状态：WP0 + WP1 完成。** 已有可运行、可测试、可回退的 Event 日历域内核（`workbench-core/`，93 项测试全绿），**尚未接入 DSH Host、未实现 UI、未安装到任何 DSH profile**。

| 工作包 | 状态 | 产出 |
| --- | --- | --- |
| WP0 | ✅ | 锁定上游、事件域源码级验证、证据链 |
| WP1-0 | ✅ | 可复现构建环境、5 个失败测试修复、zod 安全升级 |
| WP1-1~1-5 | ✅ | Event 日历域核心（校验/时区/重复/冲突/存储/ICS/统一入口） |
| WP1-6 | ✅ | 脚本加固、证据脱敏、最终回归与交付报告 |
| WP2+ | ⏸ | 未授权，未开始 |

快速验证：

```bash
bash scripts/wp1-setup.sh                    # 可复现构建环境（含原生 binding 自愈）
cd upstream/dely0-v1.17.2 && pnpm test       # 上游全量：1339 / 1337 pass / 0 fail / 2 skip
cd workbench-core && node --test test/*.test.mjs   # 核心域：93 / 93 pass
cd workbench-core && node demo/demo.mjs      # 功能演示
```

## 来源与锁定版本

| 上游 | 版本 | 锁定方式 | 快照 sha256 | 许可证 |
| --- | --- | --- | --- | --- |
| Dely0/dsh-personal-workbench | v1.17.2 | tag `v1.17.2` codeload tarball | `9158f87f8c6eac1574f9dab7afdbad6c1a5f2e9ebb4caaaf7bac2bc8a8c313ee` | MIT |
| STARDUSTLC666/dsh-calendar | 0.14.5 | release commit `29dc9ef3`（tag 名非 `v0.14.5`，改用 commit SHA） | `23f98a06c834b428a97779abc17347adaf0a9492954a39f18d2919bbce0c460d` | MIT |

npm pack 交叉校验产物：`@dely0/dsh-personal-workbench@1.17.2`（sha256 `42836eea…`）、`dsh-calendar@0.14.5`（sha256 `9f597a9f…`），详见 `evidence/wp0/00-artifact-sha256.txt`。

## 目录约定

```
upstream/dely0-v1.17.2/        # 上游基座快照（唯一生产改动：canonicalDatabasePath 的 realpath 修复）
upstream/dsh-calendar-0.14.5/  # 只读参考快照（日历域模块源）
workbench-core/                # 核心域：零依赖 ESM（src/ + test/ + demo/）
scripts/wp1-setup.sh           # 可复现构建环境
docs/wp0/                      # WP0 验证报告、事件域结论、修订后 WP1 计划
docs/wp1/                      # WP1 报告、Review 记录、最终交付
evidence/wp0/ evidence/wp1-0/  # 命令原始输出（已脱敏本机路径）
LICENSES/                      # 上游许可证原文 + 第三方署名（逐字复制）
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
