# WP3 最终独立 Review

- 审查对象：`/tmp/wp3-final-freeze-f89a311`（基准 `f89a311`，git archive 导出）
- 审查员：WP3 最终独立 Review 员（只读，独立复跑）
- 状态：**完成**
- 结论：**APPROVE WITH NITS**（10 项必验全 PASS；1 个 fail-closed nit；无 blocker）

## 检查记录（逐条 append：检查名 / 命令 / 实际输出 / 判定）

（见下，逐条 append 完成）

---

### 检查 1：真实 DSH 契约对齐（docs/wp3/00-contract.md vs asar 源码）

命令与输出（全部针对冻结目录的 `docs/wp3/00-contract.md` 与 `/tmp/dsh-asar-full/dsh/node_modules/@deepseek-ai/*/lib/index.js`）：

- `defineTool(options)` 存在：`lib/index.js:838`（`function defineTool(options)`），读 `options.output.render`、`options.output.schema`、`parameters`、`timeoutMs` 等 —— 与文档 §1 一致。
- `options.output` 必须 `{schema,render}`：`register()` 在 `lib/index.js:2974-2978`，实测抛错文案 `tool "NAME" must declare output { schema, render, presentationMeta? }` —— 一致。
- `execute` 预校验抛 `ToolArgsError`：`lib/index.js:850 validate` / `:868 throw new ToolArgsError(violations)`；`ToolArgsError` 定义于 `:813`，`export` 列表 `:3810` 含 `defineTool, ToolArgsError` —— 一致。
- `ctx.tools.register(definition)` 返回 disposer：`:2974` 末尾 `return this.layers.effect(...)`，JSDoc `:2972` 明写 `@returns the exact disposer that unregisters the tool`；`run_code` 保留名在 `:2978` —— 一致。
- `exec` 真实字段（`:3239-3266`）：`token, callId, rootCallId, name, signal, agent?, parent?, schema?, deferContext(), concludeTurn(), arguments(deepFreeze)`；源码中**无 `exec.sessionId`**。文档 §1「没有 exec.sessionId」成立。
- sessionId 来源：`dsh-tools/lib/index.js:1531` 用 `exec.agent.session.id`；`dsh-tool-schedule/lib/index.js:540,562,594,636` 全部 `agent.session.id`；`:532/556/587/627` 先 `const agent = exec.agent; if (agent === void 0) return internalError()`。文档「唯一来源 = exec.agent.session.id」成立。
- 插件范式：`dsh-tool-schedule/lib/index.js:13 const name="tool-schedule"`, `:17 const inject=["tools"]`, `:496 function apply(ctx)`, `:497 ctx.inject(["schedule"], (scheduleCtx)=>...)`, `:661 export { apply, inject, name }` —— 与文档 §2 逐字一致。
- `subagentCallerRefusal`:`:300 delegationDepthOf(agent)===0`、稳定 `{code:"subagent_session",message}` —— 文档 §2 一致。
- 审批 seam：`dsh-tools/lib/index.js:3313-3320` 的 `tools/pre-execute` waterfall → `serviceAsk`，与 `dsh-user-approval/README.md` 的 `ask/never`、`unavailable` fail-closed、`request(req)` 需 open turn、写请求会话审计、`setPolicy/setApprovalPolicy` 全部一致。
- `ctx.tools.restrict/get/schemas(scope)`：`dsh-tools/README.md:85,109` 一致。
- 错误 `{code,message}`：`dsh-tool-schedule` 的 `internalError()/operationError()` 与 `schedule_delete` 等返回稳定 `{code,message}`；`dsh-tools` 错误结果经 `toolErrorResult`。文档 §2「稳定 {code,message}」成立。
- 文档 §5/§6 对 `service.js` `execute(op,payload,meta)` / `deny` / 红线的描述：与冻结 `service.js:432-450`、`:33-57` 一致（非编造）。
- `ctx.provide` 范式：`dsh-cmdline/lib/index.js:29-31` 真实使用 `ctx.provide("cmdlineArgs"/"appExit"/"appReady", ...)`，与 `host-service.js:211` 注释引用一致。

判定：**PASS**。逐条核对未发现任何编造 API；特殊点（`exec.agent.session.id` 唯一来源、register 返回 disposer、output 必须 `{schema,render}`、稳定错误码）全部与 app.asar 一手源码吻合。文档标注的行号均可复核。

---

### 检查 2：真 defineTool 验证（直接 import 冻结目录 src/index.js）

探针：`/tmp/wp3final/probe-defineTool.mjs`（`import ${FREEZE}/workbench-core/src/index.js` + `import ${ASAR}/@deepseek-ai/dsh-tools/lib/index.js` 的 `defineTool, ToolArgsError`）。

命令：`cd /tmp/wp3-final-freeze-f89a311 && node /tmp/wp3final/probe-defineTool.mjs`

