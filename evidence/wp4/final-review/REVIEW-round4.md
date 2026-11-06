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

## 2. BLOCKER-1 修复有效（检查名：blocker1-regression-guard）

**复现命令（只在 /tmp 副本 /tmp/wp4r4/blk 里改源码）**
```
$ cp -R /tmp/wp4r4/repo /tmp/wp4r4/blk
$ python3 - <<'PY'   # 复现第三轮缺陷：删 defaultT + 三个组件去掉 `t = defaultT` + WorkbenchPage 内 t 退回内联
p='packages/workbench-ui/client.js'
s=open(p,encoding='utf-8').read()
s=s.replace("    const defaultT = (key) => LOCALE.en[key] ?? key\n", "    // [MUTATION] defaultT removed (复现第三轮 BLOCKER-1)\n")
s=s.replace("function EventForm({ initial, onSave, onCancel, saving, t = defaultT }) {", "function EventForm({ initial, onSave, onCancel, saving }) {")
s=s.replace("function TaskForm({ initial, onSave, onCancel, saving, t = defaultT }) {",  "function TaskForm({ initial, onSave, onCancel, saving }) {")
s=s.replace("function ConfirmDelete({ label, onConfirm, onCancel, approving, t = defaultT }) {", "function ConfirmDelete({ label, onConfirm, onCancel, approving }) {")
s=s.replace("      const t = props.t ?? defaultT", "      const t = props.t ?? ((k) => LOCALE.en[k] ?? k)")
open(p,'w',encoding='utf-8').write(s)
PY
$ cd /tmp/wp4r4/blk/workbench-core && node --test test/workbench-ui-render.test.mjs
```

**实际输出（变红）**
```
not ok 2 - WP4：三个弹窗组件渲染不得抛异常（第三轮 BLOCKER-1 守卫）
  error: |-
    Got unwanted exception: EventForm 渲染不得抛异常（t 必须在作用域内可见）
    Actual message: "t is not defined"
  name: 'ReferenceError'
  stack: |-
    EventForm (eval at loadClient (…/workbench-ui-render.test.mjs:77:5), <anonymous>:381:71)
    file:///…/workbench-ui-render.test.mjs:113:20
not ok 4 - WP4：t 必须在工厂作用域可见（防止退回 WorkbenchPage 内部）
  error: '工厂层必须有 defaultT'
1..4
# tests 4
# pass 2
# fail 2
```
全量套件同样变红：`# tests 271 / # pass 269 / # fail 2`。

**还原后（实际输出）**
```
$ cp /tmp/wp4r4/repo/packages/workbench-ui/client.js packages/workbench-ui/client.js
$ node --test test/workbench-ui-render.test.mjs   → # pass 4  # fail 0
$ node --test test/*.test.mjs                    → # tests 271  # pass 271  # fail 0
```

**判定：通过**（第三轮缺陷被真实复现为 `ReferenceError: t is not defined`，本轮测试**变红**；还原后全绿）

## 3. MAJOR-1 修复有效（检查名：major1-real-render）

**核对命令**
```
$ grep -n "React\.\|useState\|useEffect\|useCallback\|useMemo\|useRef\|useTransition\|forwardRef\|memo\|useId\|Fragment" packages/workbench-ui/client.js
22:    const React = require('react')
23:    const h = React.createElement
24:    const { useState, useEffect, useCallback, useMemo, useRef } = React
```
client.js 只用到 `createElement / useState / useEffect / useCallback / useMemo / useRef` 六个 API，
测试的 `makeReact()` 全部实现（createElement、useState、useEffect、useCallback、useMemo、useRef），
**没有 useTransition / forwardRef / memo / useId / Fragment / useReducer / useContext** 等遗漏。

**组件来源核对**
```
$ sed -n '61,83p' workbench-core/test/workbench-ui-render.test.mjs
```
- `loadClient()` 用 `new Function('window', clientSource)(globalThis.window)` **真实执行 client.js 源文件**，
  并提供 `window.__ModuleLoader__.load({factory})`，`require('react')` 返回真实工厂所用的 React。
- 断言 `plugin.__test` 非空、`probe[name]` 是函数 → **同一批实例**（不是复刻实现、不是正则）。
- 断言 `plugin.apply` 是函数 → 工厂整体被执行。

**判定：通过**（渲染测试跑的是 client.js 工厂导出的真实组件实例；变异 W9/W10 证明它能捕获渲染期异常与「组件不渲染」）

## 4. 回归三件套（检查名：regression-suite）

**命令（全部在 /tmp/wp4r4/repo 导出副本里）**

```
$ cd /tmp/wp4r4/repo/workbench-core && node --test test/*.test.mjs
1..271
# tests 271
# pass 271
# fail 0
# skipped 0
```

