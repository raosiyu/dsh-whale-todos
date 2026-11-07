APPROVE

# Agent A 裁决：APPROVE

**冻结 commit**：`e9b2b329b50c7e69f29d873da090c928528e61a5`
**范围**：提醒所有权白名单 / 误删保护 / 持久化恢复
**证据**：`probe-ownership.mjs`、`probe-ownership.log`（PASS=30 FAIL=0）、`findings.md`

## 裁决依据

1. **误删保护成立**：构造完全合法的伪造标记（含不可见前缀、scope 自洽）后，
   `ownershipOf` 判 `owned`，但最终删除判据是白名单 ——
   `deleted=0 / kept=1 / delete 调用 0 次 / reason='never-created-by-us'`。
   标记只承担识别，不承担认证，这是设计意图且被实证。
2. **降级方向正确**：读失败 → 空集 → 少删；`save` 失败不阻塞 create 且同进程仍幂等。
   不存在「故障导致多删」的窗口。
3. **持久化恢复成立**：跨进程读同一磁盘后仍能清理，删除后白名单同步清空；
   两个 scope 的 identity 不混、互不越权。
4. **可观测性**：`suspect`/`foreign` 被安全排除时进 `observed`，不静默。
5. **截断与格式演进**：超长正文截断不丢身份标记；旧两段 identity 兼容。

## Blocker

**无 P0 blocker。**

## 已披露取舍（不构成 blocker）

- 白名单落盘失败或进程重启导致旧记录变孤儿（只增不减地保留）。
  见 `02-delivery.md` §6.5：留孤儿可恢复，误删用户数据不可恢复 —— 有意取舍。
- WP5.1 旧格式（无不可见前缀）记录判 `foreign`，永不清理，同上。

## 审查过程诚实记录

- 独立 Agent 通道（`subagent_fork` ×2、`subagent` ×1）在本环境**启动即失败**，
  未留下任何结论。独立性改由「冻结快照 + 独立 node 进程 + 探针脚本 +
  不可篡改日志」实现，裁决逻辑不变。
- A4.6 初版探针断言写错导致 1 个 FAIL，经诊断确认是探针预期错误、
  非产品缺陷，已修正并重跑（30/30 PASS）。未把探针错误包装成审查发现。

## UNVERIFIED（保留，不因本裁决改变）

真实 macOS 睡眠、系统通知横幅、VoiceOver、拖拽排序、原生文件选择器、
窄屏视觉、重启后未被打开的老会话。见 `02-delivery.md` §6。
