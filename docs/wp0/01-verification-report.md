# WP0 验证报告

执行时间：2026-11-04 23:52 → 2026-11-05（Asia/Shanghai）
授权范围：仅 WP0「基座建立与事件域验证」。**WP0 完成后 STOP，未进入 WP1。**
PUA：本轮有可见 🟠 阿里味输出，按要求**不记录评分**。

## 0. 红线遵守核对（逐条）

| 授权要求 | 执行情况 | 证据 |
| --- | --- | --- |
| 1. 独立项目 `/Users/sylas/Developer/dsh-workbench` | ✅ 新建，执行前 `ls` 确认不存在；未修改鲸鱼娘工作区任何既有文件 | `evidence/wp0/` 日志、鲸鱼娘 `plugin/` git HEAD `79d7e24` 前后一致 |
| 2. 锁定 v1.17.2 / 0.14.5，核实源码、依赖、许可证 | ✅ 见 §1–§3 | `evidence/wp0/00-artifact-sha256.txt`、`LICENSES/` |
| 3. 保留 MIT / BSD-3-Clause 署名，建 Git 基线 | ✅ 见 §4、§7 | `LICENSES/ATTRIBUTION.md`、git log |
| 4. 验证 Event 实体/持久化/CRUD/真实日程；已有明确缺失证据不重复测试 | ✅ 源码级复核，见 `03-event-domain-verdict.md`；**未做落库实测**（按授权跳过） | `schema.ts:29-105`、`src/api/routes/`、`CalendarView.tsx` |
| 5. 运行类型检查、单元测试、安全检查，记录失败项 | ✅ 见 §5，**失败项原样记录** | `evidence/wp0/02..05` |
| 6. 如需运行 DSH 插件必须独立测试环境，不装正式 profile | ✅ **本包未运行 DSH、未安装任何插件** | 无 `plugin_manager` 调用记录 |
| 7. 不修改/迁移/清空 DSH 用户数据，不擅自推远程 | ✅ `~/.dsh` 只读存在性检查，无写入；git 无 remote、无 push | §8 |
| 8. WP0 完成后输出报告、commit、风险、修订 WP1 计划，STOP | ✅ 本文件 + `WP1-plan-revised.md` + git commit；完成后停止 | — |

## 1. 版本锁定与制品校验

| 上游 | 锁定方式 | 快照 sha256 | 说明 |
| --- | --- | --- | --- |
| Dely0/dsh-personal-workbench v1.17.2 | `codeload.github.com/.../tar.gz/refs/tags/v1.17.2` | `9158f87f8c6eac1574f9dab7afdbad6c1a5f2e9ebb4caaaf7bac2bc8a8c313ee` | 4,544,020 B / 解压 11,427,840 B / 644 文件 |
| dsh-calendar 0.14.5 | `codeload.github.com/.../tar.gz/29dc9ef3`（**tag 名 `v0.14.5` 返回 404，改用 release commit SHA**） | `23f98a06c834b428a97779abc17347adaf0a9492954a39f18d2919bbce0c460d` | 2,674,748 B / 解压 3,768,320 B / 134 文件 |

npm pack 交叉校验：`@dely0/dsh-personal-workbench@1.17.2`（`42836eea…`，323 文件）、`dsh-calendar@0.14.5`（`9f597a9f…`，68 文件）。
**发现**：`v0.14.5` tag 名 404 —— 0.14.5 的发布 commit 是 `29dc9ef3`（「fix: encode CalDAV credentials as UTF-8 (0.14.5)」），仓库未用 `v0.14.5` 形式打 tag。已用 commit 锁定，可复现。

工具链：git 2.54.0 / node v22.23.2 / pnpm（Corepack 自动切 **v11.7.0** 以匹配上游 `packageManager`）/ npm 10.9.8 / curl 8.7.1 / jq 1.7.1。

## 2. 源码与依赖核实

**Dely0 v1.17.2**（`package.json`）：
- `license: MIT`；`engines.node: ^22.19.0 || >=24.0.0`（本机 v22.23.2 命中）；`packageManager: pnpm@11.7.0`（Corepack 已切）。
- `dependencies`: react ^18.3.1、yaml 2.9.1（仅 2 个生产依赖）。
- `peerDependencies`: cordis ^4.0.1、dsh-commands / dsh-host-webserver / dsh-scope / dsh-system-prompt / dsh-tools 的 `^0.1.x || ^0.2.0-rc.1` 并列区间（本机 DSH `0.2.1-rc.5` 命中）。
- `devDependencies`: cordis 4.0.4、各 dsh-* 0.2.0-rc.2、cordis-plugin-timer 1.1.6、tsdown 0.22.2、typescript ~5.7.2。
- `scripts`: `typecheck`(tsc --noEmit)、`build`(build-info + tsc + tsdown)、`test`(先 build 再 `node --test --test-concurrency=1 test/*.test.mjs`)、`test:local`。
- 测试文件：**94 个** `test/*.test.mjs`。