实际输出：
```
== 工具数 == 8
== 工具名 == workbench_event_list, workbench_event_get, workbench_task_list, workbench_event_create, workbench_event_update, workbench_task_upsert, workbench_help, workbench_audit
== 真 defineTool 包住 8 个全部不抛错 == 8 / 8
== create.ok == true | event.title == 原名
== session-REAL event.list.length == 1
== session-OTHER event.list.length == 0
== update.ok == true | get.title == 新名 | get.location == 会议室
== 缺参抛错 name == ToolArgsError | instanceof ToolArgsError == true
== PROBE-DEFINE-TOOL: ALL PASS ==
```

- 8 个定义全部被真 `defineTool` 接受（不抛 TypeError，说明 `output.schema` 通过 `assertSupportedJsonSchema`、`render` 是函数）。
- `execute` 经真包装后：创建成功、本 session 查询到 1 条、跨 session 查询 0 条、编辑后 `event.get` 返回新 title/location、缺 `title` 抛 `instanceof ToolArgsError`。
判定：**PASS**。真加载的是 asar 解包目录的 `dsh-tools/lib/index.js`（非 stub），8 个定义与真契约兼容。

---

### 检查 3：契约对齐实证（工具层 → service 真实 payload 形状）

探针：`/tmp/wp3final/probe-contract-shapes.mjs`（spy 包 `service.invoke` 捕获 `op/payload`，同时透传真 service 落盘）。
命令：`cd /tmp/wp3-final-freeze-f89a311 && node /tmp/wp3final/probe-contract-shapes.mjs`

实际输出：
```
== event.update payload == {"id":"6f5...","patch":{"title":"新名","location":"会议室"}}
== event.get after update title == 新名
== task.upsert #1 payload == {"task":{"id":"t1","title":"买牛奶"}}
== task.list after #1 == 1 [{"id":"t1","title":"买牛奶"}]
== task.list after #2 (same id) == 1 [{"id":"t1","title":"买牛奶（改）","done":true}]
== event.list payloads == [{"includeDeleted":true},{"includeDeleted":false}]
== PROBE-CONTRACT-SHAPES: ALL PASS ==
```

- `event.update` 确实传 `{id, patch:{...}}`（title/location 在 patch 内，未平铺）；改后真 `event.get` 返回 `title=="新名"`。
- `task.upsert` 确实传 `{task:{id,...}}`；同 id 第二次调用后 `task.list` 仍 1 条且 title 已改 → 是更新不是新增。
- `event.list` 全部调用 payload 键集合恰为 `['includeDeleted']`，只传该字段。
判定：**PASS**。与 `docs/wp3/03-natural-language-and-unified-api.md` §3 表格及 `service.js:201/379/145` 真实读法一致。

---

### 检查 4：会话 / scope 隔离 + `workbench_audit` 跨 session 不可见

探针：`/tmp/wp3final/probe-isolation.mjs`（直接 import 冻结 `src/index.js`）。
命令：`cd /tmp/wp3-final-freeze-f89a311 && node /tmp/wp3final/probe-isolation.mjs`

实际输出：
```
== session-A list == 1 | session-B list == 0
== after B writes: session-A titles == A-only
== [fresh svc] scope events/tasks/default counts == 1 1 0
== events titles == events-scope | tasks titles == tasks-scope
== [fresh svc] rootDir 子目录 == 3 s-1b9342d91e352d3e5b6cc5e9, s-...-085154084c74, s-...-862417b9e7c3
== after default-scope write: default == via-tool-default | events == events-scope
== audit session-A rows == 4 | session-B rows == 3
== audit A sessionId token == s-1b9342d91e352d3e5b6cc5e9
== session-B audit contains A token? == false
== PROBE-ISOLATION: ALL PASS ==
```

- 两个 session 互不看见；B 写入后 A 仍只有自己的 `A-only`。
- 两个 named scope（`events`/`tasks`）各写各的、default scope 独立第 3 个目录；rootDir 下确有 3 个独立 sha256 子目录（scope 进了目录路径，不只是 Map key）。
- `workbench_audit`：`host-service.js:179-185` 按 `sessionDirName(sessionId)` 过滤；实测 B 的 rows 里不含 A 的 token。
判定：**PASS**。

> 备注（审查员自设探针的一次「失败」已排除）：首版探针在同一 service 上先用工具（default scope）写过 event，再断言 default scope 为空，得到 `1 !== 0` —— 这是探针自身 setup 顺序问题，非产品缺陷；用 fresh service + 显式验证「default 目录只含 default 写入」后通过。如实记录，不计为问题。

---

### 检查 5：审批安全

探针：`/tmp/wp3final/probe-approval.mjs` + `/tmp/wp3final/probe-confirmed.mjs`（均直接 import 冻结 `src/index.js`）。
命令：`cd /tmp/wp3-final-freeze-f89a311 && node /tmp/wp3final/probe-approval.mjs && node /tmp/wp3final/probe-confirmed.mjs`

