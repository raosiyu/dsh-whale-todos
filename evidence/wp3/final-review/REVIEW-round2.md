# WP3 修复后最终独立 Review（第二轮）

- 状态：**已完成（结论：REQUEST CHANGES）**
- 审查对象：`/tmp/wp3-final2-freeze-17f79e8`（基准 commit `17f79e8`，829 文件）
- 主仓库：`<repo>`（任务给 HEAD=`17f79e8`；只读未改。实测当前 HEAD 已前进到 `d3c79d5`/830 tracked，但 commit `17f79e8` 仍在且冻结快照与其逐字节一致，见检查 8）
- 探针目录：`/tmp/wp3final2/`（直接 import 冻结目录 `workbench-core/src/index.js`）
- 产物：`<repo>/evidence/wp3/final-review/REVIEW-round2.md`
- 开始时间：2026-11-05 23:26 (Asia/Shanghai)
- 原则：只读审查冻结目录；除本产物与 `/tmp/wp3final2/` 外不写任何文件；不在冻结目录里跑会写日志的探针。

## 检查记录（每完成一条立即 append）

### 检查 0：结构与环境映射（进行中→完成）
- 命令：`find . -type f | wc -l` = 829（与基准一致）；`node --check workbench-core/src/host-service.js` exit=0
- workbench-core 共 17 src + 12 test。核心文件：host-tools.js / host-service.js / service.js / approval-gate.js。
- **初步疑点（待真探针验证）**：`applyWorkbenchHostService`（host-service.js:253-254）引用 `activeAgent` 与 `currentAgent`，但二者只在 `createWorkbenchHostService` 内部声明（:77 / :65）——不同函数作用域，疑似 ReferenceError / 取值永远 undefined。

### 检查 1：B1 真出参校验（PASS）
- 探针：`/tmp/wp3final2/probe-b1.mjs`，日志 `/tmp/wp3final2/probe-b1.log`（`node probe-b1.mjs`，EXIT=0）
- 命令：`node --test` 之外，直接 `import ${FREEZE}/workbench-core/src/index.js` + `import ${ASAR}/dsh-tools/lib/index.js`（真包，`validateJsonSchemaValue`/`defineTool`/`ToolRuntime.prototype.createSuccessResult`/`ToolOutputError` 均为 function）。
- 编译后 OUTPUT_SCHEMA（真 `defineTool`→`valueSchemaSpecToJsonSchema`）：
  `oneOf:[{type:object,additionalProperties:true,properties:{ok:{const:true},op:{type:string}},required:[ok,op]},{type:object,additionalProperties:false,properties:{ok:{const:false},code,message},required:[ok,code,message]}]` → 成功/错误分支由 `ok` const 互斥。
- 8 个工具定义（真 defineTool 编译 8/8 通过），带合法 args 无 agent 时均返回 `{ok:false,code:'internal_error',message:'...no calling Agent.'}`；对 8 个 noAgent 错误值 + 8 种稳定错误（含 `not-found`/`validation`/`confirmation-required`/`conflict`/`unsupported`）+ 5 种成功值，真 `validateJsonSchemaValue` 全部 `violations=[]`（0 violation）。
- 真 `createSuccessResult`（借 ToolRuntime.prototype + 最小 runtime 桩）：8 个 noAgent 错误值 + 显式 `not-found` 业务错误，**全部 `isError=false` 正常返回，未抛 ToolOutputError**。
- 判定：**B1 修复成立，PASS**。（旧坏 schema 复现见下方补充：需用真编译器 `valueSchemaSpecToJsonSchema` 才能 faithful 复现 matched 2，裸 DSL 直接喂 checkValue 不触发。）
- 旧 B1 忠实复现（`/tmp/wp3final2/probe-b1-old.mjs`，日志 `probe-b1-old.log`）：从主仓库 `git show f89a311:workbench-core/src/host-tools.js` 逐字取旧 `RESULT_SCHEMA={type:object,additionalProperties:true}` + `ERROR_SCHEMA`（无 ok const），用真 `valueSchemaSpecToJsonSchema` 编译后，旧错误值 `{code:'not-found',message:'未找到'}` → `violations=["\"value\" must match exactly one oneOf branch (matched 2)"]`。**确认旧 BLOCKER 真实、修复真实**。

### 检查 2：B2 真审批通道（进行中）

