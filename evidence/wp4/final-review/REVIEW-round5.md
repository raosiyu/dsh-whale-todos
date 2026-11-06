# WP4 第五轮（终审）独立复审

- 审查对象：`<repo>`，冻结 commit `9596b30`
- 导出副本：`/tmp/wp4r5/`
- 探针目录：`/tmp/wp4r5/probe/`
- 状态：**进行中**

> 本文件按检查项逐条追加。每条包含：检查名 / 命令 / 实际输出 / 判定。

---
## 1. 冻结纪律（检查名：freeze-discipline）

**命令**
```
$ cd <repo> && git rev-parse HEAD
9596b30b5db02c69055692a23c87637db4335dce
$ git archive 9596b30 | tar -x -C /tmp/wp4r5/export
$ git ls-files -z | wc -l                       → 859
$ find /tmp/wp4r5/export -type f | wc -l        → 859
$ git ls-files -z | while read f; do cmp -s "$f" "/tmp/wp4r5/export/$f" || echo "DIFF: $f"; done
DIFF: upstream/dely0-v1.17.2/docs/releases/v1.16.4.md
DIFF: upstream/dely0-v1.17.2/test/routes.test.mjs
```

**实际输出**（差异归因）
```
$ for f in <上面两个>; do git rev-parse "HEAD:$f"; git hash-object "/tmp/wp4r5/export/$f"; file "$f" "/tmp/wp4r5/export/$f"; done
b3bdfc564b36dea5721a6ceafea531b328cae6e7
b3bdfc564b36dea5721a6ceafea531b328cae6e7
.../v1.16.4.md: Unicode text, UTF-8 text, with very long lines (526), with CRLF line terminators
.../v1.16.4.md: Unicode text, UTF-8 text, with very long lines (526)          ← 导出副本是 LF
d22440843478a29db29cbb98a0016aa8e20d0232
d22440843478a29db29cbb98a0016aa8e20d0232
.../routes.test.mjs: Unicode text, UTF-8 text, with CRLF line terminators
.../routes.test.mjs: Unicode text, UTF-8 text                                  ← 导出副本是 LF

$ git diff HEAD --stat -- <那两个文件>       → 空（git 视二者与 HEAD 一致）
$ git config --get core.autocrlf              → input
$ ls .gitattributes                           → 不存在
```

**被审代码树（排除 upstream/ 第三方 vendored 目录）逐字节比对**
```
$ git ls-files -z | grep -v '^upstream/' | while read f; do cmp -s ... || echo DIFF; done
=== non-upstream compared=226 mismatches=0 ===
```

**HEAD 开始 / 结束**
- 开始：`9596b30b5db02c69055692a23c87637db4335dce`
- 结束（本次记录时）：`9596b30b5db02c69055692a23c87637db4335dce`（HEAD 未漂移）
- 工作树改动仅 2 个 **untracked** 新文件，非本审查产生的源码改动：
  ```
  $ git status --porcelain
  ?? evidence/wp4/12-isolated-boot-round4-fixes.log
  ?? evidence/wp4/final-review/REVIEW-round5.md      ← 本文件
  ```
  注：`12-isolated-boot-round4-fixes.log` 在开工前即存在（我开工时第一次 `git status` 已列出），
  不是被审 commit 的一部分，也不影响被审代码树。

**判定：通过**。导出副本与 `9596b30` 逐字节一致（唯一 2 处差异是 `core.autocrlf=input` 导致
`git archive` 规范化 CRLF→LF 的**第三方 upstream 目录**文本文件，与被审代码无关，且 git blob hash 相同）。
被审的 226 个非 upstream 文件全部逐字节相同。主仓库未被本轮修改。

---

## 2. 第四轮 BLOCKER-4 的根因属实（检查名：blocker4-root-cause）

**命令**
```
$ node /tmp/wp4r5/probe/r5-02-real-approval.mjs
```
（探针用**真** `/tmp/dsh-asar-full/dsh/node_modules/@deepseek-ai/cordis` 的 `Context` +
**真** `@deepseek-ai/dsh-user-approval` 的 `ApprovalService`；session 事件流为
`[{type:'turn/start'},{type:'turn/end'}]`，即**回合已闭合**。）

**实际输出**
```
PASS  1.1 turn 已闭合时真 approval.request 抛错（第四轮 BLOCKER-4 根因属实）
      threw=approval.request() outside an open turn: the approval/asked + approval/decided audit pair must be turn-enclosed (a bare event between turns is crash-tail garbage on reload). Ask from inside the turn that needs the decision.
PASS  1.2 回合外抛错发生在审计之前：waterfall 0 次、无 approval/asked 事件
      waterfallCalls=0 askedEvents=0
PASS  1.3 turn 打开时真 approval.request 返回 allowed-once（AI 侧路径成立）
      outcome=allowed-once waterfallCalls=1
```

**对照 DSH 一手源码**（不是 README 转述）
```
$ sed -n '128,132p' .../@deepseek-ai/dsh-user-approval/lib/index.js
	async request(req) {
		const session = req.agent.session;
		if (!hasOpenTurn(session)) throw new Error("approval.request() outside an open turn: ...");
```

