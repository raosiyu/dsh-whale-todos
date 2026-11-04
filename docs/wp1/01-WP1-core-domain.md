# WP1-1 ~ WP1-5 核心域实现报告

执行时间：2026-11-05（Asia/Shanghai）
代码位置：`workbench-core/`（零运行时依赖的 ESM 包）
测试：**92 / 92 pass，0 fail，0 skip**（`node --test test/*.test.mjs`）
演示：`node demo/demo.mjs` 端到端跑通（EXIT 0）

## 一、为什么是「零依赖 ESM 包」而不是继续扩 Dely0

| 考量 | 决定 |
| --- | --- |
| 可运行性 | 核心域必须在**隔离环境零安装**下可跑（`node --test` 直接执行），不引入新的 npm 依赖面 |
| 供应链 | 上游刚发生过原生 binding 下载中断（WP1-0 已修），不再引入新的原生/编译依赖 |
| 可回退 | 纯 ESM + 文件存储，没有构建步骤，回退 = `git revert`，不涉及编译产物 |
| 与 DSH 的关系 | DSH Host 侧接线属后续工作包；本包交付**可独立验证的领域内核**，不假装已装进 DSH |
| zod | 不引入：校验层手写（`validate.js`，156 行），错误路径精确到字段。WP1-0 的 zod 升级只影响上游 dev 链 |

## 二、模块清单与职责

| 文件 | 职责 | 关键设计 |
| --- | --- | --- |
| `errors.js` | 统一错误码（validation / not-found / conflict / confirmation-required / schema-too-new / store-corrupt / unsupported） | 错误带可判定 `code`，调用方不匹配文案 |
| `validate.js` | 校验层：`validateObject` / `optional` / `number(range)` / `oneOf` / `arrayOf` / `isoInstant` / `isoDate` / `ianaTimeZone` | `optional()` 带 `OPTIONAL` 标记，`validateObject` 据此不把可选字段当必填（这是 WP1-1 实测抓到的设计缺陷） |
| `time.js` | 时区/DST：`wallToInstant` / `instantToWall` / `offsetMsAt` / `addDaysToDate` / `WEEKDAY_INDEX` | 墙钟迭代两轮收敛；**gap 前移、overlap 取较早**；用 Intl 而非硬编码偏移 |
| `event.js` | Event 模型与校验 | 全天/定时二选一互斥；**全天保留 timeZone**（表达"哪一天"在哪个时区成立） |
| `recurrence.js` | RRULE 子集展开 | 支持 DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL/COUNT/UNTIL/BYDAY(WEEKLY)；**MONTHLY 从原始日重算**避免短月漂移；不支持的字段显式报 `unsupported`；2000 次上限防 OOM |
| `conflict.js` | 冲突检测 + 空闲时段 | 半开区间（首尾相接不算冲突）；全天与全天永不冲突；全天与定时默认不冲突（`allDayBlocks` 可开）；buffer 合并 |
| `store.js` | 原子 JSON 存储 | 临时文件 + fsync + rename；journal 携带 pending 新状态；**pre/post 两类快照**（pre 供 rollback，post 供崩溃恢复）；schema 过高拒绝启动 |
| `event-repo.js` | Event CRUD + 审计 | 软删除可恢复；patch 白名单（不能改 id/createdAt）；每次写落审计 |
| `ics.js` | ICS 导入导出 + JSON 快照 | VEVENT 子集；折行处理；`VALUE=DATE` 识别全天；RECURRENCE-ID 例外跳过并告警；导出→回读往返成立 |
| `service.js` | **统一业务入口** | `execute(op, payload, meta)` 唯一入口；危险操作需 `meta.confirmed`；Task 与 Event 共用入口但集合隔离 |

## 三、关键语义决定（都写进测试）

1. **半开区间**：`[start, end)`。09:00–10:00 与 10:00–11:00 相邻**不算**冲突。
2. **全天语义**：两个全天事件同一天**不冲突**（"生日 + 假期"是常态）；全天与定时默认不冲突，需要占位时显式 `allDayBlocks: true`。
3. **DST gap**：不存在的墙钟（如纽约 3/8 02:30）**前移**到空档结束（03:30）。
4. **DST overlap**：重复出现的墙钟（如纽约 11/1 01:30）**取较早**瞬间（EDT 侧）。
5. **MONTHLY 31 号**：从原始起始日重算，`1/31 → 2/28 → 3/31`（不是 `3/28`）。
6. **不支持的 RRULE 字段**：`bySetPos`/`byMonthDay`/`byWeekNo` 等显式报 `unsupported`，**不静默忽略**。
7. **危险操作**：`event.delete` / `event.bulkDelete` / `event.import` / `snapshot.replace` / `store.rollback` 必须 `confirmed: true`。
8. **Task 不迁移**：`tasks` 集合在本包里是**新建的空集合**；Dely0 的 `~/.dsh/workbench` SQLite **一律不碰**。共用入口 ≠ 共用数据。

## 四、测试覆盖（92 项）

