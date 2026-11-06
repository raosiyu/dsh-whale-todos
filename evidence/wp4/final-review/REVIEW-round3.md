# WP4 第三轮独立 Review（进行中）

- 审查对象：冻结快照 `/tmp/wp4-final3-freeze-d64deab`（基准 commit `d64deab`），主仓库 HEAD `548be95`
- 审查员：WP4 第三轮独立 Review 员（只读）
- 开始时间：2026-11-06（Asia/Shanghai）
- 状态：**进行中**

本文件在每个检查完成后立即 append 追加结果。结尾将写明最终判定。

---

## 检查记录（追加中）

---

## 检查 1：冻结纪律

**命令**
```
git -C <repo> rev-parse HEAD
git -C <repo> archive 548be95 | tar -x -C /tmp/wp4r3/freeze-548be95
diff -rq /tmp/wp4-final3-freeze-d64deab /tmp/wp4r3/freeze-d64deab
diff -rq /tmp/wp4-final3-freeze-d64deab /tmp/wp4r3/freeze-548be95
```

**实际输出**
```
主仓库 HEAD 开始 = 548be95ac725b4136e7f36a5e062e16fd1760cbe

provided-freeze vs git archive d64deab:
(无输出) EXIT=0          → 提供的冻结副本与 d64deab 逐字节一致

provided-freeze vs git archive 548be95:
Only in /tmp/wp4r3/freeze-548be95/evidence/wp4: 09-isolated-boot-round3.log
Files .../packages/workbench-ui/client.js and ... differ
Only in /tmp/wp4-final3-freeze-d64deab/packages/workbench-ui: host-call.mjs
Files .../scripts/r3-mutations.json and ... differ
Files .../workbench-core/src/service.js and ... differ
Files .../workbench-core/test/workbench-ui-bridge.test.mjs and ... differ
Files .../workbench-core/test/workbench-ui-standards.test.mjs and ... differ
```

**判定**：提供的冻结副本是**旧版**（d64deab），不含第三轮修复。已按要求用 `git archive 548be95` 自行导出到 `/tmp/wp4r3/freeze-548be95` 并以它为审查对象。主仓库全程只读（仅 `git archive` / `rev-parse` / `log`），未修改。

---

## 检查 2：callHost 内联 —— 内联本身正确，但**发现新的运行时 BLOCKER（`t` 未定义）**

### 2.1 内联确认（通过）

**命令**
```
grep -n "require(" /tmp/wp4r3/freeze-548be95/packages/workbench-ui/client.js
grep -n "host-call" /tmp/wp4r3/freeze-548be95/packages/workbench-ui/client.js
```

**实际输出**
```
24:    const React = require('react')      ← 只有包名 require
（无 './host-call.mjs'；无相对路径 require）
```

`host-call.mjs` 在 548be95 中已删除（diff 显示 `Only in .../d64deab/...: host-call.mjs`）。相对 require 确实不存在。

### 2.2 变异验证：退回旧解码必须变红

（见检查 7 的变异脚本结果）

### 2.3 🔴 BLOCKER-1：`t` 在工厂作用域未定义 → 打开表单/删除弹窗必崩

**根因**：第三轮把 `EventForm` / `TaskForm` / `ConfirmDelete` 里的 `'Cancel'`、`'Delete?'` 改成 `t('cancel')` / `t('delete')`（client.js:358、390、396、400），但 `t` 只在 `WorkbenchPage` **内部**声明（client.js:406 `const t = props.t ?? ...`）。这三个组件是**工厂作用域的兄弟函数**，不在 `WorkbenchPage` 词法作用域内 → `t` 解析不到 → `ReferenceError`。

**复现命令**
```
node /tmp/wp4r3/probe-t-scope.mjs
```

**实际输出**
```
[baseline (no form)] render OK (no throw)
[NEW EVENT form open] RENDER THREW: ReferenceError: t is not defined
        at Object.EventForm [as type] (client.js:358:71)
[NEW TASK form open] RENDER THREW: ReferenceError: t is not defined
        at Object.TaskForm [as type] (client.js:390:71)
[DELETE confirm open] RENDER THREW: ReferenceError: t is not defined
        at Object.ConfirmDelete [as type] (client.js:396:11)
```

**这是第三轮引入的新缺陷**：同一探针跑 d64deab（第三轮修复前）：
```
[d64deab NEW EVENT form] render OK
[d64deab DELETE confirm] render OK
```

**影响面**（真实 UI 路径，全部不可用）：
1. 点「+ New」→ 新建日程 → `EventForm` 渲染即崩（client.js:358 的 Cancel 按钮）
2. 点「+ New」→ 新建待办 → `TaskForm` 渲染即崩（client.js:390）
3. 侧栏详情点「Delete…」→ `ConfirmDelete` 渲染即崩（client.js:396/400）

