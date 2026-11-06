# WP4 收口复审（REVIEW-closing）

- 审查对象：冻结副本 `/tmp/wp4-final6-freeze-dd99ae6`
- 基准 commit：`dd99ae6`
- 审查时间：2026-11-06
- 审查员：WP4 收口复审员（只读审查）
- 状态：**进行中**

---

## 检查记录

（每完成一项立即追加：检查名 / 命令 / 实际输出 / 判定）

## 1. 冻结纪律（commit 一致性 + 主仓库 HEAD）

**命令**
```bash
cd /Users/sylas/Developer/dsh-workbench
rm -rf /tmp/wp4close/archive-dd99ae6 && mkdir -p /tmp/wp4close/archive-dd99ae6
git archive dd99ae6 | tar -x -C /tmp/wp4close/archive-dd99ae6
diff -rq /tmp/wp4close/archive-dd99ae6 /tmp/wp4-final6-freeze-dd99ae6
git rev-parse HEAD
git status --porcelain
```

**实际输出**
```
archived files:      862
frozen files:        862
=== diff -rq ===
diff exit=0          # 无任何差异输出
```
主仓库 HEAD（开始）：`dd99ae6b52774695d1000f7570a9532783ab3856`
主仓库 `git status --porcelain`（开始）：
```
?? evidence/wp4/final-review/REVIEW-closing.md   # 本次审查新建的产物
```
（除此之外干净，无其他改动）

**判定：PASS** — 冻结副本与 `git archive dd99ae6` 逐字节一致（862 文件，diff 退出码 0）。

---

## 2. 回归三件套（/tmp 副本 `/tmp/wp4close/work`）

**命令**
```bash
cp -R /tmp/wp4-final6-freeze-dd99ae6 /tmp/wp4close/work   # 变异脚本会改源码，故先复制
cd /tmp/wp4close/work/workbench-core && node --test test/*.test.mjs
cd /tmp/wp4close/work && node scripts/r3-mutate.mjs
cd /tmp/wp4close/work && bash scripts/wp2-r5-gate.sh
```

**实际输出（1）单测**
```
1..279
# tests 279
# suites 0
# pass 279
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2451.9265
[status: completed, exit code: 0]
```

**实际输出（2）变异**
```
CAUGHT W11 WP4：event.restore 不校验凭证（审批旁路 → 已删事件被悄悄恢复）  → pass 277 fail 2
CAUGHT W12 WP4：ConfirmDelete 不传 t（中文界面确认弹窗变英文）  → pass 278 fail 1
CAUGHT W13 WP4：用户确认凭证的指纹并入调用方 digest（内容类操作必失效）  → pass 278 fail 1
=== 汇总 ===
CAUGHT: 49
VACUUM: 0
SKIP:   0
结论：全部保护点都有测试约束（0 真空，0 跳过）
[status: completed, exit code: 0]
```

**实际输出（3）WP2 R5 门禁**
```
=== 门禁汇总 ===
通过 8 项，失败 0 项
RESULT: PASS
[status: completed, exit code: 0]
```

**判定：PASS** — 279/279、49/49（0 VACUUM、0 SKIP）、8/8，与报告数字一致。

---

## 3. 三条修复是否真的成立（必查 2.a / 2.b / 2.c）

**命令**（独立探针 `/tmp/wp4close/probe-core.mjs` + `/tmp/wp4close/probe-ui.mjs`，不依赖仓库自带的测试断言）
```bash
node /tmp/wp4close/probe-core.mjs    # 44 项，全 PASS
node /tmp/wp4close/probe-ui.mjs      # 25 项，全 PASS
```

### 2.a `event.restore` 无凭证 → 必须 `confirmation-required`；带凭证 → 成功恢复

**实际输出（真 service 实现，`approvalMode:'isolated'`）**
```
✅ 软删后 event.list 为空
✅ 无凭证 event.restore → confirmation-required — code=confirmation-required
   msg=危险操作 event.restore 需要宿主审批凭证（原因：missing-token）；payload 里的 confirmed 不被采信
✅ confirmed:true 不能绕过 event.restore — code=confirmation-required
✅ 伪造 token → confirmation-required — code=confirmation-required
✅ 带凭证 event.restore 成功恢复 — list=1 deletedAt=null
```

**判定：PASS**。修复真实成立（`service.js:228` 的 `requireConfirmation('event.restore', meta, { target: id })`）。

### 2.b `h(ConfirmDelete, {...})` 调用点确实传了 `t`，且无 `t` 时仍能渲染

**实际输出**
```
✅ 找到 h(ConfirmDelete, {...}) 调用点
✅ 调用点传了 t — props=" label: confirming.label, approving, t, onConfirm: ..., onCancel: ... "
✅ ConfirmDelete 无 t 时不抛异常（defaultT 兜底）
✅ ConfirmDelete 有 t 时使用传入的 t — ["ZH:delete","?","...","ZH:cancel"]
✅ EventForm 无 t 时不抛异常 / ✅ TaskForm 无 t 时不抛异常
```
源码事实：`packages/workbench-ui/client.js:818` → `label: confirming.label, approving, t,`；
组件签名 `client.js:414` → `function ConfirmDelete({ label, onConfirm, onCancel, approving, t = defaultT })`。

**判定：PASS**。上一轮的谎报已纠正 —— 调用点确实传了 `t`，且有真实测试守住
（`workbench-ui-render.test.mjs:146` 断言 `/h\(ConfirmDelete,\s*\{[^}]*approving,\s*t,/s`；
变异 **W12**「ConfirmDelete 不传 t」被 CAUGHT）。

