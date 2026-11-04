# WP1-0 构建环境收口与上游失败测试修复

执行时间：2026-11-05（Asia/Shanghai）
授权：WP1（仅独立开发仓库 + 隔离环境；不装正式 profile、不动用户数据、不 push）
门禁结论：**PASS**（`pnpm test` = 1339 tests / 1337 pass / 0 fail / 2 skipped）

## 一、5 个失败测试：根因与修复

### 根因（已用 /tmp 诊断脚本实锤，非推断）

`src/experts/install.ts` 的 `canonicalDatabasePath()` 只做 `resolve()`（词法归一，**不穿符号链接**）。而同一个 DB 文件有两种取法：

| 取法 | 来源 | macOS 上的值 |
| --- | --- | --- |
| 打开时路径 | 夹具 `dbPath = join(mkdtempSync(tmpdir()), 'workbench.db')` | `/var/folders/.../workbench.db` |
| SQLite 真实路径 | `PRAGMA database_list` 的 `main.file` | `/private/var/folders/.../workbench.db` |

`/var` 是指向 `/private/var` 的符号链接，`resolve()` 不会解析它 → 两侧 SHA-256 不同 → `ownerDbKeyFor(context)` 与 journal 里的 `ownerDbKey` 比对失败 → 本 DB 的安装日志被误判成 `skipped-foreign-owner`，期望 `rolled-back` 的断言失败。

诊断证据（`/tmp/wp1-diag-ownerkey.mjs` 输出）：

```
dbPath          : /var/folders/.../workbench.db
PRAGMA main.file: /private/var/folders/.../workbench.db
fixtureKey      : fcc6d382b19475971e8f788d2b42d2b6a8cdd772ce1dda3d4205bcddd5655592
recoveryKey     : a5082be1e4ddcb426049414b9fcf5396646b849d17c83296ce6c5aa81e2d34ca
MATCH?          : false
--- realpathSync 归一化后 ---
MATCH2?         : true
```

### 修复（只改生产代码，测试零改动）

`src/experts/install.ts`：
- 导入 `realpathSync`，`node:path` 导入补 `basename`。
- `canonicalDatabasePath()` 改为三级归一：① `realpathSync(absolute)`；② 文件未落盘时 `join(realpathSync(dirname), basename)`；③ 父目录也不存在时退回词法 `resolve()`。任何情况下不因路径不存在而抛异常。
- 保留原有 NFC 归一与 Windows 小写归一；`ownerKeyCache`（WeakMap）未动，仍只算一次。

**为什么改生产代码是对的（独立 Review 后修正表述）**：

最初我写成「真实 profile 经符号链接也会算错，这是生产缺陷」。**独立 Review 实测推翻了这句话，我照实改**：

- SQLite `PRAGMA database_list` 的 `main.file` **永远返回 realpath**——经目录符号链接打开、经叶子符号链接打开、直接打开，三者返回完全一致（实测 `SAME? true`）。
- 生产代码里 `ownerDbKeyFor` 只有一条算 key 的路径：`computeOwnerDbKey` → 读 PRAGMA；`service.ts` 里从不注入 `ownerDbKey`（grep 为 NONE）。
- 所以**生产两侧本来就都走 PRAGMA，修复前也没有算错过**。

真实的不对称是：**测试夹具用词法 `dbPath` 算 key，生产用 PRAGMA 算 key**。修复把 `canonicalDatabasePath` 收敛到 realpath，使夹具算法与生产对齐。**修法正确，但对生产是 no-op**——它修的是「夹具与生产算法不一致」，不是「生产误判事故」。这一条已按 Review 结论改写，避免后续误判历史。

### 结果

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `pnpm typecheck` | EXIT 0 | `evidence/wp1-0/10-typecheck.log` |
| `pnpm test` | EXIT 0；**1339 tests / 1337 pass / 0 fail / 2 skipped** | `evidence/wp1-0/11-test-after-fix.log` |

修复前：1332 pass / 5 fail / 2 skipped。

## 二、2 个 skipped 测试：核实结论

两处均为**正当的平台条件跳过**，不是漏测、不是失败，代码未改动：

| 测试 | 位置 | 跳过条件 | 结论 |
| --- | --- | --- | --- |
| `workspace-check: WSL 形态 /mnt/<drive>/... 在 Windows 上映射回真实目录` | `test/workspace-check.test.mjs:111` | `{ skip: !isWindows && '仅 Windows 平台有 WSL↔Windows 映射' }` | macOS 上不适用，跳过正确 |
| `workspace-check: Windows 反斜杠真实路径（tmpdir 与项目根）通过校验` | `test/workspace-check.test.mjs:166` | `{ skip: !isWindows && '仅 Windows 平台有反斜杠路径形态' }` | macOS 上不适用，跳过正确 |