即 **第三轮的 locale 改造把「新建」「删除审批」三条主路径全部打断**，且因为是渲染期抛错，React 会卸载整棵子树 → 页面塌成空白/错误边界。这是典型的「运行时挂掉」blocker。

**为什么现有测试没抓到**：`workbench-ui-standards.test.mjs` 只做**正则静态断言**（`assert.match(client, /t\('panel'\)/)` 等），从不真正渲染组件；`workbench-ui-bridge.test.mjs` 只测 `callHost`。两处都不覆盖组件渲染 → 变异/回归全绿。

**修复方向**（供实现方参考）：把 `t` 提升到工厂作用域。
- 方案 A：`const t = (k) => LOCALE.en[k] ?? k` 提到工厂作用域，组件改为从 props 接收 `t`（`WorkbenchPage` 用 `props.t` 传给子组件），或
- 方案 B：`ctx.locale.bind(NS)` 不可在 factory 顶层取（ctx 只在 apply 有），故应在 `apply` 内 `const t = ctx.locale.bind(NS)` 后用 `ctx.slots.inject` 的 `inject: () => ({ ctx, t })` 传下去，同时把 `t` 作为 prop 传给三个子组件。

注意：`locale: NS` 已经在 slot 定义上声明，渲染器会**自动**把 `t` 注入 kit（`dsh-client-ui-renderer/lib/client.js:742-745` `kit["t"] = localeSeat(face, entry.locale)`），且 `assertNoPropOverlap`（同文件 943 行）会在 kit 与 inject 结果**同名 prop** 时抛 `SlotAssemblyError`。当前 `inject: () => ({ ctx, t: ctx.locale.bind(NS) })` 与 `locale: NS` 同时存在 → **`t` 重复** → 渲染时可能直接抛 `SlotAssemblyError`（见检查 3 的隔离启动验证）。这是同一个缺陷的第二重表现。

**判定**：🔴 **BLOCKER**

---

## 检查 3：locale 真接入

### 3.1 API 形状核对（对照 asar 一手源码）

**命令**
```
sed -n '1675,1705p' dsh-client-locale/lib/client.js   # register/bind 实现
sed -n '425,436p' dsh-client-ui-approval/lib/client.js # 真调用点
sed -n '736,748p' dsh-client-ui-renderer/lib/client.js # slot 的 t 座位
```

**实际输出（register 实现）**
```js
register(ns, localeOrDicts, dict) {
  const pairs = typeof localeOrDicts === "string" ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts);
  for (const [locale] of pairs) if (!LOCALE_ID_PATTERN.test(locale)) throw new Error(...);
  ...
  for (const [locale, entries] of pairs) locales.set(localeKey(locale), entries);
  ...
}
bind(ns) {
  let t = this.bound.get(ns);
  if (!t) { t = (key, params) => this.translate(ns, key, params); ... }
  return t;
}
```
→ **字典形状正确**：`register(NS, { zh, en })` 的每个 locale 值是一个 **key→string 映射**（`Object.entries` 直接存），与本实现一致 ✅。`bind(ns)` 返回 `(key, params) => string` ✅。

**实际输出（渲染器的 t 座位）**
```js
if (entry.locale !== void 0) {
  const face = host.locale;
  if (face === void 0) throw new SlotAssemblyError(`entry declares locale namespace '${entry.locale}' but no locale face is installed ...`);
  kit["t"] = localeSeat(face, entry.locale);
}
```
→ 渲染器**已经**会把 `t` 注入 slot 的 props kit。因此 client.js 里
`inject: () => ({ ctx, t: ctx.locale.bind(NS) })` 与 `locale: NS` **重复提供 `t`**。
渲染器对 entry 路径不调用 `assertNoPropOverlap`（该断言只用于 factory 路径，
见 `dsh-client-ui-renderer/lib/client.js:1026`），entry 路径是 `{...kit, ...injected, ...}`
——`injected` 覆盖 `kit`，所以**不会抛错**，`t` 取 inject 提供的那个。
→ 行为上不炸，但**与 `dsh-client-ui-schedule` 的真范式不一致**：schedule 用
`locale: MANAGER_NS` + 在 `apply` 里 `const t = ctx.locale.bind(MANAGER_NS)`，
**不**在 inject 里再传 `t`。这是**风格 nit**，不是 blocker（记录）。

### 3.2 隔离 boot（locale 依赖不报错）

**命令**
```
DSH_HOME=/tmp/dsh-iso-Jv2UeM dsh --profile rescue --patch /tmp/wp4-isolated-patch.yml --no-open --port 45999
（后台启动，25 秒后 kill）
```