### 2.c `issueForUserConfirm` 忽略调用方 digest

**实际输出**
```
✅ event.import + 自选 digest 凭证被拒 — code=confirmation-required
   msg=...（原因：fingerprint-mismatch）...
✅ snapshot.replace + 自选 digest 凭证被拒 — code=confirmation-required
   msg=...（原因：fingerprint-mismatch）...
✅ event.delete + 自选 digest 凭证仍成功（digest 未污染指纹） — code=null
✅ 执行侧指纹 == 签发侧（digest 恒空）指纹
     fpExecDelete  = 3181d5e558c9c2c462f1a04e31c4f9fdd46012bd8f2c76a5d29dd4e730c6b8bf
     fpIssuedEmpty = 3181d5e558c9c2c462f1a04e31c4f9fdd46012bd8f2c76a5d29dd4e730c6b8bf
     fpIssuedEvil  = c8fef7d5e5a1a99e623acc85e4e4075dd8f0ca88af297e71118b3281d102d854
```
（指纹等式是**直探** `approvalFingerprint` 算出的，不是转述源码注释。）

**判定：PASS**。签发侧 `approval-gate.js:166` 固定 `digest: ''`，执行侧 `service.js:124`
用 `contentDigest(text)` 服务端重算 → 内容类操作必然 `fingerprint-mismatch`；
非内容类 op（`event.delete`）执行侧 digest 恒为 `undefined`→`''`，与签发侧一致 → 仍可用。
变异 **W13**（把签发侧改回 `detail.digest`）被 CAUGHT。

---

## 4. 审批旁路全面复查（必查 3）

### 4.1 `DANGEROUS_OPS` 每个 op 的 handler 是否都调 `requireConfirmation`

`DANGEROUS_OPS` = `["event.bulkDelete","event.delete","event.import","event.restore","snapshot.replace","store.rollback","task.upsert"]`

**逐个无凭证调用（真 service，actor='attacker'）**
```
✅ event.delete 无凭证被拒 — code=confirmation-required
✅ event.bulkDelete 无凭证被拒 — code=confirmation-required
✅ event.import 无凭证被拒 — code=confirmation-required
✅ snapshot.replace 无凭证被拒 — code=confirmation-required
✅ store.rollback 无凭证被拒 — code=confirmation-required
✅ event.restore 无凭证被拒 — code=confirmation-required
✅ task.upsert 无凭证被拒 — code=confirmation-required（软删语义）
```
源码位置：`service.js:216`（delete）、`:243`（bulkDelete）、`:283`（import）、
`:343`（snapshot.replace）、`:381`（store.rollback）、`:228`（restore）、`:427`（task.upsert 软删）。

**判定：PASS** — 7/7 全部受控。

### 4.2 有没有别的危险写 op 漏了审批？

**deny 模式下 `WRITE_OPS` 全部 10 个 op 逐一实测**
```
✅ deny 模式 event.create 被拒   ✅ deny 模式 event.update 被拒
✅ deny 模式 event.restore 被拒  ✅ deny 模式 event.delete 被拒
✅ deny 模式 event.bulkDelete 被拒 ✅ deny 模式 event.import 被拒
✅ deny 模式 task.upsert 被拒    ✅ deny 模式 snapshot.replace 被拒
✅ deny 模式 store.rollback 被拒 ✅ deny 模式 store.backup 被拒
```
（拦截点：`service.js:509` 的唯一入口 `execute`，不在各 handler 里。）

**判定：PASS**（在 service 层）。**但见 §8 NEW-2：task 侧的「撤销软删」方向存在不对称缺口。**

### 4.3 用户确认凭证的约束

```
✅ 一次性：第二次用被拒 — code=confirmation-required
✅ 挪用 target 被拒（fingerprint-mismatch）
✅ 挪用 op 被拒（fingerprint-mismatch）
✅ 非危险 op event.list / task.list / event.create / event.update / store.backup 不得签发凭证 — code=validation
✅ 伪造 token（'forged-token'）被拒
✅ host-tools.js 全文不含 confirmUserAction（AI 工具面不暴露）
✅ AI 工具的 approvalToken 恒为 meta.approvalToken（默认 undefined）
```

### 4.4 AI 侧删除路径仍走真 ApprovalService（回合内）

```
✅ askApproval 在有 agent.session 时被宿主批准
   {"approved":true,"token":"5a391eceb5162b3f938c21589902ad6e0d5e4c1e41cdfaedf993fdbdd51baf73"}
✅ 宿主收到 agent + toolName — {"agent":{"session":{"id":"sess-1"}},"toolName":"event.delete","reason":"event.delete"}
✅ 带真宿主签发的 token 删除成功
✅ 无 agent 时宿主返回 unavailable（不签发 token） — {"approved":false,"reason":"host-unavailable"}
```

### 4.5 会话隔离

```
✅ sess-A 看不到 sess-B 的事件
✅ 不同 scope 的 tasks 互相隔离 — scope1=["ta"] scope2=["tb"]
✅ svc 返回面 = ["confirmUserAction","defaultTimeZone","events","execute","listOps","requestApproval","store"]
✅ svc.store 只有只读方法 — ["listBackups","listPreBackups"]
✅ svc.events 只有只读方法 — ["get","list"]
✅ svc 不暴露 gate 对象（拿不到 gate 就不能自签）
✅ hostService keys = ["askApproval","audit","describe","forSession","invoke","listOps"]
✅ forSession().* 不含 gate
```

