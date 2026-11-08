# WP6-C 交付证据：Agent 会话关联 / 进度回写 / 人工验收

> 基线 `7eabf55`（WP6-B）。数据层（会话关联、进度、验收 op）在 WP6-A
> 已落地；本阶段交付**上层协作链路**与真实边界核实。

## 1. 「从任务详情进入 Agent 会话」的契约结论（一手核实，不粉饰）

查 `app.asar` 一手源码：
- `dsh-client-ui-session` 的 `uiSession` controller 只暴露
  `bindingSource` / `whenAccess` / `provide`，**没有会话跳转/激活方法**；
- `dsh-schedule/lib/index.js:1955` 明确「management reads and writes
  never activate a Session, and only delivery creates or resumes one」；
- GUI 会话切换属于 Web shell 路由层（`window.__DSH_BOOT__`），插件层
  **没有可靠的一手契约**。

因此不自造 `openSession` 之类假接口。落地为插件层可可靠实现的形态：

| 用户意图 | 真实落地 |
|---|---|
| 任务关联会话 | `task.linkSession` / `sessionLinks[]`（已完成） |
| 从任务详情进入会话 | 任务详情**展示关联 sessionId**（可复制、作为会话标识）；UI 在 WP6-D 做 |
| Agent 读授权任务上下文 | **`task.context`**（本阶段新增只读 op） |
| 执行结果回写进度/证据 | `task.writeProgress`（已完成） |
| AI 申请完成、用户验收 | `requestCompletion` / `acceptCompletion` / `rejectCompletion`（已完成） |
| 禁止 AI 自行完成/删除/覆盖 | AI 工具面无危险工具（测试锁死） |

> 诚实说明：「点击按钮切换到那个 GUI 会话」无插件层契约，
> **保持 UNVERIFIED**，不伪报 PASS。

## 2. 本阶段新增

| 项 | 落点 |
|---|---|
| `task.context` 只读 op | `proposal-ops.js`：传自己的 sessionId，返回关联任务的投影 |
| `workbench_task_context` AI 工具 | `host-tools.js`（第 27 个工具） |
| 契约补充 | `docs/wp6/00-contract.md` §7 |

`task.context` 权限红线：
- `payload.sessionId !== meta.sessionId`（invoke 受信任注入）→ `conflict` 拒绝；
- 只返回**该会话关联**的任务；
- 投影只含必要字段 + 最近 5 条执行记录 + 自己那条 role；
- **不返回** `sessionLinks` 里其他会话的 sessionId 明细；
- 返回 `sessionId:'[self]'` 脱敏，不回显原文。

## 3. 端到端链路（真实 service 测试，7/7）

```
用户建任务 + setEstimate + linkSession(A:execute, B:review)
  → Agent A 调 task.context 读到授权上下文（progress=0, completion=null）
  → A 回写两次进度 + 证据（30→80）
  → A 调 task.context 看到 progress=80、recentLog 2 条
  → A 提交 requestCompletion（done 仍为 false，completion=pending）
  → 用户 acceptCompletion → 才 done=true、decidedBy='user'
  → 重新 open 同一目录：关联 2 条、执行记录 2 条、done=true 全不丢
```

并发验证：A/B 交替回写进度 → `executionLog` 4 条全在、顺序 A1/B1/A2/B2，
不互相覆盖，两条会话关联都保留。

## 4. 安全红线（全部有测试 + 变异）

| 红线 | 测试 |
|---|---|
| 跨会话越权读上下文 | B 传 A 的 id → `conflict`；B 传自己 id → 空集 |
| 上下文不泄露其他会话 | `raw.includes(B) === false`；roles 只含自己那条 |
| AI 不能自行完成 | `requestCompletion` 不置 done；进度上限 99；工具面无完成工具 |
| 用户验收才可完成 | 无 pending 申请时 `acceptCompletion` 被拒 |
| 驳回可再次申请 | reject 带 feedback → 再 request → 再 accept |
| 危险工具不注册 | 9 个危险工具名逐一断言不存在 |

## 5. 测试与变异

| 项 | 结果 |
|---|---|
| 全量回归 | 488 / 488 pass，0 fail 0 skipped |
| WP6-C 专项（`collaboration-wp6.test.mjs`） | 7 / 7 |
| 变异验证 | 见 `01-mutation-C.log` |

## 6. 未做（留给后续阶段）

UI 任务详情的会话关联展示 / 进度展示 / 验收入口（WP6-D）。
真机 GUI 会话切换无契约，保持 UNVERIFIED。

## 7. UNVERIFIED（保留）

真实 macOS 睡眠、系统通知横幅、VoiceOver、拖拽排序、原生文件选择器、
窄屏视觉、重启后未被打开的老会话、**GUI 会话跳转（无插件层契约）**。

## 8. 变异首轮 VACUUM 处置

首轮 158 CAUGHT / **1 VACUUM**（WP6C6：`task.context` 返回 sessionId 原文）。

根因：初版测试只断言「不出现**别的**会话 id B」，没断言「不回显**自己**
的 sessionId 原文」。变异返回 `b.sessionId` 后，测试仍全绿 → 真测试缺口。

处置：补两条断言
- `raw.includes(A) === false`（不得回显调用方自己的 sessionId 原文）
- `ctx.sessionId === '[self]'`（必须脱敏）

注入实测 `pass 6 / fail 1`，确认能被抓到。**没有删变异凑数字**。
