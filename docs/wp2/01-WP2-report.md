# WP2 提醒系统与 Host 集成 — 交付报告

执行时间：2026-11-05（Asia/Shanghai）
状态：**WP2 完成，STOP，未进入 WP3**
测试：**133 / 133 pass，0 fail，0 skip**（WP1 收尾时 96，本包 +37）
演示：`node demo/demo.mjs` EXIT 0

## 一、前置检查结论（授权要求的三项）

### 1. 测试数量与 Git 提交状态

| 项 | 核对结果 |
| --- | --- |
| WP1 结束时实测 | 93（`docs/wp1` 曾写 92） |
| 文档修正 | `docs/wp1/01…`、`docs/wp1/02…`、`README.md` 已改为 93 |
| Git | 4 个 commit（`873e554` WP0 → `be98ab9` WP1-0 → `80164dc` WP1-1..5 → `d43326a` WP1-6），工作树干净、无 remote |

### 2. WP1 计划 vs 实际交付差账

见 `docs/wp1/03-plan-vs-actual.md`。三项差异：

| 计划 | 实际 | 性质 |
| --- | --- | --- |
| `ctx.storageDomain` | 未使用，改用零依赖原子 JSON 文件存储 | 主动取舍（隔离环境零安装可跑） |
| DSH Host 接线 | WP1 未接线（纯领域内核） | 计划内后续 → **本包开始接入** |
| UI/Tool 一致性测试 | 未实现（UI 尚不存在） | 完整 UI 留 WP4；本包用「同入口 + 审批门」保证 |

### 3. RRULE 月末语义与 RFC 5545 的差异

见 `docs/wp2/00-rrule-monthend.md`。**已修正为默认 RFC 合规**：

| 策略 | 行为（1/31 起 MONTHLY count=4） | 依据 |
| --- | --- | --- |
| `rfc`（默认） | `1/31 → 3/31 → 5/31 → 7/31` | RFC 5545 §3.3.10：非法日期实例 MUST be ignored，且不计入 COUNT |
| `clamp`（可选） | `1/31 → 2/28 → 3/31 → 4/30` | 本项目扩展，需显式传参 |

未知策略值抛 `validation`，**不静默回退**——避免「以为在用 RFC 其实在用扩展」。两条路径各有独立测试锁定。

## 二、实施内容

### 2.1 统一 ScheduleAdapter（Event + Task）

`workbench-core/src/schedule-adapter.js`

- 一套适配器同时处理 Event 提醒（含重复事件逐次发生）与 Task 到期提醒。
- **稳定幂等键** `reminderKey = sha256(kind|entityId|occurrenceKey|offsetMinutes)`：
  - 重复对账不产生重复提醒；
  - 事件改时间 → 旧键被取消、新键建立；
  - 事件删除 → 其提醒被取消（测试覆盖）。
- 双后端同一接口：
  - `memory`：隔离测试用，支持 `tick` 模拟到点；
  - `host`：包装真实 `ctx.schedule`（注入 `create/remove/list/history`），保留 `reminderKey → hostId` 映射。

### 2.2 优先集成 DSH 原生 ctx.schedule

| 证据 | 内容 |
| --- | --- |
| 契约探测（真实调用） | `schedule_create` 返回 `{id, kind:'after', title, prompt, afterSeconds, scheduledAt, state:'scheduled', deliveryMode:'host'}` |
| 初始态 | `schedule_list` → `[]` |
| 投递后 | 探测提醒到点后 `schedule_list` 回到 `[]`，即**投递即出队** |
| 适配器接入点 | `createHostBackend({create,remove,list,history})`，业务层不自己实现调度 |

### 2.3 提醒能力

| 能力 | 实现 | 测试 |
| --- | --- | --- |
| 提前提醒 | `leadMinutes`（默认 15） | `适配器：memory 后端按事件生成提前提醒` |
| 到期提醒 | `task-due`，跳过已完成/无 dueAt | `适配器：任务到期提醒` |
| 结束提醒 | `includeEnd: true` 时额外生成 | `适配器：includeEnd 时额外生成结束提醒` |
| 取消提醒 | `adapter.cancel(key)`，不存在抛 not-found | `适配器：取消单条提醒` |
| 重复提醒 | 按 `expandEvent` 的每次发生各生成一条 | `适配器：重复事件按每次发生生成提醒` |
| 重启恢复 | `createReminderRecovery().recover(plans, {scenario:'restart'})` | `场景 restart…` |
| 休眠恢复 | 同上，`scenario:'suspend'` | `场景 suspend…` |
| 退出恢复 | 同上，`scenario:'exit'` | `场景 exit…` |