**判定（4.1–4.5）：PASS**，无审批旁路。

---

## 5. 隔离 boot（必查 5）

**命令**
```bash
rm -rf /tmp/dsh-iso-Jv2UeM && mkdir -p /tmp/dsh-iso-Jv2UeM
DSH_HOME=/tmp/dsh-iso-Jv2UeM dsh rescue --from-default-profile web        # 建 rescue profile
DSH_HOME=/tmp/dsh-iso-Jv2UeM dsh plugin --profile rescue add /tmp/wp4close/work/packages/workbench-ui
DSH_HOME=/tmp/dsh-iso-Jv2UeM dsh --profile rescue --patch /tmp/wp4-isolated-patch.yml --no-open --port 0 &
sleep 12; kill $BPID
```

**实际输出**
```
dsh web: http://127.0.0.1:64169/?token=QMgH9f0EOmcClBo0t8bMmKWCTkOFlu4WKSFhFALLQHk
=== ps === 53339 S node /opt/homebrew/bin/dsh --profile rescue --patch /tmp/wp4-isolated-patch.yml --no-open --port 0
=== error/failed/did-not-activate/workbench 扫描 → 0 ===
curl http://127.0.0.1:64169/            → 401（无 token，符合预期）
curl http://127.0.0.1:64169/?token=...  → 303（重定向，Web 服务正常）
```
配置层证据：
```
$ DSH_HOME=/tmp/dsh-iso-Jv2UeM dsh --profile rescue --patch /tmp/wp4-isolated-patch.yml --dump-config | grep -A3 workbench-ui
# == @local/dsh-workbench-ui
- id: workbench-ui
  name: '@local/dsh-workbench-ui'
  config:
    rootDir: ''
# == /tmp/wp4-isolated-patch.yml
- id: workbench-ui
  name: '@local/dsh-workbench-ui'
  config:
    rootDir: /tmp/dsh-iso-Jv2UeM/workbench-data
```

**判定：PASS** — 零错误、零 did-not-activate、Host 半边真激活、Web 服务起来。
（说明：首次用 `dsh plugin --profile rescue add` 建出来的 profile 只有 `@deepseek-ai/dsh-base`
而无 web bundle，`--port 0` 不会起 Web 服务；必须用 `dsh rescue --from-default-profile web`
建 profile。这是本次复审新发现的**步骤差异**，与被审代码无关。）

---

## 6. 红线（必查 6）

**命令与实际输出**
```bash
$ grep -c "workbench" ~/.dsh/profiles/desktop/package.json ~/.dsh/profiles/desktop/cordis.patch.yml
/Users/sylas/.dsh/profiles/desktop/package.json:0
/Users/sylas/.dsh/profiles/desktop/cordis.patch.yml:0
$ stat -f "%Sm %N" ~/.dsh/profiles/desktop/package.json ~/.dsh/profiles/desktop/cordis.patch.yml
Nov  6 15:11:41 2026 /Users/sylas/.dsh/profiles/desktop/package.json
Nov  6 15:09:10 2026 /Users/sylas/.dsh/profiles/desktop/cordis.patch.yml
$ git -C /Users/sylas/Developer/dsh-workbench remote -v      → 空
$ git -C ... remote | wc -l                                → 0
$ git -C ... log --branches --not --remotes --oneline | wc -l → 66   （全部本地，无一推送）
$ ls -d /Users/sylas/Developer/鲸鱼娘/.git                 → 不存在（该目录**不是 git 仓库**）
```

**判定：PASS（红线本身）** — 正式 profile 无 workbench-ui 行；0 remote；未 push。

**但见 §8 NIT-4**：报告 §六 写的「鲸鱼娘 `79d7e24` dirty 0」**当场无法复核**——
`/Users/sylas/Developer/鲸鱼娘` 现在根本没有 `.git` 目录，我在 `/Users/sylas/Developer/*/`
与 `/Users/sylas/*/` 下所有 git 仓库里 `git cat-file -e 79d7e24` 全部无匹配。
该表述不符合「当场可复核」的标准（详见 §9）。

---

## 7. 诚实性（必查 7）

### 7.1 报告数字与实测一致？

| 报告声称 | 实测 | 判定 |
|---|---|---|
| 279/279 单测 | `# tests 279 / # pass 279 / # fail 0` | ✅ |
| 49/49 变异、0 VACUUM、0 SKIP | `CAUGHT: 49 / VACUUM: 0 / SKIP: 0` | ✅ |
| 门禁 8/8 | `通过 8 项，失败 0 项 / RESULT: PASS` | ✅ |
| 静态规范 10/10 | `# tests 10 / # pass 10` | ✅ |
| bridge 23/23（evidence index §4） | **`# tests 24 / # pass 24`** | ❌ 数字过期 |
| 组件渲染 4/4（evidence index §4） | **`# tests 5 / # pass 5`** | ❌ 数字过期 |
| bridge + 渲染 27/27（报告 §五） | **24 + 5 = 29** | ❌ 数字过期 |

**实际输出**
```
$ node --test workbench-core/test/workbench-ui-bridge.test.mjs    → # tests 24 / # pass 24
$ node --test workbench-core/test/workbench-ui-render.test.mjs    → # tests 5  / # pass 5
$ node --test .../bridge.test.mjs .../render.test.mjs             → # tests 29 / # pass 29
```