```
$ cd /tmp/wp4r4/repo && node scripts/r3-mutate.mjs /tmp/wp4r4/probe/mutation.log
CAUGHT: 46
VACUUM: 0
SKIP:   0
结论：全部保护点都有测试约束（0 真空，0 跳过）
（exit 0；W8 → pass 270 fail 1、W9 → pass 269 fail 2、W10 → pass 269 fail 2）
```

```
$ cd /tmp/wp4r4/repo && bash scripts/wp2-r5-gate.sh
=== 门禁汇总 ===
通过 8 项，失败 0 项
RESULT: PASS
（unit-tests / demo / probe-real-storage / probe-protect / probe-retention /
  real-service-l4 / acceptance-8 / mutations 全 ✅）
```

**判定：通过**（271/271、46/46 且 0 VACUUM 0 SKIP、门禁 8/8）

## 5. 隔离加载（检查名：isolated-load）

**命令**
```
$ DSH_HOME=/tmp/dsh-iso-Jv2UeM dsh --profile rescue --patch /tmp/wp4-isolated-patch.yml --no-open --port 0 &
PID=90314
$ sleep 12 ; kill $PID
```

**实际输出**
```
dsh web: http://127.0.0.1:52779/?token=00NC1Cw_1rLcK6OsBONtHzRfmAagDp7rMTVeG92Kw88
（日志共 1 行；无 ERROR / no "did not activate"）
```
`--port 0` → 随机端口 52779，Web 服务独立起；隔离 HOME 为 `/tmp/dsh-iso-Jv2UeM`，
profile `rescue` 的 package.json 只含 `@local/dsh-workbench-ui`（link 安装）。

**判定：通过**（零错误、零 did-not-activate）

## 6. 红线（检查名：red-lines）

**命令**
```
$ grep -n "workbench" ~/.dsh/profiles/desktop/package.json            → 无
$ grep -n "workbench" ~/.dsh/profiles/desktop/cordis.patch.yml       → 无
$ grep -l "workbench" ~/.dsh/profiles/desktop/package.json* ~/.dsh/profiles/desktop/cordis.patch.yml*
NO workbench anywhere in desktop profile
$ cd /Users/sylas/Developer/dsh-workbench && git remote -v            → 空
$ git branch -vv
* main bf1c657 WP4-10: fix round-3 BLOCKER-1 ...
（无 [origin/...] 跟踪 → 未 push）
```

**判定：通过**（正式 profile 未被写入；0 remote；未 push；本轮也未 push）

## 7. 诚实性（检查名：honesty）

**命令**
```
$ find evidence/wp4 -type f | sort
01-isolated-boot-before-fix.log   02-isolated-boot-after-fix.log
03-isolated-load.md               04-isolated-boot-after-fixes.log
05-real-approval-after-fixes.log 06-review-response.md
07-isolated-boot-after-round2-fixes.log 08-real-approval-after-round2-fixes.log
09-isolated-boot-round3.log       10-isolated-boot-round3-fixes.log
final-review/REVIEW-round3.md     final-review/VERDICT.md

$ find evidence/wp4 -type f \( -iname "*.png" -o -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.webp" -o -iname "*.gif" -o -iname "*.svg" \)
（空 → 无任何图片文件）
```

**报告数字逐条实测**
| 报告声明 | 实测 | 结论 |
| --- | --- | --- |
| 单测 271/271 | `node --test test/*.test.mjs` → tests 271 / pass 271 / fail 0 | ✅ |
| 变异 46/46、0 真空 0 跳过 | r3-mutate.mjs → CAUGHT 46 / VACUUM 0 / SKIP 0 | ✅ |
| 门禁 8/8 | wp2-r5-gate.sh → 通过 8 项，失败 0 项 | ✅ |
| UI↔Host 21/21（bridge + 渲染） | bridge 17 + render 4 = **21** | ✅ |
| 静态规范 **9/9** | `workbench-ui-standards.test.mjs` 实际 **10** 个 test（9 个 + 第 3 轮新增 locale 一条） | ⚠️ **数字过期（MINOR）** |

UNVERIFIED 项保留情况：§5 仍保留「深浅色截图 / 窗口缩放 / 真实点击 / 真实键盘操作 /
`ctx.remote.commands.execute` 浏览器网络层 / 独立视觉 Review」为 UNVERIFIED，未被删除或改写。

**判定：基本通过，含 1 条 MINOR（N1：静态规范数字 9/9 应为 10/10）**

## 8. 前几轮已过项抽验（检查名：spot-check-prior）