**实际输出**
```
dsh web: http://127.0.0.1:45999/?token=uXDm5vsTiTQh0f5Z89yYTRtP50XaxYZIEwbPW_FvuD8
=== grep workbench|error|failed|did not activate ===
(无匹配)
```
→ 进程存活、Web 服务起来、**零错误零 "did not activate"** ✅（locale 是 **Client** 依赖，
此 boot 只覆盖 Host 半边；Client 半边仍 UNVERIFIED，见检查 10）。

**判定**：locale 接入的**契约形状正确**，隔离 boot 无回归。
但**阻塞点是 BLOCKER-1**：`t` 在三个兄弟组件里不可达（见检查 2.3）。

### 3.3 `sidebar.panellist` 的 label 仍硬编码 `'Workbench'`（nit）

**命令**：`sed -n '810,816p' packages/workbench-ui/client.js`

**实际输出**
```js
const d2 = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist',
  id: PANEL_ID,
  order: 20,
  locale: NS,
  label: () => 'Workbench',        ← 硬编码，未走 locale
}, function WorkbenchIcon() {
```

对照 `dsh-client-ui-schedule/lib/client.js:19387-19394` 的真范式：
```js
yield ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
  name: "sidebar.panellist", id: PANEL_ID, order: 10, locale: MANAGER_NS,
  label: () => t("panel")           ← 走 locale
}, TaskManagerIcon));
```
→ 侧栏面板名**永远显示英文 "Workbench"**，中文用户看不到「工作台」。
**nit**（不影响功能、不阻断），但与「locale 真接入」的宣称**不一致**，建议一并修。

**判定**：🟡 MINOR（nit）

---

## 检查 4：软删语义与审批指纹

### 4.1 service.task.list 过滤 deleted（通过）

**命令**：`sed -n '388,396p' workbench-core/src/service.js`
```js
'task.list': (payload = {}) => {
  const includeDeleted = payload.includeDeleted === true
  return store.collection('tasks')
    .filter((task) => includeDeleted || !isTaskDeleted(task))
}
```
`isTaskDeleted`（service.js:493）判定 `deleted === true` 或 `deletedAt` 非空字符串 ✅

### 4.2 仅软删需审批（通过）

**命令**：`sed -n '415,422p' workbench-core/src/service.js`
```js
const isSoftDelete = task.deleted === true
  || (typeof task.deletedAt === 'string' && task.deletedAt !== '')
if (isSoftDelete) {
  requireConfirmation('task.upsert', meta, { target: task.id })
}
```
→ 新建/完成（`done` 翻转）不触发审批 ✅；软删触发 ✅

### 4.3 审批指纹 op/target 一致性（通过）

- 客户端申请：client.js:629 `const op = kind === 'task' ? 'task.upsert' : 'event.delete'`，
  detail `{ target: id, summary: ... }`
- Host 签发：index.js:136 `service.askApproval(sessionId, payload.approvalOp ?? payload.op ?? 'event.delete',
  { target, summary }, agent)` → `service.requestApproval(op, detail)` → `gate.request({op, target, digest, summary})`
  → 指纹 `approvalFingerprint({op, target, digest})`
- 客户端实际执行：client.js:645 `task.upsert` 带 `payload: { task: {...t, deleted:true, deletedAt} }` + `approvalToken`
  → Host index.js:144 `service.invoke(sessionId, 'task.upsert', payload, { approvalToken })`
  → service.js:420 `requireConfirmation('task.upsert', meta, { target: task.id })`
  → 指纹 `approvalFingerprint({op:'task.upsert', target: task.id, digest: undefined})`
- 申请时 `target = id`（= task.id）、`digest` 未传 → `detail.digest` 为 undefined → `String(undefined)` = `'undefined'`
  → 两侧 `digest` 都是 `'undefined'` ✅ **指纹一致**，不会 fingerprint-mismatch
- `event.delete` 同理：申请 target=id，执行 `requireConfirmation('event.delete', meta, { target: id })` ✅

**判定**：✅ 一致。

### 4.4 真 ApprovalService + open-turn session（通过）

**命令**：`cd workbench-core && node --test test/host-approval-real.test.mjs`
```
ok 1 - WP3：真 ApprovalService 端到端 —— allowed-once 经适配器签发 token
ok 2 - WP3：真 ApprovalService 词汇白名单 —— 非 allowed-once 全 fail-closed
# tests 2 / # pass 2 / # skipped 0
```
（asar 解包目录 `/tmp/dsh-asar-full` 存在，测试**未 skip**，真的加载了
`@deepseek-ai/dsh-user-approval` 与 `@deepseek-ai/cordis`，构造 open-turn session，
验证 `approval/asked` + `approval/decided` 审计对 ✅）

**判定**：✅ 通过

---

## 检查 5：main sessionId（通过）