### 检查 2：B2 真审批通道（**FAIL / BLOCKER**）
- 探针：`/tmp/wp3final2/probe-b2.mjs`，日志 `/tmp/wp3final2/probe-b2.log`（`node probe-b2.mjs`，EXIT=0，断言 assert.equal(out,'allowed-once') 通过）
- 真包：`import ${ASAR}/@deepseek-ai/dsh-user-approval/lib/index.js` 的 `ApprovalService`（用 `Object.create(ApprovalService.prototype)` + 最小 `ctx.waterfall/inject` 桩承载**真** answerer；`request/decide/effectivePolicy` 全为真类方法，非 stub）。
- 最小 open-turn session：`session.seq=1`、`eventAt(0)={type:'turn/start'}`。真 `ApprovalService.request({agent,toolName:'event.delete'})` → **`allowed-once`**，并追加 `approval/asked`/`approval/decided` 审计对（真行为验证成功）。
- 真词汇核对：`OUTCOMES=['allowed-once','rejected','cancelled','unavailable']`（`types/index.js:15`；主 `lib/index.js:30-35` 同样）；`req.agent.session` @129、`toolName` @134、`hasOpenTurn` @49-56 全部与真源码一致。
- **失败复现（决定性）**：`applyWorkbenchHostService(ctx,{approval:{request: realApprovalService.request}, currentAgent:()=>agent})` 后，`askApproval('s1','event.delete')` → `{"approved":false,"reason":"host-error:activeAgent is not defined"}`；`config.approval.request` **被调用 0 次**；**不签发 token**；带/不带 token 都无法打通审批通道。
- 场景 B（`config.approval.request` 直接返回 `'allowed-once'`）：适配器**未调用**它（`seen.length=0`）。场景 C（never 真 decide）、D（无 answerer 真 fallback unavailable）同样返回 `host-error:activeAgent is not defined`（拒绝发生在触及真 ApprovalService 之前）。
- 对照 E：直接 `createWorkbenchHostService({requestApproval:async()=>'approved'})`（不经过 apply 的适配器）→ `{"approved":true,"token":"2717a569..."}` 能签发。说明坏的是 **applyWorkbenchHostService 的适配器**，不是 gate/service。
- **根因（静态定位）**：`host-service.js:253-254` 在 `applyWorkbenchHostService`（:235-286）里读写 `activeAgent`、`currentAgent`；但二者只在 `createWorkbenchHostService`（:56-220）内部声明（`let activeAgent` :77、`currentAgent` 解构 :65），是**兄弟函数、无共享作用域**。ESM 严格模式下读取/赋值未声明变量 → `ReferenceError`。`approval-gate.js:127-129` 的 try/catch 把它吞成 `host-error:...` → 永远 denied。
- **附带发现**：`service.requestApproval`(service.js:122-141) → `gate.request`(approval-gate.js:127 `options.request({...req,fingerprint})`) 传的 req 是 `{op,target,digest,summary}` —— **不含 `agent` / `callId` / `signal`**（场景 E 打印 `agent? false` 实证）。因此即便修好作用域，`req.agent ?? activeAgent ?? currentAgent()` 仍取不到本次请求的 agent；`currentAgent` 传到 `createWorkbenchHostService` 后也从未被使用（grep 仅 :65/:282）。
- 上一轮 VERDICT.md:302 只做静态阅读（「把 config.approval.request 透传」）就判 PASS，**从未跑真 ApprovalService**，正是 workflow 指出的漏洞；本轮真包端到端复现证明 B2 修复未落地。
- 判定：**REQUEST CHANGES（BLOCKER：真宿主审批通道完全不通，apply 适配器 ReferenceError；危险 op 在 host 模式被永久锁死，真 ApprovalService 从未被调用）**。

### 检查 3：真 defineTool 包 8 定义 + 执行（PASS）
- 探针 `/tmp/wp3final2/probe-exec.mjs`（日志 `probe-exec.log`，EXIT=0）：真 `defineTool` 编译 8/8；真 `createWorkbenchHostService` + 真文件 store 下：创建→查询→跨 session（B 看不到 A）→`event.update` 改名真的生效（`get` 返回 `'改名后的评审'`）→`task.upsert` 真的写入 tasks（`task.list` 1 条）→`event.list includeDeleted`→4 个缺参工具全部抛真 `ToolArgsError`（`missing required property "id"/"allDay"`）。全过。

