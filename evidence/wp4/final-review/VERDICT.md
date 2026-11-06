# WP4 最终独立 Review — 已完成（结论：REQUEST CHANGES）

审查对象（冻结快照）：`/tmp/wp4-final-freeze-1a2c7ef`
基准 commit：`1a2c7ef`（846 文件）
主仓库 HEAD（开始时）：`1a2c7ef970f4efc5cc8f195203c80e87e8ba05bb`
审查员：WP4 最终独立 Review 员（代码 + 视觉静态，只读）

状态：**已完成**（每完成一项检查即时 append 于下方）。最终结论见文件末尾 `# 结论：REQUEST CHANGES`。

---

## 检查记录

### 检查 1：冻结纪律 — PASS
- 命令：`git archive 1a2c7ef | tar -x -C /tmp/wp4rev/archive`；`diff -rq /tmp/wp4rev/archive /tmp/wp4-final-freeze-1a2c7ef`
- 实际输出：archive 文件数 **846**，冻结目录文件数 **846**，`diff -rq` 无任何输出，`DIFF_EXIT=0`。
- 判定：冻结副本与 commit `1a2c7ef` 逐字节一致。
- 主仓库 HEAD（开始）：`1a2c7ef970f4efc5cc8f195203c80e87e8ba05bb`（`git -C /Users/sylas/Developer/dsh-workbench rev-parse HEAD`）。结束 hash 在文件末尾复核。

### 检查 2：真实 DSH 契约对齐（逐条核对 asar 源码）
命令与输出（FULL=/tmp/dsh-asar-full/dsh/node_modules/@deepseek-ai）：

- `main` keyed slot：`dsh-client-ui-layout/lib/client.js:119` = `renderSlot("main", {}, { entryKey: usePanelInfo(info=>info.activePanelId) ?? "conversation" })`；`:631-633` 声明 `"main": { kind:"keyed", scope:"root" }`。→ 契约文档「main 是 keyed、不覆盖 conversation」**真实成立**。
- `sidebar.panellist`：`dsh-client-ui-schedule/lib/client.js:7484-7490` 用 `ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({name,id,order,locale,label}, Icon))`。→ 真实存在。
- `--dsw-alias-*` 令牌：`grep -o -- '--dsw-alias-[a-z0-9-]*' dsh-client-ui-schedule/lib/client.js | sort -u` 实际列出 22 个（含 label-primary/secondary/tertiary、interactive-bg-hover、border-l1/l2/l3/l4、scrollbar-*、state-warn-*、state-business-primary 等）。契约文档 §2 列的 11 个全部在真实集合内，**无编造令牌**。
- `ctx.commands.register` / `execute` 真实签名：`dsh-commands/lib/index.js:327` `execute(agent, line, submittedAttachments, signal)`；`invocation = {commandId, agent, rawInput, attachments, signal}`（`:375-380`）；`agent.session.id`、`rawInput`、`signal` 字段真实存在。`dsh-client-ui-commands/lib/client.js:1718` `const result = await this.ctx.remote.commands.execute(session.sessionId, line, attachments)`；`:1720` `result.value === void 0` 判断；`:1721` `result.value.result`（→ 见 Blocker-1）。
- `ctx.remote.commands.execute` 的 Remote 结果 schema：`dsh-commands/lib/typert.remote-client.js:21-33` = `value: { commandId, result: {kind,text,sourceEventSeq?} }`；`dsh-api-gateway/lib/client.browser.js:1830-1836` = `{ok:false,error}` / `{ok:true, value:<decoded result>}`。
- **指出编造的 API/字段**：契约文档 §1 引用 `:7473-7483`（真为 7473-7483，OK）；文档未列 `activeSessionId`（client.js 里出现，但真 renderer 无此 prop）。契约文档本身未编造核心 API/字段。但 **client.js 的 `inject:(sessionId)=>...` 和 `callHost` 的结果形状假设与真契约不符**（见下方 Blocker，属实现层而非契约文档）。

判定：契约文档对齐基本属实；**实现层存在 2 处与真契约不符（Blocker-1/2）**。

---