**命令**：`sed -n '414,438p' packages/workbench-ui/client.js`
```js
const snap = ctx.sessions?.list?.getSnapshot?.()
const row = snap?.byId ? Object.values(snap.byId).find((r) => (r?.retainedBy?.mainView ?? 0) > 0) : undefined
return row?.id ?? props.sessionId ?? undefined
```
对照真源 `dsh-client-ui-workspace/lib/client.js:89`
```js
const current = () => Object.values(ctx.sessions.list.getSnapshot().byId).find((row) => (row.retainedBy.mainView ?? 0) > 0);
```
→ **来源与判据完全一致** ✅；`useEffect` 里 `list.subscribe(read)` 跟随切换 ✅

**无活动会话时的提示**：client.js:466-469
```js
if (typeof sessionId !== 'string' || sessionId === '') {
  setError('No active session; open the workbench from a conversation')
  return
}
```
→ 明确错误文案 + StatusBar `role=alert` + Retry，**不是空白/永久 loading** ✅

**判定**：✅ 通过

---

## 检查 6：load 降级（通过，但有一处 nit）

**命令**：`sed -n '465,514p' packages/workbench-ui/client.js`
```js
const [ev, tk, cf, ex] = await Promise.all([...4 个命令...])
if (ev.ok !== true && tk.ok !== true) throw new Error(...)   // 主数据全失败才算整体失败
if (ev.ok !== true) setError(`日程加载失败：${ev.error?.message ?? ''}`)
if (tk.ok !== true) setError(`待办加载失败：${tk.error?.message ?? ''}`)
```
→ `event.conflicts` / `event.expand` 失败只降级为「无」（conflictIds 空 / recurrenceCount 空），
   页面其余部分照常渲染 ✅；`event.list` 或 `task.list` 单个失败也不整页变空 ✅

**nit**：两个 `setError` 连续调用 → **后者覆盖前者**。若 ev 与 tk 同时失败但没走
`throw` 分支（不可能，因为同时失败会 throw），实际只有**一个**失败时另一个不写 error，
所以覆盖只在「两者都失败」时发生——而那时已被 `throw` 提前拦截。
→ 实际**不会**丢信息。**不构成 nit**。（第一处 `throw` 分支取 `ev.error?.message ?? tk.error?.message`，
在 ev 失败且 tk 也失败时优先显示 ev 的消息，可接受。）

**判定**：✅ 通过

---

## 检查 7：回归

### 7.1 单测

**命令**：`cd workbench-core && node --test test/*.test.mjs`
```
# tests 267
# pass 267
# fail 0
# cancelled 0
# skipped 0
# todo 0
```
→ **267/267**（任务书写 266/266，实际 267 —— 第三轮新增了 1 条 standards 测试，
是**实测值更高**，不是造假；d64deab 为 266）。

### 7.2 变异（在 /tmp 副本跑，未碰冻结版）

**命令**：`cp -R freeze-548be95 mutate-run && cd mutate-run && node scripts/r3-mutate.mjs`
```
变异定义：44 项（scripts/r3-mutations.json）
CAUGHT: 44
VACUUM: 0
SKIP:   0
结论：全部保护点都有测试约束（0 真空，0 跳过）
```
→ **44/44、0 真空、0 跳过** ✅（任务书预期 44/44，一致）

### 7.3 门禁

**命令**：`cp -R freeze-548be95 gate-run && cd gate-run && bash scripts/wp2-r5-gate.sh`
```
=== unit-tests ===        ✅
=== demo ===              ✅
=== probe-real-storage === ✅
=== probe-protect ===      ✅
=== probe-retention ===    ✅
=== real-service-l4 ===    ✅
=== acceptance-8 ===       ✅  PASS 26  FAIL 0  UNVERIFIED 0
=== mutations ===          ✅
=== 门禁汇总 ===
通过 8 项，失败 0 项
RESULT: PASS
```
→ **8/8** ✅

### 7.4 独立变异验证（我自己写，不依赖仓库脚本）

**命令**
```
# 把内联 callHost 退回旧扁平解码
python3 → 替换 packages/workbench-ui/client.js 的信封解码段
cd workbench-core && node --test test/workbench-ui-bridge.test.mjs
```
**实际输出**
```
# tests 17
# pass 9
# fail 8
```
→ **退回旧解码必须变红** ✅。测试确实约束的是**从 client.js 源码提取的真实现**
（`workbench-ui-bridge.test.mjs:112-134` 的 `extractCallHost` 用配对花括号扫描
`async function callHost(ctx, sessionId, req) {` 并 `new Function` 执行），
不是复刻实现 ✅。

### 7.5 🔴 但：测试**完全不覆盖组件渲染**（新发现的覆盖空洞）