**判定：部分不通过。** 主回归数字（279/49/8/10）全部诚实；**但 `evidence/wp4/00-evidence-index.md`
的 23/23 与 4/4、报告 §五 的 27/27 是过期数字**（实测 24/24、5/5、29/29）。
这与第二轮 Review 抓过的「报告数字过期」属**同类问题复发**——修好了 §七 表格，
但 §五 与 evidence index 的分项数字没跟上。

### 7.2 UNVERIFIED 项保留？

```
$ grep -c "UNVERIFIED" docs/wp4/01-final-report.md  → 14
```
§五「深浅色截图 / 窗口缩放 / 真实点击 / 真实键盘操作」、
§七「浏览器渲染 / WebSocket RPC / 休眠唤醒 / 投递回执」均标 **UNVERIFIED**。

**判定：PASS** — UNVERIFIED 保留，无夸大。

### 7.3 `evidence/wp4/` 有无图片文件？

```
$ find evidence/wp4 -type f | while read f; do file -b --mime-type "$f"; done | grep -c image/
0
```
**判定：PASS** — 无任何图片文件，未伪造截图。

### 7.4 审批模型文档不再有假断言？

`docs/wp4/02-approval-model.md:36-40` 现文：
```
- 限制在 `DANGEROUS_OPS` 内 → 不是万能钥匙（`event.list` / `task.list` / `event.create`
  等非危险 op 拿不到）。
  ⚠️ 但要说清楚：`snapshot.replace`、`event.import`、`store.rollback`、`event.restore`
  **也在** `DANGEROUS_OPS` 内，因此**可以**为它们签发用户确认凭证。
  它们的实际风险由「执行侧服务端重算内容摘要」挡住（见下条），
  **不是**由「不在 DANGEROUS_OPS」挡住。
```
**判定：PASS** — 上一轮指认的假断言（「snapshot.replace 拿不到」）已改，且改法诚实：
明确承认这几个 op **在**清单内，并说明挡住它们的是执行侧重算摘要而非清单限制。

### 7.5 报告 §八 记录了第四、五轮结论？

**冻结版 `dd99ae6` 的实际内容**
```
$ git show dd99ae6:docs/wp4/01-final-report.md | sed -n '170,180p'
## 八、独立 Review（四轮）

| 轮次 | 基准 | 结论 | 处理 |
| --- | --- | --- | --- |
| 1 | `1a2c7ef` | 🔴 REQUEST CHANGES（5 blocker） | 全部修复 → `836ce52` |
| 2 | `836ce52` | 🔴 REQUEST CHANGES（1 MAJOR + 4 MINOR） | 全部修复 → `24ba56b` |
| 3 | `548be95` | 🔴 REQUEST CHANGES（1 blocker + 1 MAJOR） | 全部修复 → `bf1c657` |
| 4 | `bf1c657` | 见 `evidence/wp4/final-review/REVIEW-round4.md` | — |
```
标题仍是「**四轮**」，第 5 轮**不在表内**，第 4 轮那行的结论写「见文件」而**没写
两路冲突**（子 Agent APPROVE WITH NITS vs workflow REQUEST CHANGES / BLOCKER-4）。

**判定：不通过。** 上一轮 Review 的 NIT-3（「报告 §八 只登记到第 4 轮；
第四轮两路结论冲突与第五轮均未入表」）**在冻结版 `dd99ae6` 里仍未修**。

> **补充说明（不计入冻结版判定）**：复审期间主仓库 HEAD 漂移到 `9b7a99f`
> （WP4-19），该 commit 恰好修了这一项 —— §八 表格加了第 4 轮两路冲突、第 5 轮
> 两路冲突，以及「提交信息不是证据」的教训段。
> ```
> $ git diff --name-only dd99ae6 9b7a99f
> docs/wp4/01-final-report.md
> evidence/wp4/final-review/REVIEW-closing.md
> ```
> 即 HEAD 漂移**只动了文档**，未动任何源码（`workbench-core/src/**`、
> `packages/workbench-ui/**` 零改动）。但**被审的冻结版 `dd99ae6` 本身没有这一项**。

---

## 8. 主动找新缺陷 —— 找到 **2 个真缺陷（BLOCKER 级）+ 4 个 nit**

### 🔴 NEW-1（BLOCKER）AI 工具更新既有待办 → **静默抹掉未提供的字段**（数据丢失）

**性质**：与第一轮 Review 抓到的「`TaskForm` 编辑丢字段」**同款缺陷，但发生在 AI 工具面**，
第一轮只修了 UI 侧（`client.js:391` 展开 `initial` 全量字段），**服务层与 AI 工具侧没修**。

**根因**：`service.js:429-432` 的 `task.upsert` 是**整行替换**：
```js
const index = draft.tasks.findIndex((row) => row.id === task.id)
if (index < 0) draft.tasks.push({ ...task })
else draft.tasks[index] = { ...task }      // ← 整行替换，未提供的字段直接消失
```
而 `host-tools.js:213-215` 的 AI 工具 payload 是：
```js
payload: (args) => ({ task: { ...args } }),   // args 只有 id/title/dueAt/done
```
工具参数 schema（实测）：
```json
{"id":{"type":"string","required":true},"title":{"type":"string","required":true},
 "dueAt":{"type":"string"},"done":{"type":"boolean"}}
```
→ 模型传 `{id, title, done}` 时，`priority` / `status` / `dueAt` / `subtasks` /
`sourceSessionId` **全部被抹掉**，且**返回值里也不提示**（工具返回
`{"ok":true,...,"result":{"task":{"id":"ui-task-1","title":"季度总结","done":true}}}`），
审计里也不记 before/after → **静默数据丢失**。