### Blocker-1（确认）：`callHost` 对真 `ctx.remote.commands.execute` 返回值解码错误 → 真浏览器里 UI 全部数据静默为空
复现：探针 `/tmp/wp4rev/probe-callhost.mjs`（直接 import 冻结目录 `packages/workbench-ui/index.js` 与 `apply()`，逐字抽取 `client.js` 的 `callHost`）。
命令：`node /tmp/wp4rev/probe-callhost.mjs`
关键实际输出：
```
=== 真 ctx.remote.commands.execute 结果形状 ===
{"ok":true,"value":{"commandId":"c-real","result":{"kind":"success","text":"{\"ok\":true,\"value\":[...],\"op\":\"event.list\"}"}}}
=== callHost 对真形状的返回值 ===
decoded.ok = true
Array.isArray(decoded.value) = false
decoded.value?.result?.text = {"ok":true,"value":[...]}   ← 业务 JSON 被埋在 result.text 里
=== 对照：bridge 测试扁平形状 {ok:true,value:<text>} 喂给 callHost ===
Array.isArray(decodedFlat.value) = true
=== 判定 ===
BLOCKER: 真形状下 callHost 返回的 value 不是数组 …
```
根因：`callHost` 取 `text = result.value ?? result.text`，期望 `text` 是业务 JSON 字符串；真形状下 `result.value` 是 `{commandId, result:{kind,text}}` 对象，`typeof text !== 'string'`，于是 `return {ok:true, value: text}` 把整个对象原样返回。`load()` 里 `Array.isArray(ev.value)?ev.value:[]` 全部落到空数组，且 `ev.ok===true` 不抛错 → **静默失败**。
证据链：`dsh-commands/lib/typert.remote-client.js:21-33`（result schema 是 `{commandId, result:{kind,text}}`）、`dsh-client-ui-commands/lib/client.js:1718-1721`（真消费者访问 `result.value.result.text`）、`dsh-api-gateway/lib/client.browser.js:1830-1836`（RemoteResult 信封）。
`workbench-ui-bridge.test.mjs:79` 的 `makeHost().execute` 返回 `{ok:true, value: result.text}`（**扁平字符串**），与真 Remote 形状不同 → 8 项 bridge 测试全绿但**未覆盖真浏览器解码路径**，这正是授权中「不得用模拟接口冒充真实宿主」要防的情形。

---

### Blocker-2（确认）：`main` slot 的 `inject:(sessionId)=>...` 拿不到 sessionId
`client.js:657` `inject: (sessionId) => ({ sessionId, ctx })`，组件 `WorkbenchPage` 用 `props.sessionId ?? props.activeSessionId`（:315），`request()` 在 sessionId 非字符串时抛 `'No active session'`（:336-338）。
真契约核对：
- `dsh-client-ui-layout/lib/client.js:631-633`：`"main": { kind:"keyed", scope:"root" }` → **root 作用域**。
- `dsh-client-ui-renderer/lib/client.js:432-441` `runInject(entry, binding, actions)`：`args.push(binding.key)`（root 时 `binding` 为 `void 0`/`key:void 0`，不 push）、`args.push(actions)`；root 路径 `:886` 调 `cachedRootInject(entry, actions)` → `inject(actions)` 最多一个参数（store actions 或 undefined），**绝不是 sessionId**。
- `dsh-client-ui-renderer/lib/client.js:1317-1324` `_rootBinding = {key:void 0, hooks:{}, keyedHooks:{}, props:{}}`；`provideRoot` 贡献（workspace:5040 / session:1104 / layout:621）只有 `hooks`/`keyedHooks`，**没有任何 `sessionId` / `activeSessionId` prop**；全 asar `grep -rn "activeSessionId"` 无结果。
- 参考实现 `dsh-client-ui-schedule/lib/client.js:7475` 用的是 `inject: () => ({...detail, onNewTask})` **无参**，其页面 sessionId 来自 root 的 `useSession` 之类标准 hook，不是 inject 参数。
- 契约文档 §1 自己也写 `inject: () => ({ ... })`（:27），client.js 却写成 `(sessionId)=>`。
判定：`inject:(sessionId)=>({sessionId,ctx})` 与真 `main` keyed slot 的 inject 语义不符；真浏览器里 `sessionId` 至多是 `actions` 对象或 `undefined`，`request()` 会抛 `No active session…`，UI 无法发起任何 Host 调用。**会话隔离/UI↔Host 双向一致在真浏览器里不成立**。