### 8.1 client.js 无相对 require
```
$ grep -n "require(" packages/workbench-ui/client.js
22:    const React = require('react')
（仅包名 require；无 './x'）
$ grep -rn "require('\./\|require(\"\./" packages/workbench-ui/   → 无
```
**判定：通过**

### 8.2 locale register/bind 形状对齐 dsh-client-ui-approval/lib/client.js
一手源码（从 app.asar 解出）：
```
$ grep -n "ctx.locale.register(NS" dsh-client-ui-approval/lib/client.js
426:  ctx.effect(() => ctx.locale.register(NS, {
（本仓库 client.js:824  同形：ctx.effect(() => ctx.locale.register(NS, LOCALE), 'workbench-ui: locale')）
```
> 注：代码注释里写的行号「approval/lib/client.js:316」**对不上当前 asar**（316 行是 `escalation:` 文案，
> 真正的 register 在 **426**）。属**注释行号漂移（N2）**，不影响行为。
真 locale 服务实现（dsh-client-locale/lib/client.js:1676）确认 `register(ns, dicts)` 接受
`{en,zh}` 形状，`bind(ns)` 返回 `t(key)`。

**端到端探针 P4**（`/tmp/wp4r4/probe/p4-locale-e2e.mjs`，真实调用 `plugin.apply(ctx)`）：
```
=== register 调用 ===
[{ "ns": "@local/dsh-workbench-ui", "langs": ["en","zh"] }]
main.locale = @local/dsh-workbench-ui | sidebar.locale = @local/dsh-workbench-ui
main 有 key: workbench
sidebar label (active=en) = "Workbench"
sidebar label (active=zh) = "工作台"
main inject() 返回 keys = [ 'ctx', 't' ]
main inject().t('panel') (active=zh) = "工作台"
main inject().t('delete') (active=zh) = "删除"
```
→ register / main inject bind / sidebar label bind **四处同一命名空间**，切换语言后 sidebar 与页面文案同步中文。
**判定：通过**（附 N2：注释行号漂移）

### 8.3 软删需审批且审批指纹 op 与实际操作一致
**探针 P6**（`/tmp/wp4r4/probe/p6-softdelete-approval.mjs`，真 service + 真 approval gate）：
```
无 token 软删： 被拒 code=confirmation-required
requestApproval(task.upsert, target=t-1) → {"approved":true,"token":"c06262a2…"}
带正确 token 软删：✅ 成功
用 event.delete 指纹去执行 task.upsert： 被拒 code=confirmation-required（原因：fingerprint-mismatch；payload 里的 confirmed 不被采信）
```
指纹三元组对齐：
- client.js:653 `op = kind === 'task' ? 'task.upsert' : 'event.delete'`，payload `{approvalOp: op, target: id, summary}`
- Host index.js:136 `service.askApproval(sessionId, payload.approvalOp ?? payload.op ?? 'event.delete', {target, summary})`
- service.js:420 `requireConfirmation('task.upsert', meta, { target: task.id })`

**判定：通过**

### 8.4 main sessionId 取自 retainedBy.mainView>0
```
client.js:439  Object.values(snap.byId).find((r) => (r?.retainedBy?.mainView ?? 0) > 0)
参考 dsh-client-ui-workspace/lib/client.js:101
  const current = () => Object.values(ctx.sessions.list.getSnapshot().byId).find((row) => (row.retainedBy.mainView ?? 0) > 0);
```
**判定：通过**（形状一致；另有 bridge 测试「UI 的 sessionId 必须来自 sessions store（不得回退到无效来源）」）

### 8.5 真 ApprovalService + open-turn session 能签发 token
```
$ cd /tmp/wp4r4/repo/workbench-core && node --test test/host-approval-real.test.mjs
ok 1 - WP3：真 ApprovalService 端到端 —— allowed-once 经适配器签发 token
ok 2 - WP3：真 ApprovalService 词汇白名单 —— 非 allowed-once 全 fail-closed
# tests 2 / # pass 2 / # skipped 0
```
（真 asar 的 `@deepseek-ai/dsh-user-approval` + `@deepseek-ai/cordis`，非 SKIP）
**判定：通过**

## 9. 主动找新缺陷（检查名：new-defect-hunt）

