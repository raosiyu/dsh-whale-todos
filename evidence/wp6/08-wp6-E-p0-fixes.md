# WP6-E 独立复审 P0 修复记录

> 复审对象 `a59f287`（冻结 `/tmp/wp6-freeze-a59f287`）。
> 复审探针：`evidence/wp6/final-review/probe-01-ai-surface.*`、`probe-02-cross-session-and-complete.*`

## 复审指控成立（4 个 P0）

### P0-1 · AI 可直接完成任务，绕过人工验收

**证据**（复审 A2）：
```
workbench_task_upsert(done:true) => ok:true, task.done=true
FAIL  A2 AI 无法用 workbench_task_upsert 直接置 done — 实际 done=true
FAIL  A4 AI 无法把用户已验收的任务改回未完成
```
**我的复现**：`done=undefined` → `task.upsert(done:true)` → `done=true, completion=none`。
确认成立，直接违反「AI 可以申请任务完成，但必须由用户最终验收」。

**根因**：`workbench_task_upsert` 工具暴露了 `done`/`status` 参数，且
`payload: (args) => Object.entries(args)` **全量透传**任何字段。

**修复**（纵深防御两层）：
1. 工具 schema 移除 `done` / `status` 参数，description 明写「CANNOT set completion」；
2. `payload` 构造器改为**显式白名单** `['id','title','dueAt','priority','project','parentId','subtasks']`，
   `done`/`status`/`completion`/`deleted` 一律丢弃。
   （只改 schema 不够：绕过 schema 或将来放宽 schema 时会重新穿透，已实测。）

### P0-2 · 真实 Host 下跨会话协作完全断裂

**证据**（复审 B1/B1b/B2/B3）：
```
FAIL  B1 用户会话能看到 Agent 生成的提案 — list=0；get=not-found
FAIL  B1b 用户能确认落地 Agent 的提案 — not-found
FAIL  B2 Agent 用 task.context 能读到自己被关联的任务 — 0 条
FAIL  B3 task.bySession 反查命中关联任务 — 0 条
```
**根因**：真实 Host 按 `sessionId × scope` 分片存数据（`sessionDirName` = sha256 前缀），
Agent 与用户是两个完全不同的目录 → 提案/关联天然互不可见。
这是 WP1–WP5 刻意建立的隔离保证，但 WP6 的主路径正是跨这两个会话。

**修复**：
1. `host-service.forSession` 增加 **scope 级共享目录** `.collab<scopeSuffix>`，
   作为 `collabDir` 传给 service；业务数据（tasks/events）仍各自私有；
2. `service` 增加 `collabStore`（可选），`createProposalOps` 的提案读写走它；
   未提供时回落自身 store（单机/单测语义不变）；
3. 提案写 collabStore、审计仍写本地 store（拆成两次 mutate）；
4. `task.linkSession` 额外写一条 **scope 级共享 assignment 摘要**；
5. `task.context` 合并两条来源：本工作区直连 + 共享 assignment，
   并**强制回盘重读** assignments（各 svc 实例的 collabStore 是不同内存副本，
   不重读就读不到别人的写入 —— 实测过）。

**修复后实测**（真实 Host，双 session）：
```
PASS  B1 用户能看到 Agent 的提案 — list=1
PASS  B1b 用户能读到提案详情 — ok
PASS  B1c 用户能确认落地 Agent 的提案 — created=2
PASS  B1d 落地任务建在用户工作区 — tasks=1
PASS  B1e Agent 工作区不被写入用户任务
PASS  B2 Agent task.context 读到关联任务 — tasks=1
PASS  B3 task.bySession 反查命中 — count=1
跨会话协作: PASS=7 FAIL=0
```

## 隔离没有被破坏

| 保证 | 状态 |
|---|---|
| 业务数据仍按 session 分片 | 保持（`dataDir` 规则未动） |
| 跨 scope 仍不可见 | 保持（提案 list/get 按 scope 过滤） |
| Agent 工作区不被写入用户任务 | 实测 PASS（B1e） |
| Agent 只能读到**被分配**的任务摘要 | 是（assignment 只含协作必需字段，不含任务全量） |

## 新增回归测试（3 条，锁死这两个 P0）

