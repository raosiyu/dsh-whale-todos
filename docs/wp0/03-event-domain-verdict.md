# WP0 事件域验证结论（源码级）

验证时间：2026-11-05（Asia/Shanghai）
验证对象：`upstream/dely0-v1.17.2`（v1.17.2 tag 源码）、`upstream/dsh-calendar-0.14.5`（commit 29dc9ef3）
口径：Phase 0 已有明确缺失证据（GitHub tree + 蓝军复核），本包**不做无意义的重复落库实测**，改为「真实源码正文复核」，把结论从文件名推断升级为代码事实。

## 结论（一句话）

**Dely0 v1.17.2 具备「任务的全天/重复/截止时间」能力，但不具备「与任务解耦的独立日程 Event 实体 + CRUD + 真实日程功能」。** 双源方案（Dely0 任务/AI 基座 + dsh-calendar 日历域移植）成立，WP1 日历域按自研/移植估工有效。

## 一、容易误判的同名陷阱（本轮最重要的修正）

`src/db/schema.ts:94` 有一张 `task_events` 表，名字里带 event，但它是**任务验收事件流水**，不是日程事件：

```sql
CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_code TEXT NOT NULL,       -- 'completion_rejected' / 'completion_deferred'
  before_json TEXT, after_json TEXT,
  actor TEXT NOT NULL DEFAULT 'user',
  note TEXT, at TEXT NOT NULL
) STRICT;
```

`src/db/repo/progress.ts:131-136` 证实其用途：`listTaskEvents()` 过滤 `completion_rejected` / `completion_deferred`，用于「第 N 次验收提交（此前被驳回 X 次、暂存 Y 次）」的话术。`src/shared/contracts.ts:81` 的 `TaskDetailView.events` 也是同一份验收流水。
**结论：`task_events` ≠ 日程事件。若按名字判断会误判「已有事件域」。**

## 二、Dely0 实际具备的能力（源码事实）

| 能力 | 证据 | 说明 |
| --- | --- | --- |
| 任务持久化 | `schema.ts:29` `CREATE TABLE tasks (...)`，STRICT 表；`src/db/database.ts` 管理 `schema_version` | 有本地持久化，且做过 schema 18→19 迁移 |
| 全天（任务） | `schema.ts:39` `all_day INTEGER NOT NULL DEFAULT 0`；`contracts.ts:43` `allDay: boolean`；`src/tools.ts:162` `all_day` 参数 | 是 **Task 的属性**，不是独立事件 |
| 重复（任务） | `schema.ts:208-213` 迁移给 `tasks` 加 `recurrence_code / recurrence_rule / recurrence_master_id / recurrence_last_generated`；`src/db/repo/recurring.ts` | 周期任务，非日程 RRULE/VEVENT |
| 任务 CRUD | `src/api/routes/tasks.ts`、`src/db/repo/tasks.ts` | 完整 |
| 任务提醒 | `schema.ts:56` `task_reminders`、`src/api/routes/reminders.ts`、`src/reminder/*` | 自管定时器 + 补发幂等设计 |
| 日历视图 | `src/client/views/CalendarView.tsx` 头部注释：「选中某天 = 同一个日期面板（ADR 0001 / D15）」；props 为 `tasks: Task[]` | **周/月格子 + 任务日期面板**，不是日程渲染 |
| 任务与日期关联 | `DayPanel.tsx`、`dayPanelModel.ts`、v1.16.1/1.16.2 发布说明 | 按「当日到期 ∪ 当日计划项 ∪ 进行中」组织 |

## 三、Dely0 明确缺失的能力（源码事实 + 文件树反证）

