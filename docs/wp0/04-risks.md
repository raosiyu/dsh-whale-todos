# WP0 技术风险登记

口径：四栏齐全（trigger / impact / mitigation / verification），不写「无」「n/a」。验证方式写「单测」必须指到真实存在的测试文件；本包未写新代码，故多数用「人工核对 / 命令复跑」。

| # | 风险 | 触发 | 影响 | 缓解 | 验证 |
| --- | --- | --- | --- | --- | --- |
| R-W0-1 | **原生二进制下载中断导致 build/test 不可跑** | npm registry 对 `@rolldown/binding-darwin-arm64@1.1.5` tarball 返回 `error (23)`；本次已发生 | `tsdown`/`pnpm build` MODULE_NOT_FOUND，94 个单测未执行，无法用上游测试证明基线可构建 | 换通道直接 `npm pack` 原生 tarball 手工落位；或改用 `npm install`/Corepack 重装；**不改上游锁文件与源码** | 人工核对：`evidence/wp0/06-build-retry.log` 与 `07-test-retry.log` 的 EXIT/测试汇总；若仍红，作为环境限制交接，不伪造通过 |
| R-W0-2 | **dev 链 zod 4.6.5 high 通告** | `pnpm audit --json` 命中 GHSA-mrhx-c7xc-m3w5（超大 constrained collections 内存耗尽），`<4.6.6` | 开发环境构造超大校验输入时可能 OOM；生产依赖 0 漏洞 | WP1 评估升级 zod ≥4.6.6 或确认不触达该路径；本包**不擅自改依赖版本**（属 WP1 授权范围） | 人工核对：`pnpm audit --prod --json` 为 0；`05-audit-all.json` advisories 详情；升级后复跑 audit |
| R-W0-3 | **tag 名与版本不一致** | dsh-calendar `v0.14.5` tag 返回 404 | 若按常见 tag 命名取源码会拿到空/错版本 | 已用 release commit `29dc9ef3` 锁定，并在 README/报告中注明；后续任何再取都以该 SHA 为准 | 人工核对：`tar tzf` 顶层目录 `dsh-calendar-29dc9ef3/`、`package.json` version `0.14.5`、`evidence/wp0/00-artifact-sha256.txt` |
| R-W0-4 | **`task_events` 同名误判** | 后续开发者看到 schema 里有 `task_events` 就以为已有事件域 | WP1 漏建 Event 实体，日历需求落空 | `03-event-domain-verdict.md` 明确其为验收事件流水（`completion_rejected`/`completion_deferred`），并在 WP1 计划把「新建 Event 域」列为第一票 | 人工核对：`schema.ts:94-105`、`src/db/repo/progress.ts:131-136` |
| R-W0-5 | **宿主契约漂移** | DSH 从 0.2.1-rc.5 升级，或 peer 区间不再命中 | 面板整块不启动（Dely0 刻意不降级，README L61/L67） | 锁本机 0.2.1-rc.5 基线；移植模块前用 `cordis_inspect_query` 复核 slot/inject；WP1 用隔离 profile | 人工核对：干净 profile 安装后重启 dsh web，逐项点验面板/模型选择器/AI 执行弹窗「开始」/提醒投递 |
| R-W0-6 | **许可证署名遗漏** | fork 后只带 `LICENSE` 不带 `THIRD_PARTY_NOTICES.md` | 违反 MIT 保留声明与 BSD-3-Clause 条款 | `LICENSES/ATTRIBUTION.md` 索引 + 逐字复制 5 份许可文本；后续移植逐文件保留 MIT 头 | 人工核对：`cmp` 结果（已通过）、`LICENSES/` 目录清单 |
| R-W0-7 | **上游 schema 回退脆弱** | 未来版本升级/回退（历史事故 `docs/issues/2026-09-12-plugin-rollback-schema-too-new-boot-failure.md`，v1.16.0 schema 18→19） | 启动失败、数据不可读 | WP1 迁移前自动备份 + 版本号 + 一键回滚；不在 WP0 动任何用户数据 | 人工核对：WP1 迁移单测（旧样本→迁移→全量比对 + 回滚还原），文件 `test/migration.test.mjs`（WP1 新建，当前不存在） |
| R-W0-8 | **macOS 桌面端验收被上游推迟** | V1.17.0/V1.16.4 发布说明把「桌面端人工点验」列被推迟，README 装向 `--profile web` | 系统通知、退出/休眠/重启后提醒行为在 Desktop 未验证 | WP7 用独立隔离环境做三场景端到端；不在正式 profile 装 | 人工核对：`ctx.schedule.history()` 投递记录 + 三场景脚本输出（WP7 交付） |

## 与 Phase 0 风险表的关系

本表是 WP0 实测后新增/细化的技术风险，不替代 `workbench-plan/README.md` §6.1 的 9 条项目级风险；两者叠加执行。新增最有价值的是 **R-W0-1（真实构建阻塞）**、**R-W0-3（tag 命名）**、**R-W0-4（同名误判）**，均为 Phase 0 文档阶段不可见、WP0 实跑才暴露的问题。