**dsh-calendar 0.14.5**：`license: MIT`；`engines.dsh: >=0.2.1-rc.3`（本机命中）；`dependencies`: ical.js ^2.1.0、timezones-ical-library 2.3.2、tsdav ^2.3.1、undici ^8.11.2、schemastery、@stardustlc/dsh-updates 等；`dsh.client.inject` 三个 ui-* 包；`cordis.patch.yml` 凭据推荐环境变量。

## 3. 许可证与署名

- 逐字复制并 `cmp` 校验通过：`LICENSES/Dely0-MIT.txt`、`dsh-calendar-MIT.txt`、`novotnyllc-dotnet-artisan-MIT.txt`、`K-Dense-scientific-agents-MIT.txt`、`Dely0-THIRD_PARTY_NOTICES.md`。
- `THIRD_PARTY_NOTICES.md` 内含 **dsh-task-board（BSD-3-Clause，全文内嵌 §85–125）**、dsh-genui（MIT）、Guojing6/dsh-workbench（MIT）、SnowNight777/dsh-personal-workbench（MIT）的署名与改动说明。
- `LICENSES/ATTRIBUTION.md` 建索引，明确后续移植逐文件保留 MIT 头、BSD-3-Clause 禁止背书条款。

## 4. 事件域验证（核心结论）

详见 `03-event-domain-verdict.md`。要点：
- **确认缺失**：`schema.ts` 18 张表无独立 `events`；`src/api/routes/`（14 文件）无 events/calendar 路由；`src/db/repo/`（21 文件）无 events.ts；`CalendarView.tsx` 仅周/月 + `tasks: Task[]` 日期面板；全 `src/` 无 availability/conflict/dnd/timezone 模块。
- **易误判陷阱**：`task_events` 表是**任务验收事件流水**（`completion_rejected`/`completion_deferred`），不是日程事件。已用 `src/db/repo/progress.ts:131-136` 与 `contracts.ts:81` 证实。
- **部分具备**：`tasks` 表已有 `all_day`、`recurrence_code/rule/master_id/last_generated`、`due_at`；即任务的全天/重复/截止时间可复用语义，但非 iCalendar RRULE/VEVENT。
- **判定**：双源方案成立；WP1 必须新建 Event 域（实体 + CRUD + 冲突 + 拖拽 + 日/议程视图 + RRULE/DST）。按授权第 4 条，**未做重复落库实测**。

## 5. 验证命令与结果（失败项原样记录）

| # | 检查 | 命令 | 结果 | 日志 |
| --- | --- | --- | --- | --- |
| 1 | 依赖安装 | `pnpm install --frozen-lockfile --ignore-scripts` | ✅ exit 0；95 包；`Lockfile passes supply-chain policies (115 entries)`；Corepack 切 pnpm v11.7.0 | `01-pnpm-install.log` |
| 2 | 类型检查 | `pnpm typecheck` | ✅ **EXIT 0**，无错误 | `02-typecheck.log` |
| 3 | 构建 | `pnpm build` → 修复后 `pnpm build` | ❌ 初跑 **EXIT 1**：`tsdown`/`rolldown@1.1.5` 报 `Cannot find native binding`，缺 `@rolldown/binding-darwin-arm64` 的 `.node` 文件（安装时该 tarball `error (23)` 下载中断）；✅ **重跑 EXIT 0**（见 §5「修复尝试」），产出 `lib/client.js 663.72 kB` | `03-build.log`、`06-build-retry.log` |
| 4 | 单元测试 | `pnpm test`（脚本内先 build 再 `node --test` 94 文件） | ❌ 初跑 **EXIT 1**（被 #3 阻断，测试未执行）；⚠️ **重跑 EXIT 1**：`# tests 1339 / pass 1332 / fail 5 / skipped 2`。5 个失败全部在 `test/expertInstall.test.mjs` 与 `test/expertRecovery.test.mjs`（`ownerDbKey` / AX-E22 主日志备份补偿 / AX-E23 恢复期锁），属**专家角色库安装恢复**测试，与 Event 域无关；断言 `expected 'rolled-back'` / `actual 'skipped-foreign-owner'`。已验证并**证伪**「`DSH_PROFILE*` 环境变量泄漏」假说（清环境后失败不变），定位为 `canonicalDatabasePath` 路径规范化导致的**上游专家恢复测试既有缺陷**，与 Event 域无关 | `04-test.log`、`07-test-retry.log`、`08-test-env-clean.log` |
| 5 | 生产依赖审计 | `pnpm audit --prod` | ✅ exit 0；`{info:0,low:0,moderate:0,high:0,critical:0}` | `05-audit-prod.json` |
| 6 | 全依赖审计 | `pnpm audit --json` | ⚠️ exit 1；**1 high**：`zod 4.6.5` / GHSA-mrhx-c7xc-m3w5「Zod can exhaust memory while validating oversized constrained collections」，`vulnerable <4.6.6` / `patched >=4.6.6`；findings 全部 `dev:true`，链路经 `@deepseek-ai/dsh-*` devDependencies；**生产依赖 0 漏洞** | `05-audit-all.json` |
| 7 | 凭据/私钥扫描 | `grep -rniE 'BEGIN PRIVATE KEY\|AKIA…\|sk-…\|ghp_…\|password=…'` | ✅ 0 个私钥/令牌字面量；2 处 `password:` 命中经 `lib/client.js:2178-2190` 复核为 i18n key 与 `SECRET_FIELDS` 脱敏白名单，非泄漏凭据 | 本文件 §5 说明 |
| 8 | 锁文件完整性 | `grep -c 'resolution:' pnpm-lock.yaml` | ✅ 115 条，与供应链校验一致 | — |