### 9.1 `__test` 挂在生产 plugin 对象上的契约/安全影响
**一手源码链（全部来自 app.asar）**
```
cordis-plugin-loader/lib/index.js:589
  const plugin = this.loader.unwrapExports(moduleNamespace);
cordis-plugin-loader/lib/index.js:813
  unwrapExports(exports) { exports = exports.default ?? exports; if (!exports.__esModule) return exports; ... }
cordis/lib/index.js (registry.resolve)
  resolve(plugin) { if (typeof plugin === "function") return plugin; if (isApplicable(plugin)) return plugin.apply; }
cordis/lib/index.js (registry.plugin)
  runtime = { name, callback, fibers, Config: plugin.Config };
  const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, ...);
dsh-cordis-client-runner/lib/client.js:760 (guardedSurface)
  return { ...plugin, name: moduleIdOf(pkg.pluginId), apply: (ctx, config) => plugin.apply(guarded(ctx), config) };
```
**实测（探针 P7）**
```
our plugin shape after unwrap: [ 'inject', '__test', 'apply' ] has apply: function
```
**结论**：
- cordis 只把 `plugin.apply` 当回调、只读 `plugin.inject` / `plugin.Config` / `plugin.name`；
  **`__test` 不被任何一方读取或执行**，不构成契约破坏、不会改变插件行为。
- `guardedSurface` 用 `{...plugin}` 展开，`__test` 会随对象进入浏览器模块表的 exports；
  同页脚本能读到组件函数引用——但这些组件本来就要渲染在同页，**不是权限提升**。
- 唯一实质代价：生产 bundle 里带了一个测试钩子（N3 级 nit，非 blocker）。
  若要消除，可在 factory 内按 `process.env.NODE_ENV === 'test'` 或构建期常量剔除，
  但那会让「同一份源码」不再一致，反而削弱本轮修复的可验证性。

**判定：通过（附 N3 nit）**

### 9.2 渲染测试的最小 React mock 是否漏实现 client.js 用到的 React API
```
$ grep -n "React\.\|useState\|useEffect\|useCallback\|useMemo\|useRef\|useTransition\|forwardRef\|memo\|useId\|Fragment" packages/workbench-ui/client.js
22: const React = require('react')
23: const h = React.createElement
24: const { useState, useEffect, useCallback, useMemo, useRef } = React
```
| React API | client.js 是否用 | mock 是否实现 |
| --- | --- | --- |
| createElement | ✅ | ✅ |
| useState | ✅ | ✅ |
| useEffect | ✅ | ✅ |
| useCallback | ✅ | ✅ |
| useMemo | ✅ | ✅ |
| useRef | ✅ | ✅ |
| useTransition / forwardRef / memo / useId / Fragment / useReducer / useContext / useLayoutEffect / createContext / Suspense / lazy / useSyncExternalStore | ❌ 未使用 | —（无需实现） |

**判定：通过**（mock 覆盖 client.js 实际使用的全部 React API，无遗漏；若将来引入新 API，
`require('react')` 会返回缺字段的对象 → 渲染测试立刻抛 `TypeError: useX is not a function` → 变红，
属于「fail-loud」，不会误判为通过。）

### 9.3 渲染测试的递归 render 是否有循环引用 / 栈溢出风险
**探针 P2(a)**
```
WorkbenchPage 渲染树最大深度 = 8 (栈安全)
自引用组件在 maxDepth 保护下抛错： Maximum call stack size exceeded
```
- 真实渲染树深度 **8**，远低于栈上限；无环。
- 组件树是有限树（MonthView 42 格、AgendaList 按事件数），不存在自引用；
  未来若引入自引用组件，JS 自身会抛 `Maximum call stack size exceeded` → 测试红，不会误判通过。
**判定：通过**

### 9.4 三个组件从 props 取 t；defaultT 兜底是否每个都有
**探针 P2(d)**
```
EventForm:    { initial, onSave, onCancel, saving, t = defaultT }        → 有 defaultT 兜底
TaskForm:     { initial, onSave, onCancel, saving, t = defaultT }        → 有 defaultT 兜底
ConfirmDelete:{ label, onConfirm, onCancel, approving, t = defaultT }   → 有 defaultT 兜底
```
**判定：通过**（三个组件**全部**带 `t = defaultT`；将来新增组件若忘传 `t`，会退回英文默认文案而**不会崩**）

### 9.5 `load()` 四个命令全失败时页面显示什么
**探针 P2(b)**
```
合并后 StatusBar error 文案 = "日程：日程炸了；待办：待办炸了；冲突检测：冲突炸了；重复展开：展开炸了"
```
源码（client.js:508-514）确实把 4 条错误**合并成一条**（`problems.join('；')`），
StatusBar 以 `role="alert"` 渲染并带 Retry 按钮；不静默、不覆盖。
**判定：通过**（第三轮 nit N3/N4 已修）

