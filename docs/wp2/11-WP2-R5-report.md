# WP2-R5 报告：真实集成与最终审查

基准（初始）：`930bf38` → 实施后：`2b0aabb` → 修复后：`8c264b1`
门禁：`bash scripts/wp2-r5-gate.sh` → **8/8 PASS**

## 一、真实 Host（真实 storageDomain）

`scripts/probes/p1-real-storage-domain.mjs` 用**真组件**搭最小 Host：

| 组件 | 包 |
| --- | --- |
| 容器 | `@deepseek-ai/cordis` Context（Service 必须在**插件 context** 内构造，根 Context 没有 `reflect`） |
| 存储 hub | `@deepseek-ai/dsh-storage` Storage |
| 后端 | `@deepseek-ai/dsh-storage-json` JsonStorageBackend（落盘） |
| 域 | `@deepseek-ai/dsh-storage-domain` DomainFacility + `ctx.storage.mount('domain', …)` |
| 数据 | `@deepseek-ai/dsh-schedule` scheduleDomain |

结果：**schedule.json 真实落盘** → 新实例读回 → 适配器 5 次「重启」后**仍只有 1 条提醒**。

## 二、N-17 与 protect（探针 P2）

| 情形 | 结论 |
| --- | --- |
| history 抛错 | 宿主提醒**原样保留**，不重建 ✅ |
| 回执被 retention 裁剪 | 同上 ✅ |
| history 返回非法形状 | 同上 ✅（修复后） |
| 跨 session | s1 对账不删 s2 的 ✅ |
| 跨 scope | 只删本 scope，tasks 的保留 ✅ |
| 映射丢失 | 不认领、不删除、上报 unmapped ✅ |
| 宿主记录已失效 | 重建（正确）✅ |
| 宿主 delete 失败 | 计入 failed，不计入 removed ✅ |

## 三、500 条映射裁剪（探针 P3）

放大到 2000 条后暴露三个缺陷，全部已修：

| 缺陷 | 后果 | 修法 |
| --- | --- | --- |
| 我给身份 index 加了上限 | **1500 条被重复创建**（宿主 2000→3500） | **撤销 index 封顶**：体积是渐进增长，重复投递是用户可见故障，**正确性优先** |
| `put` 每次全量写文件 | 2000 次 put = 8.8s（O(N²) I/O） | 脏标记 + 显式 `flush()`；适配器在 upsert/remove 后**立即 flush** |
| `catalog` 逐行线性查找 | 对账 O(宿主行 × 映射条目)，2000 条时不可接受 | `hostIdLookup()` 一次建表，O(1) 查 |

性能：**8000 条 36.8s → 0.76s**（48 倍）。

## 四、审批旁路 / 并发 / 异常

- `deny` 模式：10 个写操作全部拦截（拦截点在唯一入口 `execute`）
- 返回面：`store`/`events` 只剩只读方法且被冻结
- 异常：宿主 create/delete/history 的各种抛法都有可观察出口（`failed[]` / `unavailable`）

## 五、复审抓到的**流程缺陷**（比代码缺陷更值得记）

复审检查 01 发现：三个探针把仓库路径**硬编码**成主仓库绝对路径。
后果：在冻结副本内跑门禁时，探针实际 import 的是**主仓库未提交的代码** → **门禁日志是污染的**，
却显示为通过。

修法：探针按 `import.meta.url` 推导仓库根（`scripts/probes/x.mjs` 上两级），
使其在冻结副本内**自证**测的是副本自己的代码。已验证：副本内 REPO 指向副本，三个探针全 PASS。

**这条教训**：冻结的价值全在「审的确实是那份代码」。探针一旦指向别处，冻结就形同虚设。

## 六、四类结果（分别报告）

| 类别 | 结果 |
| --- | --- |
| **真实 Host** | ✅ 真实 storageDomain 落盘/重启/去重通过（探针 P1）；真实 ScheduleService 类可实例化并跑通五方法（`r3-real-service.mjs`） |
| **模拟环境** | ✅ 197 项单元/集成测试；36/36 变异被捕获（0 真空 0 跳过）；8 项验收 26/26 |
| **macOS 系统级** | ❌ **UNVERIFIED** —— 真实休眠/唤醒/退出/重启、系统通知是否弹出，均未测试 |
| **独立 Review** | ✅ 已取得结论（`evidence/wp2/review-final/REVIEW-WP2R5-Final.md`） |

## 七、UNVERIFIED 清单

| 项 | 原因 |
| --- | --- |
| **真实宿主投递回执不可读** | 本会话无对应工具；**因此不宣称 exactly-once** |
| 真实 Host 的 fiber/effect 生命周期 | P1 用真实 storageDomain，但宿主生命周期仍是简化构造 |
| **真实 macOS 休眠 / 唤醒 / 退出 / 重启** | **完全未测试** |
| 系统通知是否真正弹出 | 未验证 |
| 多进程并发写 | 文件存储非多进程安全；`hostMap` 无跨进程锁 |
| 独立 Review 对最新 commit 的复核 | 复审基准为 `2b0aabb`；其后的 `8c264b1` 修复需再复审 |

## 八、红线

| 红线 | 结果 |
| --- | --- |
| 不修改正式 DSH profile | ✅ `~/.dsh/profiles` 零改动 |
| 不碰用户数据 | ✅ |
| 不碰其他项目 | ✅ 鲸鱼娘 `79d7e24` dirty 0 |
| 不 push | ✅ 0 remote |