`probe-approval.mjs` 实际输出：
```
== 工具名清单 == workbench_event_list, workbench_event_get, workbench_task_list, workbench_event_create, workbench_event_update, workbench_task_upsert, workbench_help, workbench_audit
   event.delete / event.bulkDelete / event.import / snapshot.replace / store.rollback 暴露为工具? 全部 false
== create.execute 源码含 confirmed? == false
== invoke event.delete with confirmed:true → code == confirmation-required
== requestApproval(event.delete) 无 answerer → {"approved":false,"reason":"host-unavailable"}
== execute(event.delete) 无 token → code == confirmation-required
== service.store frozen? true keys=[listBackups, listPreBackups]
== service.events frozen? true keys=[list, get]
== store.replace/mutate/rollback, events.remove/create → 全部 undefined
== hostService.store / hostService.events → undefined undefined
== PROBE-APPROVAL: ALL PASS ==
```
`probe-confirmed.mjs` 实际输出（澄清一次探针假设偏差后）：
```
== [真 defineTool] confirmed:true → ok == undefined | code == validation | 未知字段：event.confirmed
== 事件数（应 0，未落库）== 0
== [真 defineTool] 正常创建 ok == true
== delete with confirmed:true → code == confirmation-required
== PROBE-CONFIRMED: ALL PASS ==
```

- **`args.confirmed:true` 不能绕过**：真 `defineTool` 生成的 parameters schema 不设 `additionalProperties:false`（`parameterSchemaSpecToJsonSchema` `:802-809` 仅 type/properties/required），故额外字段透传到 service；service 的 `validateObject(allowUnknown=false)` (`validate.js:53`) 抛 `validation`「未知字段：event.confirmed」，调用不 ok、不落库。危险 op 不在工具面，直接 `invoke` 带 `confirmed:true` 仍 `confirmation-required`。全程 confirmed 无授权含义。
- **危险 op 未注册为工具**：8 个工具仅 list/get/create/update/upsert/help/audit；delete/bulkDelete/import/replace/rollback 全部不在面。
- **host 模式无 answerer fail-closed**：`requestApproval` 返回 `unavailable` → `approval-gate.js:131` `if (outcome !== 'approved') return {approved:false, reason:'host-unavailable'}` → `service.js:96-107 requireConfirmation` 抛 `confirmation-required`（原因 missing-token）。
- **`svc.store` / `svc.events` 不可写**：`createWorkbenchService` 返回面是 `Object.freeze` 的只读投影（`listBackups/listPreBackups`、`list/get`）；`replace/mutate/rollback/remove/create` 全部 undefined；`host-service` 返回面干脆不暴露 store/events。
判定：**PASS**。

---

### 检查 6：自然语言机制 + `workbench_help` 不泄露 sessionId

命令与输出：
- `grep -rniE "nlp|intent.parser|parse.intent|natural.language.parser|keyword.match|classif" workbench-core/src/` → **无任何输出**（源码中没有 NLP/意图解析器实现），与 `docs/wp3/03-natural-language-and-unified-api.md` §1「不内置 NLP 解析器」一致。
- 真实 DSH 机制核对：`dsh-tools/README.md:30`「Registering a tool is enough to make it visible — the registry feeds its schemas into the system-prompt assembly automatically」；`:141` tool schemas 自动进 prompt assembly。→ 模型读 schema 自行映射，确实无需自造 NLP。文档引用准确。
- 探针 `/tmp/wp3final/probe-nlp-help.mjs`（`node` 运行）输出：
```
== help.ok == true
== help sessionId 字段 == [redacted]
== 输出包含 sessionId 原文? == false
== 输出包含 sha256 前缀? == false
== tools 数 == 8
== 工具名里有无 parse/nlp/intent/understand 类 == []
== 全部 8 个工具都有 >=20 字符 description == true
== help 内部 invoke 调用次数（应 0）== 0
== PROBE-NLP-HELP: ALL PASS ==
```
- `workbench_help` 返回 `sessionId: '[redacted]'`（`host-tools.js:214`），实测用 `'super-secret-session-id-12345'` 作 sessionId 调用，输出 JSON 中不含原文、也不含 sha256 `s-` 前缀。
- `workbench_help` 内部调用 `createWorkbenchToolDefinitions({service:{invoke:()=>({})}})` 只做 `.map(d => ({name, description, parameters: Object.keys(...)}))`，**不调用 invoke**（实测 0 次），无副作用、无无限递归。
判定：**PASS**。

---

### 检查 7：不冒充真实宿主（stub 使用 / 真 asar 加载）

