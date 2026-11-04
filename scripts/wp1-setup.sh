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
  *) log "WARN: node 版本不在上游声明区间，请核对" ;;
esac

# Corepack 会按上游 packageManager: pnpm@11.7.0 自动切版本
log "pnpm=$(cd "$D" && pnpm --version) (upstream packageManager pinned)"

# --- 2. 安装（不执行上游生命周期脚本） -----------------------------------
log "pnpm install --frozen-lockfile --ignore-scripts"
(cd "$D" && pnpm install --frozen-lockfile --ignore-scripts) 2>&1 | tee "$E/setup-install.log"

# --- 3. 原生 binding 可复现恢复 ------------------------------------------
# 症状：npm registry 偶发 error(23) 导致 @rolldown/binding-darwin-arm64 目录为空，
# tsdown 报 "Cannot find native binding"。检测 + 从 registry 直取 tarball 落位。
BIND="$D/node_modules/.pnpm/@rolldown+binding-darwin-arm64@1.1.5/node_modules/@rolldown/binding-darwin-arm64"
if [ ! -f "$BIND/rolldown-binding.darwin-arm64.node" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) PKG="@rolldown/binding-darwin-arm64@1.1.5"; FILE="rolldown-binding.darwin-arm64.node" ;;
    *) log "ERROR: 仅处理了 darwin-arm64，请手工补 $(uname -s)-$(uname -m) 的 binding"; exit 1 ;;
  esac
  log "native binding 缺失，npm pack $PKG 恢复"
  TMP="$(mktemp -d)"
  (cd "$TMP" && npm pack "$PKG" --pack-destination "$TMP" >/dev/null 2>&1)
  mkdir -p "$BIND"
  tar xzf "$TMP"/rolldown-binding-darwin-arm64-1.1.5.tgz -C "$BIND" --strip-components=1
  rm -rf "$TMP"
  [ -f "$BIND/$FILE" ] && log "OK: $BIND/$FILE" || { log "ERROR: 恢复失败"; exit 1; }
else
  log "OK: native binding 已存在"
fi

# --- 4. 验证 -------------------------------------------------------------
log "pnpm typecheck"
(cd "$D" && pnpm typecheck) 2>&1 | tee "$E/setup-typecheck.log"
log "pnpm build"
(cd "$D" && pnpm build) 2>&1 | tee "$E/setup-build.log"
log "pnpm audit --prod"
(cd "$D" && pnpm audit --prod) 2>&1 | tee "$E/setup-audit-prod.log"

log "DONE: 构建环境可复现。全量测试请另行跑 pnpm test。"
