# 独立复验环境（供复审方使用）

复审对象：`/Users/sylas/Developer/wp6-review-freeze`
- 由 `git worktree add --detach <dir> 6f6dbe7` 生成，HEAD = `6f6dbe7b050fccf4ea1a6585a846bb441bb3ddba`
- 主仓 `/Users/sylas/Developer/dsh-workbench` 工作区干净，未被复审污染

**为什么不用 `/tmp` 快照**：前几轮把 `git archive` 解到 `/tmp`，被系统清理后
复审方 `cd` 进不存在的目录，探测无果直至失败。这是复审反复「无 verdict」的
直接原因，与基础设施无关。改为仓库内持久 worktree 后 `npm test` 实测可跑。

## 基线

```
cd /Users/sylas/Developer/wp6-review-freeze/workbench-core && npm test
# pass 515 / fail 0 / skipped 6
```

6 条 skip 是 `test 117/118/141/142/148/149`，条件为「asar 解包目录不存在
（不冒充真实宿主）」——fail-closed 设计，非缺陷。主仓有 asar 时这 6 条会实跑。

## 注意

`node --test test/` 在 Node 22 上会解析成模块路径而报 MODULE_NOT_FOUND，
必须用 `npm test`。
