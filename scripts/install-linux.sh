#!/usr/bin/env bash
# install-linux.sh — Install daeva on Linux
#
# Supports: apt (Debian/Ubuntu), dnf (Fedora/RHEL), snap, flatpak
# Flags:
#   --skip-podman     Skip Podman installation
#   --skip-service    Skip systemd user service setup
#   --dry-run         Print commands without executing them
#   --help            Show usage
#   --non-interactive Suppress prompts; use defaults
#   --install-dir DIR Install directory (default: ~/.local/lib/daeva)
#   --port PORT       HTTP port for the service (default: 8787)
#   --data-dir DIR    Data directory (default: ~/.local/share/daeva)
#   --node-bin PATH   Explicit path to node binary
#   --npm-bin PATH    Explicit path to npm binary
#
# Usage examples:
#   ./install-linux.sh
#   ./install-linux.sh --skip-podman --skip-service
#   ./install-linux.sh --dry-run
#   ./install-linux.sh --node-bin ~/.local/share/fnm/current/bin/node --npm-bin ~/.local/share/fnm/current/bin/npm
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
SKIP_PODMAN=false
SKIP_SERVICE=false
DRY_RUN=false
NON_INTERACTIVE=false
INSTALL_DIR="${HOME}/.local/lib/daeva"
DATA_DIR="${HOME}/.local/share/daeva"
PORT=8787
SERVICE_NAME="daeva"
NODE_VERSION_REQUIRED="20"
NODE_BIN=""
NPM_BIN=""

# ---------------------------------------------------------------------------
# Colours
# ---------------------------------------------------------------------------
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[info]${NC} $*"; }
ok()      { echo -e "${GREEN}[ok]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC} $*"; }
err()     { echo -e "${RED}[err]${NC}  $*" >&2; }
die()     { err "$*"; exit 1; }

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
    --node-bin)         shift; NODE_BIN="$1" ;;
    --npm-bin)          shift; NPM_BIN="$1" ;;
    --help|-h)
      echo "Usage: $0 [--skip-podman] [--skip-service] [--dry-run] [--non-interactive]"
      echo "           [--install-dir DIR] [--port PORT] [--data-dir DIR] [--node-bin PATH] [--npm-bin PATH]"
      exit 0
      ;;
    *) die "Unknown flag: $1  (use --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# OS detection
# ---------------------------------------------------------------------------
detect_pkg_manager() {
  if command -v apt-get &>/dev/null; then   echo "apt";  return; fi
  if command -v dnf     &>/dev/null; then   echo "dnf";  return; fi
  if command -v yum     &>/dev/null; then   echo "yum";  return; fi
  if command -v zypper  &>/dev/null; then   echo "zypper"; return; fi
  if command -v pacman  &>/dev/null; then   echo "pacman"; return; fi
  echo "unknown"
}

PKG_MGR="$(detect_pkg_manager)"
info "Detected package manager: ${PKG_MGR}"

# ---------------------------------------------------------------------------
# Prerequisite check
# ---------------------------------------------------------------------------
MISSING=()
check_prereq() {
  local cmd="$1" label="${2:-$1}"
  if ! command -v "${cmd}" &>/dev/null; then
    MISSING+=("${label}")
  fi
}

check_prereq node  "Node.js >= ${NODE_VERSION_REQUIRED}"
check_prereq npm   "npm"
check_prereq git   "git"

if [[ ${#MISSING[@]} -gt 0 ]]; then
  warn "Missing prerequisites: ${MISSING[*]}"
fi

# ---------------------------------------------------------------------------
# Node.js / npm installation
# ---------------------------------------------------------------------------
refresh_node_shims() {
  hash -r
}

set_node_bins() {
  if [[ -n "$NODE_BIN" ]]; then
    [[ -x "$NODE_BIN" ]] || die "--node-bin is not executable: $NODE_BIN"
    export PATH="$(dirname "$NODE_BIN"):$PATH"
  fi
  if [[ -n "$NPM_BIN" ]]; then
    [[ -x "$NPM_BIN" ]] || die "--npm-bin is not executable: $NPM_BIN"
    export PATH="$(dirname "$NPM_BIN"):$PATH"
  fi
  refresh_node_shims
}

try_load_fnm() {
  local fnm_bin=""
  if command -v fnm &>/dev/null; then
    fnm_bin="$(command -v fnm)"
  elif [[ -x "$HOME/.local/share/fnm/fnm" ]]; then
    fnm_bin="$HOME/.local/share/fnm/fnm"
  fi

  [[ -n "$fnm_bin" ]] || return 1
  info "Loading Node environment from fnm..."
  eval "$($fnm_bin env --shell bash)"
  refresh_node_shims
  command -v node &>/dev/null && command -v npm &>/dev/null
}

try_load_nvm() {
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  local nvm_sh="$nvm_dir/nvm.sh"
  [[ -s "$nvm_sh" ]] || return 1

  info "Loading Node environment from nvm..."
  # shellcheck disable=SC1090
  source "$nvm_sh"
  refresh_node_shims
  if ! command -v node &>/dev/null && command -v nvm &>/dev/null; then
    nvm use default >/dev/null 2>&1 || nvm use node >/dev/null 2>&1 || true
    refresh_node_shims
  fi
  command -v node &>/dev/null && command -v npm &>/dev/null
}

resolve_node_toolchain() {
  set_node_bins

  if command -v node &>/dev/null && command -v npm &>/dev/null; then
    return 0
  fi

  try_load_fnm && return 0
  try_load_nvm && return 0
  return 1
}

install_node() {
  info "Installing Node.js ${NODE_VERSION_REQUIRED}+..."
  case "${PKG_MGR}" in
    apt)
      run "curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION_REQUIRED}.x | sudo -E bash -"
      run "sudo apt-get install -y nodejs"
      ;;
    dnf)
      run "sudo dnf install -y nodejs npm"
      ;;
    yum)
      run "sudo yum install -y nodejs npm"
      ;;
    zypper)
      run "sudo zypper install -y nodejs npm"
      ;;
    pacman)
      run "sudo pacman -S --noconfirm nodejs npm"
      ;;
    *)
      # Fallback: try snap
      if command -v snap &>/dev/null; then
        run "sudo snap install node --channel=${NODE_VERSION_REQUIRED}/stable --classic"
      else
        die "Cannot install Node.js automatically. Please install Node.js ${NODE_VERSION_REQUIRED}+ manually and re-run."
      fi
      ;;
  esac
}

