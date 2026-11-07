# WP5.2-P0 · 隔离 Host 真机验证证据

## 结论

**VERDICT：PASS**（真机首次运行 allOk=true；重启二次运行 created 恒为 0）。

## 首次运行（真实 ctx.schedule，隔离 DSH_HOME /tmp/dsh-iso-Jv2UeM）

探针 `probe-host-verify.mjs`，5 种 scope 连续 3 次 reconcile：

| scope | created(3 轮) | hostActive | 磁盘 identity（尾部） |
|---|---|---|---|
| `a::b` | 1,0,0 | 1 | `wb2.task.YTo6Yg.dnQx` |
| `proj:sub` | 1,0,0 | 1 | `wb2.task.cHJvajpzdWI.dnQx` |
| `x:y:z` | 1,0,0 | 1 | `wb2.task.eDp5Ono.dnQx` |
| `中文:作用域` | 1,0,0 | 1 | `wb2.task.5Lit5paHOuS9nOeUqOWfnw.dnQx` |
| ``（空） | 1,0,0 | 1 | `wb2.task..dnQx` |

- `schedule.json` 总 active = 5，每 scope 恰好 1 条，无碰撞。
- 空 scope 编码为空串（`wb2.task..dnQx`），与真实 scope `_` 不再撞车。
- 冒号、Unicode 全部正确编码，base64url 不含 `.`，分段无损。

## 重启验证

```
重启前 schedule.json 记录数: 5
重启后 schedule.json 记录数: 5        ← 不重复创建
二次 reconcile: created=0,0,0, hostActive=1（5 个 scope 全部）
```

> 注：探针 `allOk` 判据硬编码「首次必须 created=1」，二次运行打印 `allOk=false`。
> 这是**探针判据适配问题**，非产品缺陷：二次运行的 `created=0` 恰恰证明幂等。
> 磁盘记录数 5→5 是更直接、更硬的重启幂等证据。

## 命令复现

```bash
DSH_HOME=/tmp/dsh-iso-Jv2UeM \
  dsh --profile rescue --patch /tmp/p0-patch.yml --no-open --port 63999
# 浏览器导航建立 session → 探针自动跑 5 scope × 3 reconcile
# 结果: /tmp/wp52p0-verify.json  (allOk=true)
# 磁盘: /tmp/dsh-iso-Jv2UeM/storages/schedule.json  (active=5)
```
