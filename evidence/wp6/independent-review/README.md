# 独立方裁决（范围：单条不变量）

## 来源
独立 subagent `0136e4bc-a9b4-4460-9664-65d8a92a377d`，2026-11-09。
脚本 `verify.mjs` 由其本人编写（落盘 /tmp/v9/，实施方未改一行），
`verify.log` 为实测输出。

## 裁决：**PASS**（原文）
> VERDICT: PASS

## 它验证了什么
不变量：同一审批凭证不能跨内容复用（`task.upsert` 删除场景）。

| 检查 | 实测结果 |
|---|---|
| 篡改 payload 内容 | `confirmation-required` / `fingerprint-mismatch` |
| 篡改后无副作用 | 列表仍 `["b1:原始:low"]`，未被删 |
| 对照（内容一致） | 成功，b1 真被删，列表变空 |
| 重放同一 token | `unknown-token` 被拒（一次性） |

它的判断依据：`fingerprint-mismatch` 而非 `unknown-token`，说明 token 被识别但
内容对不上——这正是「绑定内容」而非「随便拒」的证据。

## 它明确声明**未**覆盖（原文摘要）
- 只测了 `task.upsert` 一条链路，其他危险 op 是否同样做指纹绑定**未知**
- 未测并发双请求抢同一 token
- 未测指纹算法的具体字段集合（只改 project、多传未知字段是否算 mismatch）
- 未测 `approvalMode` 非 `deny` 时的行为
- 未做大幅代码审查，未读 evidence 报告

## 结论的边界（不得越读）

这是**一条不利量的独立验证**，不是对 WP6 的完整独立复审。
完整复审（A~E 五阶段、UI 集成、提案两阶段、失败安全、undo 范围）**仍未达成**。
不得据此声称「WP6 已通过独立复审」或填写全面 APPROVE。
