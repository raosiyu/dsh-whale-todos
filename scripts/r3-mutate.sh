#!/usr/bin/env bash
# 变异验证：逐个删除保护代码，测试必须失败。
# 任何一项"变异后仍全绿"= 测试真空，必须补测试。
set -u
CORE=workbench-core
OUT=${1:-evidence/wp2-r3/01-mutation.log}
: > "$OUT"

run_tests() {
  ( cd "$CORE" && node --test test/*.test.mjs 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' ' )
}

mutate() {
  local name="$1" file="$2" from="$3" to="$4"
  cp "$file" "$file.bak"
  # 用 python 做精确替换，避免 sed 转义问题
  python3 - "$file" "$from" "$to" <<'PY'
import sys
p, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8').read()
if a not in s:
    print(f"__MISSING__", file=sys.stderr)
    sys.exit(3)
open(p, 'w', encoding='utf-8').write(s.replace(a, b, 1))
PY
  local rc=$?
  if [ $rc -ne 0 ]; then
    echo "SKIP   $name（锚点未找到）" | tee -a "$OUT"
    mv "$file.bak" "$file"
    return
  fi
  local result
  result=$(run_tests)
  local fails
  fails=$(echo "$result" | grep -o 'fail [0-9]*' | awk '{print $2}')
  if [ "${fails:-0}" -gt 0 ]; then
    echo "CAUGHT $name  → $result" | tee -a "$OUT"
  else
    echo "VACUUM $name  → $result  ← 测试未捕获，必须补测试" | tee -a "$OUT"
  fi
  mv "$file.bak" "$file"
}

echo "=== 变异验证（删保护代码，测试应失败）===" | tee -a "$OUT"
echo "" | tee -a "$OUT"

mutate "M1 catalog 改为只读 active（退化为 list 语义）" \
  "$CORE/src/schedule-adapter.js" \
  ".filter((row) => row.sessionId === undefined || row.sessionId === sessionId)" \
  ".filter((row) => (row.sessionId === undefined || row.sessionId === sessionId) && row.status === 'active')"

mutate "M2 reconcile 恢复删除 inactive（缺陷回归）" \
  "$CORE/src/schedule-adapter.js" \
  ".filter((r) => (r.status ?? 'active') === 'active')" \
  ""

mutate "M3 host create 退回单参 + 数字 at" \
  "$CORE/src/schedule-adapter.js" \
  'created = await hostSchedule.create(sessionId, {' \
  'created = await hostSchedule.create({' 

mutate "M4 catalog 失败时静默当空（不降级）" \
  "$CORE/src/schedule-adapter.js" \
  "return { status: HOST_READ.UNAVAILABLE, error: read.error, rows: [], degraded: true }" \
  "return { status: HOST_READ.OK, rows: [], degraded: false }"

mutate "M5 恢复层不传 scope" \
  "$CORE/src/reminder-recovery.js" \
  "const res = await adapter.reconcile(future, { scope: input.scope })" \
  "const res = await adapter.reconcile(future)"

mutate "M6 已投递判定失效（无视 history）" \
  "$CORE/src/reminder-recovery.js" \
  "if (delivery.state === DELIVERY_STATE.DELIVERED) {" \
  "if (false) {"

mutate "M7 UNKNOWN 也去重建（不保守）" \
  "$CORE/src/reminder-recovery.js" \
  "if (delivery.state === DELIVERY_STATE.UNKNOWN) {" \
  "if (false) {"

mutate "M8 审批门放行（不校验 token）" \
  "$CORE/src/service.js" \
  "const check = gate.verify(
      { op, target: detail.target, digest: detail.digest },
      meta?.approvalToken,
    )" \
  "const check = { ok: true }"

mutate "M9 service 重新暴露 store 写方法" \
  "$CORE/src/service.js" \
  "store: Object.freeze({
      listBackups: () => store.listBackups(),
      listPreBackups: () => store.listPreBackups(),
    })," \
  "store,"

mutate "M10 bulkDelete target 退回逗号拼接" \
  "$CORE/src/service.js" \
  "target: JSON.stringify([...ids].map(String).sort())," \
  "target: [...ids].map(String).sort().join(','),"

mutate "M11 hostMap 不持久化（只写内存）" \
  "$CORE/src/host-map.js" \
  "      persist()
      return { ...state.entries[entry.reminderKey] }" \
  "      return { ...state.entries[entry.reminderKey] }"

mutate "M12 hostMap 允许 hostId 重复" \
  "$CORE/src/host-map.js" \
  "if (key !== entry.reminderKey && value.hostId === entry.hostId) {" \
  "if (false) {"

mutate "M13 损坏映射静默重建为空" \
  "$CORE/src/host-map.js" \
  "    } catch (error) {
      throw storeCorruptError(\`宿主映射不是合法 JSON：\${String(error?.message ?? error)}\`, { filePath })
    }" \
  "    } catch (error) {
      state = emptyState()
      return
    }"

mutate "M14 compileReminder 不再滤过期" \
  "$CORE/src/schedule-adapter.js" \
  "if (fireAtMs <= nowMs) return null" \
  ""

mutate "M15 hostMap 不裁剪（无界增长）" \
  "$CORE/src/host-map.js" \
  "      prune()
      persist()" \
  "      persist()"

mutate "M16 prune 按错误方向裁剪（保留最旧）" \
  "$CORE/src/host-map.js" \
  "      return fb - fa" \
  "      return fa - fb"

# --- 第三轮 Review 指出的 6 处测试真空（X6/X9/X11/X12/X13）---
mutate "X6 degraded 时不检查仍然盲目建（应只建不删但仍需判重）" \
  "$CORE/src/schedule-adapter.js" \
  "      const existingKeys = activeKeys" \
  "      const existingKeys = activeKeys.size > 0 ? activeKeys : new Set()"

mutate "X11 UNKNOWN 纳入 future（应保持不建不删）" \
  "$CORE/src/reminder-recovery.js" \
  "        if (delivery.state === DELIVERY_STATE.UNKNOWN) {
          // 投递状态未知：**不删不建**，只记录。宁可留着，不可误删误建。
          unknown.push({ reminderKey: plan.reminderKey, reason: delivery.reason })
          continue
        }" \
  "        if (delivery.state === DELIVERY_STATE.UNKNOWN) {
          future.push(plan)
          continue
        }"

mutate "X12 删除失败不计入 failed（回到静默吞）" \
  "$CORE/src/schedule-adapter.js" \
  "            else failed.push({ key, reason: res.reason ?? 'delete-failed', op: 'remove' })" \
  ""

mutate "X13 回执裁剪判 not-delivered（N-02 回归）" \
  "$CORE/src/reminder-recovery.js" \
  "    if (records.length === 0 && res.earlierRecordsUnavailable === true) {
      return { state: DELIVERY_STATE.UNKNOWN, reason: 'history-pruned' }
    }" \
  ""

mutate "X14 hostMap 保留上限失效" \
  "$CORE/src/host-map.js" \
  "    if (all.length <= maxEntries) return []" \
  "    return []"

mutate "X15 N-05 deny 模式不拦（回到分散判断）" \
  "$CORE/src/service.js" \
  "      if (gate.mode === 'deny' && WRITE_OPS.includes(op)) {" \
  "      if (false) {"

mutate "X16 N-03 unmapped 不报告（回到静默 continue）" \
  "$CORE/src/schedule-adapter.js" \
  "          unmapped.push({ id: row.id, scheduledAt: row.scheduledAt, title: row.title })
          continue" \
  "          continue"

mutate "X17 N-04 create 失败抛穿（中断整轮）" \
  "$CORE/src/schedule-adapter.js" \
  "      } catch (error) {
        return {
          ok: false,
          reason: 'host-create-rejected'," \
  "      } catch (error) {
        throw error
        return {
          ok: false,
          reason: 'host-create-rejected',"

mutate "X18 scope 退回前缀匹配（M3' 原样回归）" \
  "$CORE/src/schedule-adapter.js" \
  "      const inScopeRow = (row) => (scope === undefined ? true : row.scope === scope)" \
  'const inScopeRow = (row) => (scope === undefined ? true : String(row.reminderKey).startsWith(String(scope) + ":"))' 

echo "" | tee -a "$OUT"
echo "=== 汇总 ===" | tee -a "$OUT"
grep -c '^CAUGHT' "$OUT" | sed 's/^/CAUGHT: /' | tee -a "$OUT"
grep -c '^VACUUM' "$OUT" | sed 's/^/VACUUM: /' | tee -a "$OUT"
grep -c '^SKIP' "$OUT" | sed 's/^/SKIP: /' | tee -a "$OUT"