**判定：通过**。第四轮 workflow 指出的 BLOCKER-4 根因**属实且精确**：真
`ApprovalService.request` 在回合闭合时于审计之前抛错，waterfall 0 次。
第四轮子 Agent 判「无 blocker」是错的。

---

## 3. UI 删除路径不再依赖 ctx.approval.request（检查名：ui-delete-path）

**命令**
```
$ node /tmp/wp4r5/probe/r5-02-real-approval.mjs   （第 2 段：回合闭合 + 注入真 ApprovalService）
```

**实际输出**
```
PASS  2.0 事件已创建
PASS  2.1 回合外 confirmUserAction 签发凭证成功
      {"ok":true,"value":{"approved":true,"token":"d75a1140...de2a9"},"op":"confirmUserAction"}
PASS  2.2 回合外删除成功、剩余 0 条
      del.ok=true remaining=0
PASS  2.3 DSH 审批 waterfall 在 UI 删除路径中被调用 0 次
      delta=0
```

**源码核对**（UI 侧已不再走 DSH 审批）
```
$ grep -n "confirmUserAction\|requestApproval\|approvalToken" packages/workbench-ui/client.js
663:      op: 'confirmUserAction',
680:      approvalToken: token,
683:      r = await request({ op: 'event.delete', payload: { id }, approvalToken: token })
```
`client.js` 全文**不再出现** `requestApproval`（原 `op: 'requestApproval'` 已移除）。

**判定：通过**。第四轮 BLOCKER-4 的「删除在真实浏览器里必然失败」已被本轮修复：
回合闭合时 UI 删除路径完全不经 DSH 审批（waterfall 0 次），删除成功、剩余 0 条。

---

## 4. AI 侧删除路径未被削弱（检查名：ai-path-intact）

**命令**
```
$ node /tmp/wp4r5/probe/r5-02-real-approval.mjs   （第 2.4/2.5 段 + 静态核对）
$ grep -n "confirmUserAction" workbench-core/src/host-tools.js → 无匹配
$ grep -n "confirmUserAction\|requestApproval" packages/workbench-ui/client.js → 只有 confirmUserAction
```

**实际输出**
```
PASS  2.4 AI 侧 requestApproval 在回合外拿不到 token（AI 路径未被削弱）
      result={"ok":false,"value":{"approved":false,"reason":"host-unavailable"},"op":"requestApproval"}
PASS  2.5 回合外 DSH 审批同样抛错 → waterfall 0 次
      delta=0
```
（`host-unavailable` 来自 `host-service.js:86`：agent 缺失时 fail-closed；回合外时
真 ApprovalService 抛错 → `hostRequest` catch → `'unavailable'` → gate 认 `denied`。）

**源码核对**：`host-tools.js` 全文**不含** `confirmUserAction`；AI 工具侧唯一的审批入口仍是
`service.requestApproval` → `gate.request` → 真 `ctx.approval.request`。

**判定：通过**。AI 侧删除路径未被改成 `confirmUserAction`，仍必须走真 `ApprovalService`。

---

## 5. 安全审查：confirmUserAction 通道（检查名：security-user-confirm）★ 本轮核心

### 5.1 任务书 2.a：浏览器能否未经用户点击直接调 confirmUserAction 拿到凭证？

**命令**
```
$ node /tmp/wp4r5/probe/r5-01-security.mjs        （对 9596b30）
$ node /tmp/wp4r5/probe/r5-03-mint-overreach.mjs   （对 9596b30）
$ node /tmp/wp4r5/probe/r5-04-model-reach.mjs
```

**实际输出（9596b30，冻结版本）**
```
===== A) 无用户交互直接调 confirmUserAction =====
PASS  A1 confirmUserAction 无用户交互即签发凭证
      {"ok":true,"value":{"approved":true,"token":"949a6000...2c8979"},"op":"confirmUserAction"}
PASS  A2 用该凭证可直接删除事件（=审批旁路成立）
PASS  A3 删除确实落盘（事件数减少）   remaining=0
===== E) DANGEROUS_OPS 语义 =====
PASS  E1 confirmUserAction 对**非危险 op**（event.create）也签发凭证
      {"approved":true,"token":"f54e1f49...3ddbad4"}
PASS  E2 为**根本不存在的 op** 也签发凭证
      {"approved":true,"token":"a64967a6...6e96e6ddf"}
```

**结论（这是本轮最重要的判定）**

**是的，能。** Host half 的 `confirmUserAction` 分支（`packages/workbench-ui/index.js:140-148`）
**不验证任何"用户真的点了"的事实**：

```js
if (op === 'confirmUserAction') {
  const target = payload.target ?? payload.id ?? ''
  const approval = service.forSession(sessionId).confirmUserAction(
    payload.approvalOp ?? 'event.delete',
    target,
    { digest: payload.digest, summary: payload.summary ?? `Confirm ${target}` },
  )
  return encodeResult({ ok: approval.approved === true, value: approval, op })
}
```