### 2.4 审批：不信任 AI 传入的 confirmed

**这是本包最重要的安全改动。**

`workbench-core/src/approval-gate.js` + `service.js`：

- `payload.confirmed === true` **不再有任何授权含义**。
- 危险操作必须带 `meta.approvalToken`：由宿主签发、绑定操作指纹（`op + target + digest`）、带 TTL、**一次性**。
- 三种模式：`host`（真实宿主 `ctx.approval`）、`isolated`（测试，**必须显式 `allowIsolated:true`**，否则构造即失败）、`deny`（全拒）。
- 缺 requester → fail closed（不自动放行）。

### 2.4.1 自查攻防：抓到一个真实漏洞并修掉

写完之后我先自己攻了一遍审批门（**不把安全验证外包给 Reviewer**），抓到：

| 攻击 | 结果 |
| --- | --- |
| payload 里塞 `confirmed:true`（含同时塞 meta） | ✅ 拦下 |
| 已消费 token 重放 | ✅ 拦下 |
| 篡改 target 后使用凭证 | ✅ 拦下 |
| **拿「批准 A 文件」的凭证导入等长但内容不同的 B 文件** | ❌ **曾被绕过** |

**漏洞成因**：`import` / `snapshot.replace` 的指纹用的是调用方传入的 `digest`，而我最初写的是 `String(text.length)`——两段等长内容会得到同一指纹，审批实际只绑定了「长度」。

**修复**：服务层**自己按内容算 SHA-256**（`contentDigest`），内容类操作的 digest 一律不采信调用方传值。修复后该攻击被 `fingerprint-mismatch` 拦下。

已写成两条回归测试固化（`test/schedule.test.mjs`）：
- `攻击回归：等长但内容不同的 ICS 不能复用同一审批凭证`
- `攻击回归：摘要由服务层按内容计算，不采信调用方传入的 digest`

测试锁定：
- `审批门：凭证一次性，重放被拒`
- `审批门：凭证绑定操作指纹，不能挪用到别的操作`
- `审批门：凭证过期后失效`
- **`审批门矩阵：… payload 里塞 confirmed:true 不能绕过审批`**
- demo 里也有实证段落：`伪造 confirmed 被拒：confirmation-required`

### 2.5 恢复语义（明确的产品决定）

| 情况 | 行为 | 理由 |
| --- | --- | --- |
| 提醒仍在未来 | 恢复 | 正常 |
| 提醒刚过期但在 `graceMs`（默认 60s）内 | 补建 | 刚睡醒不至于漏 |
| 提醒已过去较久 | **不补发**，记为 `missed` 并给摘要 | 避免醒来被 N 条历史提醒轰炸 |
| 重复事件的未来实例 | 照常建立 | 不受历史影响 |
| 恢复重复执行 | 幂等（幂等键） | 不重复投递 |

`rebuildPlans` 默认**回溯 1 天**——否则过期提醒会被窗口直接裁掉，用户永远看不到「错过了 N 条」。

## 三、三场景实际结果（分别记录）

用独立 adapter（避免状态串味）+ 固定时间基准（可复算）。证据：`evidence/wp2/01-scenarios.log`

| 场景 | 设定 | restored | missed | 计划数 | 判定 |
| --- | --- | --- | --- | --- | --- |
| **restart** | 进程重启，从持久化重建（基准 T） | 2 | 0 | 2 | ✅ 未来提醒全恢复 |
| restart 幂等复跑 | 再跑一次 | 0 新增 | 0 | 2 | ✅ 不重复建立 |
| **suspend** | 休眠 3 小时后唤醒（T+3h） | 0 | 1 | 1 | ✅ e1 提醒已过期→不补发；e2 保留 |
| **exit** | 提醒到点前退出，1 小时后重开（T+1h） | 0 | 0 | 2 | ✅ 两条都在未来，无误判 |

错过摘要实测输出：`离线期间错过 1 条提醒：两小时后`

投递幂等：首次 `tick` 投递 1 条、重复 `tick` 0 条、`history` 1 条（与真实投递一致）。