**命令**
```
# 变异 1：把 EventForm 的 t('cancel') 退回硬编码 'Cancel'（等价于第三轮前的行为）
node --test test/*.test.mjs   →  # tests 267 / # pass 267 / # fail 0

# 变异 2：把 EventForm 的 t('cancel') 改成 t('cancelTYPO')（一个不存在的 key）
node --test test/*.test.mjs   →  # tests 267 / # pass 267 / # fail 0
```
**实际输出**：两次都是 **267 pass / 0 fail**。

→ **没有任何一条测试会渲染任何组件**。`workbench-ui-standards.test.mjs` 全是
`assert.match(client, /.../)` 正则断言；`workbench-ui-bridge.test.mjs` 只测
`callHost` 与 Host 侧。所以：
- BLOCKER-1（`t` 未定义）在 267 条测试下**全绿**
- 连「key 拼错」这种最低级错误也**测不出来**

这正是第一轮 Review 第 ① 条 blocker（「用模拟接口冒充真实宿主」）的同一个病根
换了个马甲：**测试跑的是"源码长什么样"，不是"运行起来对不对"**。

**判定**：🔴 **MAJOR（覆盖空洞）** —— 与 BLOCKER-1 同源；
即使修好 `t`，这个空洞仍在，下一次 locale/组件改动仍会静默通过。

---

## 检查 8：红线

**命令**
```
git -C <repo> status --porcelain
git -C <repo> remote -v
grep -c workbench-ui ~/.dsh/profiles/desktop/cordis.patch.yml
ls -la ~/.dsh/profiles/desktop/package.json
```

**实际输出**
```
?? evidence/wp4/final-review/REVIEW-round3.md     ← 只有我自己写的报告文件
（packages/workbench-ui 与 workbench-core 无改动：git diff HEAD --stat 为空）

git remote -v  →  (无输出，0 remote)

grep -c workbench-ui ~/.dsh/profiles/desktop/cordis.patch.yml → 0
```

**判定**：✅ 红线全部保持。正式 `desktop` profile 未被改、0 remote、未 push。

---

## 检查 9：诚实性

| 报告声称 | 实测 | 一致？ |
| --- | --- | --- |
| 266/266 单测 | **267/267**（第三轮 +1 条 standards 测试） | ✅ 实测更高，非造假 |
| 43/43 变异 | **44/44**（第三轮 +1 项 W8） | ✅ 实测更高，非造假 |
| 门禁 8/8 | **8/8** | ✅ |
| bridge 17/17 | **17/17** | ✅ |
| 静态规范 9/9 | **10/10** | ✅ 实测更高 |
| 深浅色截图 UNVERIFIED | 报告明写 UNVERIFIED | ✅ |
| 无伪造截图 | 仓库内无截图文件 | ✅ |

**但**：报告 §5「隔离环境加载 ✅」与 §5「既有测试回归」仍写的是**第三轮修复前**的数字
（`git diff 8756a7f d64deab -- docs/wp4/01-final-report.md` 只把 257→266 改了一次，
**548be95 没有再更新报告**）。
→ 数字本身不假（都是实测过的历史值），但**报告没有反映第三轮的新状态**（267/44/10）。
**nit**。

**判定**：🟡 MINOR（nit）

---

## 检查 10：视觉静态核查（按 references/verification.md）

本轮只做**静态**核查，未取得任何真实渲染画面。

**明确声明**：**真实渲染画面未取得，视觉验证不可得。**
深浅色截图、窗口缩放、真实点击/键盘交互、真实浏览器网络层的
`ctx.remote.commands.execute` 端到端 —— 全部 **UNVERIFIED**，不伪造。

本轮**静态**核查到的事实：
- `main` keyed slot：`ctx.slots.inject('main', ...)` + `key: PANEL_ID`（client.js:803-809），
  `PANEL_ID='workbench'` ≠ `'conversation'` ✅
- `sidebar.panellist`：`id: PANEL_ID` + `order: 20` ✅
- 样式只用 `--dsw-alias-*`（standards 测试断言通过）✅
- 无 iframe / 不写 `document.body` / 不 require Client primitives ✅
- 16px 正文 / 20px、24px 标题 / 44px 点击区 / 4 的倍数间距 ✅
- focus-visible / role=status、alert、dialog / aria-modal / aria-label / Ctrl/Cmd+K ✅
- **但**：因为 BLOCKER-1，**真实渲染时「新建」「删除」两条主路径必崩** → 静态全绿、
  运行时挂掉的典型例子。

**判定**：⚠️ 静态通过；视觉 UNVERIFIED（如实声明）。

---

## 检查 11：主动找新缺陷（逐条回应任务书的问题）

### 11.1 `__test` 导出是否泄露到生产返回面？

**命令**：`grep -n "__test" packages/workbench-ui/client.js` + 读 `dsh-client-modules/README.md:77`

