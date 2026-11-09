# V1.1 真实界面验证记录

## 环境
- 隔离 DSH_HOME：`/tmp/dsh-iso-v11b`
- 隔离数据目录：`/tmp/dsh-iso-v11b/workbench-data`
- 启动方式：`DSH_HOME=/tmp/dsh-iso-v11b dsh --profile v11b --port 3081 --no-open`
- **正式 Desktop profile（/Users/sylas/.dsh/profiles/desktop）全程未改动**

## §1 待办日期缺陷修复

| 项 | 修复前 | 修复后 |
|---|---|---|
| 表单控件 | 裸文本框 + `placeholder='2026-11-10T09:00:00Z'` | 原生 `date` + `time` 控件 |
| 新建默认值 | 空串（placeholder 是假的） | 真实预填今天 09:00 |
| 保存结果 | `delete next.dueAt`，无截止 | `dueAt` 带 +08:00 偏移 |

磁盘实证：`t-1794205954556-8hn3s7` → `dueAt = "2026-11-09T09:00:00+08:00"`

界面实证：新建表单显示「到期日期 2026/11/09」「到期时刻 09:00」，保存后列表显示 `2026-11-09`，落在「今日」视图。

## §2 Agent 协作面板六项能力

真实界面截图验证（任务 T-COLLAB-V11）：

| # | 能力 | 界面证据 |
|---|---|---|
| 1 | 任务关联 | `sess-agent-clarify · clarify — 澄清需求`、`sess-agent-exec · execute — 负责实现`，各带「复制」按钮 |
| 2 | 执行进度 | 80% + 进度条 + 状态徽标「等待你验收」 |
| 3 | 完成申请 | 「待用户验收（任务尚未完成）」 |
| 4 | 人工验收 | 「通过验收」「驳回」按钮，实测通过后 done=true |
| 5 | 实时刷新 | 8 秒轮询；Agent 写入后刷新即显示 |
| 6 | 处理记录 | 执行记录 4 条，含进度/备注/证据 `[commit abc123]`、`[test.log]` |

## 验收红线实测

| 攻击路径 | 结果 |
|---|---|
| Agent 调 `task.acceptCompletion` | 拒绝「待办不存在」 |
| Agent 用 `task.upsert` 写 `done=true` | 拒绝「Agent 不能直接设置完成态，请走 task.requestCompletion 申请、由用户验收」 |
| Agent 写 `progress=100` | 拒绝「进度必须在 0..99；完成请走完成验收申请，不能自行置 100」 |

最终 `done = false` —— **Agent 无法自行完成任务**。

## 本次顺带修掉的真实缺陷

1. `task.list` 未合并 `sessionLinks` / `executionLog` —— 详情面板读这两个键，而合并层只给了 `recentLog`，Agent 关联了会话界面仍显示「暂无」。
2. `byTask.set(taskId, a)` 覆盖 —— 多会话关联时只剩最后一个会话，前面全部丢失。改为按 taskId 聚合。
3. `linkSession` 跨工作区报「待办不存在」 —— 与 `writeProgress` 的跨区支持不对称，多个 Agent 协作从第二步就断。

## 契约边界（不伪报）

插件层**没有**会话跳转契约（`docs/wp6/00-contract.md` §7.1 一手核实）。「从任务进入会话」落地为**可复制的 sessionId**，不自造 `openSession`。

## 未验证项

- 正式 Desktop 升级（等用户确认）
- 跨机安装验证

## 独立安装验证（全新环境）

| 项 | 结果 |
|---|---|
| 环境 | `/tmp/dsh-iso-install`（全新 DSH_HOME，端口 3082） |
| 安装 | `dsh plugin --profile inst add dsh-whale-workbench-1.1.0.tgz` |
| 加载 | `import('dsh-whale-workbench')` → `name = workbench-ui` |
| 界面 | 侧栏出现「鲸鱼待办」，日历/待办正常渲染 |
| 日期 | 新建表单预填今天 09:00，保存后 `dueAt = "2026-11-09T09:00:00+08:00"` |

### 独立安装才发现的两个打包缺陷（1.0.0 同样存在）

1. **相对导入跳出包目录**
   `index.js` 用 `../../workbench-core/src/index.js`（开发仓库层级）。
   发布包里 `../..` 解析到 profile 根目录 → `Cannot find module
   .../profiles/<name>/workbench-core/src/index.js`。
   用 `link:` 安装时恰好指回开发目录，所以本地一直"好用"。
   修复：改为包内相对路径 `./workbench-core/src/...`。

2. **模块注册 id 与包名不一致**
   `client.js` 注册 `id: '@local/dsh-workbench-ui'`（开发包名），
   宿主按发布包名 `dsh-whale-workbench` 查找 →
   `loaded without registering "dsh-whale-workbench" via __ModuleLoader__.load`，
   整个 web 启动失败，界面只剩 "Failed to load plugins"。
   修复：发布分支的注册 id 改为包名。

**这两个缺陷 1.0.0 的发布包同样存在** —— 之前只做过 `link:` 安装，
没做过真实 tarball 独立安装，所以从未暴露。