---

### 检查 3：隔离加载证据复核 — PASS（Host 半边）
- 读 `evidence/wp4/01`（修复前：`cannot get property "approval" without inject` + `1 entry did not activate`）、`02`（修复后仅 `dsh web: http://127.0.0.1:50981/...`）、`03`（隔离加载说明，如实标注 Client 半边未验证）。
- 自己复核配置 compose：`DSH_HOME=/tmp/dsh-iso-Jv2UeM dsh --profile rescue --patch /tmp/wp4-isolated-patch.yml --dump-config | grep -A4 -i workbench-ui`，实际输出含：
  ```
  # == @local/dsh-workbench-ui
  - id: workbench-ui
    config: { rootDir: '' }
  # == /tmp/wp4-isolated-patch.yml
  - id: workbench-ui
    config: { rootDir: /tmp/dsh-iso-Jv2UeM/workbench-data }
  ```
  → 真 DSH 把 bundle patch 与 `--patch` 合并，隔离 `rootDir` 生效。
- 有界 boot：`DSH_HOME=/tmp/dsh-iso-Jv2UeM dsh --profile rescue --patch /tmp/wp4-isolated-patch.yml --no-open --port 0`，12s 后 kill。实际输出仅 `dsh web: http://127.0.0.1:50666/?token=...`；`grep -nEi "error|did not activate|failed|warning" boot.log` **无匹配**。端口 50666 ≠ 当前 GUI 55719，未占用 GUI。
- 正式 profile：`grep -c workbench-ui ~/.dsh/profiles/desktop/cordis.patch.yml` = 0、`package.json` = 0；`~/.dsh/profiles/desktop` 未被改。0 remote，未 push。
- 判定：「真实 DSH 隔离环境加载 Host 半边」成立（配置 compose + 零错误零 did-not-activate 自有复现）。Client 半边渲染按报告如实 UNVERIFIED。
- ⚠️ 注意：boot 只证明 `ctx.provide` + `ctx.commands.register` 激活；**不证明 Client 能真正读到数据**（见 Blocker-1/2，激活≠可用）。

### 检查 4：Client→Host→Storage 真实性 — 测试本身真，但**形状不真**
- 复跑：`node --test test/workbench-ui-bridge.test.mjs` → `# tests 8 # pass 8 # fail 0`；`workbench-ui-standards.test.mjs` → `9/9`。
- bridge 确实用真 `apply()`、真 `createWorkbenchHostService` + 真文件存储（断言 `.json` 落盘、重启读回），不是纯 mock；请求按真 `parseCommand`/`invocation.rawInput`/`agent.session.id`/`signal` 形状构造。
- **但 `makeHost().execute`（bridge.test.mjs:79）返回 `{ok:true, value: result.text}`（扁平字符串），不是真 `ctx.remote.commands.execute` 的 `{ok:true, value:{commandId,result:{...}}}`**。因此 8 项测试覆盖的是「假 Remote 信封」，恰好掩盖 Blocker-1。判定：Client 解码路径未被真形状测到。
- 真实业务形状实测（探针 `/tmp/wp4rev/probe-shapes.mjs`，真 apply + 真 handler）：
  - `event.create` 冲突规则真生效（重叠即 `conflict` 拒绝）；`event.update` 才允许制造重叠。
  - `event.conflicts` → `[{a:{eventId,...}, b:{eventId,...}, overlapMs}]` ✅ 含 `overlapMs`。UI 的 `c.a?.eventId` 提取**正确**（client.js:365）。
  - `event.freeSlots` → `{free:[...], busy:[...]}` ✅（UI 未调用此 op，无错）。
  - `event.expand` → 实例数组，每项含 `eventId` ✅；UI `inst.eventId ?? inst.sourceId ?? inst.id` 正确。
  - 判定：业务形状与 UI 解析一致；**唯一不匹配的是 Remote 信封**（Blocker-1）。