- `WP6-E/P0：AI 工具面无法用 task_upsert 直接完成任务`
- `WP6-E/P0：AI 不能把用户已验收的任务改回未完成`
- `WP6-E/P0：真实 Host 下 Agent 生成提案、用户可见可确认`

## 变异项（5 条）

`WP6E1` 重新暴露 done、`WP6E2` payload 全量透传、`WP6E3` 移除 collab 目录、
`WP6E4` 不读共享 assignments、`WP6E5` 不写 assignment。

## 复审意见全部采纳，无异议
这 4 个缺陷都是真实的产品缺陷，我此前的测试（单 service、单 session）
**结构上不可能覆盖**跨会话与工具面绕过。复审的价值正在于此。

---

## 复审第二轮（第二轮复审裁决 REQUEST CHANGES，3 P0 + 4 P1）

### P0-3 · 「44/44」是假绿 —— **复审这条最狠也最对**

复审原话：`probe-wp6-e2e.mjs:39` 用单一 dataDir 的裸 service，只用不同 sessionId
标签打同一个 store；E1.11/E1.12/E3.1/E3.2/E3.3 这五条跨会话断言**结构上不可能**
发现 P0-2。165/165 CAUGHT 同样只证明「已定义保护点有测试」。

**后续验证**：本轮补测把变异集扩到 176 条后，首跑得到 `VACUUM=5 / SKIP=1` ——
即新增的 6 条 P0/P1 变异里有 5 条**没有测试能杀掉**。这条数字反过来证明了复审
判断的正确性：CAUGHT 数只描述「已定义保护点」，不描述「缺陷是否真的被守住」。

**我接受这个指控**。原探针确实没走生产装配层。

**修复**：探针改用 `createWorkbenchHostService`（sessionId×scope 分片 + 真审批门
+ scope 级 collab 目录），token 由各自会话签发，磁盘断言按真实分片目录定位。

改造过程中**新暴露并修掉**的真实缺陷（都是假绿掩盖的）：
1. `proposal.get/apply/reject` 读提案用实例内存快照 → 跨会话看到 0 条（拟回盘读）；
2. 跨工作区落地被 `base-digest-mismatch` 误拒（提案的 digest 描述创建者工作区）；
3. 跨工作区 `task.writeProgress` / `task.requestCompletion` not-found；
4. **collab 写入 lost update**：多个会话实例共享同一 collab 文件时，后写方用 stale
   快照覆盖先写方，`assignments` 被 `proposal.preview` 抹掉（实测 assignments=[]）。

第 4 条尤其隐蔽：`mutateCollab` 必须区分两种模式 —— 单实例走 `store.mutate`
（保原子写/journal），跨实例共享走「回盘 + 只改目标集合」。首版我让它直写整个
文件，会覆盖 events/tasks，被全量回归当场抓红（8 个测试失败），已修正。

**修复后实测**（真实 Host）：**45/45 PASS**，全量 507/507。

### P1-1 · undo 栈已满时 collapseUndo 短路 ✅ 已修

实测：栈满 20 后落地 → `current.length(20) <= undoDepth(20)` → 折叠完全不执行，
`nextUndo=event.create`，要按 3 次 Cmd+Z。
修复：短路判据改为「锚点是否已是栈尾 entry」。修复后 `nextUndo=proposal.apply`，
一次撤销精确回到落地前（tasks 28→25）。

### P1-2 · apply 失败回滚清空用户 undo 历史 ✅ 已修

实测：`undoDepth 4 → 0`、`canUndo=false`。根因是 `store.rollback(backupName)`
把整个 state 换成备份内容（备份里的 undo 更早）。
修复：失败回滚只还原 events/tasks + 截断到 `undoDepthBefore`，不清用户历史。
修复后：`undoDepth 4 → 4`、`canUndo=true`。

### P1-3 · targetVersion 保存但从不比对 ✅ 已修

契约 §1.2 要求「绑定目标记录、版本」。原实现只在构造时校验类型。
修复：`proposal.preview` 生成时回填每条 `task.update` 的 `targetDigest`
（目标行内容 sha256 前 16 位），apply 时逐条比对，不匹配整份拒绝。
实测：目标未变可落地；目标被改 → 拒绝。

