#!/usr/bin/env bash
# WP2-R5 门禁：一次跑完所有门禁项，任一失败即整体失败。
#
# 存在的理由：上一轮我用一串手敲命令跑门禁，结果文件名与调用名不一致，
# 探针「没跑」被当成了「通过」。**门禁必须是一个可复跑的脚本**。
set -u
cd "$(dirname "$0")/.."

LOG=evidence/wp2/review-final
mkdir -p "$LOG"
FAIL=0
PASSED=0

step() {
  local name="$1"; shift
  echo ""
  echo "=== $name ==="
  if "$@" > "$LOG/$name.log" 2>&1; then
    tail -3 "$LOG/$name.log"
    echo "  ✅ $name"
    PASSED=$((PASSED + 1))
  else
    echo "  ❌ $name（详见 $LOG/$name.log）"
    tail -20 "$LOG/$name.log"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== WP2-R5 门禁 ==="
echo "HEAD=$(git rev-parse --short HEAD)  dirty=[$(git status --porcelain | wc -l | tr -d ' ')]  remotes=[$(git remote | wc -l | tr -d ' ')]"

step "unit-tests"        bash -c 'cd workbench-core && node --test test/*.test.mjs'
step "demo"              bash -c 'cd workbench-core && node demo/demo.mjs'
step "probe-real-storage" node scripts/probes/p1-real-storage-domain.mjs
step "probe-protect"      node scripts/probes/p2-protect.mjs
step "probe-retention"    node scripts/probes/p3-retention.mjs
step "real-service-l4"    node scripts/r3-real-service.mjs
step "acceptance-8"       node scripts/r3-acceptance.mjs
step "mutations"          node scripts/r3-mutate.mjs "$LOG/mutation.log"

echo ""
echo "=== 门禁汇总 ==="
echo "通过 $PASSED 项，失败 $FAIL 项"
echo "日志目录：$LOG"
if [ "$FAIL" -gt 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
exit 0