命令与输出：
- `grep -c "contract-stub" workbench-core/test/host-service.test.mjs workbench-core/test/host-tools.test.mjs` → `0 / 0`。**WP3 新增的两个测试文件完全不引用 `contract-stub.mjs`**。该 helper 仅被 WP2 既有的 `contract.test.mjs` 使用（其文件头 `:1-23` 诚实声明「这是行为模拟，不是真宿主」，且 `docs/wp3/00-contract.md:94` 红线明确禁用它冒充 Host）。
- WP3 测试中出现的「同形注入」：`host-tools.test.mjs:140-142` 的 `defineTool = (d)=>({...d,__wrapped:true})` 用于测 `applyWorkbenchTools` 的 disposer 行为，注释明写「本测试不 import DSH 包」，**未声称是真实宿主**。
- 真 defineTool 验证：`:162 const asarReady = existsSync(...)`；`:164-197` 两个测试用 `await import('/tmp/dsh-asar-full/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')` 加载 `defineTool`。实测 `node --test --test-name-pattern="真实 defineTool" test/host-tools.test.mjs` → `pass 2 / skipped 0`；完整单测输出中 `ok 104`、`ok 105` 且 `# skipped 0`。该文件 `grep -c "function defineTool"` = 1，确为真包源码。
- `scripts/probes/p1-real-storage-domain.mjs:49-54` 加载真 `cordis`/`dsh-storage`/`dsh-storage-json`/`dsh-storage-domain`/`dsh-schedule`（均为 WP2 既有探针，非 WP3 新增，也非用 stub 冒充）。
- 全仓 grep `real.?host|真宿主|冒充|mock.?ctx|Mem.*Adapter|pretend`：命中都是文档/注释里「真宿主签发」「不冒充真实宿主」「真实宿主未测」等**诚实声明**，无「把 mock 当真宿主证据」的代码。
判定：**PASS**。WP3 新增测试没有用 stub 冒充 Host；真 defineTool 验证确实加载了 asar 包且未 SKIP。

---

### 检查 8：O(N²) 登记（`docs/wp3/01-on2-registry.md`）+ 复跑基准

命令与输出：
- `grep -n "await backend.catalog()" workbench-core/src/schedule-adapter.js` → `307, 312, 341`；`sed -n '300,345p'` 确认 `:341 const current = await backend.catalog()` 正是 `upsertLocked()` 第一行（文档 `:17` 引用准确）。
- 文档诚实性：`docs/wp3/01-on2-registry.md:3` 明写「状态：**UNRESOLVED** —— 本轮仅登记 + 建立可复现基准，**未改动对账实现，不宣称已解决**」；`:57-65` 明写「本基准实测呈线性……**不支持**『在本环境下是 O(N²)』的定性」「❌ 不照抄『O(N²) 已确认』」「❌ 也不因线性就宣称『已解决』——真实 Host 路径完全未测」「✅ 登记为『模拟环境下线性但常数大；真实 Host 未测；实现未改动』」；`:68` 修法方向明确「留待有证据时」。**没有在缺乏证据时宣称已解决**。
- 基准可复现：`scripts/bench-reconcile.mjs:28` `import createContractStub`，文档 §3 明写「与现有测试同一 `contract-stub`」，并诚实声明 `contract-stub` 的 `catalog()` 是内存操作、真实 Host 读盘代价未测。
- 复跑 `cd /tmp/wp3-final-freeze-f89a311 && node scripts/bench-reconcile.mjs /tmp/wp3final/bench-reconcile.log`（输出改到 `/tmp/wp3final/` 以守只读约束）实际输出：
```
      N          ms     ms/1000      宿主行  created  failed
    100       428.2      4281.5      100      100       0
    200       933.0      4665.1      200      200       0
    400      1992.9      4982.3      400      400       0
    800      4628.3      5785.4      800      800       0
  N= 100  ms/N² = 4.282e-2 ; 200 = 2.333e-2 ; 400 = 1.246e-2 ; 800 = 7.232e-3
状态：UNRESOLVED
```
- 数据一致性：文档记录 `379.7/746.7/1493.1/3339.2 ms`，冻结内 `evidence/wp3/bench-reconcile.log` 为 `422.4/985.1/2220.1/4589.4 ms`，本次复跑 `428.2/933.0/1992.9/4628.3 ms` —— 绝对毫秒随机器负载浮动（常识），但**同量级、N 翻倍耗时约翻倍、`ms/N²` 单调下降（线性特征）、created=N、failed=0** 三项结论完全一致。文档据 `ms/N²` 下降判「线性而非 O(N²) 实测」在本次复跑同样成立。
判定：**PASS**。如实标注 UNRESOLVED、建了可复现基准、未宣称解决、真实 Host 未测如实写明；复跑数据趋势一致。

---

### 检查 9：回归（233/233、36/36、8/8）

为守「除 `evidence/wp3/final-review/` 与 `/tmp/wp3final/` 外不写任何文件」约束，先把冻结目录 `cp -a` 到 `/tmp/wp3final/work` 并 `diff -qr` 确认 **828 文件逐字节一致**，所有会写日志/临时改源码的脚本都在该副本里跑；冻结目录本身保持只读（复核 `find -name "*.mutation-backup"` 无残留、828 文件不变）。