宿主只信任 `payload.approvalOp / target / digest` —— **这三个值全部由调用方提供**，
没有任何东西把这次调用和"用户点了确认按钮"绑定起来。`issueForUserConfirm` 也是
**无条件签发**（`approval-gate.js:155-159`，除了 `deny` 模式）：

```js
issueForUserConfirm(op, target, detail = {}) {
  if (mode === 'deny') return { approved: false, reason: 'approval-mode-deny' }
  const fingerprint = approvalFingerprint({ op, target, digest: detail.digest })
  return { approved: true, token: makeToken(fingerprint, 'user-confirm') }
}
```

**但——这构不构成 BLOCKER，取决于「谁能到达 commands 通道」。** 我做了可达性测绘：

```
$ for d in dsh-tool-*/; do grep -l "commands.execute\|remote.commands" $d/lib/*.js; done
（空 —— 没有任何模型侧工具能执行 slash command）

$ grep -rn "commands.execute(" --include=*.js <308 个 DSH 包>
dsh-api-session-controller/lib/client.js:2474      ← session.command(line)
dsh-api-session-controller/lib/types/client/sessions/session.js:293
dsh-client-ui-plan/lib/client.js:704               ← 客户端 UI
dsh-client-ui-commands/lib/client.js:1718          ← 客户端 UI（命令面板）
```

```
$ node /tmp/wp4r5/probe/r5-04-model-reach.mjs
PASS  V1 AI 工具路径调 op=confirmUserAction 被拒（不在 ops 表里）
      error=unsupported message=不支持的操作：confirmUserAction
PASS  V3 AI 工具清单里**没有**任何删除/审批工具
      names=workbench_event_list,workbench_event_get,workbench_task_list,workbench_event_create,
            workbench_event_update,workbench_task_upsert,workbench_help,workbench_audit
PASS  V5 host-tools.js 中 runTool 的 approvalToken 恒为 meta.approvalToken（默认 undefined）
PASS  V7 service 顶层不含 gate 对象（拿不到 gate 就不能自签）
      topKeys=askApproval,audit,describe,forSession,invoke,listOps
PASS  V6 forSession() 返回的对象**含** confirmUserAction（任意 host 插件可换凭证）
```

**判定**：**模型（AI）无法到达该通道** —— DSH 全量 308 个包里没有任何模型侧工具能执行
slash command；`confirmUserAction` 不在 `service.listOps()`（AI 工具面）里；
AI 工具的 `approvalToken` 恒为 `undefined`。
所以**这不构成「模型自批自放」的审批旁路**。

**但它确实构成「浏览器侧任意脚本可换取删除凭证」的通道**——这一点作者在
`docs/wp4/02-approval-model.md` §4 已如实登记为 **UNVERIFIED**（"纯软件无法区分
「用户点了确认」与「任意调用方直接索要凭证」"）。**诚实性上成立。**

### 5.2 任务书 2.b：凭证是否绑定 op 与 target？

**实际输出**
```
PASS  B1 凭证挪用到别的 target 被拒
      {"ok":false,"error":{"code":"confirmation-required","message":"...（原因：fingerprint-mismatch）..."}}
PASS  B2 凭证挪用到别的 op 被拒
      {"ok":false,"error":{"code":"confirmation-required","message":"危险操作 task.upsert ... fingerprint-mismatch"}}
```
**判定：通过**。`approvalFingerprint` 用长度前缀编码（`approval-gate.js:48-51`），
`verify()` 比对 `record.fingerprint !== expected` → `fingerprint-mismatch`。

### 5.3 任务书 2.c：是否一次性？

**实际输出**
```
PASS  C1 首次使用成功
PASS  C2 第二次使用被拒（一次性）
      {"ok":false,"error":{"code":"confirmation-required","message":"...（原因：unknown-token）..."}}
PASS  G1 过期凭证被拒（token-expired）    {"ok":false,"reason":"token-expired"}
```
**判定：通过**。`verify()` 命中即 `record.used = true; issued.delete(token)`；
TTL 默认 5 分钟，`ttlMs` 可配且实测生效。

### 5.4 任务书 2.d：payload 的 `confirmed` 布尔是否仍无授权含义？

**实际输出**
```
PASS  D1 confirmed:true 不构成授权（payload 内）
      {"ok":false,"error":{"code":"confirmation-required","message":"...（原因：missing-token）..."}}
PASS  D2 顶层 confirmed:true 不构成授权
      {"ok":false,"error":{"code":"confirmation-required","message":"...（原因：missing-token）..."}}
```
**判定：通过**。`requireConfirmation` 只读 `meta?.approvalToken`，从不读 `confirmed`。

### 5.5 凭证的 issuedBy 标记是否影响 verify？

**实际输出**
```
PASS  F1 verify() 不检查 issuedBy（host / isolated / user-confirm 同等对待）
      verify() 内是否出现 issuedBy: false
```
**判定：通过（无缺陷）**。`verify()` 只查 fingerprint / used / expiresAt；
`issuedBy` 仅作记录。`host` 与 `user-confirm` 凭证在验证层不可区分——这是**设计意图**
（同一套门），不是漏洞。`isolated` 模式在构造期就被拦住（`allowIsolated` 必传），
且 `issuedBy` 不参与 verify 意味着 isolated 凭证的语义风险不由此处引入。

