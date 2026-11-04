# 署名索引（WP0）

本仓库基于下列上游作品。逐字许可证文本见同目录；`Dely0-THIRD_PARTY_NOTICES.md` 是上游自带、必须随 fork/再分发保留的完整第三方署名文件。

| 组件 | 上游 | 版本 / 锁定 | 许可证 | 署名文本 |
| --- | --- | --- | --- | --- |
| 任务 / AI 基座 | `Dely0/dsh-personal-workbench` | v1.17.2 (tag) | MIT | `Dely0-MIT.txt`（Copyright (c) 2026 Du Penglai） |
| 日历域模块源 | `STARDUSTLC666/dsh-calendar` | 0.14.5 (commit `29dc9ef3`) | MIT | `dsh-calendar-MIT.txt`（Copyright (c) 2026 stardustlc） |
| 内置角色库（dotnet） | `novotnyllc/dotnet-artisan` | vendored / 改写 | MIT | `novotnyllc-dotnet-artisan-MIT.txt` |
| 内置角色库（科研） | `K-Dense-AI/scientific-agents` | vendored / RF 批改写 | MIT | `K-Dense-scientific-agents-MIT.txt` |
| DOM 挂载 / 客户端构建包装参考 | `dsh-task-board` | 参考思路 | **BSD-3-Clause** | 全文内嵌于 `Dely0-THIRD_PARTY_NOTICES.md` §85–125 |
| 同上 | `dsh-genui` | 参考思路 | MIT | `Dely0-THIRD_PARTY_NOTICES.md` §127–136 |
| 社区 fork 贡献 | `Guojing6/dsh-workbench` | 合入上游 | MIT | `Dely0-THIRD_PARTY_NOTICES.md` §138 |
| 社区贡献 | `SnowNight777/dsh-personal-workbench` | 合入上游 | MIT | `Dely0-THIRD_PARTY_NOTICES.md` §159 |

## 约束

- BSD-3-Clause 与 MIT 均要求保留版权声明与许可证文本；BSD-3-Clause 另禁止未经许可用原作者名义为衍生品背书。
- 后续从 `upstream/dsh-calendar-0.14.5/src/` 或 `lib/` 移植任何文件时，须在新文件头保留 MIT 版权行，并在本索引追加「移植了什么 / 改了什么」。
- 上游 `assets/personas/` 内含两个 MIT 角色库素材，再分发时须连同两份 LICENSE 与 `THIRD_PARTY_NOTICES.md` 一起带。