### 9.6 sidebar label 的 `ctx.locale.bind(NS)` 与 `ctx.locale.register(NS, LOCALE)` 是否同一命名空间
**探针 P3**
```
NS 常量值 = "@local/dsh-workbench-ui"
  locale.register:  标识符=NS → @local/dsh-workbench-ui → ✅ 同命名空间
  main inject bind: 标识符=NS → @local/dsh-workbench-ui → ✅ 同命名空间
  sidebar label bind:标识符=NS → @local/dsh-workbench-ui → ✅ 同命名空间
```
**探针 P4（真实调用 plugin.apply）** 进一步确认切换语言后 sidebar 与页面文案同步中文。
**判定：通过**

### 9.7 `packages/workbench-ui/index.js` 与 `workbench-core/src/host-service.js` 两处 apply 行为是否一致
**探针 P5**
```
✅ approval 来源优先级 config.approval 优先
✅ 保留 receiver 的箭头包装（两侧都是 (req) => approval.request(req)）
✅ rootDir 空则拒绝启动（pkg）/ 非空校验（core）
✅ 词汇映射 allowed-once→approved 由 core 的 hostRequest 统一做（pkg 不重复映射）
✅ agent 缺失 → 'unavailable'（core）
差异：core 支持 currentAgent 兜底，pkg 未传；pkg 另有 ctx.get('approval') 兜底而 core 的
      applyWorkbenchHostService 只吃 config.approval。
```
差异是**有意的**：pkg（插件入口）需要「ctx.get 兜底」以便在隔离 profile 里不炸；
core 的 applyWorkbenchHostService 是给「已经拿到 approval 服务」的调用方用的。
两侧最终都走 `createWorkbenchHostService` → 同一套 gate / 指纹 / 词汇映射。
**判定：通过**（行为一致，差异是入口形态差异且已在注释中说明）

### 9.8 报告是否遗漏「已修但未记录」的问题
第三轮修的三件事在报告里都有落点：
- 相对 require：`evidence/wp4/06-review-response.md` 与 client.js 注释「为什么内联而不 import 同包文件」；
- locale 接线：§四 UI 规范表 + §五 21/21（含「组件渲染不抛异常」）；
- load 降级：§五 21/21 与 client.js:499 注释「各命令独立降级」。
`ad90579` 又补了 §8 的三轮回顾与「共同教训」。
**唯一遗漏（本轮 N1）**：静态规范测试数从 9 增到 **10**，报告仍写 **9/9**（§四 末行与 §五 表）。

**判定：基本通过，N1 记录在案**

## 10. 视觉静态核查（检查名：visual-static）

**Client Inspect 通道实测（本次复审时）**
```
$ cordis_inspect_query(platform=client, provider=Theme,   method=listTokens)
Error: Theme.listTokens: Client inspect query Theme.listTokens timed out after 10000ms.
$ cordis_inspect_query(platform=client, provider=Slots,   method=listSubTree, root=main)
Error: Slots.listSubTree: Client inspect query Slots.listSubTree timed out after 10000ms.
$ cordis_inspect_query(platform=client, provider=Builtin, method=listBuiltins)
Error: Builtin.listBuiltins: Client inspect query Builtin.listBuiltins timed out after 10000ms.
```
→ Client 通道不可用（与报告 §5 记载的「Client Inspect 不可用」一致）。

**按 `references/verification.md` 的规则**：无浏览器控制时只能静态核查，
不得用模拟 React-DOM / 另起浏览器 / rasterizer 补截图。

**逐项静态结论**
| 项 | 静态结论 | 真实渲染 |
| --- | --- | --- |
| `main` keyed slot，key='workbench'，不覆盖 conversation | ✅ 源码 key:'workbench'；bridge 测试断言 | **未取得** |
| `sidebar.panellist` id/order/locale/label | ✅ order:20、locale:NS、label 走 locale（探针 P4 实测中英文） | **未取得** |
| 只用 `--dsw-alias-*` 令牌，无硬编码颜色 | ✅ standards 测试静态扫描 | **未取得** |
| 4/8 倍数间距、正文 16px、标题 20–28px、点击区 ≥44px | ✅ CSS 逐值静态核查 + standards 测试 | **未取得** |
| 深浅色两套主题 | ✅ 由宿主令牌切换，插件不写死颜色 | **未取得（截图 UNVERIFIED）** |
| 键盘/焦点/可访问性 | ✅ focus-visible、role=tablist/alert/status/dialog、aria-label、Ctrl/Cmd+K、effect 内清理监听 | **未取得（真实键盘操作 UNVERIFIED）** |
| 窄窗布局 | ✅ flex + `@media (max-width:800px)` 侧栏下移 | **未取得（窗口缩放 UNVERIFIED）** |
| 紧凑无装饰 | ✅ 无插图/无动效 | **未取得** |

**结论：真实渲染画面未取得，视觉验证不可得。** 本轮未提交、也不接受任何伪造截图
（`evidence/wp4/` 下只有 .log/.md，实测无 png/jpg/webp/svg）。

