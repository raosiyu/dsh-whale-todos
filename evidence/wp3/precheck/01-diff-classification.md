# WP3 前置检查：`368207b..d6cc887` 完整 diff 核对

核对时间：2026-11-05
命令：`git diff --stat 368207b..d6cc887` / `git diff --name-status 368207b..d6cc887`

## 提交清单（2 个）

| commit | 说明 |
| --- | --- |
| `d6cc887` | R5-9 最终 R5 报告（两轮 Review 结论） |
| `dcca6b6` | R5-8 修复复审 N-1/N-2/N-3/N-4（含业务代码） |

## 分类（37 文件，3968 插入 / 444 删除）

| 类别 | 文件数 | 是否影响行为 |
| --- | --- | --- |
| `docs/wp2/11-WP2-R5-report.md` | 1 | 否（文档） |
| `evidence/wp2/review-final/*`（第二轮 Review 报告 + 12 探针 + 日志） | 31 | 否（证据/日志，探针是**独立 Review 的只读产物**，不参与运行时） |
| `scripts/r3-mutations.json` | 1 | 否（变异定义，仅测试期使用） |
| `workbench-core/src/host-map.js` | **1** | **是 —— 业务/持久化逻辑修改** |
| `workbench-core/test/contract.test.mjs` | 1 | 否（新增守卫测试） |
| `workbench-core/test/schedule.test.mjs` | 1 | 否（修正时间依赖测试） |

## 判定

**不是「仅涉及文档、证据和不影响行为的修改」**。`host-map.js` 的增量包含：

1. 数据结构变更：`indexScopes: {hostId→string}` → `indexMeta: {hostId→{scope,fireAtMs}}`（含旧格式兼容读取）
2. 时间老化判龄：`state.entries[key]?.fireAtMs` → 回退到 `state.indexMeta[hostId]?.fireAtMs`（使墓碑可被老化），并新增 `fireAt === 0` 的保守跳过
3. 老化时同步清理 `indexMeta`
4. `prune()` 裁剪条目时写入 `indexMeta`（保留 fireAtMs + scope）
5. `flush()` 返回值修正：`{flushed: dirty}` → 保存 `was` 再返回
6. `describe()` 对墓碑返回真实 `fireAtMs` 与 `indexMeta.scope`
7. `remove()` / `removeByHostId()` / `put()` 同步维护 `indexMeta`

→ 按前置检查第 3 条：**针对该增量执行独立 Review**（见 `02-incremental-review.md`）。

## 复核命令（可复现）

```bash
cd /Users/sylas/Developer/dsh-workbench
git diff 368207b..d6cc887 -- workbench-core/src/host-map.js
git diff 368207b..d6cc887 -- scripts/r3-mutations.json
```