### 5.6 ★ 新缺陷：调用方自选 digest / target → 凭证可挪用到「内容任意」的破坏性操作

**这是本轮我发现的最实质问题（`9596b30` 上成立）。**

`issueForUserConfirm(op, target, detail)` **直接采信调用方传入的 `detail.digest`**。
但 `service.js:117-125` 自己写明了既定规则：

> "内容摘要：**由服务层自己算**，绝不信任调用方传进来的 digest。…早期实现让调用方传
> digest（例如 `String(text.length)`）作为指纹的一部分，这是可绕过的…这里改为对
> **实际内容**取 SHA-256，调用方无法用长度之类弱信息冒充。"

`requestApproval` 遵守了这条（`detail.text` → 服务层算 `contentDigest`）；
**`issueForUserConfirm` 没有遵守** —— 它把 `detail.digest` 原样塞进指纹。

**复现命令**
```
$ node /tmp/wp4r5/probe/r5-03-mint-overreach.mjs
```

**实际输出（9596b30）**
```
===== A) confirmUserAction 自选 digest → 为 event.import 签发「内容匹配」凭证 =====
      attacker-computed digest = e6984e97f56e836f1010b70cf49be227c220795c4f83a75b1a9f729ffd105704
PASS  A1 宿主为 event.import 签发凭证（digest 由调用方自选）
      {"ok":true,"value":{"approved":true,"token":"d78c8519...ecd2029e"},"op":"confirmUserAction"}
PASS  A2 **该凭证成功导入任意 ICS**（无任何用户确认手势）
      import result={"ok":true,"value":{"imported":1,"events":[{"id":"def1e578-...","uid":"evil-1",
      "title":"Injected by anyone with the command channel",...
PASS  B1 用自选 digest 的凭证完成 snapshot.replace（全量覆盖）
      result={"ok":true,"value":{"replaced":{"events":1,"tasks":0},"backup":{...}},...
PASS  B2 覆盖后原有事件被清空     remaining=0
PASS  C1 用自选 target 的凭证完成 store.rollback
      result={"ok":true,"value":{"restored":"0009-pre-...json",...}}
PASS  D1 用自选 ids 集合的凭证完成 bulkDelete（一次删 3 条）
```

**分析**：这构成一条**「万能破坏性凭证」链**。调用方只要能到达 commands 通道，
就可以：
1. 自己算好目标内容的 SHA-256 当 `digest` 传给 `confirmUserAction`；
2. 拿到与该内容指纹绑定的凭证；
3. 用它执行 `event.import` / `snapshot.replace` / `store.rollback` / `event.bulkDelete`
   —— 任意内容、任意目标、任意 id 集合。

**这恰好推翻了凭证指纹的"防挪用"承诺**：`digest` 本应把凭证钉死在
"用户当时看到的那个具体内容"上，但既然是调用方自己算自己传的，指纹并没有绑定到
**任何真实存在的、用户确认过的内容**——它只是让调用方能自由地为**任意内容**申请
一张凭证。

**严重度判定**：
- **不是**「模型自批自放」——模型到不了 commands 通道（§5.1 已实证）。
- **是**「浏览器侧任意调用方可换取任意破坏性操作的凭证」——但作者已在
  `docs/wp4/02-approval-model.md` §4 **如实登记为 UNVERIFIED 并说明官方更弱**
  （`dsh-client-ui-schedule` 的删除确实无 token，我已独立核实：
  `dsh-client-ui-schedule/lib/client.js:6298` 直接 `ctx.remote.schedule.delete(...)`，
  `dsh-schedule/lib/index.js` 全文无 approval/approvalToken/confirm）。
- 因此：**这是把「已知的、被如实登记的残余风险」从「只影响删除」扩大到
  「影响导入/覆盖/回滚/批量删除」**，属于**风险面扩大 + 与本包自身既定规则不一致**
  （service.js 明写"绝不信任调用方传进来的 digest"，而新路径没遵守）。

**判定：MINOR-to-MAJOR（记为 MAJOR-1 / NIT-1）**。理由：
- 数据丢失能力**确实**从「删一条」扩大到「清空整个库 + 回滚」，超出「UI 删除按钮」
  的原始意图，属于**功能范围外的破坏性能力**；
- 但它**不能被模型利用**（模型到不了该通道），且**官方 UI 删除无凭证**这一对照成立，
  故不构成「比现状更弱」的回归；
- 修法明确且小：让 `issueForUserConfirm` **不采信调用方的 digest**，
  对内容类 op（`event.import` / `snapshot.replace`）由服务层按内容计算，
  或干脆把这两个 op 排除在 user-confirm 之外（UI 本来也没有导入/覆盖入口）。

### 5.7 DANGEROUS_OPS 语义（9596b30 上未约束 → 已被作者的 WP4-17 修补）

**9596b30 实测**：E1/E2 显示对**非危险 op**（`event.create`）甚至**不存在的 op**
（`not.a.real.op`）都签发凭证 → 万能钥匙。

