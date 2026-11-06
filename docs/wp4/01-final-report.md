# WP4 最终报告：可视化工作台

**基准**：`aadaba0` → **最终冻结** 见本文件末尾 Git hash
**结论**：WP4 功能完成；Host 半边已在**真实 DSH 隔离环境**加载验证；
Client 视觉验证 **UNVERIFIED**（原因见 §5）；按授权 **STOP，不进入 WP5**。

---

## 一、开发前检查

| 项 | 结果 |
| --- | --- |
| Git | `aadaba0` HEAD、dirty=0、0 remote |
| WP3 报告 | `docs/wp3/04-final-report.md`：APPROVE WITH NITS、0 blocker、4 条 nit |
| 4 条 nit | ①审批词汇合并 ②named-scope token 域 ③restore/upsert 不在 requireConfirmation ④displayReason 已删；均**未阻断**，本包未改 WP3 核心 |
| Host Service 契约 | `ctx.provide('workbench')` + `invoke(sessionId,op,payload,meta)`；sessionId 唯一来源 `exec.agent.session.id` |
| 真实 DSH 契约 | `docs/wp4/00-contract.md`（带一手源码行号） |
| 复用 | `dsh-client-ui-schedule` 的 `main` keyed slot / `sidebar.panellist` / `--dsw-alias-*` / query lifecycle 范式；**数据层不复用**（它走 `ctx.schedule` 提醒，我们走 `ctx.workbench`） |

### 核实的真实契约（摘要）
- `main` 是 **keyed** slot：`dsh-client-ui-layout:119` 用 `entryKey = activePanelId ?? "conversation"` 渲染；我们的 `key='workbench'` 与 conversation 并存，**不覆盖**。
- `sidebar.panellist`：`dsh-client-ui-sidebar:226,568,583` 渲染/同步/订阅。
- `--dsw-alias-*` 令牌取自 `dsh-client-ui-schedule` 实际使用集合，**未臆造**。
- Remote：Typert `collectSrcClaims` 需要 `@Remote` 生成器元数据，独立 bundle 不能凭空造 `ctx.remote.workbench.*` → 采用**真** `ctx.commands.register` + `ctx.remote.commands.execute(sessionId,line,attachments)`（`dsh-commands:327-395`、`dsh-client-ui-commands:1718`），handler 调 `ctx.workbench.invoke(...)`，与 AI 工具**同一个方法**（`references/user-actions.md:7-11`）。
- 生命周期：`window.__ModuleLoader__.load` factory、`React` 从 `require('react')`、`ctx.effect` 清理、locale + 原创图标、不 iframe / 不 require Client primitives / 不写 `document.body`。

## 二、交付（每个工作包独立 Commit）

| commit | 内容 |
| --- | --- |
| `7e55e95` | WP4-0 前置检查 + 真实契约文档 |
| `1892a28` | WP4-1/2 插件骨架 + Client→Host→Storage 数据桥 |
| `06cd184` | WP4-2b 隔离 boot 修复（approval inject）+ 加载证据 |
| `1366d2a` | WP4-3/4 冲突/重复/子任务/AI 会话关联 |
| `07c3b9d` | WP4-5 UI 规范机器可校验测试 + 4px 网格修正 |

### 插件位置
`packages/workbench-ui/`：`index.js`(Host) / `client.js`(Client) / `cordis.patch.yml` /
`package.json` / `locale/{en,zh}.json` / `icon.svg`。

### 功能对照（授权 §二）

