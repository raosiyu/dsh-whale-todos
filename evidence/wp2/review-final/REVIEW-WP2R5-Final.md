# WP2-R5 最终独立 Review 结论（Reviewer: WP2R5-Final）

审查对象：冻结快照 `/tmp/wp2r5-freeze-2b0aabb`（基准 commit `2b0aabb`，756 文件）
审查人：WP2-R5 最终独立 Review 员（子会话）
产出目录：`/Users/sylas/Developer/dsh-workbench/evidence/wp2/review-final/`

---

## 检查 00：基线复跑（单元测试 / demo）

**命令**
```bash
cd /tmp/wp2r5-freeze-2b0aabb/workbench-core && node --test test/*.test.mjs
cd /tmp/wp2r5-freeze-2b0aabb && node workbench-core/demo/demo.mjs
```

**实际输出摘录**
```
# tests 196
# pass 196
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1538.456459
```
```
DEMO EXIT=0
  首次对账：created=2 removed=0
  重复对账（幂等）：created=0（应为 0）
  到点投递：第一次 2 条，重复 tick 0 条（应为 0）
  投递历史合计 2 条（status=ok），与真实投递一致=true
```

**判定：PASS** — 196/196 测试通过，demo 正常退出。

---

## 检查 01：探针的「冻结纪律」——探针实际测的是哪个代码？

**命令**
```bash
cd /tmp/wp2r5-freeze-2b0aabb && grep -n "REPO\s*=" scripts/probes/*.mjs
cd /Users/sylas/Developer/dsh-workbench && git status --short
diff -rq /tmp/wp2r5-freeze-2b0aabb/workbench-core/src workbench-core/src
```

**实际输出摘录**
```
scripts/probes/p1-real-storage-domain.mjs:22:const REPO = '/Users/sylas/Developer/dsh-workbench'
scripts/probes/p2-protect.mjs:17:const REPO = '/Users/sylas/Developer/dsh-workbench'
scripts/probes/p3-retention.mjs:20:const REPO = '/Users/sylas/Developer/dsh-workbench'
```
```
 M evidence/wp2/review-final/mutation.log
 M evidence/wp2/review-final/p1-real-storage-domain.log
 M scripts/r3-mutations.json
 M workbench-core/src/host-map.js
 M workbench-core/test/contract.test.mjs
```
```
Files /tmp/wp2r5-freeze-2b0aabb/workbench-core/src/host-map.js and workbench-core/src/host-map.js differ
```

**发现（事实）**：三个探针的 `REPO` 常量全部**硬编码为主仓库工作副本**，而不是冻结目录。
因此 `bash scripts/wp2-r5-gate.sh`（在冻结目录里跑）测的**不是冻结代码**——它 import 的是主仓库
未提交的 `host-map.js`（该文件在冻结版里没有 index 封顶逻辑，主仓库里多了一段）。

**主仓库与冻结版的 src 差异（未提交）**：
```diff
--- /tmp/wp2r5-freeze-2b0aabb/workbench-core/src/host-map.js
+++ /Users/sylas/Developer/dsh-workbench/workbench-core/src/host-map.js
@@ -154,6 +154,17 @@
       state.index[v.hostId] = k
       delete state.entries[k]
     }
+    // index 也必须封顶：否则它会随运行时间无限增长（实测 8000 条 → 269 KB）。
+    const indexEntries = Object.entries(state.index)
+    if (indexEntries.length > maxEntries) {
+      const orderedIndex = indexEntries.sort((a, b) => { ... })
+      for (const [hostId] of orderedIndex.slice(maxEntries)) delete state.index[hostId]
+    }
```

**判定：MAJOR（流程缺陷，非本轮代码缺陷）** — 冻结目录里的门禁脚本无法自证冻结版；
它测的是主仓库 HEAD+未提交改动。这也意味着：**冻结版 `host-map.js` 里 `index` 确实没有上限**
（见检查 05 的独立实测），而门禁日志里显示的却是「有上限」的结果。

> 我的所有独立探针一律直接 import 冻结目录的 `workbench-core/src/index.js`，
> 不走 `REPO` 常量，避免上述污染。

---
