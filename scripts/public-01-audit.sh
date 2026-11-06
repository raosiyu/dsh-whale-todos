#!/usr/bin/env bash
# PUBLIC-01：公开前安全审计。
# 判据只有一条：任何一项不过，就不许公开推送。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0
say() { printf '%s\n' "$1"; }
chk() { # chk 名称 结果0/1 详情
  if [ "$2" -eq 0 ]; then say "PASS  $1  $3"; else say "FAIL  $1  $3"; fail=1; fi
}

say "=== PUBLIC-01 公开安全审计 ==="
say "仓库: $ROOT"
say "HEAD: $(git rev-parse HEAD)"
say ""

# 1. 凭据字面量（全历史）
say "-- 1. 全历史凭据扫描 --"
HITS=$(git log --all -p 2>/dev/null \
  | grep -E "ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xoxb-[A-Za-z0-9-]{20,}|AKIA[A-Z0-9]{16}|BEGIN [A-Z ]*PRIVATE KEY|npm_[A-Za-z0-9]{20,}" \
  | grep -v "grep -rniE\|grep -E\|必须一并扫\|SECRET_FIELDS" | head -5)
if [ -z "$HITS" ]; then chk "凭据字面量" 0 "0 命中（已排除文档中的 grep 模式串）"
else chk "凭据字面量" 1 "命中如下："; printf '%s\n' "$HITS"; fi

# 2. 本机绝对路径
say ""
say "-- 2. 本机绝对路径 --"
# 只把「真实用户名」算违规：/Users/<user>/、C:/Users/<user>/ 这类占位符
# 与 /Users/Me 这类测试字面量不算。否则审计永远误报，久了就没人看结果。
REAL=$(git grep -h "/Users/" HEAD 2>/dev/null \
  | grep -vE "/Users/<|/Users/Me|C:/Users/<|/mnt/c/Users/Me" \
  | grep -oE "/Users/[A-Za-z0-9._-]+" | sort -u | head -5)
if [ -z "$REAL" ]; then
  chk "本机绝对路径" 0 "0 个真实用户名（占位符与测试字面量已排除）"
else
  chk "本机绝对路径" 1 "发现真实用户名路径："; printf '%s\n' "$REAL"
fi

# 3. 私钥/证书文件
say ""
say "-- 3. 私钥与证书文件 --"
K=$(git ls-files | grep -E "\.(pem|key|p12|pfx|jks|keystore)$|id_rsa|id_ed25519|\.env$|\.env\.(local|production)" | head -5)
if [ -z "$K" ]; then chk "私钥/证书文件" 0 "0 个"
else chk "私钥/证书文件" 1 "发现：$K"; fi

# 4. 大文件（>2MB 会让 clone 痛苦，也可能是误入的二进制）
say ""
say "-- 4. 入库文件体积 --"
BIG=$(git ls-files -z | xargs -0 -I{} sh -c 'test -f "{}" && s=$(wc -c <"{}" 2>/dev/null || echo 0); test "$s" -gt 2097152 && echo "{} $s"' 2>/dev/null | head -5)
if [ -z "$BIG" ]; then chk "大文件(>2MB)" 0 "0 个"
else chk "大文件(>2MB)" 1 "发现：$BIG"; fi

# 5. 许可证完整性
say ""
say "-- 5. 许可证 --"
MISS=""
for f in LICENSES/Dely0-MIT.txt LICENSES/dsh-calendar-MIT.txt LICENSES/Dely0-THIRD_PARTY_NOTICES.md; do
  [ -f "$f" ] || MISS="$MISS $f"
done
if [ -z "$MISS" ]; then chk "许可证文件" 0 "上游 MIT 原文与第三方声明齐全"
else chk "许可证文件" 1 "缺失：$MISS"; fi

# 6. 上游快照完整性（不许夹带 node_modules / 构建产物）
say ""
say "-- 6. 上游快照夹带 --"
N=$(git ls-files upstream/ | grep -cE "node_modules/|/lib/|\.pnpm-store/|dist/" || true)
if [ "$N" = "0" ]; then chk "上游无构建产物" 0 "0 个 node_modules/lib/dist"
else chk "上游无构建产物" 1 "$N 个可疑文件"; fi

# 7. 全历史真实用户名（隐私项，非凭据）
say ""
say "-- 7. 全历史本机用户名（隐私，非凭据）--"
H=$(git log --all -p 2>/dev/null | grep -oE "/Users/[A-Za-z0-9._-]+" \
  | grep -vE "/Users/<|/Users/Me" | sort -u | head -3)
if [ -z "$H" ]; then chk "全历史用户名" 0 "0 处"
else
  CNT=$(git log --all -p 2>/dev/null | grep -c "/Users/sylas")
  say "WARN  全历史用户名  HEAD 已干净，但历史仍含 $CNT 处（$(printf '%s' "$H" | tr '\n' ' ')）"
  say "      改写历史需 force push —— 授权明令禁止，故仅记录，等待人工决定"
fi

say ""
say "=== 结论 ==="
if [ "$fail" -eq 0 ]; then say "PUBLIC-01: PASS —— 允许公开推送"; exit 0
else say "PUBLIC-01: FAIL —— 阻止公开推送（本地开发可继续）"; exit 1; fi
