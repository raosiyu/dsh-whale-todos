# WP6-E 交付证据：端到端真实验收

> 基线 `e9ceab5`（WP6-D）。探针 `probe-wp6-e2e.mjs` → `probe-wp6-e2e.log`。

## 验收结论

**44 / 44 PASS，0 FAIL。**

真实 service（真 store / 真审批门 / 真磁盘），不 mock 业务层，可复跑：

```bash
cd evidence/wp6 && node probe-wp6-e2e.mjs
```

## 完整链路（用户要求的主路径）

```
自然语言「准备下周发布会：写稿件、约场地、发邀请」
  → plan.suggest：拆解 3 条子任务 + 4 条日程建议（基于真实 freeSlots）
  → 生成提案时业务数据零变化
  → 无 token 落地被拒
  → 用户确认（Host 一次性审批 token）→ 落地 created>0
  → 磁盘核对：tasks/events 确实写入
  → task.linkSession 关联 Agent 会话
  → Agent task.context 读到授权上下文（不含其他会话）
  → 回写进度 50→90 + 证据
  → requestCompletion（done 仍 false，completion=pending）
  → 用户 acceptCompletion → done=true、decidedBy=user
```

## 逐项验收结果

| 组 | 检查 | 结果 |
|---|---|---|
| E1 完整链路 | 19 项（提案生成/零变化/审批/落库/关联/上下文/进度/验收） | 19 PASS |
| E2 重启 | 任务数、会话关联、验收状态、执行记录均保留 | 4 PASS |
| E3 AI/UI 一致 | 同 scope 读到一致任务集；双向写入互见 | 3 PASS |
| E4 拒绝 | tasks/events 完全不变；状态 rejected；已拒绝不能落地 | 3 PASS |
| E5 并发 | 进度不互相覆盖、关联都保留、重复 apply 被拒、只建 1 条 | 5 PASS |
| E6 审批 | 4 个危险 op 无 token 全拒、confirmed 不采信、进度 100 被拒、无申请不能完成 | 7 PASS |
| E7 失败 | 目标不存在时失败、现有任务未破坏、无关提案不受影响 | 3 PASS |

## 验收中发现并修掉的真缺陷（3 个，均为产品语义问题）

### A. 提案只能由创建者确认 → AI 协作主路径不可用

`verifyProposalBinding` 硬校验 `proposal.sessionId === 调用方 sessionId`。
而主路径是 **Agent 生成提案、用户在 UI 确认**，两者 sessionId 必然不同 →
实测 `conflict/session-mismatch`，整条链路在真实使用中直接不可用。

**修复**：sessionId 不再作为拒绝条件。安全边界未放松：
- 落地必须带 Host 签发的一次性审批 token（只有真人在 UI 点确认才签发）；
- scope 必须一致（跨 scope 仍拒绝）；
- baseVersion/baseDigest 仍绑定，防确认后数据替换。

### B. `proposal.list` / `get` / `reject` 按 sessionId 过滤 → 用户看不到 Agent 的提案

同源问题。**修复**：改为按 **scope** 隔离 —— 同 scope 跨会话可见（产品要求），
跨 scope 仍不可见（真正的越权边界）。

### C. `store.rollback` 参数校验先于审批校验（探针误报，非缺陷）

首轮 E6.1 报告 `store.rollback` 未按预期拒绝，实测是探针传了 `{id}` 而非
`{name}`，先被参数校验拦住（`validation`）。传正确 `name` 后确认审批正常：
```
rollback 无 token → confirmation-required | 危险操作 store.rollback 需要宿主审批凭证（missing-token）
```
**如实记录为探针参数错误，未包装成产品缺陷。**

## 安全边界复核（未因上述修正放松）

| 边界 | 证据 |
|---|---|
| 危险 op 必须带 token | E6.1 4 个 op 全拒 |
| `payload.confirmed` 不被采信 | E6.2 |
| AI 不能自行完成 | E6.3 进度 100 被拒；E1.15/16 requestCompletion 不置 done |
| 用户验收才可完成 | E1.18/19；E6.4 无申请不能完成 |
| 跨 scope 越权 | 跨 scope 的 list/get/apply 全部拒绝 |
| 失败回滚 | E7.2 现有任务未被破坏 |

## UNVERIFIED（保留，不伪报）

真实 macOS 睡眠、系统通知横幅、VoiceOver、拖拽排序、原生文件选择器、
窄屏视觉、重启后未被打开的老会话、GUI 会话跳转（插件层无契约）。
