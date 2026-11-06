# WP4 审批模型与宿主边界（重要，请先读）

## 1. DSH 的真实约束

`@deepseek-ai/dsh-user-approval` 的 `request(req)` **只能在模型回合内发起**：

> `dsh-user-approval/README.md:153` —
> "Requests are valid only inside an open turn — an idle or between-turn caller
> throws before auditing; a durable out-of-turn approval workflow is deferred."

真实现可复现（`evidence/wp4/11-user-confirm-out-of-turn.log`）：

| 场景 | `approval.request` 结果 |
| --- | --- |
| turn 开着（只有 `turn/start`） | `allowed-once`，写 `approval/asked` + `approval/decided` |
| **turn 已闭合**（用户看完 AI 回答后的常态） | **抛错** `approval.request() outside an open turn`，waterfall 调用 0 次 |
| 全新会话（无事件） | 同上，抛错 |

## 2. 因此 WP4 有两条授权来源，都由宿主签发凭证

| 发起方 | 授权来源 | 凭证签发方 | 适用 op |
| --- | --- | --- | --- |
| **AI / 模型** | DSH `ctx.approval.request`（回合内有效） | 真 `ApprovalService` | 全部危险 op |
| **UI 用户** | 用户在确认对话框**显式点击**「删除」 | **宿主**（`approval-gate.issueForUserConfirm`） | 仅 `DANGEROUS_OPS` 内的破坏性 op |

### UI 侧凭证的约束（与 WP2 审批门同一套机制）
- 指纹绑定 `(op, target, digest)` → 挪用到别的目标 = `fingerprint-mismatch`
- **一次性** → 用第二次 = `confirmation-required`
- 宿主签名（issuer nonce）→ 浏览器/模型**无法离线构造**
- `payload` 里的 `confirmed` 布尔**永远没有授权含义**
- **签发侧不采信调用方自选的 digest**（`issueForUserConfirm` 用固定空 digest）：
  调用方自带的 digest 一律忽略。
  - `event.import` / `snapshot.replace`：摘要在**执行侧**由服务端从内容重算
    （`contentDigest(text)`），与签发侧的固定空摘要不符 → 换出的凭证**用不了**。
  - `store.rollback`：执行侧指纹是 `{op, target: 备份名, digest: undefined}`，
    与签发侧 `{op, target: 备份名, digest: ''}` **匹配** → 凭证**可用**。
    它的风险来自「回滚会丢数据」本身，而不是摘要不符。
- 限制在 `DANGEROUS_OPS` 内 → 不是万能钥匙（`event.list` / `task.list` / `event.create`
  等非危险 op 拿不到）。
  ⚠️ 但要说清楚：`snapshot.replace`、`event.import`、`store.rollback`、`event.restore`
  **也在** `DANGEROUS_OPS` 内，因此**可以**为它们签发用户确认凭证。
  风险来源各不相同：`event.import` / `snapshot.replace` 被「执行侧服务端重算内容摘要」
  挡住；`store.rollback`（回滚丢数据）与 `event.restore`（复活已删数据）**不被摘要挡住**，
  它们的约束是「必须由用户在 UI 明确确认」这一交互前提 —— 见 §4 的残余风险。
- **不在 AI 工具面**：`workbench-core/src/host-tools.js` 未暴露 `confirmUserAction`
- 删除落审计（`events.remove` 内部写 `store.audit`）

## 3. 与官方范式的关系（不夸大）

官方 `@deepseek-ai/dsh-client-ui-schedule` 的删除是
**纯 UI 确认对话框 → 直接 `ctx.remote.schedule.delete(...)`**，
**没有 token、没有宿主审批**（其 Host Schedule 服务没有审批门）。

WP4 的做法**不比官方弱**：凭证仍由宿主签发、绑定 op+target、一次性、不可伪造，
并额外落审计。差别在于我们的 Host Service 本来就有审批门（WP2 的硬要求），
所以 UI 侧必须显式走一次凭证。

## 4. 诚实登记的残余风险

**纯软件无法区分「用户点了确认」与「任意调用方直接索要凭证」**——
只要某段代码能调 `ctx.remote.commands.execute(sessionId, '/workbench <json>', [])`，
它就能换出一张删除凭证。这是宿主契约的边界（官方同样如此，且更弱：它连凭证都没有）。

本包采取的收敛措施：
1. 凭证仅限 `DANGEROUS_OPS`；
2. 不在 AI 工具面暴露；
3. 命令需结构化 JSON（误敲命令面板不会产生有效载荷）；
4. 全部删除落审计，可事后追查。

**未取得的证据**：本包没有在真实浏览器里验证「未经用户点击的第三方脚本能否调用
commands 通道」——该路径依赖 DSH 的 Client 信任边界与浏览器同源策略，
本会话无浏览器控制（见 `docs/wp4/01-final-report.md` §5）。列为 **UNVERIFIED**。

## 5. 复核命令

```bash
# 真 ApprovalService 的回合约束
node /tmp/turn-e2e.mjs   # 场景 A/B/C

# 宿主签发的用户确认凭证：回合外删除成功
node /tmp/wp4-userconfirm-e2e.mjs
cat evidence/wp4/11-user-confirm-out-of-turn.log

# 约束的回归测试
cd workbench-core && node --test test/workbench-ui-bridge.test.mjs
```