| 要求 | 实现 | 数据来源 |
| --- | --- | --- |
| 月/周/日/议程视图 | ✅ 四视图 + 上/下/今天导航 | `event.list` |
| 创建/编辑/删除独立 Event | ✅ 表单 + 确认删除 | `event.create/update/delete` |
| 全天事件、重复事件展示 | ✅ allDay 表单、recurrence 规则 + 近 7 天出现次数 | `event.expand` |
| 日程冲突提示 | ✅ 冲突徽章 + 顶部冲突条 | `event.conflicts`（真实 `findConflicts`） |
| 今日及未来七天概览 | ✅ 独立 section | `event.list` + 客户端窗口过滤 |
| 今日/计划中/进行中/已完成 | ✅ 四 bucket | `task.list` |
| 任务列表、优先级、截止日期 | ✅ | `task.upsert` |
| 任务详情、子任务展示 | ✅ 详情面板 + 子任务列表 | `task.list` |
| 快速创建及编辑 | ✅ `+ New` / 行内编辑 | `event.*` / `task.upsert` |
| 与现有 AI Agent 会话关联 | ✅ 同一 `sessionId` 的同一 Host Service；详情显示关联说明 | `ctx.workbench.invoke` |
| 搜索与筛选 | ✅ 文本搜索 + 视图/桶筛选 + Ctrl/Cmd+K | Host 数据本地过滤 |
| 任务和日程详情面板 | ✅ 右侧面板 | `event.get` / 列表数据 |
| 加载/成功/失败状态 | ✅ StatusBar + Retry + 明确错误 | 命令返回 |
| 删除使用真实 Host 审批 | ✅ `requestApproval` → token → delete；**不读 `confirmed:true`** | `service.askApproval` |
| 所有数据来自 Host Service | ✅ 无 mock/假数据（静态测试锁定） | `ctx.remote.commands.execute` |

> **真实业务规则发现**：`event.create` 自身会拒绝时间冲突（`conflict`），
> 因此「冲突」的真实来源是**编辑已有事件**或导入；测试据此用 `event.update`
> 制造冲突再查 `event.conflicts`，而非假造两条重叠创建。

## 三、必须打通的真实流程（授权 §四）

| # | 流程 | 证据 |
| --- | --- | --- |
| 1 | 从 DSH 侧栏打开工作台 | `sidebar.panellist` 注册（静态核查 + 真配置 compose）；**实际点击 UNVERIFIED** |
| 2 | 创建日程保存到真实 Host | bridge 测试：create → 磁盘 `.json` 落盘 |
| 3 | 重新加载后恢复 | bridge 测试：全新 Host Context 读同一 rootDir，数据读回 |
| 4 | 编辑后检查持久化 | bridge 测试：update → get 返回新 title/location |
| 5 | 创建并完成待办 | bridge 测试：upsert ×2 → list 显示 done=true |
| 6 | AI Agent 创建日程，UI 看到同一数据 | 双向一致性测试：UI create → `svc.invoke('event.list')` 看到 |
| 7 | UI 修改后 AI 工具可查到 | 双向一致性测试：`svc.invoke('event.update')` → UI list 看到新值 |
| 8 | 删除经过可信审批 | bridge 测试：无 token → `confirmation-required`；`requestApproval` 无 answerer → fail-closed；WP3 真 `ApprovalService` 端到端 2/2 |
| 9 | 错误明确、不静默 | bridge 测试：未知 op → `unsupported`；StatusBar `role=alert` + Retry |

**测试覆盖真实 Client→Host→Storage 路径**：`test/workbench-ui-bridge.test.mjs`（17 项）用
`dsh-commands` 的真实 `parseCommand` / `invocation` 形状构造请求，跑**真实**
`apply()` + 真实文件存储，断言落盘与读回；**不是只测模拟接口**。
（浏览器网络层 `ctx.remote.commands.execute` 本身无浏览器控制，未端到端跑，见 §5。）

## 四、UI 设计规范（授权 §三）

| 要求 | 实现 / 静态核查 |
| --- | --- |
| `main` keyed slot | ✅ `key:'workbench'`，测试断言不占 `conversation` |
| `sidebar.panellist` | ✅ `id/order/locale/label` |
| 不覆盖 Conversation | ✅ keyed 共存 |
| `--dsw-alias-*` 令牌 | ✅ 静态测试：无硬编码颜色、≥8 个真实令牌 |
| 浅/深色 | ✅ 由宿主 token 切换；**实际截图 UNVERIFIED** |
| 4/8 倍数间距 | ✅ 静态测试逐值校验，修掉两处 2px |
| 正文 16px / 标题 20–28px | ✅ 静态测试 |
| 点击区 ≥44×44px | ✅ `min-height/min-width:44px` |
| 键盘/焦点/可访问性 | ✅ focus-visible、tablist/alert/status/dialog、aria-label、Ctrl/Cmd+K、effect 内监听清理 |
| Mac 窗口缩放 | ✅ flex + `@media (max-width:800px)` 侧栏下移；**实际缩放 UNVERIFIED** |
| 紧凑、不过度装饰 | ✅ 无插图/无动效，令牌配色 |

