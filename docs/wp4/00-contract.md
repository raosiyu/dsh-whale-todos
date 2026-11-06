# WP4 契约底稿：DSH Client Slots / Theme / Remote / 生命周期

来源：`/tmp/dsh-asar-full/dsh/node_modules`（从
`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 解包）
+ 技能 `cordis-plugin-development/references/*`（`read` 工具可读）。
**全部为真实契约，带一手源码行号；未确认的明确标注。**

## 0. 前置检查结论

| 项 | 结果 |
| --- | --- |
| Git | HEAD=`aadaba0`，dirty=0，0 remote |
| WP3 报告 | `docs/wp3/04-final-report.md`：WP3 完成、APPROVE WITH NITS、0 blocker |
| 4 条遗留 nit | ①审批词汇合并 ②askApproval 与 named-scope token 域 ③restore/upsert 不在 requireConfirmation ④displayReason 已删 |
| Host Service 契约 | `createWorkbenchHostService` / `invoke(sessionId, op, payload, meta)`，`ctx.provide('workbench')`，sessionId 唯一来源 `exec.agent.session.id` |
| 复用边界 | `dsh-client-ui-schedule` 已有 `main` + `sidebar.panellist` 页面范式，但它管的是 **Host Schedule 提醒**，数据走 `ctx.schedule`；**本项目数据必须走 `ctx.workbench`**，故复用其 UI 骨架/样式/交互模式，不复用其数据层 |

## 1. Client Slots（`main` keyed slot / `sidebar.panellist`）

真源码 `dsh-client-ui-schedule/lib/client.js`：

```js
ctx.slots.inject("main", () => ctx.slots.register({
  name: "main",
  key: PANEL_ID,            // ← keyed slot：不覆盖 Conversation
  locale: MANAGER_NS,
  inject: () => ({ ... })
}, TaskManagerPage));                                    // :7473-7483

ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
  name: "sidebar.panellist",
  id: PANEL_ID,
  order: 10,
  locale: MANAGER_NS,
  label: () => t("panel")
}, TaskManagerIcon));                                    // :7484-7490
```

- `main` 由 `dsh-client-ui-layout/lib/client.js:119` 以
  `renderSlot("main", {}, { entryKey: activePanelId ?? "conversation" })` 渲染 →
  **keyed**：我们的 `key` 与 `conversation` 并存，**不覆盖现有 Conversation 页**（授权硬要求）。
- `sidebar.panellist` 由 `dsh-client-ui-sidebar/lib/client.js:226` 渲染，
  `:568` `entriesOfSlot("sidebar.panellist")` 同步面板，`:583` `subscribe` 生命周期。
- 注册范式：`ctx.slots.inject(ownerKey, () => ctx.slots.register({...}, Component))`
  （`practices.md:36`）；`inject` 回调的注册在 owning declaration 折叠时自动 dispose。

## 2. Theme Tokens（`--dsw-alias-*`）

`dsh-client-ui-schedule/lib/client.js:1784,2107,2433` 实际使用的令牌（**只抄这些，不臆造**）：

```
--dsw-alias-label-primary
--dsw-alias-label-secondary
--dsw-alias-label-tertiary
--dsw-alias-interactive-bg-hover
--dsw-alias-border-l1
--dsw-alias-scrollbar-bg-l2
--dsw-alias-scrollbar-hover-l2
--dsw-alias-state-warn-tertiary
--dsw-alias-state-warn-label
--dsw-alias-state-business-primary
```

`practices.md:34`：**只用 theme tokens，字面颜色仅用于 artwork**；
token 改名只会降级外观、不会破坏渲染。浅色/深色由宿主自动切换，插件不写死颜色。

> ⚠️ Client `Theme.listTokens` / `Slots.listSubTree` / `Builtin.listBuiltins`
> 在本会话对合法 `{}` 均返回 `"input" must be an object`——**Client Inspect 通道不可用**。
> 因此令牌清单取自上述真源码，而非 live inspection；这一限制写入风险清单。

## 3. Remote 调用（UI → Host）

`dsh-typert-protocol/README.md` + `lib/index.js:326-410`：

- Host 方法用 `@Remote` 标记，Service 继承 `TypertRemoteService`（或 `bindTypertRemote`）；
  生成器产出 `./remote` 描述符，Gateway 与 Client `ctx.remote` 共用。
- Client 侧真用法（`dsh-client-ui-agent-preset/lib/client.js:1095,1112,2084`）：
  `await ctx.remote.agentPresets.list()` / `.select(...)`；
  事件 `ctx.remote.$on("settings/document-updated", ...)`（`:2374`）。
- `RemoteError` 携带稳定 `<domain>/<reason>` code；`signal: AbortSignal` 为末参时协作取消。
- `resources` 选项声明访问的资源（`session` 等），访问控制由 `dsh-api-remote-access` 决定。

`user-actions.md`（技能）给出的**另一条真路径**：
> UI action 通过「Client-callable Host entry point」调用，例如
> `ctx.remote.commands.execute()` 运行的 session command；
> 同一操作再由 agent tool 暴露，**不得在 UI 与 tool 各写一套逻辑**。

⚠️ **未确认**：独立工作区 bundle 能否不经过 Typert 生成器就注册自定义
`ctx.remote.workbench.*` 命名空间。若不能，采用 `commands.execute` 路径或
Host 侧事件转发。此项在实现前用真包实测，不臆造。

## 4. 生命周期（技能 references 硬约束）

- `index.js` 导出 `export function apply(ctx, config) {}`；
  `cordis.patch.yml` 用 `- insert: [{ id, name: '@local/...' }]`
  （模板 `templates/decoration/cordis.patch.yml`）。
- `package.json` 需 `dsh.client = {platform:'web', immediately:true, inject:[...]}`
  + `exports: {"./client":"./client.js", "./locale/*.json":..., "./icon":...}`
  （模板 `package.json`）。
- Client 模块用 `window.__ModuleLoader__.load({ id: <包名>, factory(require){...} })`，
  React 从 `require('react')` 取（**不装第二份 React、不用 CDN/UMD**）
  （模板 `client.js`）。
- 资源（样式、timer、listener）在 `apply` 内用 `ctx.effect`/`ctx.on` 注册并返回清理；
  factory 无副作用（`ui-plugin.md:13`）。
- **不许** iframe / 不许 `require('@deepseek-ai/dsh-client-ui-primitives')` /
  不许写 DOM 到 `document.body` / 不许读别的插件 DOM（`practices.md:33,35`、`ui-plugin.md:13`）。
- UI 文本走 Client locale service；`locale/en.json` + `locale/zh.json` 写
  `meta.title` / `meta.description`，图标原创且 ≤256KiB（`host-plugin.md:29-51`）。
- 安装走 `plugin_manager install_bundle`；**不手改 profile 的
  `package.json` / `cordis.patch.yml`**（`cordis-plugin-development` 技能 + 用户红线）。

## 5. 验证边界（`references/verification.md`）

> 「Prefer the authenticated page already connected to Harness. Do not launch a
> separate browser from shell commands ... A screenshot of a mock page is not
> verification of the running plugin.」

- 没有浏览器控制时：**视觉验证不可得，必须如实报告**；
  只做 JS 语法、manifest、live Client slot、样式只用 token、无 Client 包 import、
  无 slot crash 的静态/运行时检查。
- **不得**找 rasterizer / Quick Look / 模拟 React-DOM / 自定义渲染器补截图。
- 用户要「深浅色截图」→ 若 Client 通道不可用，列为**未取得**，不造假。

## 6. 删除审批（真 Host）

`dsh-client-ui-schedule/README.md`：删除前要求确认，且「Every deletion path
reports its settled outcome into one store that `shell.overlay` notice renders」。
本项目删除走 WP3 的 `askApproval(op, detail, agent)` → 真 `ApprovalService`
（`allowed-once` → token），再 `invoke(..., {approvalToken})`；
**不用 `confirmed:true` 布尔**。

## 复核命令

```bash
FULL=/tmp/dsh-asar-full/dsh/node_modules/@deepseek-ai
sed -n '7473,7490p' $FULL/dsh-client-ui-schedule/lib/client.js
sed -n '115,122p' $FULL/dsh-client-ui-layout/lib/client.js
grep -o -- '--dsw-alias-[a-z0-9-]*' $FULL/dsh-client-ui-schedule/lib/client.js | sort -u
sed -n '355,410p' $FULL/dsh-typert-protocol/lib/index.js
```
