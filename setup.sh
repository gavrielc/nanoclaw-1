#!/bin/bash
set -euo pipefail

# setup.sh — Bootstrap script for NanoClaw (sandbox fork)
# Handles Node.js/npm setup, then hands off to the Node.js setup modules.
# On virtiofs (Docker Desktop sandbox), also handles build tools, proxy
# config, CRLF fixes, and the symlink workaround for npm install.

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [bootstrap] $*" >> "$LOG_FILE"; }

# --- Platform detection ---

detect_platform() {
  local uname_s
  uname_s=$(uname -s)
  case "$uname_s" in
    Darwin*) PLATFORM="macos" ;;
    Linux*)  PLATFORM="linux" ;;
    *)       PLATFORM="unknown" ;;
  esac

  IS_WSL="false"
  if [ "$PLATFORM" = "linux" ] && [ -f /proc/version ]; then
    if grep -qi 'microsoft\|wsl' /proc/version 2>/dev/null; then
      IS_WSL="true"
    fi
  fi

  IS_ROOT="false"
  if [ "$(id -u)" -eq 0 ]; then
    IS_ROOT="true"
  fi

  # Test if filesystem supports symlinks (virtiofs on Windows doesn't)
  NO_SYMLINKS="false"
  if ! ln -s /dev/null "$PROJECT_ROOT/.symlink_test" 2>/dev/null; then
    NO_SYMLINKS="true"
  fi
  rm -f "$PROJECT_ROOT/.symlink_test" 2>/dev/null

  log "Platform: $PLATFORM, WSL: $IS_WSL, Root: $IS_ROOT, NoSymlinks: $NO_SYMLINKS"
}

# --- Node.js check ---

check_node() {
  NODE_OK="false"
  NODE_VERSION="not_found"
  NODE_PATH_FOUND=""

  if command -v node >/dev/null 2>&1; then
    NODE_VERSION=$(node --version 2>/dev/null | sed 's/^v//')
    NODE_PATH_FOUND=$(command -v node)
    local major
    major=$(echo "$NODE_VERSION" | cut -d. -f1)
    if [ "$major" -ge 20 ] 2>/dev/null; then
      NODE_OK="true"
    fi
    log "Node $NODE_VERSION at $NODE_PATH_FOUND (major=$major, ok=$NODE_OK)"
  else
    log "Node not found"
  fi
}

# --- Sandbox prep (build tools, proxy config, CRLF) ---

sandbox_prep() {
  if [ "$NO_SYMLINKS" = "false" ]; then
    return
  fi

  log "No symlink support — running sandbox prep"

  # Install build tools for native modules (better-sqlite3)
  if ! command -v gcc >/dev/null 2>&1; then
    log "Installing build-essential..."
    sudo apt-get update -qq >/dev/null 2>&1
    sudo apt-get install -y -qq build-essential python3 >/dev/null 2>&1
    log "Build tools installed"
  fi

  # Configure npm for MITM proxy (only when proxy is present)
  if [ -n "${http_proxy:-}" ]; then
    npm config set strict-ssl false 2>/dev/null
    npm config set proxy "$http_proxy"
    npm config set https-proxy "$http_proxy"
  fi
  if [ -f /usr/local/share/ca-certificates/proxy-ca.crt ]; then
    npm config set cafile /usr/local/share/ca-certificates/proxy-ca.crt
  fi
  log "npm proxy configured"

  # Fix CRLF from Windows host (temp file on same filesystem so mv is a rename)
  find "$PROJECT_ROOT" -maxdepth 2 -name "*.sh" -exec sh -c \
    'tr -d "\r" < "$1" > "$1.tmp" && mv "$1.tmp" "$1" && chmod +x "$1"' _ {} \;
  log "CRLF fixed"
}

# --- npm install ---

install_deps() {
  DEPS_OK="false"
  NATIVE_OK="false"

  if [ "$NODE_OK" = "false" ]; then
    log "Skipping npm install — Node not available"
    return
  fi

  cd "$PROJECT_ROOT"

  if [ "$NO_SYMLINKS" = "true" ]; then
    install_deps_virtiofs
  else
    install_deps_normal
  fi
}

# Standard npm install (macOS, Linux, WSL)
install_deps_normal() {
  local npm_flags=""
  if [ "$IS_ROOT" = "true" ]; then
    npm_flags="--unsafe-perm"
    log "Running as root, using --unsafe-perm"
  fi

  log "Running npm ci $npm_flags"
  if npm ci $npm_flags >> "$LOG_FILE" 2>&1; then
    DEPS_OK="true"
    log "npm install succeeded"
  else
    log "npm install failed"
    return
  fi

  verify_native_modules
}