### P1-4 · bySession/linkSession/unlinkSession 不校验调用方 ✅ 已说明并加固

这三个 op 的业务语义就是「按指定 agent 会话反查/管理**我自己的**任务」，
参数 `sessionId` 天然不是调用方，无法加 `payload.sessionId === meta.sessionId`。
真正的越权防线是**目录隔离**（任务实体只在各自工作区）+ collab 只读共享摘要。
已在代码注释与契约中写明：**若将来引入可写共享任务表，必须在此补显式授权校验**。

### 复审确认已通过的部分（不重复返工）

危险 op 不在 AI 工具面、proposal.apply 只认 Host token、pickPayload 白名单 27/27、
AI 文本不参与控制流、baseDigest 防替换、跨 scope 拒绝、task.context 拒跨会话、
正常规模一次 undo 整体回滚、元操作 undo:false、规划引擎真实消费 freeSlots、
重复 apply 被拒、UNVERIFIED 诚实保留。

---

## 复审第三轮 · 把 VACUUM 打到 0（最终验证）

第三轮变异集扩到 **176 条**（新增 `WP6P1–WP6P6` 覆盖 P0-2/P1-2/P1-3 的修复点）。
首跑结果 **不容乐观**：

| 轮次 | CAUGHT | VACUUM | SKIP | 说明 |
| --- | ---: | ---: | ---: | --- |
| 首跑（176 条） | 170 | 5 | 1 | 新增 6 条修复变异里 5 条存活 |
| 补测后 | 173 | 3 | 0 | 锚点漂移已修，仍有 3 条存活 |
| 终跑 | **176** | **0** | **0** | 全部保护点都有测试约束 |

### 这 5 条 VACUUM 暴露的真实问题（测试没到被测代码）

这不是「测试写得不够多」，是**测试压根没执行到被变异的行**：

| 变异 | 存活原因 | 修法 |
| --- | --- | --- |
| `WP6P1` 失败回滚 | 我在**绑定校验**层造失败，而 `backup`/`try`/回滚在绑定校验**之后** | 改成「第 1 条 event 落地成功、第 2 条落地时段冲突」，才真正进回滚分支 |
| `WP6P2` `targetDigest` 比对 | 同上——同工作区全局 `baseDigest` 更早拦截，逐条比对不可达 | 直接改提案记录伪造陈旧 `targetDigest`（保留 baseDigest 一致），构造纵深防御场景 |
| `WP6P3` preview 回填摘要 | 无测试断言回填值非空 | 显式断言 `targetDigest.length > 0` |
| `WP6P4` 跨区跳过全局摘要 | 已有覆盖，锚点漂移导致误报 | 修缩进锚点 |
| `WP6P5` collab 回盘取最新 | 单实例测试里内存与磁盘永远一致；双实例测**不同集合**时 `base[name]=next` 只替换目标集合，也看不出差异 | 双实例写**同一集合**（proposals / assignments 各来一遍） |
| `WP6P6` 跨区写进度 | 已有覆盖，锚点漂移 | 修锚点 |

`WP6P5` 这一条最值得记：`store.collection()` 读的是**内存 `state`**，单实例下
内存与磁盘恒等，所以「回盘取最新」被删掉也测不出来 —— **只有两个实例各自持有
旧快照、且写同一集合时，lost update 才可观测**。

### 顺带发现并修掉的加固点

`WP6P2` 补测时发现：跨工作区生成提案时读不到目标行（Agent 工作区没有该任务），
`targetDigest` 会是 `''`，此时原实现**静默跳过校验**。已改为空摘要硬拒绝
（`target-digest-missing`）。核对 `planning.js` 确认它只产出 `task.create` /
`event.create`、从不产 `task.update`，因此该拒绝不会误伤真实用户路径。

### 最终数据

- 测试：**514 tests / 514 pass / 0 fail / 0 skipped**
- 变异：**CAUGHT 176 / VACUUM 0 / SKIP 0**
- 真实 Host 端到端探针：**PASS 45 / FAIL 0**（`createWorkbenchHostService`，含重启持久化、
  跨会话协作、AI 无法绕过审批、失败不破坏数据）
