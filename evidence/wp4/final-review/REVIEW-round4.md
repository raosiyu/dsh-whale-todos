# WP4 第四轮独立复审（REVIEW-round4）

- 审查对象：`/Users/sylas/Developer/dsh-workbench`，冻结 commit `bf1c657`
- 导出副本：`/tmp/wp4r4/repo`（`git archive bf1c657`）
- 探针目录：`/tmp/wp4r4/probe/`
- 审查员：WP4 第四轮独立复审员（只读主仓库；变异脚本只在 /tmp 副本里跑）
- 状态：**进行中**

---

## 0. 前置事实（开工时）

```
$ git rev-parse HEAD
bf1c657b348c3fbcc5dca7b109130408d90d15eb

$ git status --porcelain
(空)

$ git remote -v
(空)

$ git log --oneline -3
bf1c657 WP4-10: fix round-3 BLOCKER-1 (t not defined -> whole page blank) + MAJOR-1
548be95 WP4-9: third-round self-review fixes - inline callHost, wire locale, degrade load
d64deab WP4-10: fix the remaining stale regression numbers in the report
```

---

（本文件按检查项逐条 append，最终追加 `# 结论：…`）

## 1. 冻结纪律（检查名：freeze-discipline）

**命令**
```
$ cd /Users/sylas/Developer/dsh-workbench && git rev-parse HEAD
bf1c657b348c3fbcc5dca7b109130408d90d15eb
$ git archive bf1c657 | tar -x -C /tmp/wp4r4/repo
$ git -c core.quotepath=false ls-tree -r bf1c657 --format='%(objectname) %(path)'   # 856 行
$ python3 逐文件算 git blob hash（sha1("blob <len>\0"+content)）与 archive 内文件比对
```

**实际输出**
```
tracked: 856 | missing: 0 | byte-mismatch: 0 | extra: 0
=== 文件清单比对 ===
tracked-not-in-archive: 0    in-archive-not-tracked: 0
```

**HEAD 开始/结束**
- 开始：`bf1c657b348c3fbcc5dca7b109130408d90d15eb`
- 结束（本次记录时）：`ad905798ab62c9fb7029989936b5bd6ad641255f`
- 差异原因：`ad90579 WP4-11: record the three REQUEST CHANGES rounds in the report`，
  **仅改文档**，与本轮审查对象无代码关系：
  ```
  $ git diff --name-status bf1c657 ad90579
  M  docs/wp4/01-final-report.md
  A  evidence/wp4/final-review/REVIEW-round4.md
  $ git diff --name-only bf1c657 ad90579 -- packages workbench-core scripts upstream | wc -l
  0
  ```
  说明：`ad90579` 里新增的 `evidence/wp4/final-review/REVIEW-round4.md` 就是**本文件本身**
  （作者在我写完第一段「进行中」后提交，把我的文件一起 commit 进去了）。
  代码树（packages / workbench-core / scripts / upstream）在 bf1c657 与 ad90579 之间**零差异**，
  故本轮全部技术结论对两个 commit 同样成立。

**判定：通过**（导出副本与 commit 逐字节相同；主仓库未被我修改；HEAD 漂移是并发的、仅文档的 commit，不影响被审对象）