**复现命令**（走**真实** AI 工具 `execute` 路径，不用复刻实现）
```bash
node /tmp/wp4close/probe-final.mjs
```

**实际输出**
```
=== 场景：用户在 UI 里新建一个「高优先级 + 子任务 + 到期日」的待办 ===
  BEFORE = {
 "id": "ui-task-1", "title": "季度总结",
 "dueAt": "2026-11-20T09:00:00Z", "priority": "high", "status": "planned", "done": false,
 "subtasks": [ { "title": "拉数据" }, { "title": "写初稿" } ],
 "sourceSessionId": "sess-origin"
}
=== 用户对 AI 说「把季度总结标记为完成」→ AI 调用 workbench_task_upsert ===
  TOOL RESULT = {"ok":true,"op":"task.upsert","result":{"task":{"id":"ui-task-1","title":"季度总结","done":true}}}
  AFTER  = {
 "id": "ui-task-1", "title": "季度总结", "done": true
}
✅ REPRO: priority 被静默抹掉 — priority=undefined
✅ REPRO: status 被静默抹掉 — status=undefined
✅ REPRO: dueAt 被静默抹掉 — dueAt=undefined
✅ REPRO: subtasks 被静默抹掉 — subtasks=undefined
✅ REPRO: sourceSessionId 被静默抹掉 — sourceSessionId=undefined
✅ 对照：event 侧白名单合并 → description/location 保留 — description="keepme" location="here"
```

**对照（证明这是 task 侧独有的）**：`event.update` 走 `PATCHABLE` 白名单合并
（`event-repo.js:182-206`），不丢未提供的字段（实测 `description`/`location` 保留）。

**为什么是 BLOCKER**：用户数据**无提示地消失**，且这是「创建并完成待办」这一
授权明确要求的核心路径；模型**每次**标记完成都会抹掉子任务、优先级、到期日。

**测试/变异有没有守住？**
```
$ grep -rn "保留|merge|不丢|subtasks.*保留" workbench-core/test/*.mjs
（无相关断言）
变异清单里与 task 相关的只有：
  W4 已软删待办仍进列表 / W5 service task.list 不过滤已删除
  W6 软删待办不需审批 / W7 TaskForm 编辑丢字段（**只覆盖 client.js 的 UI 侧**）
```
W7 只改 `packages/workbench-ui/client.js`；**没有任何变异覆盖 `host-tools.js` 的
`payload: (args) => ({ task: { ...args } })`** → 这条路径**零测试约束**。

**最小修法建议**：把 `task.upsert` 改成**合并语义**（同 `event.update` 的白名单合并），
或让 `host-tools.js` 的工具 payload 先读回既有行再展开。
（`host-tools.js` 不在本轮授权改动范围，但这是同一族缺陷。）

---

### 🔴 NEW-2（BLOCKER）task 侧「撤销软删」**不经审批** —— 与 `dd99ae6` 刚修好的 `event.restore` **不对称**

**性质**：`dd99ae6` 修了 `event.restore` 的审批旁路（无凭证即可悄悄恢复已删事件）。
但**同一语义在 task 侧没有对称修复**：`task.upsert` 的审批是**条件式**的
（`service.js:424-428`），只判**传入值**是否带删除标记，**不判库里那一行是否已被软删**：
```js
const isSoftDelete = task.deleted === true
  || (typeof task.deletedAt === 'string' && task.deletedAt !== '')
if (isSoftDelete) {
  requireConfirmation('task.upsert', meta, { target: task.id })
}
store.mutate((draft) => {
  ...
  else draft.tasks[index] = { ...task }   // ← 整行替换：deleted 标记被抹掉 = 复活
```

**复现命令**
```bash
node /tmp/wp4close/probe-find.mjs      # A) 段
node /tmp/wp4close/probe-decisive.mjs  # NEW-2 段
```

**实际输出（探针 A）**
```
=== A) task 侧「撤销软删」是否需要审批？（与 event.restore 的对称性） ===
  无凭证撤销软删 → code=null msg=null
  之后 task.list = [{"id":"t1","title":"被悄悄复活","deleted":false}]
❌ 撤销软删（复活已删任务）被拒绝或至少被记录为需审批 — code=null
✅ 对照：event.restore 无凭证被拒 — code=confirmation-required
```
**实际输出（探针 B，细节）**
```
  软删后 list = []
  软删后 includeDeleted = [{"id":"tx","title":"要删的待办","subtasks":[{"title":"sub"}],"deleted":true,"deletedAt":"2026-11-06T00:00:00Z"}]
  无凭证撤销软删 → code=null；list = [{"id":"tx","title":"要删的待办"}]
  审计 actor = [{"action":"task.create","actor":"user"},{"action":"task.update","actor":"ui"},
                {"action":"task.update","actor":"attacker"}]
```
→ 审计里这次「复活」的 actor 是**未授权的 `attacker`**，
与第五轮 Review 在 `event.restore` 上抓到的现象**完全一致**（当时原文：
「无凭证即可把已删事件悄悄恢复（审计里 actor 是未授权的 'attacker'）」）。