**作者在复审期间提交 `b32ec4b`(WP4-16) + `595d1d0`(WP4-17) 修补**：
`service.js` 的 `confirmUserAction` 现在先查 `DANGEROUS_OPS`，不在清单内抛
`validation`（"操作不在可确认清单内"）。

**在新 HEAD（595d1d0）上复测**
```
$ node /tmp/wp4r5/probe/r5-03b-mint-overreach-new.mjs
===== E) confirmUserAction 是否检查 DANGEROUS_OPS =====
WorkbenchError: 操作不在可确认清单内：event.create
    at Object.confirmUserAction (workbench-core/src/service.js:479:15)
```
→ **已修补**（E1/E2 关闭）。但 §5.6 的 A2 / B1 / C1 / D1（自选 digest / target）
**在新 HEAD 上依然全部通过**（见同一份输出）。

**判定**：§5.6 的问题**未被修补**，且是修补者自己"万能钥匙"时**没看到的第二个面**。

---

## 6. 回归三件套（检查名：regression-suite）

**命令**（全部在 /tmp 副本跑，未写主仓库）
```
$ cd /tmp/wp4r5/export/workbench-core && node --test test/*.test.mjs
$ cd /tmp/wp4r5/export && node scripts/r3-mutate.mjs
$ cd /tmp/wp4r5/export && bash scripts/wp2-r5-gate.sh
```

**实际输出**
```
# tests 273
# pass 273
# fail 0
```
（`9596b30` 冻结版；作者在复审期间提交 WP4-16/17 后，在新 HEAD `595d1d0` 上复测：
```
# tests 275
# pass 275
# fail 0
```
）

```
CAUGHT: 46
VACUUM: 0
SKIP:   0
结论：全部保护点都有测试约束（0 真空，0 跳过）
```

```
=== 门禁汇总 ===
通过 8 项，失败 0 项
RESULT: PASS
```

**判定：通过**。273/273（冻结版）、275/275（当前 HEAD）、46/46 变异（0 真空 0 跳过）、
门禁 8/8，全部与报告数字一致。

---

## 7. 隔离 boot（检查名：isolated-boot）

**命令**
```
$ DSH_HOME=/tmp/dsh-iso-Jv2UeM dsh --profile rescue --patch /tmp/wp4-isolated-patch.yml --no-open --port 0 > /tmp/wp4r5-isolated-boot.log 2>&1 &
$ sleep 12; kill $BGPID
```

**实际输出**
```
=== LOG ===
dsh web: http://127.0.0.1:50772/?token=qKubltIXx6O_o8Ix9JSFpahX_1aXHqFvxpMEZ5cexCA
=== error/did-not-activate scan ===
0
```
（无 error、无 did-not-activate；只打印了 web 地址行。）

**判定：通过**。隔离 Host 正常激活，零错误零 did-not-activate。

---

## 8. 红线（检查名：redlines）

**命令与实际输出**
```
$ grep -n "workbench" ~/.dsh/profiles/desktop/package.json      → 无匹配
$ grep -n "workbench" ~/.dsh/profiles/desktop/cordis.patch.yml  → 无匹配
$ stat -f "%Sm %N" ~/.dsh/profiles/desktop/package.json ~/.dsh/profiles/desktop/cordis.patch.yml
Nov  6 15:11:41 2026 ~/.dsh/profiles/desktop/package.json
Nov  6 15:09:10 2026 ~/.dsh/profiles/desktop/cordis.patch.yml

$ git remote -v                       → 空（remote 数 = 0）
$ cd <whale-workspace> && git status --porcelain  → 空（count = 0）
```
**未 push**：`git log --branches --not --remotes --oneline | wc -l` = 64 —— 全部 64 个
commit 都在本地、**没有任何一个推到远端**（因为没有远端）。

**判定：通过**。正式 profile 未被写入；0 remote；未 push；鲸鱼娘工作区干净。

---

## 9. 诚实性（检查名：honesty）

**命令与实际输出**
```
$ find evidence/wp4 -type f | while read f; do file -b --mime-type "$f"; done | grep image/
（无输出 —— evidence/wp4 下无任何图片文件）
$ grep -c "UNVERIFIED" docs/wp4/01-final-report.md     → 14
$ grep -nE "273|275|46/46|8/8" docs/wp4/01-final-report.md
130:| 既有测试回归 | ✅ **275/275** 单测、**46/46** 变异（0 真空 0 跳过）、门禁 **8/8** |
```

**报告数字 vs 实测**：275/275（我实测新 HEAD 275/275）、46/46（实测 46/46）、
0 真空 0 跳过（实测同）、8/8（实测同）—— **全部一致**。

**第四/五轮结论记录**：`docs/wp4/01-final-report.md` §8「独立 Review（四轮）」表格
只登记到**第 4 轮**（`| 4 | bf1c657 | 见 REVIEW-round4.md | — |`），
**第 5 轮未入表**；第四轮的两路冲突结论（子 Agent APPROVE WITH NITS vs workflow
REQUEST CHANGES）也**未被如实记录**——表格里第 4 轮那一行结论写的是"见文件"，
没有写"两路冲突"。