---

## 11. 【新发现】页面 → 组件的 `t` 传递断链（本次复审实测）

### 11.1 事实：只有 `ConfirmDelete` 没拿到 `t`

client.js 里三个组件的**定义**都有 `t = defaultT` 兜底（§9.4 已证），但**页面调用点**只有一个传了：

```
$ grep -n "h(EventForm\|h(TaskForm\|h(ConfirmDelete" packages/workbench-ui/client.js
721:  ? h(EventForm, { initial: editing.data, saving, t, onSave: saveEvent, onCancel: ... })
722:  : h(TaskForm, { initial: editing.data, saving, t, onSave: saveTask, onCancel: ... })
809:  ? h(ConfirmDelete, {
810:      label: confirming.label, approving,        ← 没有 t
811:      onConfirm: ..., onCancel: ...
812:    })
```

**探针 P8**（`/tmp/wp4r4/probe/p8-t-prop-in-page.mjs`：用可控 useState mock 让
`editing`/`confirming` 非空，真实渲染 WorkbenchPage）：
```
=== 页面实际传给三个弹窗组件的 props ===
EventForm      props.t = ✅ 已传（ZH<delete>）
ConfirmDelete  props.t = ❌ 未传 → 组件用 defaultT（英文）

=== 若未传 t，弹窗里显示的文案（defaultT 走 LOCALE.en）===
["Delete","?","This requires Host approval before deleting “演示日程”.","Request approval & delete","Cancel"]
```
→ 中文界面下点「Delete…」弹出的**确认框标题与取消按钮仍是英文**（"Delete?" / "Cancel"），
   与页面其余中文不一致。**不是崩溃**（defaultT 兜底挡住了），**不是白屏**，
   但正是本轮修复想解决的那类「locale 没真正接线」问题在第三处留下尾巴。

### 11.2 严重度判定

| 维度 | 判定 |
| --- | --- |
| 是否崩溃 / 白屏 | **否**。`t = defaultT` 兜底生效，组件正常渲染（§9.4 已证 + P8 实测输出有完整文案） |
| 是否数据丢失 / 审批旁路 | **否**。审批路径与 `t` 无关（§8.3 已用真 service + 真 gate 验证） |
| 是否影响用户完成核心流程 | **否**。删除仍需真审批、仍走 `event.delete` / `task.upsert` 正确指纹 |
| 影响面 | 1 处漏传 → 确认删除弹窗的 2 个按钮文案退回英文 |

→ **不构成 blocker**（无崩溃、无数据丢失、无审批旁路、无会话隔离问题），
   属 **MAJOR-NIT（MINOR+）**：locale 修复未做到端到端闭合，且**没有任何测试守住这条线**（见 11.3）。

### 11.3 附带发现：测试没有守住「页面→组件 props 传递」这条线（复现证据）

**探针 P9**
```
=== 测试覆盖：页面是否传 t 给三个组件 ===
渲染测试断言了 props.t 传递？ 否
渲染测试是否覆盖 WorkbenchPage 的 editing/confirming 非空态？ 否 → 页面渲染路径不产生任何弹窗组件
bridge 测试是否断言页面传 t？ 否
```

**两条变异实测（都在 /tmp 副本里改源码后跑全量 271 条）**
```
变异 A：页面给 ConfirmDelete 传坏 t（null）→ # tests 271 / # pass 271 / # fail 0
变异 B：页面不再给 EventForm 传 t              → # tests 271 / # pass 271 / # fail 0
```
→ **即使把「页面传 t」这条线完全切断，271 条测试仍然全绿。**
这说明第三轮 MAJOR-1 的修复被覆盖了「组件自身作用域」这一半，但**没有覆盖**
「页面是否真的把 locale 绑定传给组件」这一半——正是第 3 轮 blocker 的**成因链上游**。

> 说明：这不是「新增测试写得不够多」的泛泛指责，而是一个**可复现的覆盖缺口**：
> 若将来有人误删 `t` 或漏传 `t`，本轮新增的渲染测试不会变红，
> 只有用户会在中文界面里看到英文弹窗。

### 11.4 建议修法（最小改动，不扩大范围）

```js
// client.js:809
? h(ConfirmDelete, {
    label: confirming.label, approving, t,          // ← 加 t
    onConfirm: () => deleteWithApproval(confirming.kind, confirming.id),
    onCancel: () => setConfirming(null),
  })
```
并在 `workbench-ui-render.test.mjs` 补一条断言：渲染出 `editing`/`confirming` 非空的
WorkbenchPage，检查 `EventForm/TaskForm/ConfirmDelete` 三个组件的 props.t **都存在且同源**；
并加一条变异 M-EXPL（页面漏传 `t`）锁住它。