| 测试文件 | 项数 | 覆盖重点 |
| --- | --- | --- |
| `test/schema.test.mjs` | 13 | 必填/互斥/未知字段拒绝、重复规则约束、时区与日期合法性 |
| `test/recurrence.test.mjs` | 19 | DAILY/WEEKLY/MONTHLY/YEARLY、COUNT/UNTIL/INTERVAL/BYDAY、窗口裁剪、上限保护、**DST gap/overlap**、全天时区锚定、闰日收敛 |
| `test/conflict.test.mjs` | 13 | 重叠/相邻/全天互斥/重复交叉/已取消排除、空闲与 buffer、写入前检查与 `allowOverlap` |
| `test/store.test.mjs` | 12 | 持久化、备份、回滚、**journal 中断恢复**、schema 过高拒绝、损坏拒绝、副本隔离 |
| `test/ics.test.mjs` | 16 | 定时/全天/RRULE 解析、缺 DTSTART 报错、折行、RECURRENCE-ID 跳过、导出往返、转义、JSON 快照校验 |
| `test/service.test.mjs` | 19 | 统一入口、审批门、软删除恢复、patch 白名单、批量删除、ICS 预览不写库、快照替换与回滚、Task/Event 隔离、审计 |

## 五、WP1-1 ~ 1-5 逐票对账

| 票 | 要求 | 状态 | 证据 |
| --- | --- | --- | --- |
| WP1-1 | schema + 存储 + 版本迁移/备份/回滚 + 统一服务骨架 | ✅ | `validate.js`、`store.js`、`service.js`；`store.test.mjs` 12 项 |
| WP1-2 | 独立 Event 实体 + CRUD（与 Task 解耦） | ✅ | `event.js`、`event-repo.js`；`service.test.mjs` 创建/取回/更新/软删/恢复 |
| WP1-3 | RRULE/DST 展开 + 冲突检测 | ✅ | `recurrence.js`、`conflict.js`；`recurrence.test.mjs` 19 + `conflict.test.mjs` 13 |
| WP1-4 | ICS / JSON 导入导出（预览+确认+回滚） | ✅ | `ics.js`；`ics.test.mjs` 16；`service.test.mjs` 预览不写库 / 确认后导入 / 失败不破坏原数据 |
| WP1-5 | 统一入口 + 审批门 + UI/Tool 一致性 | ✅ | `service.js` 的 `execute` 唯一入口 + `DANGEROUS_OPS`；`service.test.mjs` 19 |

## 六、WP1-0 遗留问题处理（来自独立 Review）

| Review 发现 | 处理 |
| --- | --- |
| M1 `be98ab9` 混入 workbench-core 半成品、HEAD 是坏包 | 本 commit 补齐 `workbench-core` 全部模块（含 `index.js`），HEAD 不再悬空；污染事实记入 `00-review-WP1-0.md` |
| M2 文档论证与实测不符 | `00-WP1-0-build-env-and-fix.md` 已改写为「修法正确，但对生产是 no-op」 |
| m3 引用不存在的 review 文件 | 已落盘 `00-review-WP1-0.md` 并改指向 |
| m4 `catch {}` 无差别吞错 | 记录为已知限制（概率极低、降级方向保守：只跳过不动文件） |
| m5 evidence 含本机绝对路径 | 记录；公开前需脱敏（列入 WP1-6 收口清单） |
| m6 setup 脚本硬编码 binding 版本 | 记录；WP1-6 改为从 lockfile 读 |
| n7 node 越界只 WARN | 文档已注明 warn-only |
| n8 测试日志重复占体积 | 记录；后续只留 final |
| n9 叶子符号链接未收敛 | 记录；实际不触发 |

## 七、已知限制（诚实边界）

1. **RRULE 只支持子集**：`bySetPos`/`byMonthDay`/`byYearNo`/`byWeekNo`/`wkst`/`byMonth`/`byHour`/`byMinute` 未实现，传入即报 `unsupported`。
2. **ICS 不解析 ATTENDEE/VALARM/VTIMEZONE 规则**：`TZID` 仅作为时区名保留；RECURRENCE-ID 例外实例跳过。
3. **存储是文件不是 SQLite**：V1 单用户单进程足够；多进程并发写未支持（`rename` 原子性保证读者不会看到半截，但并发写会互相覆盖，属已知限制）。
4. **未接入 DSH Host**：本包是领域内核，`ctx.storageDomain` / `ctx.tools` / `ctx.schedule` 接线属后续工作包。
5. **未实现 UI**：无面板、无拖拽；那是 WP4/WP5。
6. **时区库依赖 Intl**：依赖 Node 的 ICU 数据完整；极冷门时区可能无数据。

## 八、审批门矩阵（显式声明，避免被当成漏项）

| 操作 | 需确认 | 理由 |
| --- | --- | --- |
| `event.delete` | ✅ | 删除，需显式确认 |
| `event.bulkDelete` | ✅ | 批量删除，影响面大 |
| `event.import` | ✅ | ICS 导入会批量写入 |
| `snapshot.replace` | ✅ | 整体覆盖存储，破坏性最强 |
| `store.rollback` | ✅ | 回退存储状态 |
| `event.create` | ❌ | 常规创建，UI 可自行二次确认 |
| `event.update` | ❌ | 常规编辑（patch 白名单已限制可改字段） |
| `event.restore` | ❌ | 撤销软删除，方向是恢复而非破坏 |
| `task.upsert` | ❌ | 幂等写入（按 id 覆盖），由调用方负责语义 |
| `store.backup` | ❌ | 只增加备份，不改变现有数据 |
| 全部 `*.list/get/expand/freeSlots/conflicts/preview*/export*` | ❌ | 只读 |

**判定口径**：区分「破坏性」（不可逆或批量）与「常规编辑」（可逆、单条、白名单受限）。破坏性一律 `confirmed: true`；常规编辑不强制，但 UI 层仍可加二次确认——**服务层不拦 ≠ UI 不提示**。
该矩阵由 `test/service.test.mjs` 的「审批门矩阵」用例锁定：破坏性操作未确认时**必须**抛 `confirmation-required`。