**判定**：**部分通过**。数字诚实、UNVERIFIED 保留、无伪造图片；但
「第四轮结论冲突」与「第五轮」这两项**未记录**（见 §11 NIT-3）。

---

## 10. 前几轮项抽验（检查名：spot-check-earlier-items）

| 项 | 命令 | 实际输出 | 判定 |
|---|---|---|---|
| 无相对 require | `grep -rn "require('\./\|from '\./" packages/workbench-ui/client.js` | 无匹配（client.js 相对 require = 0） | ✅ |
| locale register/bind 形状对齐 | `grep -n "ctx.locale" packages/workbench-ui/client.js` | `ctx.locale.register(NS, LOCALE)` @832、`ctx.locale.bind(NS)` @840/847、`inject: ['slots','remote','sessions','locale']` @827 | ✅ |
| 软删需审批且指纹 op 对齐 | `grep -n "requireConfirmation" workbench-core/src/service.js` | `event.delete`→target=id（:216）；`task.upsert` 软删→target=task.id（:420） | ✅ |
| sessionId 取自 retainedBy.mainView>0 | `grep -n "retainedBy" packages/workbench-ui/client.js` | :439 与 :452 两处均 `(r?.retainedBy?.mainView ?? 0) > 0` | ✅ |
| 组件渲染测试能抓到作用域外引用 | `workbench-core/test/workbench-ui-render.test.mjs` | 真实调用组件函数捕获 `ReferenceError`（:44-52 `render()` 递归调用函数组件） | ✅ |

**判定：通过**。

---

## 11. 主动找新缺陷的结果汇总

| 编号 | 严重度 | 内容 | 状态 |
|---|---|---|---|
| MAJOR-1 | MAJOR | `issueForUserConfirm` 采信调用方自选的 `detail.digest` → 任何能到 commands 通道的调用方可为**任意内容**签发 `event.import` / `snapshot.replace` 凭证，一次导入任意 ICS / 全量覆盖 / 回滚 / 批量删。**违反 service.js:117-125 自己写明的"绝不信任调用方传进来的 digest"规则**。§5.6 | **未修**（在新 HEAD `595d1d0` 上复测仍全通过） |
| MAJOR-2 | MAJOR | `confirmUserAction` 在 `9596b30` 上可为**非危险 op 甚至不存在的 op** 签发凭证（万能钥匙）。§5.7 | **已修**（作者 WP4-16/17，新 HEAD 上 `validation` 拒绝） |
| MAJOR-3 | — | 「用户确认即授权」通道：Host half 不区分"用户真点了"与"任意调用方索要"，浏览器侧任意脚本可换删除凭证 | **已如实登记为 UNVERIFIED**（`docs/wp4/02-approval-model.md` §4），且模型不可达（§5.1 实证）→ **不判 blocker** |
| NIT-1 | MINOR | 第四轮 N4（页面漏传 `t` 给 `ConfirmDelete`）**仍未修**，且**仍无测试覆盖**：我把 `t` 补上后 275/275 **仍全绿**（变异不被抓）→ 中文界面下删除确认弹窗标题「Delete?」仍是英文。§11.1 | **未修** |
| NIT-2 | MINOR | 组件里仍硬编码英文文案（表单标签/状态栏/空态）：`'All day'`、`'Low'/'Normal'/'High'`、`'Saving…'`、`'Requesting approval…'`、`'Request approval & delete'`、`'This requires Host approval before deleting'`、`'Loaded from Host Service'`、`'No events in the next 7 days'`、`'Nothing scheduled'`、`'Shared with the current Agent session'`、`'No active session; open the workbench from a conversation'` 等（`client.js` 约 16 处）。`t('cancel')`/`t('delete')` 已接 locale，但正文/按钮/空态没有。 | 既有 nit，未修 |
| NIT-3 | MINOR | 报告 §8「独立 Review」只登记到第 4 轮；**第四轮两路结论冲突**（子 Agent APPROVE WITH NITS vs workflow REQUEST CHANGES/BLOCKER-4）与第五轮均未入表。§9 | **未修** |

### 11.1 NIT-1 的复现（第四轮 N4 未修 + 无测试守住）

**命令**
```
$ cd /tmp/wp4r5 && cp -R export-new n4mut && cd n4mut
$ python3 - <<'PY'
p='packages/workbench-ui/client.js'
s=open(p,encoding='utf-8').read()
s=s.replace("""          ? h(ConfirmDelete, {
              label: confirming.label, approving,""",
            """          ? h(ConfirmDelete, {
              label: confirming.label, approving, t,""")
open(p,'w',encoding='utf-8').write(s)
PY
$ cd workbench-core && node --test test/*.test.mjs
```

**实际输出**
```
mutation applied: N4 fix (pass t) added
# tests 275
# pass 275
# fail 0
```
**判定**：补上 `t` 之后 **275 条仍全绿** → **没有任何测试断言这一行**，
即第四轮 N4 的「覆盖缺口」**仍未闭合**。