- **单测**：`cd /tmp/wp3final/work/workbench-core && node --test test/*.test.mjs`
```
# tests 233
# pass 233
# fail 0
# skipped 0
```
→ **233/233**。含 WP3 的 `ok 104`/`ok 105`「真实 defineTool」两项（`# skipped 0`，未跳过）。

- **变异**：`cd /tmp/wp3final/work && node scripts/r3-mutate.mjs /tmp/wp3final/mut.log`
```
变异定义：36 项
CAUGHT: 36
VACUUM: 0
SKIP:   0
结论：全部保护点都有测试约束（0 真空，0 跳过）；EXIT=0
```
→ **36/36，0 真空 0 跳过**。

- **门禁**：`cd /tmp/wp3final/work && bash scripts/wp2-r5-gate.sh`
```
=== 门禁汇总 ===
通过 8 项，失败 0 项
RESULT: PASS
```
各步日志复核：unit-tests `# pass 233 / # fail 0`、mutations `CAUGHT:36 VACUUM:0 SKIP:0`、acceptance-8 `PASS 26 FAIL 0 UNVERIFIED 0`、real-service-l4 `RESULT: L4 PASS`、demo/probe-real-storage/probe-protect/probe-retention 全 ✅。→ **8/8**。
判定：**PASS**。

---

### 检查 10：诚实性（UNVERIFIED 保留 / 文档数字与实测一致）

- **UNVERIFIED 全项保留**：`docs/wp3/02-wp2-conditional-acceptance.md:52-61` 表格逐项列出 6 条 —— ①真实宿主投递回执不可读（「**不宣称 exactly-once**」）②真实 macOS 休眠/唤醒/退出/重启「**完全未测试**」③系统通知是否真正弹出未验证 ④多进程并发写（文件存储非多进程安全、hostMap 无跨进程锁）⑤真实 Host 的 fiber/effect 生命周期（「探针用真组件但宿主生命周期仍简化构造」）⑥O(N²)/线性性能「单独登记且 **UNRESOLVED**……真实 Host 未测、实现未改动」。标题明写「保留的全部 UNVERIFIED 项（不因条件验收而清除）」。无遗漏、无悄悄清除。
- **文档数字 vs 实测**：
  - `docs/wp3/03-natural-language-and-unified-api.md:85`「233/233」= 本次实测 `# pass 233` ✅
  - `:86`「36/36」= 实测 `CAUGHT: 36 VACUUM:0 SKIP:0` ✅
  - `:87`「真 defineTool 接受 8 个定义」= 实测 8 个工具、`defineTool` 全接受 ✅
  - `host-tools.test.mjs:55-64` 断言的 8 个工具名 = `host-tools.js` 实际 8 个 ✅
  - `docs/wp3/02...:48`「209/209 单测、36/36 变异、8/8 门禁、26/26 验收」—— 209 是 WP2 增量阶段（`c12d377`）的历史数字，非 WP3 冻结版数字；本冻结版为 233（WP3 新增 24 个测试后），文档 03 已用 233。属历史阶段如实记录，不是把旧数冒充当前。
  - `docs/wp3/01-on2-registry.md:29`「207 项测试」同为 WP2 阶段历史数；`:57` 关于「实测呈线性」的定性经复跑仍成立。
- `docs/wp3/02...:26-42` 主动记录并纠正主会话一处误判（把既有契约当缺陷、把 `c12d377` 说成修缺陷），保留草稿路径备查 —— 属诚实自纠，非掩盖。
- `docs/wp3/03...:52-54`「这层对齐是**实测**出来的：初版 event.update/task.upsert 平铺字段编辑不会生效；已修正」—— 与检查 3 实证一致，未夸大。
判定：**PASS**。UNVERIFIED 无删减，关键数字（233 / 36 / 8 工具）与冻结版实测一致，无「宣称解决 / 宣称 exactly-once / 冒充真宿主」类夸大。

---

### 额外自己找（5 项）

探针：`/tmp/wp3final/probe-extra.mjs` + `/tmp/wp3final/probe-apply-chain.mjs`（直接 import 冻结 `src/index.js`）。