### 检查 4：契约对齐（PASS）
- `event.update` → `{id,patch}`：host-tools.js:201 `return {id, patch}` ↔ service.js:203 `const patch = payload.patch ?? {}`（实测改名生效）。
- `task.upsert` → `{task:{id}}`：host-tools.js:215 `({task:{...args}})` ↔ service.js:380-384 `payload?.task` + `task.id` 非空校验（实测写入）。
- `event.list` → `includeDeleted`：host-tools.js:154 ↔ service.js:146（实测两分支均返回结果）。行号逐一对应冻结副本。

### 检查 5：会话/scope/audit 隔离 + 审批安全（PASS）
- 探针 `/tmp/wp3final2/probe-isolation.mjs`（`probe-isolation.log`，EXIT=0）+ `/tmp/wp3final2/probe-audit-filter.log`。
- session：A/B 各自 1 条、互不可见；scope：events/tasks/default 三域各 1 条、数据子目录 4 个（哈希目录隔离）；audit：`audit({sessionId:'B'})` 只含 B 的 `s-df7e...` 记录，不含 A 的 `s-7456...`（`probe-audit-filter.log` 实证 distinct sid 各 1 个）。
- `confirmed:true` 不绕过：抛 `confirmation-required`，数据未删。
- 危险 op（delete/bulkDelete/import/replace/rollback/restore）**未注册**为 8 个 AI 工具之一（实测逐一 false）。
- 业务 service 返回面：`store={listBackups,listPreBackups}`、`events={list,get}`，均 `Object.isFrozen`，无 `replace/rollback/remove/create`；hostService 返回面 `store/events===undefined`。只读成立。

### 检查 6：不伪造宿主 / 真 defineTool 测试真加载 asar（PASS，但见检查 9 的 B2 守卫例外）
- `host-tools.test.mjs:162` `asarReady=existsSync(...)`；`:164/:176` 两个「真实 defineTool」测试 `{skip: asarReady?false:...}`，`ASAR='/tmp/dsh-asar-full/dsh/node_modules'`（:26），真 `await import` asar 包。实跑 `node --test --test-name-pattern="真实 defineTool" test/host-tools.test.mjs` → **pass 2 / skipped 0**（真加载，非 stub）。
- WP3 新增测试 `host-service.test.mjs:7-9` 诚实标注「不冒充真实宿主」；仅注入 `requestApproval: async()=>'unavailable'`，其余用真 `createWorkbenchHostService`/真文件 store。无 `contract-stub`/`MemoryAdapter` 冒充。
- **例外（严重）**：新增的 `WP3-B2 守卫`（host-tools.test.mjs:316-324）是**纯静态源码 grep**（`readFileSync(host-service.js)` + `assert.match(/toolName:\s*req\.op/)` 等），**从不运行真 ApprovalService**；`WP3-B1 守卫 #2`（:302-314）标题写「真 ToolRuntime 端到端」，实际只调 `validateJsonSchemaValue`，**不调 `createSuccessResult`**。见检查 9。

### 检查 7：O(N²) 登记（PASS）
- `docs/wp3/01-on2-registry.md:3` 状态 **UNRESOLVED**，「未改动对账实现，不宣称已解决」；:55-66 明确「模拟环境实测线性但常数大；真实 Host 未测；不照抄 O(N²) 已确认」。
- 基准可复现：`node scripts/bench-reconcile.mjs`（在 /tmp 副本跑）→ 100/200/400/800 → 400.9/833.9/1941.7/4191.1 ms，`ms/N²` 持续下降（线性），`created=N failed=0`，输出 `状态：UNRESOLVED`。日志 `/tmp/wp3final2/bench.log`。

### 检查 8：回归（PASS；均在 /tmp 副本串行跑，避免污染冻结目录）
- 完整性：`/tmp/wp3-final2-freeze-17f79e8` 与 commit `17f79e8` **逐字节一致**（python3 用 `git ls-tree -r` 逐 blob 校验：829 tree entries、829 files、0 mismatch、0 extra）。注：主仓库 HEAD 现已前进到 `d3c79d5`（830 tracked），但 commit `17f79e8` 仍在，冻结快照对齐无误。
- `cd workbench-core && node --test test/*.test.mjs` → **236/236**（`# pass 236 # fail 0 # skipped 0`）。
- `node scripts/r3-mutate.mjs /tmp/wp3final2/mut.log` → **CAUGHT 36 / VACUUM 0 / SKIP 0**（`mut.log`）。
- `bash scripts/wp2-r5-gate.sh` → **通过 8 项，失败 0，RESULT: PASS**（`gate-clean.log`）。
  - 说明：首次跑时与变异脚本共用同一副本并发，unit-tests 抓到变异中间态报 235/236 → 系我 harness 并发撞车，非冻结缺陷；新建干净副本 `freeze-gate` 单独串行复跑得 8/8 PASS，且 unit-tests 单跑 236/236。