静态核查：`test/workbench-ui-standards.test.mjs` **9/9**（扫描去注释代码，避免文档文字误伤）。

## 五、验证结果与边界（授权 §六）

| 项 | 结果 |
| --- | --- |
| **真实 DSH 隔离环境加载** | ✅ `DSH_HOME=/tmp/dsh-iso-Jv2UeM`（rescue profile），`dsh plugin add` 以 link 安装（53ms，无构建脚本）；`--patch` 覆盖 `rootDir` 到隔离目录；有界 boot 12s：**修复后零错误、零 "did not activate"、Web 服务起在独立端口 127.0.0.1:50981**。证据 `evidence/wp4/01-03` |
| **UI ↔ Host 双向一致性** | ✅ 21/21 bridge + 渲染测试（含真 Remote 信封、main inject 形状、软删过滤与审批、**组件渲染不抛异常**）+ 真落盘/重启恢复 |
| 日历与待办功能 | ✅ 上表逐项 + 静态规范 9/9 |
| **深浅色截图** | ❌ **未取得（UNVERIFIED）** |
| **窗口缩放与交互实际检查** | ❌ **未取得（UNVERIFIED）** |
| 键盘及可访问性基础验证 | ⚠️ 静态核查通过；**真实键盘操作未测（UNVERIFIED）** |
| 既有测试回归 | ✅ **271/271** 单测、**46/46** 变异（0 真空 0 跳过）、门禁 **8/8** |
| 独立代码及视觉 Review | 见 §8 |

### 为什么没有截图（必须说清，不造假）
`references/verification.md` 明确：
> 「Do not launch a separate browser from shell commands … A screenshot of a
> mock page is not verification of the running plugin.」

本会话 **Client Inspect Provider**（`Slots.listSubTree` / `Theme.listTokens` /
`Builtin.listBuiltins`）对合法 `{}` 一律返回 `"input" must be an object`，
即 Client 通道不可用。按技能规则，此时视觉验证不可得，且**禁止**找 rasterizer、
Quick Look、模拟 React-DOM 或另起浏览器补截图。
→ 深浅色截图、真实点击、窗口缩放列为 **UNVERIFIED**，**不提交伪造截图**。

## 六、红线核查

| 红线 | 结果 |
| --- | --- |
| 不修改正式 DSH profile | ✅ `~/.dsh/profiles/desktop/package.json` mtime 仍 `Nov 5 21:32:55`、`cordis.patch.yml` 无 `workbench-ui` 行；所有安装/启动都在 `DSH_HOME=/tmp/dsh-iso-Jv2UeM` |
| 不修改现有用户数据 | ✅ `rootDir` 为空时插件**拒绝启动**；隔离测试用 `/tmp` 目录 |
| 不触碰其他项目 | ✅ 鲸鱼娘 `79d7e24` dirty 0 |
| 不擅自 push | ✅ 0 remote |
| 不进入 WP5 | ✅ **STOP** |
| 不用模拟接口冒充真实宿主 | ✅ WP3 业务层零依赖 + 真 commands 路径 + 真文件存储；bridge 测试明确标注「浏览器网络层未端到端」 |
| 真实 macOS 通知/休眠验收 | ✅ 仍 **UNVERIFIED**，未标记完成 |

## 七、风险与未验证清单

