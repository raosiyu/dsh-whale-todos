# dsh-workbench

DSH 的日历 + 待办面板插件：侧边栏叫**鲸鱼待办**。

日历拖拽改期、待办排序与分组、JSON/ICS 导入导出、到点提醒。
所有写操作走同一个 Host Service 入口与真实审批，**界面与 Agent 共用同一套数据**——
在界面里改的东西，Agent 立刻读得到；Agent 改的东西，界面刷新即可见。

**当前状态：WP0–WP5 完成。** 面板已在隔离 DSH 环境里真实渲染、
真实读写 Host 数据（不是原型截图）。

| 工作包 | 状态 | 产出 |
| --- | --- | --- |
| WP0 | ✅ | 锁定上游、事件域源码级验证、证据链 |
| WP1 | ✅ | Event 日历域内核（校验/时区/重复/冲突/存储/ICS/统一入口） |
| WP2 | ✅ | 宿主审批门、统一业务入口、按会话隔离存储 |
| WP3 | ✅ | 提醒底座（schedule-adapter / 恢复语义 / host-map）、16 个 Agent 工具 |
| WP4 | ✅ | 面板 UI、设计规范、独立审查通过（0 blocker） |
| WP5 | ✅ | 拖拽改期、排序、归档恢复、导入预览+审批、撤销重做、键盘替代（独立审查已复核） |

## 快速验证

```bash
bash scripts/wp1-setup.sh                          # 可复现构建环境（含原生 binding 自愈）
cd workbench-core && node --test test/*.test.mjs   # 核心域：362 / 362 pass
node scripts/r3-mutate.mjs evidence/wp5/01-mutation.log   # 变异测试：86 / 86 CAUGHT，0 真空 0 跳过
cd workbench-core && node demo/demo.mjs            # 功能演示
```

变异测试的判据是**零存活、零跳过**：删掉任何一处保护代码，都必须有测试变红。
存活变异（VACUUM）或锚点漂移（SKIP）都算验证不充分，不接受"大致通过"。

## 设计红线

1. **不许 AI 自签审批**：危险操作只认宿主签发的一次性凭证，payload 里的 `confirmed` 不被采信。
2. **导入执行只走界面**：模型只能预览与导出，不能代替用户按下"确认导入"。
3. **批量操作可回滚**：中途失败必须整体回退，不能留半截数据。
4. **失败要说出来**：算不出提醒、导入跳过某条规则，都必须在界面上显式可见，不许静默吞掉。
5. **界面与 Agent 同源**：同一套 Host Service、同一套校验，不许两套逻辑各写一遍。

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

1. 不修改本机其他项目的既有文件（例如鲸鱼娘工作区的 dsh-whale-gen 插件）。
2. 不安装到正式 Desktop/Web profile；需要运行插件时只用独立隔离环境。
3. 不修改、迁移、清空 `~/.dsh` 下任何现有用户数据。
4. `git push` 只在明确授权下执行；日常开发以本地 commit 为基线。
5. 每个工作包完成后 STOP，等下一包授权。