### 检查 9：诚实性 / UNVERIFIED / 文档数字（**部分 PASS，发现数字失实 + 验证夸大**）
- UNVERIFIED 全保留：`docs/wp3/02...:52-61` 6 项（真实投递回执不宣称 exactly-once、macOS 休眠/唤醒/退出/重启、系统通知、多进程并发、真实 Host fiber/effect 生命周期、O(N²) UNRESOLVED）逐条在，无删减。
- `00-contract.md:60-67`/`03:60-62` 的 `toolName`/`allowed-once` 更正与真源码一致（`dsh-user-approval/lib/index.js:30-35,128-143` 实证）。✅
- **数字失实（nit）**：`docs/wp3/03...:86` 写「233/233」，实测 **236/236**（`f89a311`=233 → `17f79e8` 新增 3 个 B1/B2 守卫测试 =236，commit message 自己写「added 3 regression tests」「Gates: 236/236」）。旧 VERDICT.md:242 判「233 与实测一致」是**上一轮**的数，本轮冻结版文档未同步。除此项外 36 变异、8 工具与实测一致。
- **验证夸大（并入 B2 BLOCKER）**：commit `17f79e8` message 宣称「Verified end-to-end with the real ApprovalService + a minimal open-turn session: allowed-once -> approved -> token issued」「real ApprovalService channel PASS」，但新增的 `WP3-B2 守卫` 只是静态 grep（见检查 6），真 ApprovalService 端到端在本轮探针中被证明**从不触达**（检查 2）。宣称与实测不符。

### 检查 10：第一轮两个 nit 是否仍存在（均仍存在，判 NIT 不升 blocker）
- 探针 `/tmp/wp3final2/probe-nits-concurrency.mjs`（`probe-nits-concurrency.log`，EXIT=0）
- **NIT 1（仍在）**：`askApproval()`（host-service.js:182-185）用 `forSession(sessionId)` 默认 scope 的 gate 签 token；`invoke()`（:134-135）按 `meta.scope` 取 service，每实例独立 gate。实测：默认域 token 在 `invoke(scope='events')` → `confirmation-required（unknown-token）`；默认域 `invoke` 则报 `not-found`（事件确实不在默认域）。**fail-closed**，且危险 op 未注册为工具（工具面 `runTool` 不传 scope，恒默认域，两者一致）→ 无旁路、无越权删除。判 **NIT**（建议 `askApproval` 加 scope 参数）。
- **NIT 2（仍在）**：`DANGEROUS_OPS` 含 `event.restore`/`task.upsert`（service.js:43-44），但两个 handler（:214-217 / :379-402）**均不调 `requireConfirmation`**（实测 handler 源码无该调用；host 模式无 token 时 `task.upsert` 直接写入成功、`event.restore` 只报 not-found 而非审批错）。`deny` 模式下二者被 `WRITE_OPS` + `gate.mode==='deny'`（:444）拦住（实测 `confirmation-required`）。**host 模式下这两个写操作不需审批即可执行**——但二者都已作为普通工具/门面暴露、本就是设计内的可写面，且 `task.upsert`/`event.restore` 不在「危险到必须问人」的语义（前者是创建/改待办，后者撤销软删），列入 DANGEROUS_OPS 反而与实现不一致。判 **NIT**（文档/清单一致性），非 blocker：无审批旁路导致数据丢失或越权（这两个操作本就允许）。