**实际输出（走真实 AI 工具链）**
```
=== NEW-2 决定性验证：真实 AI 工具路径撤销软删（完整链） ===
  删除后 task.list = []
  AI 写回结果 = {"ok":true,"op":"task.upsert","result":{"task":{"id":"ai-del","title":"已删待办"}}}
  写回后 task.list = [{"id":"ai-del","title":"已删待办"}]
  审计 = [..., {"op":"task.upsert","actor":"agent-tool"}, ...]
✅ NEW-2 AI 工具无凭证复活已软删待办 — revived=1
✅ event 侧撤销软删被拒（审批旁路已闭合） — code=confirmation-required
```
AI 工具 `workbench_task_upsert` 的 `approvalToken` 恒为 `undefined`
（`host-tools.js:112`，实测确认），但由于上面的条件式审批，
**传不带删除标记的 task 根本不触发审批** → 直接复活。

**为什么是 BLOCKER**：
1. 与本轮刚修好的 `event.restore` 是**同一个语义漏洞**，修一半留一半；
2. 用户「删除」的意图（不可见、不再出现）被**无声撤销**——待办重新出现在列表里；
3. 审计记的是 `attacker`/`agent-tool`，**没有审批凭证**；
4. 零测试约束：变异清单里**没有任何一条覆盖「撤销软删」方向**
   （`W6` 只覆盖「软删不需审批」，方向相反）。

**最小修法建议**：`task.upsert` 的审批判定改为
「**传入值带删除标记** 或 **库中该行已被软删**」→ 都要求凭证；
或引入与 `event.restore` 对称的显式恢复路径。

---

### 🟡 NIT-1 组件里仍硬编码的英文文案（延续第五轮 NIT-2，未修）

**实际输出**
```
仍硬编码的英文文案（抽样）= ["Title","Date","All day","Time","Description","Low","Normal",
 "High","Saving…","Save","Requesting approval…","Request approval & delete",
 "Loaded from Host Service","No events in the next 7 days","Nothing scheduled",
 "No tasks in this view","Select an event or task to see details","Loading…","Ready",
 "Error","Retry","All day","Repeat","Conflict"]
t() 调用次数 = 20
```
现状：`t('cancel')` / `t('delete')` 等 20 处走了 locale；但**表单标签、状态栏、空态、
确认弹窗正文与按钮**仍是硬编码英文 → 中文界面下这些区域仍显示英文。

### 🟡 NIT-2 `workbench_task_list` 工具的 `includeDeleted` 参数**未透传**

**实际输出**
```
workbench_task_list 工具参数 = {}
工具返回 = {"ok":true,"op":"task.list","result":[...]}
AI 能否列出已删待办 id：不能（工具 payload 固定为 {}）
```
`host-tools.js:167-169` 的 `workbench_task_list` 的 `payload: () => ({})` 固定空对象，
而 `workbench_event_list`（`:154`）**透传了** `includeDeleted`。⇒ AI 无法列出已软删待办
（这本身限制了 NEW-2 的可发现性，但与 event 侧行为不一致）。

### 🟡 NIT-3 `__test` 仍导出到生产 plugin 对象

**实际输出**
```
plugin keys = ["__test","apply","inject"]
✅ __test 只含组件与 callHost（无 gate/凭证签发）
   ["ConfirmDelete","EventForm","TaskForm","WorkbenchPage","callHost"]
✅ __test 不含任何可写 service 面
```
**实际风险评估：无实质风险**。`__test` 只暴露 4 个纯渲染组件与 1 个解码函数，
**不含 gate、不含 service、不含任何可写面**；拿到它们无法签发凭证、无法改数据。
但它确实让生产包里多了一份可被外部读到的组件实现 —— 属于**轻微的信息暴露 / 代码整洁度**问题，
不是安全缺陷。**不影响判定。**

### 🟡 NIT-4 报告 §六 的「鲸鱼娘 `79d7e24` dirty 0」**当场无法复核**

**实际输出**
```
$ ls -d /Users/sylas/Developer/鲸鱼娘/.git
ls: /Users/sylas/Developer/鲸鱼娘/.git: No such file or directory
$ for d in /Users/sylas/Developer/*/ /Users/sylas/*/; do git -C "$d" cat-file -e 79d7e24; done
（无任何匹配）
```
该目录**不是 git 仓库**，`79d7e24` 这个 commit 在本机所有 git 仓库里都不存在。
同一句表述在 `docs/wp2/11-WP2-R5-report.md:103`、`docs/wp3/04-final-report.md:90`
也出现过 —— 属**跨包的沿袭**，不是 WP4 独有。
该表述**不恰当**：红线核查的结论应当是「当场可复核」的事实。
（可核实的替代写法：`ls -d /Users/sylas/Developer/鲸鱼娘/.git` 不存在 +
目录 mtime 未变 + `find` 无新文件。）

### 🟡 NIT-5 `evidence/wp4/00-evidence-index.md` 与报告 §五 的**分项测试数字过期**（23/23、4/4、27/27）

见 §7.1。实测 24/24、5/5、29/29。

---

## 9. 前几轮项抽验（必查 8）

