# WP3 收口报告

**最终冻结**：`280e073`（831 文件，`git archive` 副本逐字节一致）
**结论**：WP3 功能完成；**独立 Review 结论 APPROVE WITH NITS（0 blocker）**；按授权 **STOP，不进入 WP4**。

---

## 一、前置检查（授权第 1–4 条）

| 项 | 结果 |
| --- | --- |
| `368207b..d6cc887` 完整 diff | 37 文件；仅 `workbench-core/src/host-map.js` 是业务/持久化改动，其余为文档/证据/测试/变异定义 → `evidence/wp3/precheck/01-diff-classification.md` |
| 增量独立 Review | 三路（冻结 `d6cc887` 的 Agent、实时 `c12d377` 的重派 Agent、结构化 workflow）**全部 APPROVE，0 blocker** → `02` / `03` 文件 |
| WP2 状态 | **条件验收完成**，全部 UNVERIFIED 保留 → `docs/wp3/02-wp2-conditional-acceptance.md` |

一处如实纠正：我曾据早期探针把「load/prune 不置脏」判为缺陷，冻结副本 + 基线对照证明那**是探针期望错误**（既有契约、生产路径不可达）。`c12d377` 属额外加固，不计入通过条件。

## 二、WP3 交付（每个工作包独立 Commit）

| commit | 内容 |
| --- | --- |
| `4d5c403` | 前置检查证据、DSH 真实契约文档、O(N²) 登记 + 基准 |
| `c12d377` | 增量 Review 后的额外加固 |
| `1e04015` | WP2 条件验收记录 |
| `fdee9be` | **Host Service 适配**（`ctx.provide('workbench')`、sessionId/scope 目录隔离、统一门面、审计） |
| `b543ed3` | **AI 工具注册**（真 `defineTool` / `ctx.tools.register`，参数校验、稳定错误） |
| `945c6af` | 契约对齐（`{id,patch}` / `{task}`）、`help`/`audit` 工具、自然语言映射文档 |
| `f89a311` | 门禁证据刷新（第一次冻结） |
| `17f79e8` | 修两个真 BLOCKER（oneOf 重叠、审批适配器） |
| `d3c79d5` | 修并发 agent 串味（AsyncLocalStorage） |
| `280e073` | 真 ApprovalService 端到端测试入库、删臆造字段、修文档 nit（最终冻结） |

### 实现要点

- **Event/Task Host Service**：`applyWorkbenchHostService(ctx, config)` 用真 `ctx.provide` 挂载；`forSession(sessionId, scope)` 让 UI 与 Agent 拿**同一个** `createWorkbenchService` 门面。
- **`ctx.tools.register`**：8 个工具（`workbench_event_*` / `workbench_task_*` / `workbench_help` / `workbench_audit`），真 `defineTool` 编译 8/8、真 `ToolArgsError` 拦缺参。危险 op 不注册。
- **统一业务方法**：`invoke(sessionId, op, payload, meta)` 是唯一入口，不重造第二套状态机。
- **自然语言操作**：靠 DSH 真实机制（schema 自动进 system prompt，由模型映射），**不内置 NLP 解析器**；`workbench_help` 列工具与参数供对齐。
- **Host 可信审批**：真 `ApprovalService` 的 `toolName` / `req.agent.session` / `allowed-once` 词汇对齐，open turn 内签发 token；`args.confirmed` 永不采信。
- **会话隔离**：sessionId 唯一来源 `exec.agent.session.id`；session + scope 各自独立 sha256 目录；审计按 session 过滤。
- **错误反馈**：白名单业务码 + 稳定 `{ok:false,code,message}`；真 `validateJsonSchemaValue` 0 violations。

## 三、四类结果（分别报告）

| 类别 | 结果 |
| --- | --- |
| **真实 Host** | ✅ 真 `dsh-tools` 的 `defineTool` 编译 8/8 并执行；真 `dsh-user-approval` 的 `ApprovalService` + open-turn session + 真 answerer 端到端签发 token（仓库内 `test/host-approval-real.test.mjs`，非 /tmp 散落证据）；真 `storageDomain` 落盘/重启/5 次去重（`scripts/probes/p1-real-storage-domain.mjs`）。⚠️ **完整 Host 运行时（fiber/effect 生命周期、GUI 装配）未端到端启动** |
| **模拟环境** | ✅ **240/240** 单测（0 skipped）、**36/36** 变异（0 真空 0 跳过）、**8/8** 门禁、26/26 验收；真 `validateJsonSchemaValue` 对成功/错误值 0 violations；5 路并发 agent 隔离 PASS |
| **macOS 系统级** | ❌ **UNVERIFIED** —— 真实休眠/唤醒/退出/重启、系统通知是否弹出，**完全未测试** |
| **独立 Review** | ✅ 两轮 + 前置增量共取得明确结论：前置增量三路 APPROVE；WP3 第一轮 `f89a311` 结论冲突（Agent APPROVE WITH NITS / workflow REQUEST CHANGES 2 BLOCKER）；按 workflow 复现并修复；`17f79e8` 轮次 Agent 判 REQUEST CHANGES（`activeAgent is not defined`）；**最终 `d3c79d5` 结构化复核 APPROVE WITH NITS、0 blocker**；本轮又按两轮批评补齐真 ApprovalService 端到端测试 |