### 额外自找（任务指定）
- 探针 `/tmp/wp3final2/probe-concurrency2.mjs`（`probe-concurrency2.log`，EXIT=0）
- **并发串味前提核对**：任务说「`activeAgent` 是模块级可变状态」——对 `17f79e8` **不成立**。`:77` 原文 `  let activeAgent = undefined`（2 空格缩进），声明在 `createWorkbenchHostService`(:56-220) 函数内。真实缺陷更糟：apply(:235) 是**兄弟函数**，引用它 → **确定性 ReferenceError**（单次调用即失败，非并发偶发）。
- **并发复现**：两个不同 agent 的 `askApproval` 并发 → 两次都 `{"approved":false,"reason":"host-error:activeAgent is not defined"}`，真 ApprovalService 收到 agent 记录 `[]`（0 次触达）；不存在 A→B 串味，因为**两者都在读到 agent 之前就抛错**。`a2` 精确复刻 `:251-275` 闭包体：即便 `req` 自带 agent，`:254 activeAgent = undefined` 仍抛 `ReferenceError`。
- **假设性修法风险（诚实记录）**：若有人把 `activeAgent` 提升到模块级来「修」B2，则并发串味成立（探针 (c) 复现：A 在等待期间 B 覆盖共享 activeAgent → A 的审批拿到 `agent=B`）。故「提升为模块级」**不是合格修法**；正确修法须把 agent **随请求传递**（且 `service.requestApproval` 的 req 必须真带 agent——当前不带，见检查 2 E）。`currentAgent` 同理是死参数（:65 解构、:282 传入，函数内**从未读取**），优先级 `req.agent ?? activeAgent ?? currentAgent()` 实际只可能走到第一项或抛错。
- **映射丢信息（NIT）**：`return outcome === 'allowed-once' ? 'approved' : 'denied'`（:274）把 `rejected`/`cancelled`/`unavailable` 压成同一个 `denied`；gate 收到后 reason=`host-denied`，模型无法区分「用户主动拒绝 / 信号取消 / 无 answerer 系统不可用」。属信息损失 nit；当前适配器连这步都到不了。
- **伪造字段（NIT/诚实性）**：`host-service.js:246` 注释称「真正的 reason 字段见 `displayReason`」，适配器(:267) 也传 `displayReason: req.summary`；但真 `dsh-user-approval/lib/index.js:132-137` 审计只写 `{id,toolName,callId?,reason?}`，**全包 grep 无 `displayReason`**。属臆造 API 细节（多余属性被忽略，无功能影响），记 nit。

### 检查 6 补充：B2 守卫是静态 grep，不是真端到端
- `workbench-core/test/host-tools.test.mjs:316-324`「WP3-B2 守卫」= `readFileSync(host-service.js)` + 4 条 `assert.match` 正则（`toolName:req.op` / `'allowed-once'?'approved'` / `agent.session` / 不得 `tool:req.op`）。**从不 import/run 真 ApprovalService**。`WP3-B1 守卫 #2`(:302-314) 标题「真 ToolRuntime 端到端」实只调 `validateJsonSchemaValue`，不调 `createSuccessResult`。
- 这解释了为何 236/236 全绿却漏掉 B2 真通道断裂：`git diff f89a311 17f79e8` 显示修复把 `activeAgent/currentAgent` 加进 `createWorkbenchHostService`，却在**兄弟函数** apply 的适配器里引用；源码 grep 看得到 `toolName`/`allowed-once` 字样就判 PASS，运行时作用域错误完全测不到。

### 冻结目录完整性（复核）
- `find /tmp/wp3-final2-freeze-17f79e8 -newermt "2026-11-05 23:26:00" -type f` → **0 个**；无 `*.mutation-backup`。所有会写日志的回归脚本均在 `/tmp/wp3final2/freeze-run`、`freeze-gate` 副本上跑；探针只 import 冻结目录。符合约束 3。

---

## 汇总判定表

| # | 检查项 | 判定 |
| --- | --- | --- |
| 0 | 结构 / 字节一致性（829 文件 = commit `17f79e8`） | PASS |
| 1 | B1 真出参校验（8 工具错误+成功 0 violation；真 createSuccessResult 不抛 ToolOutputError；旧 matched 2 忠实复现） | **PASS** |
| 2 | B2 真审批通道（真 ApprovalService + open turn + allowed-once） | **FAIL / BLOCKER** |
| 3 | 真 defineTool 8 定义 + 执行（创建/查询/编辑/跨 session/缺参 ToolArgsError） | PASS |
| 4 | 契约对齐（event.update/task.upsert/event.list 行号对应） | PASS |
| 5 | 会话/scope/audit 隔离 + 审批安全（confirmed 不绕过 / 危险 op 未注册 / store·events 只读） | PASS |
| 6 | 不伪造宿主（真 defineTool 测试真加载 asar） | PASS（B2 守卫例外：静态 grep，见下） |
| 7 | O(N²) 登记（UNRESOLVED / 未宣称解决 / 基准可复现） | PASS |
| 8 | 回归（236/236、36/36 0 真空 0 跳过、8/8 门禁） | PASS |
| 9 | 诚实性（UNVERIFIED 全保留 / toolName·allowed-once 更正一致） | 部分：数字 233≠236（nit）、验证夸大（并入 B2） |
| 10 | 第一轮两 nit 仍存在 | 均仍在，判 NIT |
| 额外 | 并发串味 / currentAgent 优先级 / 映射丢信息 | 前提不成立；确定性 ReferenceError；修法风险已记 |

