# 鲸鱼待办接入 DSH Desktop — 安装方案（待确认）

生成时间：2026-11-09 12:43 (Asia/Shanghai)
状态：**已备份并验证可恢复；尚未修改任何正式环境文件。**

---

## 一、备份已完成并通过恢复演练

| 项 | 值 |
| --- | --- |
| 备份路径 | `~/.dsh/backups/desktop-before-workbench-20261109-124052/desktop-profile/` |
| 体积 | 1.4 GB（含 node_modules） |
| 文件数 | 38414（源 38414，**一致**） |
| 符号链接 | 45（源 45，**一致**） |
| 方式 | `rsync -a`（保留属性、断链安全） |

关键配置校验和（备份 vs 现网，全部一致）：

| 文件 | SHA-256 |
| --- | --- |
| cordis.patch.yml | `b6741a5b7abf2aa1116b7418f63ff1974ad4a5295799b696a2e0de8e3bddf459` |
| cordis.yml | `c300dcf2ebc5f02062d6591268d29d3db6fe45e0cb138f5467276fe2ba06076e` |
| package.json | `3979ada20eb31581fdec451c7e7358966e118bd5d6afd0ba6575ffa99f6454e8` |
| pnpm-lock.yaml | `1a2819408a60502bc1396ac696580250be0cb238fc1f93e96099a68d08e20303` |

**恢复演练**：已从备份真实还原一份到独立目录，38414 文件 + 45 链接全部还原，`cordis.patch.yml` 校验和与现网一致。备份可用。

### 回滚命令（授权后如需撤销）

```bash
rsync -a --delete \
  ~/.dsh/backups/desktop-before-workbench-20261109-124052/desktop-profile/ \
  ~/.dsh/profiles/desktop/
```

---

## 二、需要改动的文件：精确差异

只改 **2 个文件**，均在 `~/.dsh/profiles/desktop/` 内。

### 改动 1：`cordis.patch.yml` 文件头新增 5 行

在文件**最开头**追加（现有 9 个顶层条目整体后移，内容一字不改）：

```yaml
- insert:
    - id: workbench-ui
      name: '@local/dsh-workbench-ui'
      config:
        rootDir: '/Users/sylas/.dsh/profiles/desktop/data/workbench-test'
```

### 改动 2：`package.json` 两处

依赖表新增一项：

```json
"@local/dsh-workbench-ui": "link:/Users/sylas/Developer/dsh-workbench/packages/workbench-ui"
```

bundle 列表末尾新增一项：

```json
"@local/dsh-workbench-ui"
```

### 不改的东西

- 不改 `cordis.yml`
- 不改任何现有 9 个条目的配置内容
- 不删任何现有插件
- 不碰 `pnpm-lock.yaml`（由 pnpm 自行更新）

---

## 三、数据隔离（你的第 3 点）

| 项 | 值 | 说明 |
| --- | --- | --- |
| 插件数据目录 | `~/.dsh/profiles/desktop/data/workbench-test` | **新建**，当前 `data/` 为空目录 |
| 真实待办数据 | 不受影响 | 插件此前从未在 desktop 运行，不存在既有数据 |
| 与预览实例的关系 | 隔离 | 预览用 `/tmp/wb-preview-data`，两套数据互不可见 |

Host 插件代码在 `index.js:114-117` **硬性要求** `config.rootDir`，缺失即抛错拒绝启动——不会自行猜测或写入用户数据路径。这是设计上的 fail-closed（失败即关闭）。

---

## 四、安装步骤（授权后执行）

1. `cd ~/.dsh/profiles/desktop && pnpm add "link:/Users/sylas/Developer/dsh-workbench/packages/workbench-ui"` — 建立符号链接
2. 编辑 `cordis.patch.yml`（插入上述 5 行）
3. 编辑 `package.json`（加入 bundle 声明）
4. `dsh --profile desktop --dump-config | grep workbench-ui` — **先验证配置能组装，不启动**
5. 重启 DSH Desktop（当前 PID 38124 正在运行，必须重启才会加载新插件）

### 必须知道的影响

- **重启会中断你当前 Desktop 会话的界面**。会话记录本身存在别处，不会丢，但当前窗口会关闭重开。
- 第 5 步之前不产生任何界面变化。

---

## 五、风险与已知边界

| 风险 | 评估 | 缓解 |
| --- | --- | --- |
| 插件加载失败导致 Desktop 起不来 | 低。预览实例已用同机制跑通 | 有完整备份 + 单行回滚命令；`--dump-config` 先行验证 |
| 与现有插件冲突 | 低。插件用独立 slot key `workbench`，不占 `conversation` | 已在 WP4 测试中固化为断言 |
| 数据写错位置 | 极低。`rootDir` 显式指定且 fail-closed | 数据目录独立于真实数据 |
| `pnpm add` 改动 lockfile | 确定会发生 | 备份已含原 `pnpm-lock.yaml`，可回滚 |

### 尚未做到的

- 插件目前 **Agent 协作面板未实现**（你的第 5 点，安装后优先做）
- 45 个 Host op 中 17 个已接界面，其余待接
- 这些不影响安装与使用，是安装后的开发任务

---

## 六、等待你确认的事项

1. 是否同意上述 2 个文件的改动？
2. 是否同意数据目录定为 `~/.dsh/profiles/desktop/data/workbench-test`？
3. 是否同意重启 DSH Desktop（当前会话界面会中断）？

**确认方式**：回复「按方案安装」即可；如需改数据目录位置或暂不重启，直接说明。