ensure_node() {
  if ! resolve_node_toolchain; then
    install_node
    resolve_node_toolchain || die "Node.js/npm still not available after installation attempt."
  fi

  local ver
  ver="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
  if [[ "${ver}" -lt "${NODE_VERSION_REQUIRED}" ]]; then
    warn "Node.js ${ver} detected; ${NODE_VERSION_REQUIRED}+ required. Attempting upgrade..."
    install_node
    resolve_node_toolchain || die "Node.js/npm still not available after upgrade attempt."
    ver="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
  fi

  ok "Node.js ${ver} already installed"
}

ensure_node

# ---------------------------------------------------------------------------
# Podman installation
# ---------------------------------------------------------------------------
if [[ "${SKIP_PODMAN}" == "false" ]]; then
  if command -v podman &>/dev/null; then
    ok "Podman already installed: $(podman --version)"
  else
    info "Installing Podman..."
    case "${PKG_MGR}" in
      apt)    run "sudo apt-get install -y podman" ;;
      dnf)    run "sudo dnf install -y podman" ;;
      yum)    run "sudo yum install -y podman" ;;
      zypper) run "sudo zypper install -y podman" ;;
      pacman) run "sudo pacman -S --noconfirm podman" ;;
      *)
        # Snap fallback
        if command -v snap &>/dev/null; then
          run "sudo snap install podman"
        # Flatpak fallback
        elif command -v flatpak &>/dev/null; then
          warn "Podman is not available via flatpak. Skipping Podman install."
          warn "Install Podman manually from https://podman.io/getting-started/installation"
        else
          warn "Podman installation skipped: no known install path for '${PKG_MGR}'."
          warn "Install manually from https://podman.io/getting-started/installation"
        fi
        ;;
    esac
  fi
else
  info "Skipping Podman installation (--skip-podman)"
fi

# ---------------------------------------------------------------------------
# Install daeva
# ---------------------------------------------------------------------------
info "Installing daeva to ${INSTALL_DIR}..."
run "mkdir -p '${INSTALL_DIR}'"
run "mkdir -p '${DATA_DIR}'"

if [[ -f "$(pwd)/package.json" ]] && grep -q '"daeva"' "$(pwd)/package.json" 2>/dev/null; then
  info "Installing from local source tree..."
  run "npm install --prefix '${INSTALL_DIR}' --production"
  run "cp -r . '${INSTALL_DIR}/'"
else
  info "Installing from npm..."
  run "npm install -g daeva"
fi

# Write .env
ENV_FILE="${DATA_DIR}/.env"
info "Writing .env to ${ENV_FILE}..."
run "mkdir -p '$(dirname "${ENV_FILE}")'"
if [[ "${DRY_RUN}" == "false" ]]; then
  cat > "${ENV_FILE}" <<EOF
PORT=${PORT}
DATA_DIR=${DATA_DIR}
EOF
fi

# ---------------------------------------------------------------------------
# systemd user service
# ---------------------------------------------------------------------------
if [[ "${SKIP_SERVICE}" == "false" ]]; then
  SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
  UNIT_FILE="${SYSTEMD_USER_DIR}/${SERVICE_NAME}.service"

  EXEC_START="$(command -v daeva 2>/dev/null || echo "${INSTALL_DIR}/node_modules/.bin/daeva")"

  info "Writing systemd user unit to ${UNIT_FILE}..."
  run "mkdir -p '${SYSTEMD_USER_DIR}'"
  if [[ "${DRY_RUN}" == "false" ]]; then
    cat > "${UNIT_FILE}" <<EOF
[Unit]
Description=daeva — local GPU pod orchestrator
After=network.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
ExecStart=${EXEC_START} --port ${PORT} --data-dir ${DATA_DIR}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  fi

  run "systemctl --user daemon-reload"
  run "systemctl --user enable '${SERVICE_NAME}'"

  ok "Service installed."
  echo ""
  echo -e "${GREEN}Start the service with:${NC}"
  echo "  systemctl --user start ${SERVICE_NAME}"
  echo "  systemctl --user status ${SERVICE_NAME}"
else
  info "Skipping service setup (--skip-service)"
  echo ""
  echo -e "${GREEN}Start manually with:${NC}"
  echo "  daeva --port ${PORT} --data-dir ${DATA_DIR}"
fi

echo ""
ok "Installation complete. API will be available at http://127.0.0.1:${PORT}"
