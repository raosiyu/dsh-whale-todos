# WP1 最终交付报告

执行时间：2026-11-05（Asia/Shanghai）
授权：WP1（WP1-0 → WP1-6），仅独立开发仓库与隔离环境
状态：**WP1-0 至 WP1-6 全部完成，STOP，未进入 WP2**

## 一、门禁与最终验收

| 检查 | 结果 | 命令 |
| --- | --- | --- |
| 上游全量测试 | **1339 tests / 1337 pass / 0 fail / 2 skipped** | `cd upstream/dely0-v1.17.2 && pnpm test` |
| 上游类型检查 | EXIT 0 | `pnpm typecheck` |
| 核心域测试 | **92 / 92 pass，0 fail，0 skip** | `cd workbench-core && node --test test/*.test.mjs` |
| 功能演示 | EXIT 0 | `node demo/demo.mjs` |
| 依赖安全（生产） | 0 漏洞 | `pnpm audit --prod` |
| 依赖安全（全部） | 0 漏洞 | `pnpm audit --all` |
| 凭据/私钥扫描 | 0 命中 | `grep -rniE 'BEGIN PRIVATE KEY\|AKIA\|sk-\|ghp_'` |
| 本机路径泄漏 | 0 命中（已脱敏） | 对 `evidence/` 全量 grep 本机绝对路径前缀 |
| 远程推送 | 无 remote | `git remote` 空 |

**2 个 skipped 的核实结论**：`test/workspace-check.test.mjs:111`（WSL `/mnt/<drive>/` 映射）与 `:166`（Windows 反斜杠路径），条件均为 `{ skip: !isWindows && … }`。macOS 上不适用，**属正当平台跳过，非失败、非漏测**，代码未改。

## 二、WP1-0：构建环境收口与 5 个失败测试修复

### 根因（已实锤，非推断）

`src/experts/install.ts` 的 `canonicalDatabasePath()` 只做 `resolve()`（词法归一，**不穿符号链接**）。macOS 上：

| 取法 | 值 |
| --- | --- |
| 夹具用 `dbPath`（`tmpdir()`） | `/var/folders/.../workbench.db` |
| 生产用 `PRAGMA database_list.main.file` | `/private/var/folders/.../workbench.db` |

`/var` 是 `/private/var` 的符号链接 → 两侧 SHA-256 不同 → 本 DB 的安装日志被判 `skipped-foreign-owner`。

### 修复

`canonicalDatabasePath()` 加 `realpathSync`，三级回退（全路径 realpath → 父目录 realpath + basename → 词法路径），任何情况下不抛异常。**只改生产代码，`test/` 零改动，断言一字未改。**

### 独立 Review 修正（重要，我改了口径）

我最初写「真实 profile 经符号链接也会算错，这是生产缺陷」。**独立 Review 实测推翻**：`PRAGMA database_list.main.file` 永远返回 realpath（目录符号链接/叶子符号链接/直接打开三者一致），且 `service.ts` 从不注入 `ownerDbKey` → **生产两侧都走 PRAGMA，修复前也没算错过**。

真实不对称是「**测试夹具用词法路径 vs 生产用 PRAGMA**」。修法正确，但**对生产是 no-op**。文档已按实测改写（`docs/wp1/00-WP1-0-build-env-and-fix.md`）。

### zod 安全通告

| 项 | 内容 |
| --- | --- |
| 通告 | GHSA-mrhx-c7xc-m3w5（HIGH / CWE-770），`fixed 4.6.6` |
| 原状 | zod 4.6.5，`audit --all` 1 high（dev 链） |
| 兼容检查 | 4 个消费方均声明 `^4.4.3`；4.6.7 在区间内；engines/peer 为空 |
| 结果 | 升级到 **4.6.7**，`audit --prod` 与 `--all` 均 **0 漏洞** |

### 可复现构建环境

`scripts/wp1-setup.sh`：校验 node 区间 → Corepack 切 pnpm 11.7.0 → frozen install → **原生 binding 自愈**（版本从 lockfile 读，多平台分支）→ typecheck → build → audit，任一失败即退出。**实跑 EXIT 0**，且实际触发了 binding 恢复分支。

## 三、WP1-1 ~ WP1-5：Event 日历域核心

代码：`workbench-core/`（零运行时依赖 ESM）

