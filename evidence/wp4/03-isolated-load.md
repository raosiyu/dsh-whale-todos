# WP4 隔离环境加载验证

## 环境
- `DSH_HOME=/tmp/dsh-iso-Jv2UeM`（隔离，`rescue` profile，web 模板）
- 当前 GUI 正式 profile = `desktop`，**未修改**
- 安装：`DSH_HOME=/tmp/dsh-iso-Jv2UeM dsh plugin --profile rescue add /Users/sylas/Developer/dsh-workbench/packages/workbench-ui`
  → `@local/dsh-workbench-ui link:...`，pnpm 53ms，无构建脚本
- 启动：`DSH_HOME=... dsh --profile rescue --patch /tmp/wp4-isolated-patch.yml --no-open --port 0`
  （`--patch` 把 `rootDir` 覆盖到 `/tmp/dsh-iso-Jv2UeM/workbench-data`，避免落用户数据）
- 独立端口 `127.0.0.1:50981`，**不与当前 GUI 冲突**；有界启动 12s 后停止

## 第一次启动（发现真缺陷）
```
workbench-ui (@local/dsh-workbench-ui): Error: cannot get property "approval" without inject
dsh: warning: 1 entry did not activate
```
根因：`apply()` 读 `ctx.approval?.request`，但 `inject = ['commands']` 未声明
`approval`，真 Cordis 拒绝访问未声明服务。静态单测测不到这一层。

修法：改用 `ctx.get('approval')` 读可选服务；缺失时 Host Service
fail-closed（危险操作拿不到 token），与 `dsh-user-approval` 的
`unavailable` 语义一致。

## 第二次启动（修复后）
```
STILL RUNNING (boot 未崩溃)
（grep workbench/error/failed/did not activate 全部为空）
dsh web: http://127.0.0.1:50981/?token=...
```
→ **`ctx.provide('workbench')` + `ctx.commands.register` 在真 Cordis 中激活成功**。

## 红线核查
- `~/.dsh/profiles/desktop/package.json` mtime 仍为 `Nov 5 21:32:55 2026`（未变）
- `~/.dsh/profiles/desktop/cordis.patch.yml` 中 `grep -c workbench-ui` = 0
- 0 remote，未 push

## 诚实边界（按 references/verification.md）
- 这证明 **Host 半边**在真实隔离环境激活、配置层 compose 正确。
- **Client 半边（浏览器渲染 / main slot 与 sidebar.panellist 的实际画面）未验证**：
  Client Inspect Provider 在本会话对合法 `{}` 一律报
  `"input" must be an object`，且 `verification.md` 禁止从 shell 另起浏览器、
  禁止找 rasterizer、禁止模拟 React-DOM 补截图。
- 因此**深浅色截图、窗口缩放、真实点击交互**列为 **UNVERIFIED**，不伪造。
- 配置层证据：`--dump-config` 输出末尾含
  `# == @local/dsh-workbench-ui` / `- id: workbench-ui` / `rootDir: /tmp/...`。

## 复核命令
```bash
DSH_HOME=/tmp/dsh-iso-Jv2UeM dsh --profile rescue --patch /tmp/wp4-isolated-patch.yml --dump-config | grep -A3 workbench-ui
cat evidence/wp4/02-isolated-boot-after-fix.log
```
