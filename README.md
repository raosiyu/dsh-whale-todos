# 鲸鱼待办 · DSH Desktop 插件

日历、待办、AI 智能规划、提醒与 Agent 工具，全部数据留在本机。

- 版本：**1.2.0**
- 包名：`dsh-whale-workbench`
- 数据：仅本机，无网络请求

---

## 一、安装

### 1. 安装包本体

```bash
cd ~/.dsh/profiles/desktop
pnpm add /path/to/dsh-whale-workbench-1.2.0.tgz
```

### 2. 声明为 bundle

编辑 `~/.dsh/profiles/desktop/package.json`，在 `dsh.profile.bundles` 数组末尾加入：

```json
"dsh-whale-workbench"
```

### 3. 指定数据目录（**必做**）

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，在文件**最开头**加入：

```yaml
- insert:
    - id: workbench-ui
      name: 'dsh-whale-workbench'
      config:
        rootDir: '/Users/<你>/.dsh/workbench-data'
```

`rootDir` 必须是**已存在或可创建的空目录**，用于存放你的待办数据。

> ⚠️ 插件在 `rootDir` 为空时**会拒绝启动**并报错
> `workbench-ui requires config.rootDir ... refusing to guess a user-data path`。
> 这是刻意的保护：插件不会猜测路径，避免把数据写到你没指定的地方。

### 4. 重启 DSH Desktop

重启后左侧栏出现「鲸鱼待办」。

---

## 二、卸载

```bash
cd ~/.dsh/profiles/desktop
pnpm remove dsh-whale-workbench
```

同时从 `package.json` 的 `bundles` 和 `cordis.patch.yml` 的 insert 段里移除对应条目，然后重启。

**卸载不会删除你的数据**——数据在 `rootDir` 里，离开插件仍然存在。重新安装并指回同一 `rootDir` 即可恢复。

---

## 三、功能

| 模块 | 说明 |
| --- | --- |
| 日历 | 月 / 周 / 日 / 议程四视图，事件增删改、冲突检测、重复规则 |
| 待办 | 今日 / 计划中 / 进行中 / 已完成 四桶，拖拽排序、归档、撤销重做 |
| AI 智能规划 | 输入目标 → 拆解子任务 + 按真实空闲时段排期 → 预览确认后写入 |
| 提醒 | 基于排期自动生成专注提醒 |
| Agent 工具 | 27 个 `workbench_*` 工具，Agent 可读写待办与日历（危险操作走审批） |
| 导入导出 | ICS / JSON |

### 数据安全设计

- 所有写操作可一次撤销
- Agent 直接改写既有数据行会被拦截，必须走「生成提案 → 用户确认 → 应用」
- 危险操作需要审批令牌

---

## 四、已知限制

- Agent **协作面板**尚未实现：后端 27 个 Agent 工具可用，但没有独立的协作视图
- 45 个 Host 操作中 17 个已接入界面，其余（导入预览、备份回滚、快照等）暂无 UI

---

## 五、许可证

MIT。上游署名见 `LICENSES/`。
