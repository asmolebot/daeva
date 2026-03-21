#!/usr/bin/env bash
# install-macos.sh — Install asmo-pod-orchestrator on macOS
#
# Requires: Homebrew (installs if absent)
# Flags:
#   --skip-podman     Skip Podman Desktop installation
#   --skip-service    Skip launchd user service setup
#   --dry-run         Print commands without executing them
#   --help            Show usage
#   --non-interactive Suppress prompts; use defaults
#   --install-dir DIR Install directory (default: ~/Library/Application Support/asmo-pod-orchestrator)
#   --port PORT       HTTP port for the service (default: 8787)
#   --data-dir DIR    Data directory (default: ~/Library/Application Support/asmo-pod-orchestrator/data)
#
# Usage examples:
#   ./install-macos.sh
#   ./install-macos.sh --skip-podman --dry-run
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
SKIP_PODMAN=false
SKIP_SERVICE=false
DRY_RUN=false
NON_INTERACTIVE=false
APP_SUPPORT="${HOME}/Library/Application Support"
INSTALL_DIR="${APP_SUPPORT}/asmo-pod-orchestrator"
DATA_DIR="${APP_SUPPORT}/asmo-pod-orchestrator/data"
PORT=8787
LAUNCHD_LABEL="ai.asmo.pod-orchestrator"
NODE_VERSION_REQUIRED=20

# ---------------------------------------------------------------------------
# Colours
# ---------------------------------------------------------------------------
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[info]${NC} $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}   $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC} $*"; }
err()   { echo -e "${RED}[err]${NC}  $*" >&2; }
die()   { err "$*"; exit 1; }

run() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo -e "${YELLOW}[dry-run]${NC} $*"
  else
    eval "$@"
  fi
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-podman)      SKIP_PODMAN=true ;;
    --skip-service)     SKIP_SERVICE=true ;;
    --dry-run)          DRY_RUN=true ;;
    --non-interactive)  NON_INTERACTIVE=true ;;
    --install-dir)      shift; INSTALL_DIR="$1" ;;
    --port)             shift; PORT="$1" ;;
    --data-dir)         shift; DATA_DIR="$1" ;;
    --help|-h)
      echo "Usage: $0 [--skip-podman] [--skip-service] [--dry-run] [--non-interactive]"
      echo "           [--install-dir DIR] [--port PORT] [--data-dir DIR]"
      exit 0
      ;;
    *) die "Unknown flag: $1  (use --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# macOS check
# ---------------------------------------------------------------------------
if [[ "$(uname -s)" != "Darwin" ]]; then
  die "This script is for macOS only. Use install-linux.sh on Linux."
fi

# ---------------------------------------------------------------------------
# Homebrew
# ---------------------------------------------------------------------------
ensure_brew() {
  if command -v brew &>/dev/null; then
    ok "Homebrew $(brew --version | head -1) already installed"
  else
    info "Installing Homebrew..."
    run '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    # Apple Silicon: add brew to path for this session
    if [[ -f "/opt/homebrew/bin/brew" ]]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
  fi
}

ensure_brew

# ---------------------------------------------------------------------------
# Node.js
# ---------------------------------------------------------------------------
ensure_node() {
  if command -v node &>/dev/null; then
    local ver
    ver="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
    if [[ "${ver}" -ge "${NODE_VERSION_REQUIRED}" ]]; then
      ok "Node.js ${ver} already installed"
      return
    fi
    warn "Node.js ${ver} < ${NODE_VERSION_REQUIRED}; upgrading via Homebrew..."
  else
    info "Installing Node.js ${NODE_VERSION_REQUIRED}+ via Homebrew..."
  fi
  run "brew install node@${NODE_VERSION_REQUIRED}"
  run 'brew link --overwrite "node@'"${NODE_VERSION_REQUIRED}"'"'
}

ensure_node

# ---------------------------------------------------------------------------
# Podman
# ---------------------------------------------------------------------------
if [[ "${SKIP_PODMAN}" == "false" ]]; then
  if command -v podman &>/dev/null; then
    ok "Podman already installed: $(podman --version)"
  else
    info "Installing Podman via Homebrew..."
    run "brew install podman"
    # Optionally install Podman Desktop (GUI) — only if interactive
    if [[ "${NON_INTERACTIVE}" == "false" ]]; then
      echo ""
      read -rp "Install Podman Desktop (GUI)? [y/N] " REPLY
      if [[ "${REPLY}" =~ ^[Yy]$ ]]; then
        run "brew install --cask podman-desktop"
      fi
    fi
  fi
else
  info "Skipping Podman installation (--skip-podman)"
fi

# ---------------------------------------------------------------------------
# Install asmo-pod-orchestrator
# ---------------------------------------------------------------------------
info "Installing asmo-pod-orchestrator..."
run "mkdir -p '${INSTALL_DIR}'"
run "mkdir -p '${DATA_DIR}'"

if [[ -f "$(pwd)/package.json" ]] && grep -q '"asmo-pod-orchestrator"' "$(pwd)/package.json" 2>/dev/null; then
  info "Installing from local source tree..."
  run "npm install --prefix '${INSTALL_DIR}' --production"
  run "cp -r . '${INSTALL_DIR}/'"
else
  info "Installing from npm..."
  run "npm install -g asmo-pod-orchestrator"
fi

# Write .env
ENV_FILE="${DATA_DIR}/.env"
info "Writing .env to ${ENV_FILE}..."
if [[ "${DRY_RUN}" == "false" ]]; then
  cat > "${ENV_FILE}" <<EOF
PORT=${PORT}
DATA_DIR=${DATA_DIR}
EOF
fi

# ---------------------------------------------------------------------------
# launchd user service (~/Library/LaunchAgents)
# ---------------------------------------------------------------------------
if [[ "${SKIP_SERVICE}" == "false" ]]; then
  LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
  PLIST_FILE="${LAUNCH_AGENTS_DIR}/${LAUNCHD_LABEL}.plist"

  EXEC_PATH="$(command -v asmo-pod-orchestrator 2>/dev/null || echo "${INSTALL_DIR}/node_modules/.bin/asmo-pod-orchestrator")"

  info "Writing launchd plist to ${PLIST_FILE}..."
  run "mkdir -p '${LAUNCH_AGENTS_DIR}'"

  if [[ "${DRY_RUN}" == "false" ]]; then
    cat > "${PLIST_FILE}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${EXEC_PATH}</string>
    <string>--port</string>
    <string>${PORT}</string>
    <string>--data-dir</string>
    <string>${DATA_DIR}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${PORT}</string>
    <key>DATA_DIR</key>
    <string>${DATA_DIR}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${DATA_DIR}/logs/stdout.log</string>

  <key>StandardErrorPath</key>
  <string>${DATA_DIR}/logs/stderr.log</string>
</dict>
</plist>
EOF
  fi

  run "mkdir -p '${DATA_DIR}/logs'"
  run "launchctl load -w '${PLIST_FILE}'"

  ok "launchd agent installed and started."
  echo ""
  echo -e "${GREEN}Manage the service with:${NC}"
  echo "  launchctl stop  ${LAUNCHD_LABEL}"
  echo "  launchctl start ${LAUNCHD_LABEL}"
  echo "  launchctl unload '${PLIST_FILE}'  # disable autostart"
else
  info "Skipping service setup (--skip-service)"
  echo ""
  echo -e "${GREEN}Start manually with:${NC}"
  echo "  asmo-pod-orchestrator --port ${PORT} --data-dir '${DATA_DIR}'"
fi

echo ""
ok "Installation complete. API will be available at http://127.0.0.1:${PORT}"