### 检查 5：审批安全 — 部分 PASS / 部分 Blocker
- `deleteWithApproval`（client.js:488-516）走 `requestApproval` → `approval.value?.token`（string 校验）→ 带 `approvalToken` 调 delete；`confirmed:true` **未被 UI 读取**（仅注释提及）。`grep -rn confirmed packages/workbench-ui/` 只在注释中出现。✅ 无 confirmed 旁路。
- WP3 真 `ApprovalService` 端到端 `test/host-approval-real.test.mjs` → `2/2`（真 asar `dsh-user-approval` + `cordis`，allowed-once 签发 token、rejected/cancelled/unavailable/never/无 answerer 全 fail-closed）。`host-service.js` 用 `AsyncLocalStorage` + `currentAgent` 兜底，WP3 第二轮的 `activeAgent is not defined` 兄弟作用域 bug 已修（定义在 createWorkbenchHostService 内部）。✅
- 无 answerer fail-closed：bridge 测试 9 项实测 `approval.ok=false, approved=false`；approval-gate `host-requester-missing` 拒绝。✅
- `ctx.get('approval')` 修复：`index.js:90` 用 `ctx.get` 读可选服务，隔离 boot 零 did-not-activate，✅ 解决了 inject 报错。
- **但 `requestApproval: approval?.request`（index.js:94）把真 `ApprovalService.request` 作为裸函数抽出，丢失 `this`**。真消费者（`dsh-tools/lib/index.js:3536,3551`、`dsh-sandbox/lib/index.js:105`）都是 `approval.request({...})` 绑定调用。真 Cordis traceable face 实测（探针 `/tmp/wp4rev/probe-cordis-approval2.mjs`）：
  ```
  裸 bare(req) 抛错 → Cannot read properties of undefined (reading 'decide') | calls= 0
  svc.request(req) → allowed-once | calls= 1
  ```
  经 index.js 全链路（探针 `/tmp/wp4rev/probe-approval-binding.mjs`）：`requestApproval` 返回 `{"approved":false,"reason":"host-unavailable"}`，`waterfallCalls=0`；对照用箭头包装保留 this → `approved:true` + 真 token。→ **真 DSH 里审批永远拿不到 token（fail-closed 但功能不可用）**。见 Blocker-4。
- 另：`task.delete` 不在 `service.listOps()`（探针 `/tmp/wp4rev/probe-taskdelete.mjs` 实测 `不支持的操作：task.delete`），而 `requestApproval(approvalOp:'task.delete')` 因不在 DANGEROUS_OPS 直接返回 `approved:true, reason:'op-not-requiring-approval'`。→ **待办删除是坏路径**（Blocker-3）。

### 检查 6：无假数据 / 不冒充 — PASS
- `client.js` 唯一 `require` 是 `require('react')`（:22）；无 `@deepseek-ai/dsh-client-ui-*`、无 iframe、无 `document.body`、无硬编码示例数据数组（`grep` 无命中）。
- 所有数据经 `callHost → ctx.remote.commands.execute → Host handler → service.invoke`；唯一数据源。
- 但**模拟接口冒充问题**：bridge 测试的 Remote 信封是模拟的扁平形状（检查 4），且报告 §六自称「不用模拟接口冒充真实宿主」——就 Client 解码路径而言，测试用的信封与真宿主不一致，属**测试未覆盖真形状**，非 client.js 主动 mock。判定为 Blocker-1 的证据链一部分。