> **过程诚实记录**：第一版 harness 三个场景共用一个 adapter，导致 suspend 已删掉 e1 的提醒，exit 场景读到的是被污染的状态（restored=1 而非 2）。**这是我的 harness 缺陷，不是业务代码错**；改为每场景独立 adapter 后全部符合预期。
>
> **证据链缺口（如实披露）**：第一版日志被第二版 `tee` 覆盖，**原样输出已不可追溯**；当前 `evidence/wp2/01-scenarios.log` 只保留修正后的干净对照。我没有保留失败版本作为证据，这是流程疏漏（应在首跑时就 `tee` 到带 `-v1` 后缀的文件）。结论以本表与当前日志为准，但「第一版确实跑出 restored=1」这一事实**只有本段叙述，没有原始日志佐证**。

## 四、`schedule.history()` 与真实投递一致性

| 验证 | 结果 |
| --- | --- |
| 适配器层 | `history()` 条目数 === 实际 `tick` 投递数（1 === 1）✅ |
| 宿主层 | 探测提醒到点后 `schedule_list` 由 `[…]` 变回 `[]`（投递即出队）✅ |
| 局限（如实说明） | 宿主 `schedule_history` 工具在本会话未暴露；宿主侧「投递记录」我只能通过 `schedule_list` 的状态迁移间接确认，**未直接读到宿主的 delivery history 明细** |

## 五、代码与测试

| 项 | 数量 |
| --- | --- |
| 新增模块 | `approval-gate.js`（审批门）、`schedule-adapter.js`（调度适配）、`reminder-recovery.js`（恢复语义） |
| 新增测试文件 | `test/schedule.test.mjs`（28）、`test/reminder-recovery.test.mjs`（9） |
| service 测试 | 20（含审批矩阵与 confirmed 绕过防护） |
| 全量 | **133 / 133 pass** |

## 六、风险与限制

| # | 风险/限制 | 影响 | 处置 |
| --- | --- | --- | --- |
| R1 | 未真正挂载到 DSH Host（无 `apply(ctx)` 插件入口） | 尚未能作为插件运行 | 本包交付「可注入的适配层」；挂载留后续工作包 |
| R2 | 宿主投递明细未直接读取 | `schedule.history()` 对账只到「状态迁移」层 | 已如实标注；待宿主暴露 history 后补 |
| R3 | `isolated` 审批若被误用于生产 = 审批失效 | 严重 | 已加构造期硬拦（必须 `allowIsolated:true`），并有测试 |
| R4 | 休眠/退出用固定基准模拟，非真实系统睡眠 | 未覆盖真实 OS 挂起 | 真实 OS 场景需 WP7 实机验收 |
| R5 | 文件存储非多进程安全 | 并发写覆盖 | 文档已声明；单用户单进程可接受 |
| R6 | 提醒不补发是产品决定 | 用户可能希望补发 | 已显式文档化 + 可调 `graceMs` |

## 六之二、独立 Review 状态（如实记录）

授权要求「独立 Review」。执行情况：

| 项 | 状态 |
| --- | --- |
| 已派出独立 Review 子 Agent（只读、审 `cebced2~1..HEAD` 全部 WP2 改动） | ✅ 已派出 |
| **取得 Review 结论** | ❌ **未取得**——子 Agent 结束但结论未回传（与 WP1 时的同样故障模式） |
| 替代措施：主会话自行对抗性自查 | ✅ 已完成，并**发现一处真实安全漏洞**（等长不同内容复用审批凭证），已修复 + 回归测试固化 |

**结论**：本包的「独立 Review」环节**没有拿到第三方结论**。为避免把它说成已完成，这里明确标注为未闭环项；需要人工或重跑 Review 补充。**我没有把自查冒充成独立 Review。**

## 七、红线合规

| 红线 | 结果 |
| --- | --- |
| 不装正式 DSH profile | 未调用 `plugin_manager` / `dsh plugin add` |
| 不动用户数据 | `~/.dsh/workbench` 不存在；探测提醒属本会话自建，测完自然出队 |
| 不 push 远程 | `git remote` 为空 |
| 不改上游测试 | `upstream/.../test/` 零改动 |
| 不调用 Codex | 全程 DSH 工具 + 子 Agent |
| 不伪造 PASS | 第一版 harness 缺陷已如实记录；宿主 history 未读到已标注 |

## 八、STOP

WP2 完成（提醒与 Host 适配）。**完整 UI 留给后续工作包**（原计划分工不变）。未进入 WP3。