**实际输出**
```js
const __test = { callHost }
...
return {
  inject: ['slots', 'remote', 'sessions', 'locale'],
  __test,          ← 工厂返回面的一部分
  apply(ctx) { ... }
}
```
→ factory 的返回值就是该模块的 **exports**（README:77「`factory(require)` → exports,
memoized in `loadCache`」）。因此 `__test.callHost` 会成为模块导出的一部分。

**评估**：
- **不是安全漏洞**：`callHost` 只是一个 `{ok, value, error}` 的解码器，不含密钥、
  不含特权能力；它内部只用调用方传进来的 `ctx`。
- **是契约卫生问题**：生产 bundle 带着一个只为测试存在的导出。
- **不是 blocker**：无凭据泄露、无越权、无数据风险。
- **对比 d64deab**：d64deab 也有 `__test`（`const __test = { callHost }`），
  **不是第三轮引入**。
→ **nit**。

### 11.2 `locale.register` 的字典形状是否与真实 API 匹配？

**实际输出**：见检查 3.1 —— `register(ns, {zh, en})` 的每个 locale 值是
key→string 映射，本实现一致 ✅。**不是缺陷。**
唯一小瑕疵：字典里混进了 `meta.title`/`meta.description`（那是 **package manifest**
的 meta，不是 slot 文案），且 `LOCALE.en[key] ?? key` 的兜底（client.js:406）
在真实 locale face 下走的是 `ctx.locale.bind(NS)`，其 `translate` 对未知 key 返回 key 本身
（`dsh-client-locale/lib/client.js:1718` `?? key`）——**行为一致** ✅。

### 11.3 `sidebar.panellist` 的 label 是否也应走 locale？

**是**，应走 locale。已记为 nit（检查 3.3）。

### 11.4 `load()` 里 cf/ex 失败时 setError 是否覆盖前面的错误？

**不覆盖**（见检查 6 的逐步推演）：cf/ex 失败**根本不调 setError**，
只有 ev/tk 失败才调；两者都失败会先 `throw`。**不是缺陷。**

### 11.5 服务端 task.upsert 的条件审批：软删指纹是 task.id，审批时 target 也是 task.id —— 一致吗？

**一致** ✅（检查 4.3 已逐步核对 op / target / digest 三项）。
注意 `digest` 两侧都是 `String(undefined) === 'undefined'` —— 这是 gate 的既有行为，
不是本次引入的问题（`approvalFingerprint` 用 `String(input.digest ?? '')`，
`undefined ?? ''` → `''`；两侧都走同一函数 → 必然一致）。**不是缺陷。**

### 11.6 `packages/workbench-ui/index.js` 与 `workbench-core/src/host-service.js` 的 apply 语义重复？

**是重复的**，但**行为一致**，无不一致隐患：

| 维度 | `packages/workbench-ui/index.js` | `workbench-core/src/host-service.js::applyWorkbenchHostService` |
| --- | --- | --- |
| provide 名 | `ctx.provide('workbench', service)` | `ctx.provide('workbench', service)` ✅ 一致 |
| service 构造 | `createWorkbenchHostService({rootDir, mode:'host', requestApproval})` | `createWorkbenchHostService({rootDir, mode: config.mode ?? 'host', requestApproval})` ✅ 一致 |
| requestApproval 包装 | `(req) => approval.request(req)`（保留 receiver） | `(req) => config.approval.request(req)`（保留 receiver） ✅ 一致 |
| approval 来源 | `config.approval ?? ctx.get('approval')` | `config.approval`（**无 ctx.get 兜底**） |
| rootDir 缺失 | throw（拒绝启动）✅ | `createWorkbenchHostService` 里 throw TypeError ✅ |

**唯一差异**：`index.js` 额外支持 `ctx.get('approval')` 兜底（因为它的 `inject` 只有
`['commands']`，不能声明 `approval` 依赖 —— 这正是第 1 轮 blocker 的修复）。
`host-service.js` 是纯 Node 侧辅助函数，不接触 Cordis ctx，所以没有这个兜底是合理的。
→ **不构成行为不一致隐患**，但确实存在**两份 apply 语义**，将来改一处忘一处会漂移。
**nit**（建议：`index.js` 改为调用 `applyWorkbenchHostService` 并把
`ctx.get('approval')` 的结果作为 `config.approval` 传入，消除重复）。

### 11.7 其他主动排查（未发现新 blocker）

- **`event.update` 丢字段**：`event-repo.js:99-110` 的 `mergePatch(current, patch)`
  是**合并**语义（不是整行替换），且 `next = {...current, ...normalized}` 保留未提及字段
  → EventForm 编辑只提交 title/description/allDay/start，不丢 location/recurrence ✅
  （TaskForm 已是全字段展开，第三轮修过）
- **`toggleTask` 用 `{...t, done: !t.done}`**：整行替换，但 `t` 来自 `task.list`（完整行），
  字段齐全 ✅；且 `done` 翻转**不触发**审批（只软删触发）✅