### 检查 7：UI 规范静态 — PASS（静态）
逐项（命令 `grep -o -- '--dsw-alias-...' client.js | sort -u` 等）：
- main keyed slot `key:'workbench'`、不占 `conversation`；`sidebar.panellist` 带 id/order/locale/label。✅
- 令牌：只用 10 个 `--dsw-alias-*`（label-primary/secondary/tertiary、interactive-bg-hover、border-l1、scrollbar-bg-l2/hover-l2、state-business-primary、state-warn-label/tertiary），全部在 asar 真令牌集合内；唯一 `rgba(0,0,0,.4)` 是 overlay 遮罩（装饰性）。✅ 无硬编码内容色。
- 字号：正文 16px（8 处）、标题 20/24px（3 处）、12px 仅徽标/周名/时间（辅助文字），符合 16 正文 / 20–28 标题。✅
- 点击区：`44px` 出现 8 处（`.wb-btn/.wb-cell/.wb-row/.wb-row-main/.wb-input/.wb-status` min-height/min-width）。✅
- 间距：gap/padding/margin 全为 4/8/16/24/32（4 倍数）。✅
- `focus-visible` 4 处（btn/cell/row-main/input），outline 用 `--dsw-alias-state-business-primary`。✅
- role/aria：`role` 8 处（tablist/tab/status/alert/dialog）、`aria-label` 11、`aria-live` 2、`aria-modal`、`aria-pressed`、`aria-selected`、`aria-hidden`。✅
- Ctrl/Cmd+K：`client.js:391-400` window keydown，`ev.ctrlKey||ev.metaKey && key==='k'` → focus 搜索框，`useEffect` 返回清理。✅
- 浅深色：全部颜色走 `var(--dsw-alias-*)`，由宿主 token 继承，无写死深浅；`@media (max-width:800px)` 侧栏下移、flex 布局缩放。✅
- DOM 顺序：top（标题/tabs/搜索/刷新/新建）→ StatusBar → notice/conflict → body（main 内容 → side 详情）→ overlay 删除确认，符合视觉/焦点顺序。✅
- `workbench-ui-standards.test.mjs` 9/9 通过，与上述静态结论一致。

### 检查 8：9 条真实流程证据核对（报告 §三）
| # | 流程 | 真实测试证据 | 判定 |
| --- | --- | --- | --- |
| 1 | 侧栏打开工作台 | 仅静态注册 + 配置 compose；**实际点击 UNVERIFIED**（报告如实） | 声称/静态 |
| 2 | 创建日程存真 Host | bridge create → 磁盘 .json | ✅ 真（Host 半边） |
| 3 | 重载恢复 | bridge 全新 Context 读同 rootDir | ✅ 真 |
| 4 | 编辑持久化 | bridge update→get | ✅ 真 |
| 5 | 创建并完成待办 | bridge upsert×2→done | ✅ 真（但 task.delete 坏，见 Blocker-3） |
| 6 | AI 创建 UI 看到 | bridge `svc.invoke('event.list')` | ✅ 真（同一 service） |
| 7 | UI 改 AI 可查 | bridge `svc.invoke('event.update')` | ✅ 真 |
| 8 | 删除经可信审批 | bridge 无 token→confirmation-required；真 ApprovalService 2/2 | ⚠️ token 签发在真 DSH 里坏（Blocker-4）；task 删除坏（Blocker-3） |
| 9 | 错误明确不静默 | bridge 未知 op→unsupported；StatusBar role=alert | ⚠️ 真浏览器里 Blocker-1 恰是**静默空列表**（ev.ok=true 不抛错），与「错误不静默」自相矛盾 |
判定：2–7 有真 Host 半边测试；1 如实 UNVERIFIED；8/9 在真浏览器路径上被 Blocker 推翻。

### 检查 9：回归 — PASS
- `cd workbench-core && node --test test/*.test.mjs` → `# tests 257 # pass 257 # fail 0 # skipped 0`。
- `node scripts/r3-mutate.mjs /tmp/wp4rev/mut.log`（**/tmp 副本 `/tmp/wp4rev/run`** 内跑，避免改冻结目录）→ `CAUGHT: 36 VACUUM: 0 SKIP: 0`。
- `bash scripts/wp2-r5-gate.sh`（/tmp 副本）→ `通过 8 项，失败 0 项 / RESULT: PASS`。
- 注意：这些是全 core 测试，不含真浏览器 `ctx.remote.commands.execute` 解码（故测不到 Blocker-1）。