**当前代码状态**（`packages/workbench-ui/client.js:817-821`）：
```js
? h(ConfirmDelete, {
    label: confirming.label, approving,
    onConfirm: () => deleteWithApproval(confirming.kind, confirming.id),
    onCancel: () => setConfirming(null),
  })
```
`ConfirmDelete` 的默认参数 `t = defaultT`（:414）兜底 → **不崩、不白屏**，
但中文界面下弹窗标题 `t('delete')` 走 `defaultT`（英文表）→ 仍是英文。

### 11.2 作者在复审期间提交的两个 commit（须记录）

复审期间（我做完 §5 探针后）主仓库 HEAD 从 `9596b30` 漂移到 `595d1d0`：

| commit | 时间 | 内容 |
|---|---|---|
| `b32ec4b` WP4-16 | 17:42 | 新增 `docs/wp4/02-approval-model.md`；`service.js` 的 `confirmUserAction` 加 `DANGEROUS_OPS` 校验；并把我正在写的 `REVIEW-round5.md` 一并 commit（当时它只有「进行中」头部） |
| `595d1d0` WP4-17 | 17:46 | 补 2 条测试（非危险 op 拒绝签发 + 不在 AI 工具面暴露）；更新报告数字到 275/275 |

**影响**：§5.6（MAJOR-1）在新 HEAD 上**依然成立**；§5.7（MAJOR-2）已修。
本文件（`REVIEW-round5.md`）在主仓库工作树里的版本比 `595d1d0` 里的版本多 146 行
（`git diff --stat 595d1d0 -- evidence/wp4/final-review/REVIEW-round5.md`），
即 `b32ec4b` commit 进去的是本文件的**早期片段**。

---

## 12. 判定汇总

**本轮修复确实闭合了第四轮 BLOCKER-4**（真 ApprovalService 回合闭合时抛错 → 属实；
UI 删除路径不再依赖 `ctx.approval.request` → 实测 waterfall 0 次、删除成功、剩余 0 条）。
AI 侧删除路径未被削弱（仍走真 `ApprovalService`，回合外 fail-closed）。
回归三件套、隔离 boot、红线、诚实性、前几轮抽验**全部通过**。

**但新引入了两个问题**：
1. **MAJOR-1（未修）**：`issueForUserConfirm` 采信调用方自选的 `digest`，
   把破坏性凭证从"只能删一条"扩大到"能导入任意 ICS / 全量覆盖 / 回滚 / 批量删"，
   且直接违反 `service.js:117-125` 自己写明的"绝不信任调用方传进来的 digest"。
   复现命令与实际输出见 §5.6（在新 HEAD `595d1d0` 上依然全部通过）。
2. **NIT-1（未修）**：第四轮 N4（`ConfirmDelete` 漏传 `t`）未修，且**仍无测试覆盖**
   （补上 `t` 后 275/275 仍全绿）。NIT-2（硬编码英文文案）延续。

**关于"用户确认即授权"通道（MAJOR-3）**：我确认 Host half **不验证用户真的点了**
（§5.1）。但：(a) **模型到不了这个通道**——DSH 全量 308 个包里没有任何模型侧工具能执行
slash command，`confirmUserAction` 不在 AI 工具面，AI 工具的 `approvalToken` 恒为 undefined
（§5.1 三项实证）；(b) 作者已在 `docs/wp4/02-approval-model.md` §4 把该残余风险
**如实登记为 UNVERIFIED**，并给出官方对照（`dsh-client-ui-schedule` 删除无 token，
我已独立核实）；(c) 修复 BLOCKER-4 的方向本身正确（DSH 审批确实回合外不可用）。
**因此不判 BLOCKER**，判为已登记的残余风险。


## 13. MAJOR-1 的最小修法已验证可行（检查名：fix-feasibility）

**命令**
```
$ cd /tmp/wp4r5 && cp -R export-head export-fix
$ python3 - <<'PY'   # 只改 /tmp 副本的 packages/workbench-ui/index.js
#   - 只允许 UI 真正用到的两个 op：event.delete / task.upsert
#   - 不再采信 payload.digest
PY
$ WP4_EXPORT=/tmp/wp4r5/export-fix node /tmp/wp4r5/probe/r5-06-fix-feasibility.mjs
$ cd /tmp/wp4r5/export-fix/workbench-core && node --test test/*.test.mjs
```

**实际输出**
```
OK    F1 UI 删除路径仍然成功        minted=true delete=true remaining=0
OK    F2 自选 digest 的 event.import 凭证不再生效   import.ok=false error=confirmation-required
OK    F3 自选 digest 的 snapshot.replace 凭证不再生效 replace.ok=false error=confirmation-required
OK    F4 自选 target 的 store.rollback 凭证不再生效  rollback.ok=false error=confirmation-required
OK    F5 软删待办路径仍然成功          softdelete.ok=true
===== 汇总 ===== 通过 5/5

# tests 275
# pass 275
# fail 0
```

**判定**：MAJOR-1 的修法**很小且不破坏任何现有行为**（275/275 仍全绿，UI 删除与软删待办
两条真实路径都正常）。建议作者按此修。

---

## 14. 复审期间 HEAD 漂移记录（检查名：head-drift）

