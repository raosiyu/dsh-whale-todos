# WP1 修订计划（WP0 实测后）

> 本文件只做**计划**，不执行任何 WP1 动作。依据：WP0 源码复核（`03-event-domain-verdict.md`）、验证报告（`01-verification-report.md`）、风险登记（`04-risks.md`）。需用户下一包授权后才开工。

## 与 Phase 0 WP1 的差别（为什么修订）

| 维度 | Phase 0 计划 | WP0 实测后修订 | 原因 |
| --- | --- | --- | --- |
| Event 域 | 「未见证据，V1 新增」 | **明确新建**，且必须先消除 `task_events` 同名误判 | 读 `schema.ts` 18 张表 + 路由/repo 全清单后确认 |
| 全天/重复 | 全部新增 | **部分复用 Task 语义**（`all_day`、`recurrence_*` 列已在 `tasks` 表），但日程是否改用 iCalendar RRULE 需 WP1 决策 | `schema.ts:39, 208-213` |
| 估工 | 4–6 人日 | **维持 4–6 人日**（Task 语义复用省一点，但新建 Event 域 + 路由 + 冲突 + 导入导出抵消） | 无新增阻塞证据 |
| 构建基线 | 假设 `pnpm test` 可跑 | **前置「构建环境修复」**：先解决 `@rolldown/binding-darwin-arm64` 原生二进制，跑绿 94 个测试再动业务代码 | WP0 build/test EXIT 1 |
| 依赖安全 | 未提 zod | **前置「zod ≥4.6.6 评估」**（dev-only high 通告） | `pnpm audit --json` |
| 版本锁定 | 写「v0.14.5 tag」 | 改为 **commit `29dc9ef3`**，并在所有文档标注 tag 名 404 | 实取时 `v0.14.5` 404 |

## WP1 目标（一句话）

在独立仓库里建立**可构建、可测试、可回退**的工程骨架，并新建与任务解耦的 **Event 日历域**（实体 + CRUD + RRULE/DST + 冲突 + 本地 ICS 导入导出），同时把 Task 与 Event 收敛到同一 `ctx.storageDomain` 数据层。

## WP1 拆分票（每张独立可验证、独立 commit）

| 票 | 内容 | 验收信号（可跑红绿） | 依赖 |
| --- | --- | --- | --- |
| **WP1-0 构建环境收口** | 已在 WP0 恢复 `@rolldown/binding-darwin-arm64` 原生二进制（`pnpm build` 已绿）；WP1-0 负责把该修复固化为可复现步骤、处理 **5 个上游既有失败**（`test/expertInstall.test.mjs` / `test/expertRecovery.test.mjs` 的 `ownerDbKey`/AX-E22/E23，本包未改测试）、评估 zod ≥4.6.6；跑 `pnpm test` 并达到 1339/1339（或给出经用户批准的显式豁免清单） | `pnpm typecheck` EXIT 0、`pnpm build` EXIT 0、`pnpm test` 全 pass 或有签字的豁免、`pnpm audit --prod` 仍 0 | WP0 完成 |
| **WP1-1 数据层契约** | 定义 Event / Task / Recurrence / Conflict / Audit 的 schema（zod 或 schemastery）、`ctx.storageDomain` 接入、schema 版本号与迁移/备份/回滚骨架；**统一写入口** | 单测 `test/schema.test.mjs` / `test/migration.test.mjs`：非法入参全拒、旧样本迁移字段全量一致、回滚可还原 | WP1-0 |
| **WP1-2 Event 域 CRUD** | 新建 `events` 表与 repo、Host service method、API 路由；与 `tasks` 解耦；支持全天、起止时间、标题、地点、重要度 | 单测 `test/events.test.mjs`：CRUD、独立创建与任何任务无关的日程、删除级联、参数校验 | WP1-1 |
| **WP1-3 重复与冲突** | 移植 `dsh-calendar/src/{time,ical,availability,availability-ical}.ts` 的算法层 + `ical.js` / `timezones-ical-library 2.3.2`，实现 RRULE 展开、DST、冲突检测、空闲时段 | 单测 `test/recurrence.test.mjs` / `test/conflict.test.mjs` / `test/dst.test.mjs`；移植时保留 MIT 头并登记 `LICENSES/ATTRIBUTION.md` | WP1-2 |
| **WP1-4 本地 ICS / JSON 导入导出** | 移植 `import-ical.ts` 的预览逻辑；实现 JSON 全量导出/导入/备份恢复，导入走同一 schema + 冲突预览 + 用户确认（草稿先预览再写入） | 单测 `test/import-export.test.mjs`：导出→清空→导入全量一致、坏文件拒绝且不破坏原数据、ICS VEVENT 预览条目正确 | WP1-1, WP1-3 |
| **WP1-5 Agent 工具与 UI 共用写入口** | `ctx.tools.register` 暴露 `workbench_*` 事件/任务操作；UI action 与 tool 调同一 Host method（`user-actions.md`）；删除/批量/外部写入走 `ctx.approval.request` | 集成测试 `test/ui-tool-parity.test.mjs`：同一操作分别经 UI 与 tool 执行，状态/返回/失败逐项一致；越权操作返回拒绝 | WP1-2 |
| **WP1-6 回归与门禁** | 复跑全部上游 94 测试 + 新增单测；`release-preflight.mjs` / `dev-verify.mjs` 接上；更新 README/ADR | `pnpm check` + `pnpm test` 全绿；`docs/adr/` 新增「Event 域与 Task 解耦」ADR | 全部 |

**并行**：WP1-2 与 WP1-3 的接口契约（Event DTO）先定可并行；WP1-4 依赖 WP1-1/1-3；WP1-5 在 WP1-2 冻结 method 签名后可与 1-3/1-4 并行；WP1-6 收口。

## 明确不做（留 V2/V3，WP1 不阻塞）

- 不引入 `src/caldav.ts` / `src/oauth.ts` / `tsdav` / `undici` 写路径（V3 外部日历）。
- 不实现 macOS 系统通知与三场景提醒验收（WP2/WP7）。
- 不实现拖拽 UI、项目分组、归档历史（WP5）。
- 不安装到任何 DSH profile；需要运行时只用隔离环境。

## 开工前置条件（缺一不启）

1. 用户对 WP1 的单独授权（本包 STOP 后等待）。
2. WP1-0 构建环境收口完成，94 个上游测试跑绿——**这是硬门**，否则无法用回归证明 Event 域改动没破坏基座。
3. 真实 Codex 额度已查（WP0 时 `hermes usage --json` 因安装目录锁失败，未取得），按用户偏好 15% 即停。
4. `LICENSES/ATTRIBUTION.md` 已就绪（WP0 已完成）。

## 估工（沿用 Phase 0，置信度提高）

约 4–6 人日（WP1-0 视网络 recovery 0.5 人日浮动）。WP0 未发现需要再上调的新缺口；反而因 `tasks.all_day` / `recurrence_*` 可复用语义，WP1-2/1-3 略有节省。