### 检查 10：诚实性 / UNVERIFIED — PASS
- 报告 §五明确：**深浅色截图未取得 UNVERIFIED**、窗口缩放/真实点击/键盘未测、浏览器网络层未端到端；§115-124 解释「Client Inspect 不可用、不伪造截图、不找 rasterizer」。`evidence/wp4/` 下只有 3 个文本/日志文件，**无任何伪造截图**（全仓图片仅 `upstream/` 参考资产，非本包产物）。✅
- macOS 通知/休眠、exactly-once、多进程、O(N²)：报告 §七分别标 UNVERIFIED / UNRESOLVED，未标完成。✅
- 数字实测一致：257 测试 ✅、36 变异 ✅、8 工具（`host-tools.js` 8 个 `workbench_*`）✅、门禁 8/8 ✅、bridge 8/8 ✅、standards 9/9 ✅、true ApprovalService 2/2 ✅。报告无夸大数字。
- 唯一诚实性瑕疵：报告 §六「不用模拟接口冒充真实宿主」在 Client Remote 信封层面不成立（测试用扁平假形状），§三 9 条流程中 8/9 未标注「真浏览器路径未验证」。属 nit（由 Blocker-1 带出）。

### 检查 11：视觉 Review（无浏览器控制，静态）— 按 `references/verification.md`
- 配色只用令牌：✅（10 个真 `--dsw-alias-*`，无内容色硬编码；overlay 遮罩为装饰）。
- 排版尺寸：✅ 16 正文 / 20–24 标题 / 12 辅助 / 44 点击区 / 4-8 间距 / `focus-visible`。
- 紧凑度：✅ flex 一列 + 侧栏，无插图无动效，spacing 克制；`.wb-grid-7` 7 列月视图，`@media(max-width:800px)` 侧栏下移。
- 焦点顺序（DOM 顺序）：✅ top→status→main→side→overlay；`autoFocus` 在表单标题，Ctrl/Cmd+K 到搜索；role/aria 齐全。
- 深浅色适配机制：✅ 全部 `var(--dsw-alias-*)`，由宿主切换，插件无颜色常量。
- 缩放：✅ flex + `min-width:0`/`overflow:auto` + `@media (max-width:800px)`。
- **明确写：真实渲染画面未取得，视觉验证不可得。** 按 verification.md 未起浏览器、未找 rasterizer/Quick Look、未模拟 React-DOM、未伪造截图；静态项只证明「代码符合规范」，不证明「画面正确」。

---

## 额外自己找（逐条回答）

**A. `callHost` 对 `ctx.remote.commands.execute` 返回值的解码是否匹配真 Remote 结果形状？会不会拿到 undefined？**
→ **不匹配，是真 blocker**（Blocker-1）。真形状 `{ok:true, value:{commandId, result:{kind,text}}}`；`callHost` 期望 `value` 是业务 JSON 字符串。真浏览器里 `decoded.value` 是 `{commandId,result}` 对象而非数组，UI 全部列表静默为空（不 `undefined`，是**对象**，`ev.ok===true` 不抛错 → 静默失败）。探针 `node /tmp/wp4rev/probe-callhost.mjs` 实测 `Array.isArray(decoded.value)=false`。根因是 bridge 测试用了扁平假信封 `{ok:true, value: result.text}` 掩盖了差异。

**B. `main` keyed slot 传给 `inject` 的参数到底是什么？是 sessionId 吗？**
→ **不是 sessionId，是真 blocker**（Blocker-2）。`main` 是 `scope:"root"` 的 keyed slot（layout:631-633）；renderer `runInject`（:434-441）对 root 传 `inject(...args)`，`args` 仅可能含 `binding.key`（root 为 `void 0`，不 push）与 `actions`（store actions，本注册未声明 store 时为 undefined）；root binding props 无 `sessionId/activeSessionId`（provideRoot 只贡献 hooks/keyedHooks）。参考实现 schedule:7475 `inject: () => ({...})` 无参，`TaskManagerPage` 用 `useCatalog` 等标准 hook。client.js `inject:(sessionId)=>({sessionId,ctx})` 与 `props.sessionId ?? props.activeSessionId` 在真浏览器里拿不到字符串 → `request()` 抛 `No active session`，UI 无法发起任何调用。

**C. `ctx.slots.inject('main',...)` 的 disposer `return () => { d1?.(); d2?.() }` 是否正确？**
→ **正确**。renderer `inject()`（:1368-1427）返回 `() => disposeController()`（幂等 disposer）；cordis `_execute`（:1143）把 `ctx.effect` 返回的函数 collect 为 disposer；`ctx.effect(() => {...; return () => {...}})` 是合法范式（模板/其他插件同款）。`d1?.()` 可选调用防御 `undefined`，无害。