| 模块 | 能力 |
| --- | --- |
| `validate.js` | 字段级校验，`OPTIONAL` 标记区分必填/可选，错误带字段路径 |
| `time.js` | 墙钟 ↔ 瞬间，**DST gap 前移 / overlap 取较早**，Intl 实现 |
| `event.js` | Event 模型；全天/定时互斥；**全天保留 timeZone** 以明确"哪一天" |
| `recurrence.js` | RRULE 子集；**MONTHLY 从原始日重算**（1/31→2/28→3/31）；不支持字段报 `unsupported`；2000 次上限 |
| `conflict.js` | 半开区间；全天互不冲突；全天 vs 定时可选；空闲时段 + buffer |
| `store.js` | 原子写（tmp+fsync+rename）；journal 带 pending；**pre/post 快照分离**；schema 过高拒启 |
| `event-repo.js` | CRUD + 软删除 + patch 白名单 + 审计 |
| `ics.js` | VEVENT 子集解析/生成；折行；`VALUE=DATE`；RECURRENCE-ID 跳过告警；JSON 快照 |
| `service.js` | **唯一入口** `execute(op,payload,meta)`；危险操作需 `confirmed`；Task/Event 集合隔离 |

## 四、功能演示（真实输出摘要）

```
=== 1) 创建定时事件（重复：每周一/三，共 4 次）===  产品周会
=== 2) 创建全天事件 ===                            2026-11-05 → 2026-11-07
=== 3) 展开窗口内的实例（11/01–11/16）===
  2026-11-02 09:00 → 10:00   allDay=false
  2026-11-04 09:00 → 10:00   allDay=false
  2026-11-05 00:00 → 11-07 00:00   allDay=true   ← 全天正确锚定 00:00
  2026-11-09 09:00 → 10:00   allDay=false
  2026-11-11 09:00 → 10:00   allDay=false
=== 4) 冲突检测 ===  已按预期拒绝：conflict — 存在时间冲突
=== 5) 空闲时段 ===  08:00–09:00、10:30–18:00
=== 6) ICS 导出→预览 ===  导出 3 条；预览 create=0 skip=3
=== 7) 审批门 ===  已按预期拒绝：confirmation-required
=== 8) 快照/回滚 ===  指纹 fb8d9511…；回滚成功
=== 9) 审计日志 ===  4 条写操作全部留痕
=== 10) Task/Event 隔离 ===  tasks=1  events=2
```

## 五、Git 提交记录

| commit | 内容 |
| --- | --- |
| `873e554` | WP0：锁定 Dely0 v1.17.2 + dsh-calendar 0.14.5 基线、事件域验证、证据 |
| `be98ab9` | WP1-0：可复现构建环境 + ownerDbKey 符号链接修复 + zod 安全升级 |
| `80164dc` | WP1-1..1-5：Event 日历域核心（零依赖 ESM，92 测试）+ Review 修正 |
| 待提交 | WP1-6：setup 脚本版本解析/多平台/严格校验、evidence 脱敏、本报告 |

无 remote，未 push。

## 六、风险清单

| # | 风险 | 影响 | 缓解 / 状态 |
| --- | --- | --- | --- |
| R1 | RRULE 仅支持子集 | 复杂规则（BYSETPOS 等）不可用 | 显式报 `unsupported`，不静默忽略；V2 扩展 |
| R2 | 文件存储非多进程安全 | 并发写会互相覆盖 | 文档已声明；V1 单用户单进程够用 |
| R3 | 未接入 DSH Host | 尚未能作为插件运行 | 本包交付领域内核；接线属后续工作包 |
| R4 | setup 脚本平台覆盖有限 | 仅 darwin/linux 四分支 | 未覆盖平台明确 exit 1，不静默失败 |
| R5 | `catch {}` 不区分错误码（上游） | EACCES 时静默降级 | 降级方向保守（只跳过不动文件）；已记录 |
| R6 | evidence 含大日志 | 仓库体积 | 已脱敏；后续只留 final |
| R7 | 宿主契约漂移 | 上游升级后测试可能红 | 锁 0.2.1-rc.5；WP1-0 脚本可复现 |
| R8 | macOS 桌面端提醒验收未做 | 需求 §4.4 未闭环 | 属 WP2/WP7 范围，不在本包 |

## 七、红线合规

| 红线 | 结果 |
| --- | --- |
| 不装正式 DSH profile | 未调用 `plugin_manager` / `dsh plugin add` |
| 不动 DSH 用户数据 | `~/.dsh/workbench` 始终不存在；未读写业务数据 |
| 不 push 远程 | `git remote` 为空 |
| 不改测试/断言 | 上游 `test/` 零改动（`git status --porcelain test/` = 0） |
| 不调用 Codex | 全程 DSH 子 Agent + 主会话工具 |
| 鲸鱼娘工作区不动 | `plugin/` 仍 `79d7e24`，dirty 0 |

## 八、STOP 声明

WP1-6 完成。**未进入 WP2**（提醒系统 / DSH Host 接线 / UI 面板），等待单独授权。