| 缺失项 | 反证 |
| --- | --- |
| 独立 Event 实体 / 表 | `schema.ts` 全部 18 个 `CREATE TABLE` 中无 `events`；仅 `task_events`（验收流水） |
| 事件 CRUD 路由 | `src/api/routes/` 14 个路由文件无 `events` / `calendar` |
| 事件 repo | `src/db/repo/` 21 个文件无 `events.ts` |
| 日视图 / 议程视图 | `src/client/views/` 9 个视图无 Day/Agenda；`CalendarView.tsx` 仅 `calMode: 'week' \| 'month'` |
| 日程冲突检测 | 全 `src/` 搜索 `conflict` 仅命中 SQL `ON CONFLICT` 与专家草稿 `draft-version-conflict`、`skill-conflict`；无日程冲突 |
| 空闲时段 / availability | 全 `src/` 无 `availability` 模块；仅 `test/teamMemoryAvailability.test.mjs`（团队记忆，无关） |
| 拖拽调整日期时间 | 全 `src/` 无 dnd/drag 模块；README 路线图明确未做 |
| 时区 / DST / RRULE 展开 | 全 `src/` 无 timezone 模块；`recurrence_rule` 是任务侧的 JSON，非 iCalendar RRULE |
| 真实日程（与任务无关的会议/约会） | 无法创建：`tasks` 表要求 `type_code/status_code/priority_code`，日程必须伪装成任务 |

## 四、对照：dsh-calendar 0.14.5 恰好提供缺失零件

| 零件 | 文件 / 测试 |
| --- | --- |
| VEVENT / ICS 解析与导入预览 | `src/ical.ts`、`src/import-ical.ts`（`getAllSubcomponents('vevent')`、`recurrence-id`、`VTIMEZONE` 校验）、`test/{ical,import,expand,series-safety}.test.mjs` |
| 时区 / DST | `src/time.ts`、`timezones-ical-library 2.3.2`、`test/{schedule-dst,draft-time-dst,time-validation}.test.mjs` |
| 全天 / 重复 / 冲突 / 空闲 | `src/caldav.ts:111`「expand 为 true 时展开 RRULE」、`:306/:319` VEVENT、`:376-377` `allDay`/`rrule`；`src/availability.ts:60` `if (event.allDay)`；`src/availability-ical.ts`；`test/availability.test.mjs` |
| 参数校验 | `src/parameters.ts` + `test/parameters.test.mjs` |
| 凭据不明文 | `cordis.patch.yml` 注释推荐 `DSH_CALENDAR_CLIENT_SECRET` / `DSH_CALENDAR_REFRESH_TOKEN` / `DSH_CALENDAR_PASSWORD` 环境变量；`lib/client.js:2190` `SECRET_FIELDS` 脱敏白名单 |
| 月/周/议程视图 | `src/web.ts`、`templates/client.js`、`templates/workbench-ui.js`、`test/render.test.mjs` |

**注意**：dsh-calendar 是 CalDAV 客户端（需自备账号），其事件模型围绕远端日历；V1 只移植「本地事件模型 + 算法层」，不引入 `src/caldav.ts`/`src/oauth.ts`/`tsdav` 写路径（V3）。

## 五、对 Phase 0 结论的修订

| 项 | Phase 0 判定 | WP0 源码复核 | 影响 |
| --- | --- | --- | --- |
| 独立 Event 实体 | 「未见证据」 | **明确缺失**（18 张表无 events，路由/repo 全无） | WP1 必须新建 Event 域，4–6 人日估工成立 |
| 全天事件 | 「未见证据」 | **部分**（Task 已有 `all_day`，可直接复用语义；日程需独立字段） | 模型可复用 Task 语义，略省 |
| 重复事件 | 「未见证据」 | **部分**（Task 有 `recurrence_*`，但非 iCalendar RRULE） | 需决定：沿用 JSON 规则 or 移植 RRULE，WP1 定 |
| `task_events` | 未识别 | **验收事件流水，非日程** | 消除最大误判风险 |
| 双源方案 | 成立 | **成立** | 不改写 |

## 六、WP0 门禁判定

**PASS（可进入 WP1 规划）**：已锁定精确版本、源码级确认事件域缺失、依赖与许可证核实、署名保留、独立 Git 基线。唯一未做的是「在 DSH 里落库实测」——按授权要求第 4 条，已有明确缺失证据，不做重复测试；且无 DSH 运行需求（未安装到任何 profile）。