**D. `deleteWithApproval` 里 `op='task.delete'` —— `service.listOps()` 有没有 `task.delete`？**
→ **没有，是真 blocker**（Blocker-3）。`service.js:143-403` 的 ops 只有 `event.list/get/expand/freeSlots/conflicts/create/update/delete/restore/bulkDelete/…`、`task.list/upsert`，**无 `task.delete`**。探针 `node /tmp/wp4rev/probe-taskdelete.mjs` 实测 `不支持的操作：task.delete`（带任意 token 亦然）。更糟：`requestApproval(approvalOp:'task.delete')` 因 `task.delete` 不在 `DANGEROUS_OPS`（service.js:33-45）而直接返回 `approved:true, reason:'op-not-requiring-approval'`（token 为 undefined），UI 随后 `if (typeof token !== 'string') throw 'Host approval was not granted'` → **待办删除永远失败**。授权要求「日历/待办功能」，待办删除是坏路径。

**E. `client.js` 里 `selected.kind` 对 Event 是否有值？删除按钮传给 `confirming.kind` 是什么？**
→ **Event 详情无 `kind` 字段**（探针实测 `kind = undefined`，keys 仅 event 业务字段）。但 client.js:633 `setConfirming({ kind: selected.kind ?? 'event', ...})` 有 `?? 'event'` 兜底，故 Event 删除 `confirming.kind='event'` → `deleteWithApproval('event', id)` 走 `event.delete`（正确路径）。Task 详情由 `setSelected({kind:'task',...t})`（:599）显式加 kind。→ **此项不构成 bug**（兜底正确），但 Event 详情里 `selected.kind === 'task' ? 'Task' : 'Event'`（:606）与 Edit 按钮判断（:629）同样依赖兜底，逻辑自洽。

**F. 待办完成 `task.upsert` 是否丢 `subtasks`/`sourceSessionId`？**
→ **分两条路**：
  - `toggleTask`（:477）用 `{...t, done:...}` 展开 → **保留**全部字段（实测探针 `/tmp/wp4rev/probe-shapes.mjs`：`subtasks`/`sourceSessionId` 均在）。✅
  - **但 `TaskForm.submit`（编辑保存，:280-285）构造全新对象 `{id,title,dueAt,priority,done,status}`，丢掉 `subtasks`/`sourceSessionId` 等所有其它字段**；`task.upsert` 是整行替换（`draft.tasks[index] = {...task}`）。探针 `node /tmp/wp4rev/probe-taskform-e2e.mjs`（真 apply + 真存储）实测：
    ```
    编辑前: {...,"subtasks":["订会议室","发议程"],"sourceSessionId":"session-origin",...}
    UI 编辑后: {...,"status":"in_progress"}   ← subtasks/sourceSessionId 全部消失
    subtasks 丢失? true | sourceSessionId 丢失? true
    ```
    → **UI 编辑待办会造成数据丢失**（Blocker-5）。授权要求「UI↔Host 双向一致、数据不丢」，且报告 §七自称「子任务展示」是功能之一，编辑即丢。

**G. `rootDir` 在 `cordis.patch.yml` 里为 `''`，不覆盖时插件拒绝启动 —— 设计还是缺陷？**
→ **是有意的安全设计，但留下部署缺陷（nit）**。`index.js:82-84` 显式注释「rootDir 必须由配置显式给出；空字符串拒绝启动，绝不悄悄落到 ~/.dsh」；bridge 测试 `rootDir 未配置时拒绝启动` 断言该行为；报告 §六把它列为红线「不修改现有用户数据 ✅」。安全性上正确。**但**：`plugin_manager install_bundle` 默认只装 `cordis.patch.yml`（`rootDir:''`），用户不手动加 `--patch` 或改 patch → 插件 `did not activate`。即「开箱即装」不可用，必须人工配置。报告已说明隔离 boot 需 `--patch`，属已知限制；判为 nit（非 blocker，不冒充、不丢数据）。

