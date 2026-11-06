# WP5 交付记录

生成时间：2026-11-06
基线：`07255ee`（WP4 收口）→ HEAD `8f7a4e2`

## 一、交付内容

| 能力 | 实现方式 | 复用服务端 op |
| --- | --- | --- |
| 日历拖拽改期 | 事件块 `draggable` → 日期格 `onDrop` | `event.move` |
| 跨日期移动 | 同上，目标日期由落点格决定 | `event.move` |
| 重复事件范围 | `MoveScopeDialog` 询问「只改这一次 / 改整个系列」 | `event.move` + `occurrenceDate` |
| 待办拖拽排序 | `wb-handle` 手柄拖拽 | `task.reorder`（传完整顺序） |
| 项目分组 | 按 `project` 分组，组内按 `order` 排序 | `task.list` |
| 归档 / 恢复 | 归档区折叠面板 | `task.archive` / `task.unarchive` |
| 导入预览 | `ImportPreview` 四类计数表 | `event.previewIcs` / `snapshot.preview` |
| 导入执行 | 用户确认 → Host 签发 token | `event.import` / `snapshot.replace` |
| 撤销 / 重做 | 工具栏按钮 + Ctrl/Cmd+Z | `history.undo` / `history.redo` |
| 失败回滚 | 失败即 `load()` 回真实值，无乐观更新 | — |
| 键盘替代 | 待办 ↑/↓；事件 ←/→ 改期 | 同 reorder / move |

## 二、验证证据

### 真机交互（隔离 DSH profile，端口 56529）

| 操作 | UI 观察 | Host 磁盘核对 |
| --- | --- | --- |
| 归档「今晚要提醒我开会」 | 出现「▸ 已归档 (1)」，撤销深度 11→12 | `archived=true, deleted=false` |
| 撤销 | 撤销深度 12→11，重做 0→1 | `archived` 清空 |
| 重做 | 撤销 11→12，重做归零 | `archived=true` 恢复 |
| 排序 ↑（排序测试 C） | 位置从第 3 升到第 2 | `order` 12→4，排到 B(5) 之前 |
| 刷新页面 | 顺序 复审数据导入 / A / C / B | 与磁盘一致 |
| 导入预览 | — | 2 条 `create` + 1 条 `conflict` |
| 无 token 导入 | — | `confirmation-required` 拒绝 |

证据文件：
- `evidence/wp5/interaction/01-dom-tasks-view.txt` —— 任务页真实 DOM 快照
- `evidence/wp5/interaction/02-host-state-after-reorder.json` —— 操作后的 Host 落盘原文
- `scripts/verify-wp5-ui.mjs` —— 上述检查的可复跑脚本（7/7 通过）

### 测试

```
node --test workbench-core/test/*.test.mjs
# pass 340
# fail 0
```

### 变异测试

```
node scripts/r3-mutate.mjs <log> scripts/r3-mutations.json
CAUGHT: 70    VACUUM: 0    SKIP: 0
```

## 三、未验证项（如实记录）

1. **文件选择器未经真机手势验证。** 原生文件对话框无法由浏览器自动化驱动，
   `input[type=file]` 的 `change` 事件未真实触发。导入的服务端契约
   （预览分类、审批拒绝）已独立验证，但「点导入 → 选文件 → 出预览」这一整条
   UI 链路未走通真机。
2. **拖拽未用真实鼠标手势。** 排序改用 ↑/↓（同一条 `task.reorder` 路径）
   验证落盘；事件拖拽的 `event.move` 路径由单测覆盖。HTML5 dragstart/drop
   事件序列本身未经真机触发。
3. **截图未落盘。** 浏览器工具只回图像内容，不返回文件路径；CDP 端口未开放。
   因此以 DOM 快照 + Host 磁盘状态作为可复核证据，而不是截图。
4. **浅色/深色主题、多窗口尺寸**未截图验证。新增 CSS 全部走 `--dsw-alias-*`
   令牌，理论随主题切换，但未实际切换主题观察。
5. **`ctx.schedule` 提醒接线**仍未完成，`reminder.plan` 目前只走
   `backend:'memory'`。这是 WP3 遗留，不在 WP5 范围内。
6. **全历史本机用户名** 436 处（`/Users/sylas`），改写需 force push，
   授权禁止，留待人工决定。HEAD 已干净。

## 四、关键教训

1. **同一条件抄多份、只测一份 = 假绿。** W4 变异把「已软删不进列表」删掉后
   337 个测试全绿，因为该条件在 `client.js` 里抄了 3 遍而测试只覆盖 1 处。
   修法不是加更多正则断言，而是抽成唯一的 `isSoftDeleted` 并做行为断言。
2. **静态断言挡不住近似改名。** 断言 `'confirmUserAction'` 时，
   `'confirmUserActionX'` 也能通过。必须断言结构（`op:\s*'confirmUserAction'`）
   并切到正确的函数体范围内（同一字面量出现两次时尤其重要）。
3. **变异存活优先于测试数量。** 340 个测试全绿不等于保护有效；
   VACUUM 计数才是保护是否真的被约束的证据。
4. **检查器不能与被检查对象共用硬编码事实。** 审计脚本一度自己写死
   本机用户名，导致「检查器自身成为污染源」；改为从路径推导。