## 四、Review 发现与修复（不掩盖）

| 轮次 | 指认 | 处理 |
| --- | --- | --- |
| workflow（第一轮） | **BLOCKER-1** `OUTPUT_SCHEMA` 的 oneOf 重叠 → 真 ToolRuntime 把业务错误变 ToolOutputError | 用 `ok:true`/`ok:false` const 互斥；真 validator 复验 0 violations |
| workflow（第一轮） | **BLOCKER-2** 审批适配器用不存在的 `tool` 字段、缺 `req.agent`、假定 `'approved'` | `toolName` + 运行时 agent + `allowed-once`→`approved` 映射 |
| 主会话自查 | 修复引入**并发 agent 串味**（模块级可变状态） | 改 `AsyncLocalStorage`，5 并发实测 A/B/C/D/E 无串味 |
| Agent 450c2967（第二轮，`17f79e8`） | **BLOCKER** `activeAgent is not defined`，真 request 调用 0 次 | 该缺陷正是 ALS 重构修掉的；**用同一探针只改路径指向 `d3c79d5` → approved + 真 request 1 次 + token**，实锤修复 |
| 两轮共同批评 | B2 守卫只是静态 grep，真端到端证据散落 /tmp | 新增 `test/host-approval-real.test.mjs`（真 asar 包，2/2） |
| 第二轮 nit | `displayReason` 是臆造字段（真源码不读） | 删除，并在 `00-contract.md` 注明 |
| 第二轮 nit | 文档 233/233 陈旧 | 更正为 240/240 |

**未采纳的误报**：第二轮 Agent 称「activeAgent 是模块级可变状态」——它自己也诚实修正为「函数内局部、兄弟函数作用域引用」。以真探针为准。

## 五、残留 NITS（不阻断，登记不改）

1. `rejected`/`cancelled`/`unavailable` 一律映射为 `denied`，丢失区分（模型不注册危险 op、全 fail-closed，无旁路）。
2. `askApproval` 用默认 scope 的 gate 签 token，`invoke(meta.scope)` 用 named-scope 域 → 跨域 `unknown-token`（fail-closed，无越权；AI 工具面恒默认域）。
3. `event.restore`/`task.upsert` 在 `DANGEROUS_OPS` 但 handler 不调 `requireConfirmation`（WP2 既有，`deny` 由 `WRITE_OPS` 兜住）。
4. `displayReason` 已从适配器删除；`dsh-tools` 的 `serviceAsk` 层仍可能传，但真 `ApprovalService` 忽略。

## 六、UNVERIFIED 清单（全部保留）

| 项 | 原因 |
| --- | --- |
| 真实宿主投递回执不可读 | 无对应工具；**不宣称 exactly-once** |
| 真实 macOS 休眠 / 唤醒 / 退出 / 重启 | **完全未测试** |
| 系统通知是否真正弹出 | 未验证 |
| 多进程并发写 | 文件存储非多进程安全；`hostMap` 无跨进程锁 |
| 真实 Host 的 fiber/effect 生命周期 / GUI 装配 | 探针用真组件但宿主生命周期简化构造 |
| **O(N²) / 线性但常数大的对账性能** | **UNRESOLVED**，见 `docs/wp3/01-on2-registry.md`；模拟环境实测线性、真实 Host 未测、实现未改动，**未宣称已解决** |

## 七、红线

| 红线 | 结果 |
| --- | --- |
| 不改正式 DSH profile | ✅ 本次工作零写入 `~/.dsh/profiles`（早前 17 项改动来自 GUI 自身插件操作，非本仓库） |
| 不碰用户数据 | ✅ `dataDir` 全部在 `/tmp` 或调用方显式传入 |
| 不碰其他项目 | ✅ 鲸鱼娘 `79d7e24` dirty 0 |
| 不 push | ✅ 0 remote |
| 不擅自进入 WP4 | ✅ **STOP** |
| 不使用模拟接口冒充真实宿主 | ✅ WP3 新增测试 0 引用 `contract-stub`；真 defineTool / 真 ApprovalService 均加载真 asar 包，缺失则明确 SKIP |

## 八、复核命令

```bash
cd /Users/sylas/Developer/dsh-workbench
git log --oneline d6cc887..280e073
cd workbench-core && node --test test/*.test.mjs            # 240/240
cd .. && node scripts/r3-mutate.mjs /tmp/mut.log           # 36/36
bash scripts/wp2-r5-gate.sh                                # 8/8
node workbench-core/test/host-approval-real.test.mjs 2>/dev/null || true
ls evidence/wp3/final-review/                              # 两轮独立 Review 结论
cat docs/wp3/01-on2-registry.md                            # O(N²) UNRESOLVED
```

---

**WP3 完成。STOP，未进入 WP4。**