| 项 | 命令 | 实际输出 | 判定 |
|---|---|---|---|
| 无相对 require | `grep` + 探针 | `requires = ["require('react')"]` —— 只有 react | ✅ |
| locale register/bind 形状对齐 `dsh-client-ui-approval/lib/client.js:316` | 读真源码 + 探针 | 真源码：`ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-approval: dictionaries")` + `const t = ctx.locale.bind(NS)`；本包：`ctx.locale.register(NS, LOCALE)` + `ctx.locale.bind(NS)` + `inject: ['slots','remote','sessions','locale']` | ✅ |
| 软删需审批且指纹 op 对齐 | 源码 + 探针 | `event.delete`→target=id（`service.js:216`）；`task.upsert` 软删→target=task.id（`service.js:427`）；UI 侧 `op = kind === 'task' ? 'task.upsert' : 'event.delete'`（`client.js:653`）—— **一致** | ✅ |
| sessionId 取自 `retainedBy.mainView>0` | 探针 + 真 DSH 源码 | 本包 2 处 `(r?.retainedBy?.mainView ?? 0) > 0`；真源码 `dsh-client-ui-workspace/lib/client.js:105,259` 同形 | ✅ |
| 组件渲染测试能抓到作用域外引用 | 探针变异 | 变异后（`t` 越出作用域）→ `ReferenceError: props is not defined` → 测试会红 | ✅ |

**判定：PASS**（5/5）。

---

## 10. 判定

### 已通过的部分（逐条有证据）

| 检查 | 判定 |
|---|---|
| 1 冻结纪律 | ✅ 冻结副本与 `git archive dd99ae6` 逐字节一致（862 文件，diff 退出码 0） |
| 2.a `event.restore` 审批凭证 | ✅ 真 service 实测：无凭证 → `confirmation-required`；带凭证 → 成功恢复 |
| 2.b `ConfirmDelete` 传 `t` | ✅ 调用点确实传 `t`；无 `t` 时 `defaultT` 兜底不崩；变异 W12 被 CAUGHT |
| 2.c `issueForUserConfirm` 忽略 digest | ✅ 内容类 op → `fingerprint-mismatch`；`event.delete` → 仍成功；指纹等式直探确认 |
| 3 审批旁路全面复查 | ✅ DANGEROUS_OPS 7/7 受控；deny 模式 WRITE_OPS 10/10 拒绝；凭证一次性/绑定/伪造/限清单/不在 AI 工具面；AI 侧仍走真 ApprovalService；会话与 scope 隔离 |
| 4 回归三件套 | ✅ 279/279、49/49（0 VACUUM 0 SKIP）、8/8 |
| 5 隔离 boot | ✅ 零错误零 did-not-activate，Web 服务起在 127.0.0.1:64169 |
| 6 红线 | ✅ desktop profile 无 workbench-ui 行；0 remote；未 push |
| 8 前几轮项抽验 | ✅ 5/5（相对 require / locale 形状 / 指纹 op 对齐 / sessionId 来源 / 组件渲染抓作用域外引用） |

**上一轮三条修复全部真实成立**，不是提交信息层面的「已修」——
本次用独立探针重新复现，其中 2.c 的指纹等式是直探 `approvalFingerprint` 算出的。

### 阻塞项（2 个，均为**真缺陷**，不是 nit）

| 编号 | 严重度 | 内容 | 复现 |
|---|---|---|---|
| **NEW-1** | 🔴 BLOCKER | AI 工具 `workbench_task_upsert` 更新既有待办 → **静默抹掉** `priority`/`status`/`dueAt`/`subtasks`/`sourceSessionId`（服务层整行替换 + 工具只传 4 个字段），审计不记 before/after → **静默数据丢失**。与第一轮抓到的「TaskForm 编辑丢字段」同款，**第一轮只修了 UI 侧**。且 `event.update` 有白名单合并，task 侧没有 → 证明是 task 侧独有 | `node /tmp/wp4close/probe-final.mjs` |
| **NEW-2** | 🔴 BLOCKER | task 侧「撤销软删」**不经审批**：`task.upsert` 的条件式审批只判**传入值**是否带删除标记，**不判库里那一行是否已被软删** → 无凭证即可把已删待办**复活**（审计 actor = `attacker` / `agent-tool`）。与 `dd99ae6` 刚修好的 `event.restore` **语义不对称** | `node /tmp/wp4close/probe-find.mjs`（A 段）、`node /tmp/wp4close/probe-decisive.mjs`（NEW-2 段） |

**两条都是「未经测试约束的写路径」**，且都不在 `scripts/r3-mutations.json` 的 49 条覆盖范围内
（变异只覆盖 `client.js` / `index.js` / `approval-gate.js` / `host-map.js` /
`reminder-recovery.js` / `schedule-adapter.js` / `service.js`，
**`host-tools.js` 零覆盖**）。

### nit（4 个）

- **NIT-1**：组件里仍有 24 处硬编码英文文案（表单标签/状态栏/空态/确认弹窗正文与按钮），中文界面下这些区域仍是英文（第五轮 NIT-2 延续）。
- **NIT-2**：`workbench_task_list` 工具的 `includeDeleted` 未透传（`event.list` 透传了），AI 无法列出已软删待办。
- **NIT-3**：`__test` 仍导出到生产 plugin 对象。**实测无实质风险**（只含 4 个纯渲染组件 + 1 个解码函数，不含 gate/service/任何可写面），属信息暴露/整洁度问题，不影响判定。
- **NIT-4**：报告 §六 的「鲸鱼娘 `79d7e24` dirty 0」**当场无法复核** —— 该目录**不是 git 仓库**，`79d7e24` 在本机所有仓库里都不存在。同句在 WP2/WP3 报告也出现（跨包沿袭）。
- **NIT-5**：`evidence/wp4/00-evidence-index.md` 与报告 §五 的分项数字过期（实测 bridge **24/24**、渲染 **5/5**、合计 **29/29**，文档写 23/23、4/4、27/27）。

