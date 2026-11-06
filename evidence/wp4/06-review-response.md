# WP4 最终 Review 响应（REQUEST CHANGES → 修复）

两路独立 Review（子 Agent 2bd05c72 + workflow wp4-final-review）一致判
**REQUEST CHANGES**，合并去重后 **5 个 blocker**。审查期间被审版本 `1a2c7ef`
未改（开始/结束 HEAD 相同，`diff -rq` 冻结副本与 `git archive` 一致）。

## 5 个 blocker 与修复

| # | 指认 | 修法 | 实证 |
| --- | --- | --- | --- |
| ① | `callHost` 把真 Remote 信封 `{ok:true,value:{commandId,result:{kind,text}}}` 当业务文本 → 真浏览器里 UI 静默空列表、命令级 error 被吞 | 先取 `value.result.text` 再 JSON.parse；`kind:'error'` 有明确出口 | 新增测试「真 Remote 信封必须解出业务数据（旧扁平解码会失败）」；bridge 测试的 `makeHost.execute` **改用真信封**（不再是 mock 扁平信封） |
| ② | `main` 是 root-scope keyed slot，inject **零参**，拿不到 sessionId → `No active session`，UI 数据链全断 | sessionId 改从 `ctx.sessions.list.getSnapshot().byId` 中 `retainedBy.mainView>0` 的行取 `.id`（`dsh-client-ui-workspace:89`），`useEffect` 订阅切换；`inject` 改无参，依赖补 `sessions` | 新增「main root-scope inject 零参」测试，静态断言 client.js 不再依赖 inject 首参、已声明 sessions |
| ③ | `task.delete` 不在 `service.listOps()` → 待办删除必失败；`requestApproval('task.delete')` 还返回无 token | 待办删除改 `task.upsert` 打 `deleted/deletedAt` 软删标记；审批用真实 `event.delete` 指纹 | 静态断言不再出现 `task.delete`；bridge 真 apply 复现旧 op 返回 unsupported（记录） |
| ④ | `requestApproval: approval?.request` 裸抽出丢 `this` → 真 `ApprovalService.request` 抛 `reading 'decide'` | 传保留 receiver 的箭头 `(req)=>approval.request(req)` | **真 ApprovalService + open-turn session 端到端**：`approved:true` + token + 审计 `approval/asked,approval/decided`（`evidence/wp4/05`） |
| ⑤ | `TaskForm` 编辑只重建 6 字段 → `subtasks`/`sourceSessionId` 静默丢失 | `onSave({...(initial??{}), ...})` 展开全字段 | 新增静态断言 + 既有「子任务与 AI 会话关联」测试仍通过 |

**最刺痛的一条**：① 的旧 bridge 测试用**假信封**让 8/8 全绿，恰好掩盖真运行时失败——
正是授权红线「不得用模拟接口冒充真实宿主」要防的。已把测试信封换成真形状。

## 一并处理的 nit
- `TaskForm` 编辑字段丢失（同上 ⑤，Review 列为 nit，按数据丢失从严处理）。
- 报告诚实性：子 Agent 指出 `desktop/cordis.patch.yml` mtime 晚于基准但无
  `workbench-ui` 行，未被证伪；本报告仍只声称「无 workbench-ui 行」。
- 本地化、`MonthView.onSelectEvent` 未调用等 nit 登记未改（不阻断，见 §7）。

## 修复后回归
- 单测 **261/261**（新增 4 条针对性测试：真 Remote 信封 / main inject 形状 /
  待办删除与审批绑定 / TaskForm 字段保留）
- 变异 **36/36**（0 真空 0 跳过）
- 门禁 **8/8**
- 隔离 boot 复核：零错误、零 did-not-activate（`evidence/wp4/04`）
- 真 ApprovalService 端到端：`approved:true` + token（`evidence/wp4/05`）
- 正式 `desktop` profile 未改、0 remote、未 push

## 仍 UNVERIFIED（不因修复而清除）
Client 浏览器渲染、深浅色截图、窗口缩放、真实点击/键盘、浏览器网络层
`ctx.remote.commands.execute` 本身；macOS 通知/休眠、exactly-once、多进程、
O(N²)/线性性能。理由见 `references/verification.md` 与 `docs/wp4/01-final-report.md`。

## 下一步
按授权「最终冻结 Commit 后开展独立 Review，禁止在审查过程中修改被审版本」：
重新冻结新 commit，再派一轮独立 Review 复核这 5 条修复。