- **`task.upsert` 软删时 `const t = tasks.find(...) ?? { id }`**：若任务不在当前列表
  （已被软删、或列表过滤掉了），则用 `{ id }` 构造**残缺任务**并写库 → **会覆盖掉
  原有字段**。但 UI 上软删按钮只对**列表里可见**的任务触发，且软删后任务从列表消失，
  用户无法再次点删除 → **实际不可达**。记为 **nit**（防御性应改用 `{...t}` 之外的
  merge 或直接报错）。
- **`load()` 的 `Promise.all`**：4 个命令并发，若 `request` 抛异常（sessionId 无效）
  会 reject → 被 catch → `setError` ✅ 不会 unhandled rejection。
- **`ctx.slots.inject('main', ...)` 的 inject 是零参**：client.js:808 `inject: () => ({ctx, t})` ✅
  与 `dsh-client-ui-renderer:435-441` 的零参语义一致。

---

# 结论：REQUEST CHANGES

**审查基准**：`548be95`（自 `git archive` 导出到 `/tmp/wp4r3/freeze-548be95`，逐字节独立）
**主仓库 HEAD 开始**：`548be95ac725b4136e7f36a5e062e16fd1760cbe`
**主仓库 HEAD 结束**：`548be95ac725b4136e7f36a5e062e16fd1760cbe`（**未变**）
**工作树**：仅新增本报告文件；`packages/workbench-ui` 与 `workbench-core` 零改动
**红线**：正式 `desktop` profile 未改（`grep -c workbench-ui ~/.dsh/profiles/desktop/cordis.patch.yml` = 0）、0 remote、未 push

## 阻塞项汇总

| # | 级别 | 问题 | 位置 |
| --- | --- | --- | --- |
| **B-1** | 🔴 **BLOCKER** | `t` 在工厂作用域未定义 → 打开「新建日程」「新建待办」「删除确认」三个弹窗**必抛 `ReferenceError`**，三条主路径全断 | `client.js:358, 390, 396, 400`（`t` 只声明于 `client.js:406` 的 `WorkbenchPage` 内部） |
| **M-1** | 🔴 **MAJOR** | 测试**完全不覆盖组件渲染**：两条自制变异（退回硬编码 `t('cancel')`、改成不存在的 key `t('cancelTYPO')`）都 **267 pass / 0 fail**。B-1 能在全绿下溜过去 | `workbench-ui-standards.test.mjs` 全为正则断言；`workbench-ui-bridge.test.mjs` 只测 `callHost` |

## nit（不阻断，建议一并修）

| # | 级别 | 问题 | 位置 |
| --- | --- | --- | --- |
| N-1 | 🟡 | `sidebar.panellist` 的 `label: () => 'Workbench'` 仍硬编码，中文用户看不到「工作台」；真范式是 `label: () => t("panel")` | `client.js:815` |
| N-2 | 🟡 | 报告 §5 的回归数字停在第三轮**之前**（266/43/9），实际为 267/44/10。数字不假但未更新 | `docs/wp4/01-final-report.md:112` |
| N-3 | 🟡 | `__test` 导出进入生产模块 exports 面。无凭据泄露、无越权，**非安全问题**，属契约卫生 | `client.js:249, 797` |
| N-4 | 🟡 | `packages/workbench-ui/index.js` 与 `workbench-core/src/host-service.js` 两份 apply 语义重复。当前**行为一致**（已逐项核对 provide 名 / service 构造 / receiver 保留 / rootDir 缺失处理），但将来易漂移 | `index.js:80` vs `host-service.js:262` |
| N-5 | 🟡 | 软删时 `const t = tasks.find(...) ?? { id }`：任务不在列表时用残缺对象整行覆盖，会丢字段。UI 路径**实际不可达**（软删后即从列表消失），属防御性问题 | `client.js:644` |
| N-6 | 🟡 | slot 同时声明 `locale: NS` 与 `inject: () => ({ctx, t})`，`t` 重复提供。真范式（schedule）只用 `locale:` + `apply` 内 `ctx.locale.bind(NS)`。entry 路径是 `{...kit, ...injected}`，**不会抛错**，只是风格不一致 | `client.js:806-808` |

## 已通过项（明确记录，避免下一轮重复劳动）