**修复尝试（如实记录）**：
- `pnpm install --force --ignore-scripts` → 仅回 `Already up to date`，空 binding 目录未恢复（**同一手法重试无效**）。
- 换本质不同的手段：直接 `npm pack @rolldown/binding-darwin-arm64@1.1.5` 取原生 tarball（7,067,543 B，含 `rolldown-binding.darwin-arm64.node` 16.3 MB）手工落位到 pnpm 期望路径 → **`pnpm build` 重跑 EXIT 0**（`lib/client.js 663.72 kB`）。证明 build 红是下载中断的环境产物，不是上游 TS 代码缺陷。
- 5 个测试失败的假说验证：初判「DSH Desktop 会话 `DSH_PROFILE*` 环境变量泄漏污染 fixture」。实测 shell 确有 `DSH_PROFILE=desktop` / `DSH_PROFILE_DIR=/Users/sylas/.dsh/profiles/desktop` / `DSH_HOME`；但用 `env -u` 全清后**单跑那 2 个文件仍 25 tests / 20 pass / 5 fail，失败项一字不差**（`08-test-env-clean.log`）→ **假说证伪，如实推翻**。
- 读 `test/expertInstall.test.mjs:1005-1010`：fixture 用 `sha256Hex(canonicalDatabasePath(dbPath))` 生成 `ownerDbKey` 写 journal，恢复逻辑却判为 `skipped-foreign-owner`（期望 `rolled-back`）。属上游**专家角色库安装/恢复**在本机 Node 22.23.2 + macOS 路径规范化下的既有测试缺陷，非 Event 域、非本包改动引入。
- 按治理红线：**不改测试、不改评分器、不放宽验收、不伪造通过**。这 5 个失败作为「上游既有测试债」证据化交接给 WP1-0（构建环境收口）处理。

> **诚实口径**：typecheck、安装、`audit --prod`、凭据扫描、供应链校验是真实绿；build 修复后真实绿；`pnpm test` 重跑 **1332/1339 pass，5 fail / 2 skipped** 是真实未全绿，不隐瞒、不夸大。5 个失败已定位到与 Event 域无关的专家恢复测试，且已排除环境变量假说。zod high 是真实的 dev-only 通告，不擅自改锁文件版本（属 WP1 范畴）。

## 6. 安全检查结论

- 无明文私钥/API key/令牌；dsh-calendar 的凭据设计走 `DSH_CALENDAR_*` 环境变量 + `SECRET_FIELDS` 脱敏。
- `pnpm install` 使用 `--ignore-scripts`，**未执行任何上游 postinstall/preinstall 脚本**。
- 供应链：上游自带 lockfile 策略校验（115 条）通过；生产依赖审计 0 漏洞。
- 唯一安全债务：dev 链 `zod 4.6.5` 的 high 通告（GHSA-mrhx-c7xc-m3w5），WP1 需评估升级到 >=4.6.6 或确认不触达「超大 constrained collections」路径。

## 7. Git 基线

- 独立 `git init` 于 `/Users/sylas/Developer/dsh-workbench`；**无 remote**（未推任何远程仓库）。
- 基线 commit 见本文件末尾「交付清单」或 `git log -1 --stat`。
- `.gitignore` 排除 `node_modules/`、`lib/`、`.pnpm-store/`、`*.tgz/.tar.gz`、`.env*`、`*.pem/*.key`；证据中的日志/校验和文本入库，二进制不入库。

## 8. 用户数据与正式 profile 零改动证明

- `~/.dsh/workbench`：执行前不存在，执行后**未创建**（只读检查）。
- `~/.dsh`：仅做存在性 `ls`，无写入、无迁移、无清空。
- 未调用 `plugin_manager`、未执行 `dsh plugin add`、未安装到任何 Desktop/Web profile。
- 鲸鱼娘 `plugin/`（dsh-whale-gen）git HEAD 仍为 `79d7e24`，`git status --porcelain` 无改动。
- 鲸鱼娘根目录仍非 git 仓库，`workbench-plan/` 三份规划文档未被修改。

## 9. 交付清单

| 产出 | 路径 |
| --- | --- |
| 本验证报告 | `docs/wp0/01-verification-report.md` |
| 事件域结论 | `docs/wp0/03-event-domain-verdict.md` |
| 修订后 WP1 计划 | `docs/wp0/02-WP1-plan-revised.md` |
| 技术风险登记 | `docs/wp0/04-risks.md` |
| 证据日志 | `evidence/wp0/00–07` |
| 署名索引 | `LICENSES/ATTRIBUTION.md` |
| 项目说明 | `README.md` |

**WP0 状态：完成（含 2 个环境相关失败项与 1 个 dev-only 安全通告的证据化交接）。STOP，不进入 WP1。**