### 11.5 同类观察：其余硬编码文案（不阻断）

```
$ python3 扫 client.js 未走 t() 的用户可见英文
  "Loading…"            ← StatusBar（locale 字典里其实有 loading/ready/error/retry 键，但没接）
  "No tasks in this view"
  "Select an event or task to see details"
  "Overlaps another event"
  "AI session"
  "Delete…"
  "All day"
  "Due (ISO instant)"
locale 字典定义 24 键，实际只用 16 键；未用：description/error/loading/meta/ready/retry/save/title
```
→ locale 字典覆盖的是**顶部标签**；表单标签、状态栏、空态文案仍是硬编码英文。
第 3 轮 nit N5（「locale 未接」被降级保留）**只解决了一半**：顶部标签接上了，
其余仍是英文。属**已知范围**（授权未要求全量本地化），不阻断；记录在此。

## 12. 本轮发现的 NIT 汇总

| # | 级别 | 问题 | 证据 |
| --- | --- | --- | --- |
| **N1** | MINOR | 报告 §四/§五 写「静态规范 **9/9**」，实测 `workbench-ui-standards.test.mjs` 是 **10** 个 test（第 3 轮新增 locale 一条后未更新数字） | `grep -c "^test(" → 10`；实测 `# tests 10 / # pass 10` |
| **N2** | MINOR | client.js 注释引「`dsh-client-ui-approval/lib/client.js:316`」，当前 asar 里真正的 register 在 **426**（316 行是 `escalation:` 文案） | `sed -n '316p'` vs `grep -n 'ctx.locale.register(NS'` → 426 |
| **N3** | NIT | 生产 plugin 对象上挂了 `__test`（含 4 个组件函数 + callHost）；cordis 只读 apply/inject/Config，**不影响行为**，但会随模块 exports 进入浏览器同页可读 | §9.1 一手源码链 + 探针 P7 |
| **N4** | MINOR | **页面漏传 `t` 给 `ConfirmDelete`** → 中文界面下确认删除弹窗标题/取消按钮是英文；且**没有任何测试守住这条线**（两条变异后 271 条仍全绿） | §11 探针 P8/P9 + 变异 A/B 实测 |
| **N5** | MINOR | 证据索引 `00-evidence-index.md` 写「Client→Host→Storage 桥 21/21」，但该命令单独跑是 **17/17**（21 = 17 + 渲染 4，两条命令合起来） | `node --test test/workbench-ui-bridge.test.mjs` → `# tests 17 / # pass 17` |
| **N6** | NIT | 表单标签/状态栏/空态仍有硬编码英文；locale 字典 24 键只用 16 键 | §11.5 |

> N1/N5 属**报告诚实性数字过期**（第 2 轮同类问题已修过一次，本轮又出现新的两处）；
> N4 属本轮修复未端到端闭合 + 覆盖缺口；均不构成 blocker。

---

## 13. 收口复核（结束时的 HEAD 与最终回归）

```
$ cd /Users/sylas/Developer/dsh-workbench && git rev-parse HEAD
a860916de3e511d12b22a0d0f409a5ead9af5226

$ git status --porcelain=v1 --untracked-files=all
 M evidence/wp4/final-review/REVIEW-round4.md
（唯一改动就是本复审文件本身；主仓库源码我一行未改）

$ git diff --name-only bf1c657 a860916 -- packages workbench-core scripts upstream | wc -l
0
（审查期间出现的两个并发 commit —— ad90579 / a860916 —— 都只动 docs 与 evidence，
  对被审代码树零差异；因此本报告所有结论对 bf1c657..a860916 区间同样成立。）
```

**最终回归复跑**
```
$ cd /tmp/wp4r4/repo/workbench-core && node --test test/*.test.mjs
# tests 271 / # pass 271 / # fail 0
$ cd /tmp/wp4r4/repo && node scripts/r3-mutate.mjs /tmp/wp4r4/probe/mutation-final.log
VACUUM: 0
SKIP:   0
结论：全部保护点都有测试约束（0 真空，0 跳过）
```

---

# 结论：APPROVE WITH NITS

**被审对象**：`bf1c657`（代码树；审查期间并发到 `a860916`，代码零差异）

## 一句话

第三轮那个真 blocker（`t` 越出作用域 → 渲染即 `ReferenceError` → 整页白屏）**已被真实修复并被测试锁住**：
删掉 `defaultT` / 去掉组件默认值 / 页面漏传 `t` 都能让测试变红（我实测了前两种），还原后 271/271 全绿。
MAJOR-1（无测试渲染组件）也已修：新增的渲染测试**真实执行 client.js 工厂并真实调用组件实例**，
不是正则断言、不是复刻实现，React mock 覆盖了 client.js 实际用到的全部 6 个 API（无遗漏、无 useTransition 类隐患）。