| 项 | 级别 | 说明 |
| --- | --- | --- |
| Client 浏览器渲染 / 深浅色截图 / 真实点击 / 窗口缩放 | **UNVERIFIED** | Client Inspect 不可用；按 verification.md 不伪造 |
| `ctx.remote.commands.execute` 浏览器网络层 | **UNVERIFIED** | Host 半边真激活、命令契约真、数据真落盘；浏览器→Host 的 WebSocket/RPC 未端到端跑 |
| 独立视觉 Review | 见 §8 | 无浏览器控制时只能做静态视觉核查 |
| 4 条 WP3 nit | 已登记 | 不阻断；本包未改 WP3 核心 |
| O(N²)/线性但常数大对账性能 | UNRESOLVED | `docs/wp3/01-on2-registry.md`，真实 Host 未测，实现未改 |
| 真实 macOS 休眠/唤醒/重启、系统通知 | UNVERIFIED | 按授权保留至后续工作包 |
| 真实投递回执 / exactly-once / 多进程并发 | UNVERIFIED | WP2 起保留 |
| `event.conflicts` 窗口 | 设计 | UI 用「今天起 7 天」固定窗口，未做成用户可选（授权未要求） |
| 子任务创建 | 设计 | 授权只要求「子任务展示」；Host `task.upsert` 存任意字段，UI 展示但不提供子任务编辑（不属本包范围） |

## 八、独立 Review（四轮）

| 轮次 | 基准 | 结论 | 处理 |
| --- | --- | --- | --- |
| 1 | `1a2c7ef` | 🔴 REQUEST CHANGES（5 blocker） | 全部修复 → `836ce52` |
| 2 | `836ce52` | 🔴 REQUEST CHANGES（1 MAJOR + 4 MINOR） | 全部修复 → `24ba56b` |
| 3 | `548be95` | 🔴 REQUEST CHANGES（1 blocker + 1 MAJOR） | 全部修复 → `bf1c657` |
| 4 | `bf1c657` | 见 `evidence/wp4/final-review/REVIEW-round4.md` | — |

### 三轮抓到的实质缺陷（不粉饰）

- **第 1 轮 5 blocker**：真 Remote 信封解码（`result.value` 是对象不是文本，真浏览器里 UI 静默空列表）；
  `main` 是 root-scope keyed slot，inject **零参**（拿不到 sessionId）；
  调用了不存在的 `task.delete`；`approval.request` 裸传丢 `this`；`TaskForm` 编辑丢字段。
- **第 2 轮 MAJOR**：软删待办**仍出现在列表**且**绕过审批**（`task.list` 不过滤、`task.upsert` 不调 `requireConfirmation`、token 可伪造）。
  4 MINOR：测试用复刻实现（真 bug 复活仍全绿）、变异对 UI 零覆盖、报告数字过期、locale 未接。
- **第 3 轮 blocker**：**我自己在第 3 轮接线 locale 时引入的回归**——`t` 只定义在 `WorkbenchPage` 内部，
  而 `EventForm`/`TaskForm`/`ConfirmDelete` 是工厂作用域的兄弟函数 → 渲染即
  `ReferenceError` → **整个工作台白屏**。同轮 MAJOR：没有任何测试渲染组件，
  267 条全绿也测不出这个必崩缺陷。

**共同教训**：前三轮抓到的两个「必崩」缺陷，静态断言全都测不出
（`require('./x')` 相对路径在浏览器模块表里不存在；`t` 越出作用域）。
**「源码长什么样」全绿 ≠ 「跑起来对不对」**。
第 3 轮起补了**真实执行工厂 + 真实调用组件**的渲染测试，
并用变异验证：退回旧写法即变红、还原即全绿。

第 1 轮 5 个 blocker：真 Remote 信封解码、main root-scope inject 零参、
不存在的 `task.delete`、approval.request 丢 `this`、TaskForm 编辑丢字段。
第 2 轮 MAJOR：软删待办仍显示且绕过审批（已修：服务层过滤 + 仅软删需审批 +
审批指纹 op 对齐 + UI 过滤）；4 个 MINOR：测试改用真实现（抽出
`host-call.mjs` 供浏览器与测试共用）、变异覆盖 WP4 UI 文件（新增 W1–W7，
其中 4 个立刻暴露了此前无测试的行为）、报告数字更新、locale 未接（保留为 nit）。

完整响应见 `evidence/wp4/06-review-response.md`，复审结论见
`evidence/wp4/final-review/`。审查期间被审版本未改（冻结纪律）。

---

**WP4 完成。STOP，未进入 WP5。**
