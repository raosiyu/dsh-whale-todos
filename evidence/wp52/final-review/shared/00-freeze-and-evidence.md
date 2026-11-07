# WP5.2 最终独立 Review · 冻结与证据基线

## 冻结对象

| 项 | 值 |
|---|---|
| commit | `e9b2b329b50c7e69f29d873da090c928528e61a5` |
| 标题 | `WP5.2 验收收尾：真实投递验证、身份安全与全量测试转绿` |
| 推送 | `9f44644..e9b2b32` → `origin/main`，非 force |
| 冻结方式 | `git archive e9b2b329 \| tar -x -C /tmp/wp52-freeze-e9b2b32` |
| 快照 tree digest | `131e8c74bcbd21d1dc23ea480b0cdc2c716cfb9e` |
| 快照属性 | 无 `.git`、`chmod -R a-w`、纯快照 |

复核命令（审查结束时再跑一次，digest 必须一致）：
```
cd /tmp/wp52-freeze-e9b2b32 && find . -type f | sort | xargs shasum | shasum
```

## 复用的既有证据（不重复全量研究）

| 文件 | 内容 |
|---|---|
| `evidence/wp52/01-mutation.log` | 135/135 CAUGHT，0 VACUUM，0 SKIP |
| `evidence/wp52/02-delivery.md` | 真实投递、SIGSTOP/SIGCONT 补投、审查处置、UNVERIFIED 清单 |
| `evidence/wp51/02-delivery.md` | WP5.1 的 `ctx.schedule` 接口核实与幂等导入 |

### 已确立的事实（审查前提，不再重跑）

1. **真实投递**：`after_seconds` 提醒到点后，消息进入原 Session 的
   `user/message`（`source:{kind:"schedule"}`），`deliveryHistory.records` 有
   `{scheduledAt,deliveredAt,messageId}`；`user/message` 仅 1 次，无重复投递。
2. **休眠唤醒补投**：SIGSTOP 跨过触发点 50s 零投递；SIGCONT 后 27ms 补投，
   迟到 1m38s；`status: active → inactive`。Host 的 `drive()` 负责，
   故本层不叠加自建恢复（避免重复消息）。
3. **全量测试**：437/437 pass，0 fail，0 skipped（连续 3 次稳定）。
4. **host-approval-real**：2/2 通过，真 ApprovalService、无 skip；直接断言
   `approvalProjectionHandle.stateOf` 可用。
5. **变异**：135/135 CAUGHT，0 真空，0 跳过。

## 本轮审查分工（作用域互不重叠）

| Agent | 范围 | 证据目录 |
|---|---|---|
| A | 所有权白名单 / 误删保护 / 持久化恢复 | `final-review/agent-a/` |
| B | 跨 session-scope 隔离 / 投递去重 / Host 审批安全 | `final-review/agent-b/` |

两者均须产出 `verdict.md`，**第一行为 `APPROVE` 或 `REQUEST CHANGES`**。

## 保持 UNVERIFIED（已知且已披露，不构成 blocker）

真实 macOS 睡眠、系统通知横幅、VoiceOver、拖拽排序、原生文件选择器、窄屏视觉、
重启后未被打开的老会话。详见 `02-delivery.md` §6。

## 本轮红线

- 冻结副本只读；**不修改任何业务代码**
- 不重复无价值的全量研究
- 独立 Agent 必须明确裁决，不得以「建议」「待确认」替代