**命令与实际输出**
```
$ git rev-parse HEAD
9596b30b5db02c69055692a23c87637db4335dce      ← 开工时（冻结版本）

...（做完 §5 探针后）...
$ git rev-parse HEAD
595d1d09ab4856363a6d785e12828bd2224e1e98      ← 当前
$ git log --oneline 9596b30..595d1d0
595d1d0 WP4-17: restrict the user-confirm credential to dangerous ops + document the boundary
b32ec4b WP4-16: document the approval model and the Host boundary
```

**两个 commit 的影响（我逐条复测）**

| commit | 改动 | 对本轮结论的影响 |
|---|---|---|
| `b32ec4b` WP4-16 | 新增 `docs/wp4/02-approval-model.md`；`service.js` 的 `confirmUserAction` 加 `DANGEROUS_OPS` 校验；**把我正在写的本文件（当时仅「进行中」头部）一并 commit** | 关闭 MAJOR-2（万能钥匙）；新增一份**诚实登记残余风险**的文档；本文件在 `595d1d0` 里的版本比工作树少 146 行 |
| `595d1d0` WP4-17 | 补 2 条测试；报告数字改 275/275 | 关闭 MAJOR-2 的测试覆盖；**未触及 MAJOR-1** |

**对「冻结纪律」判定的影响**：被审对象从 `9596b30` 漂到 `595d1d0`。
我把两者都审了：冻结版 `9596b30` 的结论见 §2–§12，漂移后 `595d1d0` 的结论见
§5.7 / §13（MAJOR-2 已修、MAJOR-1 未修、NIT-1/NIT-2/NIT-3 未修）。
**两个版本的结论一致：MAJOR-1 成立。**

---

# 结论：APPROVE WITH NITS

**理由**

第四轮 BLOCKER-4 **已真正闭合**：我用真 `@deepseek-ai/dsh-user-approval` + 真 cordis
`Context` + **回合已闭合**的 session 复现了「回合外 `approval.request` 在审计之前抛错、
waterfall 0 次」（§2），并实测 UI 删除路径**完全不经 DSH 审批**（waterfall 0 次）
且删除成功、剩余 0 条（§3）。AI 侧删除路径**未被削弱**，仍必须走真 `ApprovalService`
（§4）。回归三件套 273/273（冻结版）/ 275/275（当前 HEAD）、46/46 变异（0 真空 0 跳过）、
门禁 8/8（§6），隔离 boot 零错误（§7），红线全过（§8），诚实性基本达标（§9），
前几轮项抽验全过（§10）。

**关于「用户确认即授权」通道（任务书 2.a，本轮最关键的问题）**：
我确认 Host half 的 `confirmUserAction` **不验证用户真的点了**（§5.1）——任何能到达
commands 通道的调用方都能换出凭证。**但我没有把它判为 blocker**，因为：
1. **模型到不了这个通道**（§5.1 三项实证：DSH 全量 308 个包无任何模型侧工具能执行
   slash command；`confirmUserAction` 不在 AI 工具面；AI 工具的 `approvalToken` 恒为
   `undefined`）；
2. 作者已在 `docs/wp4/02-approval-model.md` §4 把这条残余风险**如实登记为 UNVERIFIED**，
   并给出官方对照（`dsh-client-ui-schedule` 删除无 token —— 我已独立核实）；
3. 修复 BLOCKER-4 的方向本身正确（DSH 审批确实回合外不可用，这是 DSH 的硬限制）。

**遗留项（必须处理，但不是 blocker）**

- **MAJOR-1（§5.6 / §13）**：`issueForUserConfirm` 采信调用方自选的 `detail.digest`，
  任何能到 commands 通道的调用方可为**任意内容**签发 `event.import` / `snapshot.replace`
  凭证 → 导入任意 ICS / 全量清空 / 回滚 / 批量删。这**直接违反 `service.js:117-125`
  自己写明的「绝不信任调用方传进来的 digest」**。在当前 HEAD `595d1d0` 上复现仍 5/5 成立
  （§14）。最小修法已验证（§13：只允许 `event.delete`/`task.upsert` 两个 op + 不采信
  `payload.digest`，275/275 仍全绿）。**建议本轮内修掉。**
- **NIT-1（§11.1）**：第四轮 N4（`ConfirmDelete` 漏传 `t`）未修，且**仍无测试覆盖**
  （补上 `t` 后 275/275 仍全绿）→ 中文界面下删除确认弹窗标题仍是英文。
- **NIT-2（§11）**：组件里仍有约 16 处硬编码英文文案（表单标签/状态栏/空态/按钮）。
- **NIT-3（§9）**：报告 §8「独立 Review」只登记到第 4 轮；第四轮两路结论冲突与第五轮
  均未入表。

**未取得的证据（如实保留 UNVERIFIED）**：真实浏览器里「未经用户点击的第三方脚本能否
调用 commands 通道」未验证（无浏览器控制）；`ctx.remote.commands.execute` 的
浏览器 WebSocket/RPC 层未端到端跑；真实渲染画面未取得。

**复审员**：WP4 第五轮（终审）独立复审员（只读主仓库；全部变异与探针只在 /tmp 副本跑）