# VirtioFS workaround: install in /tmp (ext4), tar-pipe back.
# virtiofs doesn't support symlinks, which breaks npm install, node-gyp,
# and the .bin/ directory. We install in /tmp where symlinks work,
# then tar-pipe node_modules back and create shell wrapper scripts for .bin/.
install_deps_virtiofs() {
  log "VirtioFS: installing deps in /tmp to work around symlink limitation"

  mkdir -p /tmp/npm-build
  cp package.json package-lock.json /tmp/npm-build/

  # Install in /tmp where symlinks work (including native module builds)
  if (cd /tmp/npm-build && npm install >> "$LOG_FILE" 2>&1); then
    log "npm install in /tmp succeeded"
  else
    log "npm install in /tmp failed"
    return
  fi

  # Add proxy packages needed by proxy-bootstrap.ts
  (cd /tmp/npm-build && npm install https-proxy-agent undici >> "$LOG_FILE" 2>&1) || true

  # Tar-pipe node_modules back — tolerate symlink errors (expected on virtiofs)
  rm -rf node_modules
  (cd /tmp/npm-build && tar cf - node_modules) | tar xf - 2>>"$LOG_FILE" || true
  log "node_modules copied via tar"

  # Create shell wrapper scripts for .bin/ (symlinks don't work on virtiofs)
  rm -rf node_modules/.bin
  mkdir -p node_modules/.bin
  if [ -d /tmp/npm-build/node_modules/.bin ]; then
    (cd /tmp/npm-build/node_modules/.bin && for f in *; do
      if [ -L "$f" ]; then
        target=$(readlink "$f")
        cat > "${PROJECT_ROOT}/node_modules/.bin/$f" << WRAPPER
#!/bin/sh
exec "${PROJECT_ROOT}/node_modules/.bin/${target}" "\$@"
WRAPPER
        chmod +x "${PROJECT_ROOT}/node_modules/.bin/$f"
      fi
    done)
  fi
  log ".bin/ wrappers created"

  DEPS_OK="true"
  verify_native_modules
}

verify_native_modules() {
  log "Verifying native modules"
  if node -e "require('better-sqlite3')" >> "$LOG_FILE" 2>&1; then
    NATIVE_OK="true"
    log "better-sqlite3 loads OK"
  else
    log "better-sqlite3 failed to load"
  fi
}

# --- Build tools check ---

check_build_tools() {
  HAS_BUILD_TOOLS="false"

  if [ "$PLATFORM" = "macos" ]; then
    if xcode-select -p >/dev/null 2>&1; then
      HAS_BUILD_TOOLS="true"
    fi
  elif [ "$PLATFORM" = "linux" ]; then
    if command -v gcc >/dev/null 2>&1 && command -v make >/dev/null 2>&1; then
      HAS_BUILD_TOOLS="true"
    fi
  fi

  log "Build tools: $HAS_BUILD_TOOLS"
}

# --- Main ---

log "=== Bootstrap started ==="

detect_platform
check_node
sandbox_prep
install_deps
check_build_tools

# Emit status block
STATUS="success"
if [ "$NODE_OK" = "false" ]; then
  STATUS="node_missing"
elif [ "$DEPS_OK" = "false" ]; then
  STATUS="deps_failed"
elif [ "$NATIVE_OK" = "false" ]; then
  STATUS="native_failed"
fi

cat <<EOF
=== NANOCLAW SETUP: BOOTSTRAP ===
PLATFORM: $PLATFORM
IS_WSL: $IS_WSL
IS_ROOT: $IS_ROOT
NO_SYMLINKS: $NO_SYMLINKS
NODE_VERSION: $NODE_VERSION
NODE_OK: $NODE_OK
NODE_PATH: ${NODE_PATH_FOUND:-not_found}
DEPS_OK: $DEPS_OK
NATIVE_OK: $NATIVE_OK
HAS_BUILD_TOOLS: $HAS_BUILD_TOOLS
STATUS: $STATUS
LOG: logs/setup.log
=== END ===
EOF

log "=== Bootstrap completed: $STATUS ==="

if [ "$NODE_OK" = "false" ]; then
  exit 2
fi
if [ "$DEPS_OK" = "false" ] || [ "$NATIVE_OK" = "false" ]; then
  exit 1
fi
