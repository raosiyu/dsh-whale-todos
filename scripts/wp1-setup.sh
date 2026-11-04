#!/usr/bin/env bash
# WP1-0 可复现构建环境
# 用法：bash scripts/wp1-setup.sh
# 只读/写本仓库 upstream/dely0-v1.17.2 的依赖目录；不改 DSH profile、不碰用户数据、不 push。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D="$ROOT/upstream/dely0-v1.17.2"
E="$ROOT/evidence/wp1-0"
mkdir -p "$E"

log() { printf '[wp1-setup] %s\n' "$*"; }

# --- 1. 工具链与版本约束 -------------------------------------------------
NODE_VER="$(node --version)"
log "node=$NODE_VER (upstream engines: ^22.19.0 || >=24.0.0)"
case "$NODE_VER" in
  v22.1[9].*|v22.[2-9][0-9].*|v2[4-9].*|v[3-9][0-9].*) : ;;
  *)
    if [ "${WP1_ALLOW_UNSUPPORTED_NODE:-0}" = "1" ]; then
      log "WARN: node $NODE_VER 不在上游区间（已用 WP1_ALLOW_UNSUPPORTED_NODE=1 放行）"
    else
      log "ERROR: node $NODE_VER 不在上游 engines 区间 ^22.19.0 || >=24.0.0；如需强行继续请设 WP1_ALLOW_UNSUPPORTED_NODE=1"
      exit 1
    fi
    ;;
esac

# Corepack 会按上游 packageManager: pnpm@11.7.0 自动切版本
log "pnpm=$(cd "$D" && pnpm --version) (upstream packageManager pinned)"

# --- 2. 安装（不执行上游生命周期脚本） -----------------------------------
log "pnpm install --frozen-lockfile --ignore-scripts"
(cd "$D" && pnpm install --frozen-lockfile --ignore-scripts) 2>&1 | tee "$E/setup-install.log"

# --- 3. 原生 binding 可复现恢复 ------------------------------------------
# 症状：npm registry 偶发 error(23) 导致 @rolldown/binding-darwin-arm64 目录为空，
# tsdown 报 "Cannot find native binding"。检测 + 从 registry 直取 tarball 落位。
# 版本从 lockfile 读，避免上游升级 rolldown 后脚本装错版本
ROLldown_VER="$(grep -oE '^  rolldown@[0-9]+\.[0-9]+\.[0-9]+' "$D/pnpm-lock.yaml" | head -1 | sed 's/.*@//')"
if [ -z "$ROLldown_VER" ]; then
  log "ERROR: 无法从 pnpm-lock.yaml 读出 rolldown 版本"; exit 1
fi
log "rolldown=$ROLldown_VER (from lockfile)"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) BIND_PKG="@rolldown/binding-darwin-arm64@$ROLldown_VER"; BIND_FILE="rolldown-binding.darwin-arm64.node"; BIND_DIR="@rolldown+binding-darwin-arm64@$ROLldown_VER" ;;
  Darwin-x86_64) BIND_PKG="@rolldown/binding-darwin-x64@$ROLldown_VER"; BIND_FILE="rolldown-binding.darwin-x64.node"; BIND_DIR="@rolldown+binding-darwin-x64@$ROLldown_VER" ;;
  Linux-x86_64) BIND_PKG="@rolldown/binding-linux-x64-gnu@$ROLldown_VER"; BIND_FILE="rolldown-binding.linux-x64-gnu.node"; BIND_DIR="@rolldown+binding-linux-x64-gnu@$ROLldown_VER" ;;
  Linux-aarch64) BIND_PKG="@rolldown/binding-linux-arm64-gnu@$ROLldown_VER"; BIND_FILE="rolldown-binding.linux-arm64-gnu.node"; BIND_DIR="@rolldown+binding-linux-arm64-gnu@$ROLldown_VER" ;;
  *) log "ERROR: 未覆盖平台 $(uname -s)-$(uname -m)；请手工补 rolldown 原生 binding"; exit 1 ;;
esac

BIND_PKG_NAME="${BIND_DIR%@*}"   # 形如 @rolldown+binding-darwin-arm64
BIND="$D/node_modules/.pnpm/$BIND_DIR/node_modules/@rolldown/${BIND_PKG_NAME#*+}"
if [ ! -f "$BIND/$BIND_FILE" ]; then
  log "native binding 缺失，npm pack $BIND_PKG 恢复"
  TMP="$(mktemp -d)"
  (cd "$TMP" && npm pack "$BIND_PKG" --pack-destination "$TMP" >/dev/null 2>&1) || { log "ERROR: npm pack 失败"; rm -rf "$TMP"; exit 1; }
  TGZ="$(ls "$TMP"/*.tgz 2>/dev/null | head -1)"
  [ -n "$TGZ" ] || { log "ERROR: 未拿到 tarball"; rm -rf "$TMP"; exit 1; }
  mkdir -p "$BIND"
  tar xzf "$TGZ" -C "$BIND" --strip-components=1
  rm -rf "$TMP"
  [ -f "$BIND/$BIND_FILE" ] && log "OK: $BIND/$BIND_FILE" || { log "ERROR: 恢复失败"; exit 1; }
else
  log "OK: native binding 已存在 ($BIND_FILE)"
fi

# --- 4. 验证 -------------------------------------------------------------
log "pnpm typecheck"
(cd "$D" && pnpm typecheck) 2>&1 | tee "$E/setup-typecheck.log"
log "pnpm build"
(cd "$D" && pnpm build) 2>&1 | tee "$E/setup-build.log"
log "pnpm audit --prod"
(cd "$D" && pnpm audit --prod) 2>&1 | tee "$E/setup-audit-prod.log"

log "DONE: 构建环境可复现。全量测试请另行跑 pnpm test。"