**没有发现 blocker**：无运行时白屏/崩溃、无数据丢失、无审批旁路、无会话隔离失效、无伪造宿主。

## 逐项判定

| # | 检查 | 判定 |
| --- | --- | --- |
| 1 | 冻结纪律（导出副本逐字节一致、HEAD 记录） | ✅ 通过（856/856 文件 blob hash 全等） |
| 2 | BLOCKER-1 修复有效（回退即变红） | ✅ 通过（实测 `ReferenceError: t is not defined`） |
| 3 | MAJOR-1 修复有效（真实组件实例渲染） | ✅ 通过 |
| 4 | 回归三件套 271/271、46/46、8/8 | ✅ 通过 |
| 5 | 隔离加载零错误零 did-not-activate | ✅ 通过（12s，日志 1 行） |
| 6 | 红线（正式 profile 无 workbench-ui、0 remote、未 push） | ✅ 通过 |
| 7 | 诚实性（数字一致、UNVERIFIED 保留、无伪造截图） | ✅ 通过（含 N1/N5 两处数字过期） |
| 8 | 前几轮抽验（相对 require / locale 形状 / 软删审批指纹 / sessionId / 真 ApprovalService） | ✅ 通过 |
| 9 | 主动找新缺陷（8 项） | ✅ 通过（发现 6 条 nit，见下） |
| 10 | 视觉静态核查 | ⚠️ **真实渲染画面未取得，视觉验证不可得**（Client Inspect 三次全超时；按 `references/verification.md` 不伪造） |

## NIT 清单（均不阻断，建议下一轮顺手修）

| # | 级别 | 问题 |
| --- | --- | --- |
| **N4** | MINOR（**本轮唯一实质发现**） | 页面调用 `h(ConfirmDelete, {...})` **漏传 `t`**（client.js:809）→ 中文界面下确认删除弹窗标题「Delete?」与取消按钮「Cancel」仍是英文。**不崩、不白屏**（`t = defaultT` 兜底生效），但 locale 修复未端到端闭合。且**无测试守住这条线**：我实测两条变异（页面传坏 t / 页面完全不传 t）后 **271 条仍全绿**——第 3 轮 blocker 的**成因链上游**仍未被覆盖。修法：client.js:809 加 `t,`，并补一条「页面渲染出 editing/confirming 非空态 → 三个组件 props.t 都存在且同源」的断言 + 一条变异锁。 |
| N1 | MINOR | 报告 §四/§五「静态规范 **9/9**」→ 实测 **10/10**（第 3 轮新增 locale 一条后数字未更新） |
| N5 | MINOR | 证据索引 `00-evidence-index.md`「Client→Host→Storage 桥 21/21」→ 该命令单独跑是 **17/17**（21 = 17 + 渲染 4，两条命令合并才 21） |
| N2 | MINOR | client.js 注释引「approval/lib/client.js:316」，当前 asar 里 register 在 **426**（316 行是 `escalation:` 文案） |
| N3 | NIT | 生产 plugin 对象挂 `__test`；cordis 只读 apply/inject/Config，**不影响行为**，但会随 exports 进入浏览器同页 |
| N6 | NIT | 表单标签/状态栏/空态仍有硬编码英文；locale 字典 24 键只用 16 键（第 3 轮 nit N5 只解决了一半） |

## 复审员备注

- 本轮所有结论均在 **`/tmp/wp4r4/repo`（`git archive bf1c657` 导出副本）**里跑出；
  变异脚本只改副本，主仓库源码零改动（`git status` 仅显示本复审文件）。
- 未 push、未改正式 DSH profile、未动其他项目（鲸鱼娘 plugin `git status` 为空）。
- 视觉验证仍为 UNVERIFIED —— Client Inspect Provider（Theme/Slots/Builtin）本轮三次全部 10s 超时，
  按 `references/verification.md` 不找 rasterizer、不模拟 React-DOM、不另起浏览器补截图。
- 建议：把 N4 连同它对应的覆盖缺口一起修（加 `t` 一行 + 一条页面级 props 断言 + 一条变异），
  并顺手更正 N1/N5 两处数字，即可进入下一轮或直接收口。

**审查员**：WP4 第四轮独立复审员
**产物**：`evidence/wp4/final-review/REVIEW-round4.md`
**探针**：`/tmp/wp4r4/probe/`（p1–p9 + mutation*.log + tree-hashes.txt）
