# WP2 条件验收完成记录（WP3 前置检查收口）

日期：2026-11-05
授权依据：WP3 执行授权「前置检查」第 1–4 条

## 1. 完整 diff 核对

`git diff 368207b..d6cc887`：37 文件，3968 插入 / 444 删除。
分类见 `evidence/wp3/precheck/01-diff-classification.md`。

**结论：不是「仅文档/证据」**——`workbench-core/src/host-map.js` 是业务/持久化逻辑修改
（`indexScopes`→`indexMeta`、老化判龄、flush 语义、describe、remove 同步维护），
触发前置检查第 3 条：对增量执行独立 Review。

## 2. 独立 Review 结果（三路，全部明确 APPROVE）

| 来源 | 审查范围 | 结论 | 证据 |
| --- | --- | --- | --- |
| Agent `8fa4a5bc` | **冻结 `d6cc887`**（`git archive` 到 `/tmp/wp3pre/frozen`，sha 校验一致） | **APPROVE** | `02-incremental-review.md`，46 PASS / 0 FAIL，207/207 单测 + 36/36 变异 |
| Agent `f98aac40`（重派） | 实时 `c12d377`（增量 + 两条置脏加固） | **APPROVE** | `03-review-verdict.md`，11/11 PASS，209/209 单测 + 36/36 变异 |
| `workflow` 结构化复核 | 同上 | **APPROVE WITH NITS**（无 blocker） | 结构化返回，5 必验点全 PASS + 3 项自查排除 |

三路一致：**无数据丢失、无重复投递、无误删身份、无审批旁路、无安全阻断**。
均确认 X29 变异锚点有效、守卫测试约束到位。

## 3. 必须如实纠正的一处主会话误判

我在前置检查中据**早期探针**（`/tmp/wp3pre/probe.stdout.log`）的 P1.7/P1.8/P7 FAIL，
判定为「`load/prune` 不置脏 = 缺陷」并做了 `c12d377` 加固。

**独立 Review（冻结副本）证明这个判定错了**：
- `dirty-test.log` 显示 `368207b` 与 `d6cc887` 的 `prune()+flush()` 行为**逐字一致**，属既有契约；
- 生产代码里唯一触发老化的路径是 `put()`，其尾部**必定 `persist()`**；
- `.prune()` / `.reload()` **无生产调用者**，「显式 flush 写不下去」实际不可达；
- 早期探针把「无脏不重写磁盘」误当成缺陷，是**探针期望错误**。

→ `c12d377` 是**额外加固**（让显式 flush 语义更一致、旧格式即时归一化），
**不是修复 `d6cc887` 的缺陷**，独立 Review 明确「不计入通过条件也不算 blocker」。
主会话此前把 02 草稿写成「有条件通过 / 探针抓到真缺陷」是错的，已由 Agent 覆写为 APPROVE 版，
草稿留在 `/tmp/wp3pre/02-main-session-draft.md` 备查。

**教训**：探针输出 ≠ 缺陷结论；冻结副本 + 基线对照才能定性「回归」还是「既有契约」。

## 4. WP2 状态：条件验收完成

- ✅ 前置检查第 1–3 条完成（diff 核对 + 增量独立 Review APPROVE）
- ✅ 第二轮独立 Review 对 `368207b` 的结论为 **APPROVE WITH NITS**，两个 BLOCKER 已修
- ✅ 门禁：209/209 单测、36/36 变异（0 真空 0 跳过）、8/8 门禁、26/26 验收
- ✅ 真实 storageDomain 落盘 / 重启 / 去重通过
- ✅ 红线：0 remote、未改正式 DSH profile、未改用户数据、未 push

### 保留的全部 UNVERIFIED 项（不因条件验收而清除）

| 项 | 原因 |
| --- | --- |
| 真实宿主投递回执不可读 | 无对应工具；**不宣称 exactly-once** |
| 真实 macOS 休眠 / 唤醒 / 退出 / 重启 | **完全未测试** |
| 系统通知是否真正弹出 | 未验证 |
| 多进程并发写 | 文件存储非多进程安全；`hostMap` 无跨进程锁 |
| 真实 Host 的 fiber/effect 生命周期 | 探针用真组件但宿主生命周期仍简化构造 |
| O(N²)/线性但常数大的对账性能 | **单独登记且 UNRESOLVED**，见 `docs/wp3/01-on2-registry.md`；模拟环境实测线性、真实 Host 未测、实现未改动 |

## 5. 授权边界

本记录仅覆盖 `368207b..d6cc887` 及其后的 `c12d377` 增量复核。
**WP3 功能开发尚未开始**，此记录不代表 WP3 任何交付已验收。

## 复核命令

```bash
cd /Users/sylas/Developer/dsh-workbench
git diff --stat 368207b..d6cc887
cat evidence/wp3/precheck/02-incremental-review.md | tail -12
tail -3 evidence/wp3/precheck/03-review-verdict.md
```
