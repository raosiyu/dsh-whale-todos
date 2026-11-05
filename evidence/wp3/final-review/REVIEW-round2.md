# WP3 修复后最终独立 Review（第二轮）

- 状态：**进行中**
- 审查对象：`/tmp/wp3-final2-freeze-17f79e8`（基准 commit `17f79e8`，829 文件）
- 主仓库：`/Users/sylas/Developer/dsh-workbench`（HEAD=`17f79e8`，只读，不改）
- 探针目录：`/tmp/wp3final2/`（直接 import 冻结目录 `workbench-core/src/index.js`）
- 产物：`/Users/sylas/Developer/dsh-workbench/evidence/wp3/final-review/REVIEW-round2.md`
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