**H. 其它 nits**
- `MonthView` 接收 `onSelectEvent` 但从未调用（:183-219 只有 `onSelectDay`），月视图里事件条不可点；用户须切到周/日/议程才能选事件。功能降级，nit。
- `inject:['slots','remote']`（client.js:648）未声明 `commands`（Client 侧不需要 Host commands，合理），但 `index.js` Host 侧 `inject=['commands']` 且用 `ctx.get('approval')` 读可选服务——boot 已证明可行。
- 报告 §六「不用模拟接口冒充真实宿主」对 Client Remote 信封而言不严谨（见检查 6/10）。

---

## Blocker 汇总（均给复现命令 + 实际输出）

| # | Blocker | 类别 | 复现 |
| --- | --- | --- | --- |
| 1 | `callHost` 解码不匹配真 `commands.execute` 信封 → 真浏览器里 event/task/conflicts/expand **全部静默空列表** | 真实契约不符导致运行时失败 / UI↔Host 双向一致失效 | `node /tmp/wp4rev/probe-callhost.mjs` → `Array.isArray(decoded.value)=false` |
| 2 | `main` slot `inject:(sessionId)` 拿不到 sessionId → `request()` 抛 `No active session`，UI 无法调 Host | 真实契约不符导致运行时失败 / 会话隔离失效 | asar `dsh-client-ui-renderer:434-441,631-633` + schedule:7475；真形状无 sessionId prop |
| 3 | `task.delete` 不在 `listOps()` → 待办删除是坏路径 | 待办功能坏路径 | `node /tmp/wp4rev/probe-taskdelete.mjs` → `不支持的操作：task.delete` |
| 4 | `requestApproval: approval?.request` 裸函数丢 `this` → 真 DSH 里审批永不签发 token（`host-unavailable`） | 审批通道不可用（fail-closed 但功能死） | `node /tmp/wp4rev/probe-approval-binding.mjs` / `probe-cordis-approval2.mjs` → `Cannot read properties of undefined (reading 'decide')`, `waterfallCalls=0` |
| 5 | `TaskForm` 编辑保存丢 `subtasks`/`sourceSessionId` 等字段 → **数据丢失** | 数据丢失 | `node /tmp/wp4rev/probe-taskform-e2e.mjs` → `subtasks 丢失? true / sourceSessionId 丢失? true` |

前 5 条中，1/2 是「真契约不符导致运行时失败」（UI 根本读不到/发不出），3 是待办删除坏路径，4 是审批在真宿主不可用，5 是数据丢失。按判定标准「真实契约不符导致运行时失败、数据丢失」→ **REQUEST CHANGES**。

---

## 收尾复核
- 冻结目录逐字节未变：结束前 `diff -rq /tmp/wp4rev/archive /tmp/wp4-final-freeze-1a2c7ef` → `FREEZE_DIFF_EXIT=0`（探针全部只 import 冻结文件、写 `/tmp/wp4rev`；变异/gate 在 `/tmp/wp4rev/run` 副本内跑）。
- 主仓库 HEAD 开始时 `1a2c7ef970f4efc5cc8f195203c80e87e8ba05bb`，结束时 `1a2c7ef970f4efc5cc8f195203c80e87e8ba05bb`（**未变**）；`git status --short` 仅 `?? evidence/wp4/final-review/`（本产物目录，未改任何被跟踪文件）。
- 正式 `~/.dsh/profiles/desktop` 未改；未 push（0 remote）；未占用/未另起当前 GUI。
- 全部检查只读审查冻结版本，未改被审版本。

# 结论：REQUEST CHANGES

理由：存在 5 个可复现的 blocker，其中 Blocker-1/2 使 **UI 在真实浏览器里根本无法与 Host 双向一致**（读回静默空、发不出请求），Blocker-3 使**待办删除坏路径**，Blocker-4 使**真 DSH 审批通道不可用**，Blocker-5 造成**待办编辑数据丢失**。隔离 Host 半边激活、257 测试、36 变异、8/8 门禁、静态 UI 规范、诚实性标注均通过，但这些测试**未覆盖真 `ctx.remote.commands.execute` 信封与真 `main` slot inject 参数**，故不能据此给 APPROVE。修复后需补「真 Remote 信封 + 真 inject 参数形状」的集成测试再复审。