### 诚实性总评

- 主回归数字（279/49/8/10）**全部诚实**，与实测一致。
- UNVERIFIED 保留完整（14 处），无伪造图片（`evidence/wp4/` 图片文件数 = 0）。
- 审批模型文档的假断言**已改且改法诚实**（明确承认 `snapshot.replace` 等**在** `DANGEROUS_OPS` 内）。
- **但**：报告 §八 在冻结版 `dd99ae6` 里**只登记到第 4 轮**，第 5 轮不在表内、
  第 4 轮那行没写「两路冲突」—— 第五轮 Review 的 NIT-3 **未修**
  （该��在复审期间漂移到 `9b7a99f` 时才被修掉，但**被审的冻结版没有**）。
- 报告 §三「创建并完成待办」列为 ✅，但**该结论只在 UI 侧成立**；AI 工具侧做同一件事会丢字段（NEW-1）。
- 报告 §六 的「鲸鱼娘 dirty 0」不具当场可复核性（NIT-4）。

---

# 结论：REQUEST CHANGES

**不能 APPROVE 收口。** 上一轮（第五轮）的三条修复**全部真实成立**，
本次用独立探针逐条重新复现确认（不是读提交信息）；回归三件套、隔离 boot、
红线、审批旁路全面复查、前几轮抽验**全部通过**。

**但本轮主动找新缺陷，找到 2 个 BLOCKER 级真缺陷**，都在 `task` 侧、
都在 49 条变异的覆盖范围之外（`host-tools.js` 零覆盖）：

1. **NEW-1 · 静默数据丢失**：AI 工具 `workbench_task_upsert` 更新既有待办时，
   把 `priority`/`status`/`dueAt`/`subtasks`/`sourceSessionId` **全部抹掉**，
   工具返回 `ok:true`、审计不记 before/after → 用户数据无声消失。
   与第一轮 Review 抓到的「TaskForm 编辑丢字段」是**同一个缺陷的另一半**
   （第一轮只修了 UI 侧 `client.js`，服务层整行替换与 AI 工具 payload 没修）。
   `event.update` 有白名单合并而 `task.upsert` 没有 → 证明这是 task 侧独有、不是设计意图。

2. **NEW-2 · 审批旁路（与本轮刚修的 `event.restore` 不对称）**：
   `task.upsert` 的条件式审批只判**传入值**是否带删除标记，**不判库里那一行
   是否已被软删** → 无凭证即可把用户已删除的待办**悄悄复活**，
   审计 actor 记为 `attacker`/`agent-tool`。这与第五轮在 `event.restore`
   上抓到并本轮刚修好的那个漏洞**是同一个语义**，只修了一半。

**复现命令（全部只读、只跑 /tmp 副本）**
```bash
node /tmp/wp4close/probe-final.mjs      # NEW-1：AI 工具丢字段
node /tmp/wp4close/probe-find.mjs       # NEW-2：task 侧撤销软删无需审批（A 段）
node /tmp/wp4close/probe-decisive.mjs   # NEW-1 / NEW-2 的决定性验证（走真实 AI 工具 execute）
node /tmp/wp4close/probe-core.mjs       # 44 项审批/隔离/凭证约束（全 PASS）
node /tmp/wp4close/probe-ui.mjs         # 25 项 UI 契约（2.b 全 PASS）
```

**必须处理（阻塞）**
- [ ] NEW-1：`task.upsert` 改合并语义（或 AI 工具 payload 先读回既有行再展开），
      并补「更新保留未提供字段」的测试 + 变异。
- [ ] NEW-2：`task.upsert` 的审批判定改为「传入值带删除标记 **或** 库中该行已被软删」，
      并补「撤销软删需审批」的测试 + 变异。

**必须处理（收口前）**
- [ ] 报告 §八 补第 5 轮与第 4 轮两路冲突结论（冻结版 `dd99ae6` 缺）。
- [ ] `evidence/wp4/00-evidence-index.md` 与报告 §五 的分项数字更新为 24/24、5/5、29/29。
- [ ] 报告 §六 的「鲸鱼娘 `79d7e24` dirty 0」换成**当场可复核**的表述。
- [ ] 报告 §三 第 5 行「创建并完成待办 ✅」需注明适用范围（UI 侧成立；AI 工具侧待 NEW-1 修）。

**可缓（nit，不阻塞）**
- [ ] NIT-1 组件硬编码英文文案（24 处）
- [ ] NIT-2 `workbench_task_list` 的 `includeDeleted` 未透传

---

**复审员**：WP4 收口复审员（只读审查）
- 冻结副本：`/tmp/wp4-final6-freeze-dd99ae6`（commit `dd99ae6`，862 文件，与 `git archive` 逐字节一致）
- 探针目录：`/tmp/wp4close/`（`probe-core.mjs` 44 项 / `probe-ui.mjs` 25 项 /
  `probe-find.mjs` 18 项 / `probe-deep.mjs` 11 项 / `probe-decisive.mjs` 13 项 /
  `probe-final.mjs` 10 项）
- 回归副本：`/tmp/wp4close/work`（变异脚本会改源码，故先 `cp -R` 再跑）
- 主仓库：审查期间 **未被我修改**（只新增本文件）；
  HEAD 于复审期间由 `dd99ae6` 漂移到 `9b7a99f`（**仅文档**，源码零改动），
  漂移由作者造成，非本审查造成。