**A) `forSession` 的 `dirName::scope` Map key / 目录哈希 —— 碰撞与路径穿越**
`cd /tmp/wp3-final-freeze-f89a311 && node /tmp/wp3final/probe-extra.mjs` 输出（节选）：
```
A1 sessionId="../../etc"/"../evil"/"a/b"/"a\\b"/".."/"."/"foo\x00bar" → escapedRoot=false（全部）
A1 rootDir 内子目录: 7 个（全部 s-<hex> 形式）
A2 新增目录: s-d3850a8512c08bc02e187232-96d489d8786a；目录名含 scope 原文? false
A3 dirName 字符集 = s-[0-9a-f]{24}，不含 ":" → key 分隔无歧义
```
- 路径穿越：sessionId 先经 `sessionDirName()` (`host-service.js:36-41`) 做 `sha256().hex.slice(0,24)` 变成 `s-<24hex>` 才进 `join(rootDir, ...)`；scope 也只取其 `sha256().hex.slice(0,12)` 作 suffix。含 `../`、绝对路径、反斜杠、null 字节的恶意 sessionId/scope **都不会逃逸 rootDir**（实测 `escapedRoot=false`，目录全是 `s-<hex>` 形式）。非空校验拒空串/非字符串（`host-service.test.mjs:134-146` 另测）。
- 哈希碰撞：`dirName` 是 96-bit 截断、`scopeSuffix` 48-bit 截断。理论上极大量 scope 时 48-bit 存在生日碰撞可能（约 2^24 个 scope 才 ~50%），届时两个不同 scope 会共用同一 dataDir —— 但这是**理论概率**，非当前证据下缺陷；且即便共用目录，二者仍是同一 session 内，不构成跨 session 泄露。session 间 96-bit 碰撞概率可忽略。
- Map key `dirName::scope`：`dirName` 字符集不含 `:`，故 `(A, "B::C")` 与 `(A::B, "C")` 不会歧义；scope 原文进 Map key 但不进目录名（A2 实测），不泄露原文到文件系统。
- 判定：**无 blocker**（真实路径穿越被哈希阻断；碰撞是理论风险，记为 nit 级观察，不驳回）。

**B) `runTool` 包 `{ok,op,result}` + `output.schema` 宽松 object —— 会不会让模型拿到不该拿的数据**
```
B1 create 返回顶层键: ok,op,result | ok= true | op= event.create
B1 result.event.title = 敏感数据
B2 output.schema.oneOf[0] = {"type":"object","additionalProperties":true}
B3 result 含内部敏感键? none
```
- `output.schema.oneOf[0]` 是宽松 `object`（`host-tools.js:67-70`），设计目的是「op 返回值形态各异」；第二分支 `ERROR_SCHEMA` 是 `additionalProperties:false` 的 `{code,message}`。
- 关键防护不在 schema，而在：service 返回面是只读投影（检查 5 已证 `store`/`events` 全 frozen 且无写方法）、`operationError` 只回白名单码、审计只记 payloadKeys。实测 `JSON.stringify(create 结果)` **不含** `store/gate/token/approvalToken/issuerNonce/dataDir/rootDir` 等内部键。`result.event.title` 是「创建后回显业务数据」，属预期输出而非泄露。
- 判定：**无 blocker**。宽松 schema 本身不把内部对象塞给模型；若要更严可给每个 op 声明专用 schema（nit）。

**C) `workbench_help` 的 `createWorkbenchToolDefinitions({service:{invoke:()=>({})}})` 副作用 / 无限递归**
```
C1 help 调用次数= 0 | ok= true | tools= 8
```
- `host-tools.js:215-216` 内部只调 `.map(d => ({name, description, parameters:Object.keys(...)}))`，**从不调用 `invoke`**（实测 0 次），也不递归调用 `workbench_help.execute`。传入的 dummy service 仅用于满足 `createWorkbenchToolDefinitions` 的 `service.invoke` 类型检查（`:123-125`）。
- 判定：**无副作用、无递归**。

**D) `applyWorkbenchHostService` 的 `ctx.approval.request` 注入是否把 `unavailable` 当批准**
```
D approval.request=unavailable → {"approved":false,"reason":"host-unavailable"}
D approval.request=denied     → {"approved":false,"reason":"host-denied"}
D approval.request=throws     → {"approved":false,"reason":"host-error:no answerer"}
D approval.request=approved   → {"approved":true,"token":"c4b19f..."}
D 无 approval 配置            → {"approved":false,"reason":"host-requester-missing"}
```
`probe-apply-chain.mjs` 端到端（经完整 `invoke → execute` 链）：
```
[unavailable] approved=false token=none | delete → THROW confirmation-required
[approved]    approved=true  token=yes  | delete → ok={"id":"...","deletedAt":"..."}
```
- `host-service.js:224-236` 把 `config.approval.request` 透传给 `approval-gate.js:122-133`；后者 `if (outcome !== 'approved') return {approved:false,...}`（`unavailable`/`denied`/抛错/未知/无 requester 全部拒绝），只认字符串 `'approved'`。无 answerer → fail closed，与 `dsh-user-approval` 真实语义一致。
- 判定：**不会误当批准**，fail-closed 成立。