- ✅ 冻结纪律：提供的副本是**旧版 d64deab**（逐字节一致），已按要求用 `git archive 548be95` 自导出审当前最新
- ✅ `callHost` 内联、无相对 require；测试用 `extractCallHost` 从**源码提取真实现**，非复刻
- ✅ **独立变异验证**：自行把内联 callHost 退回旧扁平解码 → bridge **17 tests / 9 pass / 8 fail**（必须变红）
- ✅ locale API 形状正确（`register(ns,{zh,en})` 值须为 key→string 映射；`bind(ns)` 返回 `(key,params)=>string`）
- ✅ `locale` 确在真 web composition 内（`dsh-web-app/cordis.patch.yml:254`）
- ✅ 隔离 boot 零错误零 "did not activate"（`DSH_HOME=/tmp/dsh-iso-Jv2UeM`，Web 服务起在 127.0.0.1:45999）
- ✅ 软删语义：`service.task.list` 过滤 deleted；**仅软删**需审批（新建/完成不需）
- ✅ 审批指纹 op/target/digest 三项与实际执行**完全一致**（不会 fingerprint-mismatch）
- ✅ 真 `ApprovalService` + open-turn session 端到端 **2/2 通过且未 skip**
- ✅ main sessionId 来源与 `dsh-client-ui-workspace:89` 完全一致；无活动会话有明确错误提示，非空白/永久 loading
- ✅ load 降级：cf/ex 失败只降级为空；ev/tk 单个失败也不整页空
- ✅ 回归：**267/267** 单测、**44/44** 变异（0 真空 0 跳过）、门禁 **8/8**
- ✅ 红线全部保持
- ✅ 诚实性：无伪造截图；UNVERIFIED 项保留

## 视觉验证边界（如实声明）

本轮**只做静态核查**。**真实渲染画面未取得，视觉验证不可得。**
深浅色截图、窗口缩放、真实点击/键盘交互、浏览器网络层 `ctx.remote.commands.execute` 端到端 —— 全部 **UNVERIFIED**，不伪造、不模拟。
（讽刺的是：B-1 恰好是一个「静态全绿、运行时必崩」的典型 —— 若无真实渲染，这类缺陷无法被发现。）

## 复现 B-1 的最小命令

```bash
node /tmp/wp4r3/probe-t-scope.mjs
```
```
[baseline (no form)] render OK (no throw)
[NEW EVENT form open] RENDER THREW: ReferenceError: t is not defined
        at Object.EventForm [as type] (client.js:358:71)
[NEW TASK form open] RENDER THREW: ReferenceError: t is not defined
        at Object.TaskForm [as type] (client.js:390:71)
[DELETE confirm open] RENDER THREW: ReferenceError: t is not defined
        at Object.ConfirmDelete [as type] (client.js:396:11)
```
对照第三轮修复前（d64deab）：
```
[d64deab NEW EVENT form] render OK
[d64deab DELETE confirm] render OK
```
→ **B-1 是 548be95 第三轮改动引入的新缺陷**。

## 修复指引（供实现方）

**B-1 最小修法**：把 `t` 提到工厂作用域，或让三个兄弟组件从 props 拿 `t`。
推荐后者（与真范式一致，且能顺带解掉 N-6）：
```js
// apply 内
const t = ctx.locale.bind(NS)
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main', key: PANEL_ID, id: PANEL_ID, locale: NS,
  inject: () => ({ ctx, t }),        // 或直接靠渲染器的 localeSeat 注入 t
}, WorkbenchPage))

// WorkbenchPage 内
const t = props.t ?? ((k) => LOCALE.en[k] ?? k)
h(EventForm, { initial: editing.data, t, saving, onSave: saveEvent, onCancel: ... })
h(TaskForm,  { initial: editing.data, t, saving, onSave: saveTask,  onCancel: ... })
h(ConfirmDelete, { label: confirming.label, t, approving, onConfirm: ..., onCancel: ... })
// 三个组件内部改为 function X({ t, ... }) { ... t('cancel') ... }
```

**M-1 最小修法**：加一条**真渲染**测试（不需要浏览器）——用 `react-dom/server` 的
`renderToStaticMarkup` 或一个最小递归渲染器，把 `WorkbenchPage` 在
「新建事件 / 新建待办 / 删除确认」三种状态下渲染一遍，断言不抛错。
这样 `t` 未定义、key 拼错、组件 props 漏传都会被抓住。
（探针 `/tmp/wp4r3/probe-t-scope.mjs` 已给出可直接复用的最小渲染器骨架。）

**N-1**：`label: () => ctx.locale.bind(NS)('panel')`（或在 apply 内 `const t = ctx.locale.bind(NS)` 后 `label: () => t('panel')`）。

---

**判定：REQUEST CHANGES** —— 1 个运行时 BLOCKER（B-1，三条主路径全断）
+ 1 个 MAJOR 覆盖空洞（M-1，正是 B-1 能溜过去的直接原因）+ 6 个 nit。

**第三轮的修复方向是对的**（内联 callHost 正确、locale 接入契约正确、load 降级正确、
回归数字全部达标），但落地时引入了新的运行时缺陷。建议第四轮修 B-1 + M-1 后再复审；
其余 nit 可批量处理。