## 三、最终 pass / fail / skip 分别列出

```
# tests 1339
# pass  1337
# fail  0
# skipped 2
```

- pass 1337：含原 5 个失败（已修复转绿）+ 其余全部
- fail 0
- skipped 2：上表两项 Windows 平台条件跳过

## 四、zod 安全通告评估与升级

| 项 | 内容 |
| --- | --- |
| 通告 | GHSA-mrhx-c7xc-m3w5「Zod can exhaust memory while validating oversized constrained collections」 |
| 影响版本 | `< 4.6.6`；修复版本 `>= 4.6.6` |
| 原状态 | `zod 4.6.5`，`pnpm audit --all` 报 1 high（`findings.dev: true`，链路经 `@deepseek-ai/dsh-*` devDependencies；生产依赖仅 react + yaml，`--prod` 为 0） |
| 兼容性检查 | 消费方声明 `zod: ^4.4.3`；`4.6.7` 落在该 semver 区间内；`4.6.6/4.6.7` 的 `engines` 与 `peerDependencies` 均为空 → 不引入新约束 |
| 执行 | `pnpm update zod@4.6.6 --lockfile-only` + `pnpm install --frozen-lockfile --ignore-scripts` |
| 实际解析 | **4.6.7**（≥ 修复版本 4.6.6，满足 `^4.4.3`，属同 minor 补丁上浮） |
| 复验 | `pnpm audit --prod` = 0 漏洞；`pnpm audit --all` = 0 漏洞（info/low/moderate/high/critical 全 0） |

证据：`evidence/wp1-0/zod-upgrade.log`、`zod-install.log`、`zod-audit-prod.json`、`zod-audit-all.json`。

## 五、可复现构建环境

`scripts/wp1-setup.sh`（已 `chmod +x`，实跑 EXIT 0，日志 `evidence/wp1-0/setup-run.log`）：
1. 校验 node 版本是否在上游 `engines` 区间（`^22.19.0 || >=24.0.0`）。
2. 用上游锁定的 pnpm（Corepack 按 `packageManager: pnpm@11.7.0` 自动切换）。
3. `pnpm install --frozen-lockfile --ignore-scripts`（不执行上游生命周期脚本）。
4. **原生 binding 自愈**：检测 `@rolldown/binding-darwin-arm64` 的 `.node` 是否存在，缺失则 `npm pack` 直取并落位（WP0 的手工修复已固化；这是 npm registry `error(23)` 下载中断的已知恢复路径）。
5. 依次跑 `typecheck` → `build` → `audit --prod`，任一失败即非零退出。

幂等性：binding 已存在时跳过下载；install 用 frozen-lockfile 保证可重放。

## 六、红线合规

| 红线 | 结果 | 证据 |
| --- | --- | --- |
| 不装正式 DSH profile | 未调用任何 `plugin_manager` / `dsh plugin add` | 无相关命令 |
| 不动用户数据 | 未读写 `~/.dsh` 业务数据；测试用 mkdtemp 临时目录并自行清理 | 代码 + 日志 |
| 不 push 远程 | `git remote` = 0 个 | `git remote` 输出空 |
| 不改测试/断言 | `git status --porcelain test/` = 0 行；`git diff -- test/` 空 | 已核 |
| 不调用 Codex | 全程用 DSH 子 Agent + 主会话工具 | 无 codex 调用 |
| 鲸鱼娘工作区不动 | `plugin/` HEAD 仍 `79d7e24`、dirty 0 | 已核 |

## 七、独立 Review

由独立子 Agent 只读审查本包 diff（修复正确性 / 是否改测试 / 回归风险 / 错误处理 / zod 升级 / setup 脚本 / 红线 / 证据完整性），独立 Review 结论见 `docs/wp1/00-review-WP1-0.md`（本仓库留档）。

## 八、遗留与移交

- 无阻塞项。WP1-0 门禁 PASS，可进入 WP1-1。
- 上游快照现为「基座 + 最小补丁」状态：唯一生产代码改动是 `canonicalDatabasePath`（28 增 5 删）+ 导入行；其余为 lockfile 与新增脚本/证据。后续任何上游文件改动都须在此记录并保留 diff 以便回退。