**E) 26 个新增测试里有没有「只测自己 mock、没测真实契约」的假测试**
- 计数：`host-service.test.mjs` 9 个 + `host-tools.test.mjs` 15 个 + `c12d377` 给 `contract.test.mjs` 加的 2 个守卫 = **26**，与「26 个测试」一致。
- WP3 两个测试文件的 `mkService` 注入的是**真的** `createWorkbenchHostService`（内部会建真的 `createWorkbenchService` + 真的文件 store/落盘）；唯一注入的是 `requestApproval: async () => 'unavailable'`（无真 Host answerer 时必要且诚实标注，见 `:7-9` 注释「不冒充真实宿主」）。断言的是真实行为：真文件落盘后的 session 隔离、真 `event.get` 返回新 title、真 payload 形状、真 disposer 反注册、真 `defineTool` 加载（`host-tools.test.mjs:164-197`）等，断言数 25+44 处。
- 有 2 处「文档级 / 结构级」测试（`:265` 自然语言意图映射说明、`:51` 工具定义齐全）只断言描述长度/schema 形状，属合理的契约守卫，不是「用 mock 冒充通过」。
- `applyWorkbenchTools` 的 disposer 测试用了同形 `defineTool` 注入（`:140-142`），但**另有**两个真 `defineTool` 测试（`:164/176`）覆盖真实契约，二者互补，非「只测 mock」。
- 判定：**无假测试**。

---

### 额外补强：真 defineTool 包装下 help/audit 的 `this.service` + 边界

`/tmp/wp3final/probe-defineTool-audit-help.mjs`：
```
create ok= true
[wrapped] help → ok= true | tools= 8 | code= undefined
[wrapped] audit → ok= true | rows= 2 | code= undefined | msg= undefined
== PROBE-DEFINETOOL-AUDIT-HELP: ALL PASS ==
```
`defineTool` 的 `execute` 以 `userExecute(args, exec)` 调用、不显式绑 `this`；但 `host-tools.js:242-247` 的 `boundExecute` 用 `original.call({service}, args, exec)` 主动绑定，故 help/audit 经真 `defineTool` 包装后 `this.service` 仍有效（实测 ok，无 `internal_error`）。这个「用 this 绑定 service」的设计正是为兼容真 defineTool，成立。

`/tmp/wp3final/probe-edge.mjs`：
```
noAgent / aborted / agent 无 session.id → 稳定 {code:"internal_error",...}
event.list 多传 confirmed/sessionId → {ok:true,...}，多余字段被忽略
audit limit=999999 → 被夹到 2000（rows=2，无越界）
== PROBE-EDGE: ALL PASS ==
```

`/tmp/wp3final/probe-apply-chain.mjs`（完整 `invoke → execute` 链）：
```
[unavailable] approved=false token=none | delete → THROW confirmation-required
[approved]    approved=true  token=yes  | delete → ok={"id":"...","deletedAt":"..."}
```

### 额外发现（1 个 nit，非 blocker）：`askApproval` 与 `scope` 的凭证域不一致

复现（`/tmp/wp3final/probe-scope-token.mjs` / `probe-scope-token2.mjs`）：
```
[default] askApproval → token → invoke(default) delete → ok
[named]   askApproval → token → invoke(scope='events') delete → THROW confirmation-required（原因 unknown-token）
[tool]    AI 工具 execute 传给 service.invoke 的 meta = {"actor":"agent-tool"}（不含 scope）
[A] forSession('s1','events').requestApproval → token → invoke(scope='events') delete → ok deleted=true
[B] 无 token + confirmed:true → confirmation-required
[C] default-token 用于 named-scope → confirmation-required | 事件仍存在? true
```
- 成因：`askApproval(sessionId, op, detail)` (`host-service.js:173-176`) 用 `forSession(sessionId)`（默认 scope），而 `invoke` 用 `forSession(sessionId, meta.scope)`；每个 `forSession` 实例各有独立的 `createHostApprovalGate`（独立 `issued` token map / `issuerNonce`），故默认域签发的 token 在 named-scope 域校验为 `unknown-token`。
- 严重性判定：**fail-closed nit，不是 blocker**。① 危险 op（delete/import/rollback 等）**根本没注册为 AI 工具**，工具面 `runTool` 不传 `scope`（实测 meta 仅 `{actor:'agent-tool'}`），恒走默认域，`askApproval` 与 `invoke` 同域，一致；② named-scope 下存在可用路径（路径 A：直接对 `forSession(sid,scope).requestApproval` 申请）；③ 跨域误用/无 token/`confirmed:true` 全部 `confirmation-required`（路径 B/C），**无审批旁路、无数据丢失、无越权删除**。
- 建议（nit，后续修）：`askApproval` 增加 `scope` 参数并透传给 `forSession`，或统一把审批 gate 提到 host-service 层按 session 共享。不影响本轮 WP3 功能验收。

### 数据丢失 / 重复投递 / 会话隔离失效 的独立排查
`git diff d6cc887..f89a311 -- workbench-core/src/` 共 4 文件、544 插入 / 2 删除：`host-service.js`(新 245)、`host-tools.js`(新 271)、`index.js`(+16 导出)、`host-map.js`(14 行，即 `c12d377` 已被独立 Review APPROVE 的 load/prune 置脏加固)。**WP3 未改写任何持久化、提醒投递、冲突/去重状态机**；新增代码里没有 `delete/remove/rollback/truncate/unlink` 等破坏性调用（仅 `auditTrail.splice` 做 2000 条上限裁剪，属内存审计数组，非业务数据）。会话隔离经检查 4 实测成立。无 blocker 类问题。