## BLOCKER 清单（1 个）

**B2-NEW：真宿主审批通道完全不通（确定性 ReferenceError）**
- 位置：`workbench-core/src/host-service.js:253-254`（`applyWorkbenchHostService` 内）引用并赋值 `activeAgent`/`currentAgent`，二者却只声明在兄弟函数 `createWorkbenchHostService`（:65 / :77）。
- 复现：`/tmp/wp3final2/probe-b2.mjs`、`probe-final-b2.log`、`probe-concurrency2.mjs`。真 `ApprovalService.request`（单独调用返回 `allowed-once` + 追加 approval/asked·decided 审计）接上 `applyWorkbenchHostService` 后，`askApproval` → `{"approved":false,"reason":"host-error:activeAgent is not defined"}`，`config.approval.request` **0 次调用**、**不签发 token**、真 ApprovalService 从不触达；3 个变体（真 allowed-once 返回值 / 无 currentAgent / 对照无 approval）全部如此。
- 影响：host 模式下所有需审批的危险写操作被永久锁死；`docs/wp3/03` 与 commit message 宣称的「end-to-end with real ApprovalService / channel PASS」与实测不符；`WP3-B2 守卫` 是静态源码 grep，测不到运行时作用域错误（所以 236/236 全绿仍漏）。
- 附带（同一根因链）：`service.requestApproval` → `gate.request` 传给 `options.request` 的 req 为 `{op,target,digest,summary}`，**不带 agent/callId/signal**（场景 E 实证）；`currentAgent` 在 `createWorkbenchHostService` 内从未读取；`activeAgent` 在该函数内**从无读取方**（死状态）。即便只修作用域，仍拿不到本次请求的 agent。
- 归类：审批旁路/通道失效（任务判定标准明列）→ **REQUEST CHANGES**。
- 建议修法（不越权代改，仅指路）：把 agent 随请求对象从 `runTool` → `service.invoke` meta → `requestApproval` 的 req 一路传递（不要用共享可变状态）；适配器改成读 `req.agent`，删掉 `activeAgent`/`currentAgent` 的跨函数引用；`WP3-B2 守卫` 改成**真 ApprovalService + 最小 open turn + 真 answerer** 的端到端测试（本文件探针可作蓝本），而非正则 grep；顺带把 `docs/wp3/03:86` 的 233 改为 236、删除 `displayReason` 臆造注释。

## 非 blocker 的 nit（不据此单独驳回，但建议随 BLOCKER 一并修）
1. `docs/wp3/03...:86`「233/233」→ 实测 236/236（commit 自己写 236）。
2. `host-service.js:246/267` 的 `displayReason` 真包无此字段（全包 grep 无），属臆造 API 细节。
3. B2 映射把 `rejected`/`cancelled`/`unavailable` 压成 `denied`，模型丢失拒绝原因语义。
4. NIT 1：`askApproval` 默认 scope 签 token vs `invoke` 按 meta.scope 取 service（fail-closed）。
5. NIT 2：`event.restore`/`task.upsert` 在 DANGEROUS_OPS 但 handler 不调 `requireConfirmation`（deny 由 WRITE_OPS 拦；host 下两写操作不需 token）。
6. `WP3-B1 守卫 #2` 标题「真 ToolRuntime 端到端」实只调 `validateJsonSchemaValue`，未调 `createSuccessResult`（本轮已用真 `createSuccessResult` 独立补足验证，B1 结论仍 PASS）。

## B1 说明（明确不驳回）
B1 修复**确实成立**：本轮用真 `defineTool` 编译、真 `validateJsonSchemaValue` 对 8 工具错误值+8 种稳定错误+5 种成功值全 0 violation，真 `ToolRuntime.prototype.createSuccessResult` 对 noAgent/not-found 业务错误均正常返回 `isError=false` 不抛 `ToolOutputError`；并用 `git show f89a311` 旧 schema + 真编译器忠实复现 `matched 2`。不编造 B1 问题。

## 结论

真宿主审批通道（本次两个 BLOCKER 之一）在 `17f79e8` **并未修复**，且新增的守卫测试是静态 grep 而非真端到端，与 commit message / 文档的「PASS」宣称不符。**确实有 blocker（审批通道失效 + 验证夸大），不能 APPROVE。**

# 结论：REQUEST CHANGES