---

## 结论汇总

| # | 检查 | 判定 |
| --- | --- | --- |
| 1 | 真实 DSH 契约对齐（00-contract.md vs asar 源码，含 4 个特别核对点） | PASS（无编造 API） |
| 2 | 真 defineTool 包住 8 定义 + execute 创建/查询/编辑/隔离/缺参 | PASS（8/8，ToolArgsError） |
| 3 | 契约对齐实证 event.update `{id,patch}` / task.upsert `{task:{id}}` / event.list 只 includeDeleted | PASS |
| 4 | 会话 / scope 隔离、audit 跨 session 不可见 | PASS |
| 5 | 审批安全（confirmed 不能绕过 / 危险 op 未注册 / 无 answerer fail-closed / store·events 不可写） | PASS |
| 6 | 自然语言机制（不内置 NLP、schema 进 prompt）/ help 不泄 sessionId | PASS |
| 7 | 不冒充真实宿主（WP3 测试不用 stub；真 defineTool 确加载 asar，未 SKIP） | PASS |
| 8 | O(N²) 登记 UNRESOLVED + 可复现基准 + 未宣称解决；复跑数据趋势一致 | PASS |
| 9 | 回归 233/233、36/36（0 真空 0 跳过）、8/8 | PASS |
| 10 | 诚实性（6 项 UNVERIFIED 全保留；233/36/8 工具与实测一致） | PASS |
| 额外 | forSession 碰撞/穿越、runTool 宽松 schema、help 递归、approval unavailable、假测试 | 无 blocker |
| 额外 | 1 个 nit：`askApproval` 与 named-scope 的审批 token 域不一致（fail-closed） | NIT |

### Blocker 判定（逐条排除）
- **数据丢失**：无。WP3 源码 diff 为纯新增（host-service/host-tools/index 导出）+ `host-map.js` 已审的 14 行置脏加固；未改写持久化/投递/去重状态机；破坏性调用仅审计数组上限裁剪。
- **重复投递**：无。提醒对账实现未改动（`01-on2-registry.md` 如实标注实现未改动、UNRESOLVED）；36/36 变异含 X26「去掉同 key 创建锁（并发重复投递回归）」被测试捕获。
- **审批旁路**：无。`confirmed:true` 全程无授权含义；危险 op 不在工具面；无 answerer → `unavailable` → fail-closed；跨域 token 误用被拒（非放行）。
- **伪造真实宿主**：无。WP3 新增测试不引用 `contract-stub`；真 defineTool 验证实加载 asar 包且未 SKIP；`contract-stub` 仅在 WP2 既有测试/基准中诚实标注为「行为模拟，不是真宿主」。
- **会话隔离失效**：无。sessionId 唯一来源 `exec.agent.session.id`；sha256 目录隔离 + scope 独立目录；跨 session 数据与 audit 均不可见（实测）。

### Nit（不驳回，建议后续修）
1. `host-service.js:173-176` `askApproval()` 用默认 scope 的 service 签发审批 token，而 `invoke()` 按 `meta.scope` 取 service；每实例独立 gate，故 default 域 token 在 named-scope 域为 `unknown-token`。**fail-closed**（拒绝而非放行），且 AI 工具面不传 scope（恒默认域，两者一致），named-scope 另有 `forSession(sid,scope).requestApproval` 可用路径。建议给 `askApproval` 增加 `scope` 参数，或把审批 gate 提到 host-service 层按 session 共享。
2. （可选，非缺陷）`runTool` 的 `RESULT_SCHEMA` 是宽松 `object`，可在本轮之后为各 op 声明专用 output schema 以 tighten；当前不泄露内部对象，已有只读投影 + 错误白名单兜底。
3. （可选，非缺陷）`scopeSuffix` 为 sha256 48-bit 截断，极大量 scope 时理论存在生日碰撞（约 2^24 量级）；sessionId 为 96-bit，可忽略。当前证据下无实际碰撞、无跨 session 泄露。

### 只读与写入合规
- 冻结目录 `/tmp/wp3-final-freeze-f89a311` 未改动：828 文件不变、无 `.mutation-backup` 残留（审查中父 agent 曾并发在其上跑 mutate，结束后已复原，复核通过）。会写日志/临时改源码的脚本全部在 `cp -a` 出的字节一致副本 `/tmp/wp3final/work/` 运行（已 `diff -qr` 确认一致）。
- 主仓库 `git status --porcelain` = `?? evidence/wp3/final-review/`（仅本产物目录），未改任何被跟踪文件。
- 所有探针在 `/tmp/wp3final/` 且直接 `import` 冻结目录 `workbench-core/src/index.js`；产物仅 `evidence/wp3/final-review/VERDICT.md`。

# 结论：APPROVE WITH NITS
