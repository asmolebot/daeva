#!/usr/bin/env bash
# install-server.sh — Set up daeva on a server host.
#
# Usage:
#   ./scripts/install-server.sh [OPTIONS]
#
# Options:
#   --skip-podman        Skip Podman install/setup steps
#   --skip-service       Skip systemd/quadlet service installation
#   --skip-node-check    Skip Node.js version check
#   --data-dir DIR       Override orchestrator .data directory (default: ~/.local/share/daeva)
#   --port PORT          HTTP port to listen on (default: 8787)
#   --user USER          System user to run the service as (default: current user)
#   --install-dir DIR    Directory to install orchestrator into (default: ~/daeva)
#   --dry-run            Print steps without executing them
#   --help               Show this help message
#
# Requirements:
#   - Node.js >= 20 (checked at runtime unless --skip-node-check)
#   - Podman (optional, for container-based pods; skip with --skip-podman)
#   - systemd user session (optional, for service install; skip with --skip-service)

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
SKIP_PODMAN=false
SKIP_SERVICE=false
SKIP_NODE_CHECK=false
DRY_RUN=false
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/daeva"
PORT="8787"
SERVICE_USER="${USER:-$(id -un)}"
INSTALL_DIR="$HOME/daeva"

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-podman)    SKIP_PODMAN=true ;;
    --skip-service)   SKIP_SERVICE=true ;;
    --skip-node-check) SKIP_NODE_CHECK=true ;;
    --dry-run)        DRY_RUN=true ;;
    --data-dir)       DATA_DIR="$2"; shift ;;
    --port)           PORT="$2"; shift ;;
    --user)           SERVICE_USER="$2"; shift ;;
    --install-dir)    INSTALL_DIR="$2"; shift ;;
    --help|-h)
      grep '^#' "$0" | head -30 | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo "[install] $*"; }
warn() { echo "[install] WARN: $*" >&2; }
die()  { echo "[install] ERROR: $*" >&2; exit 1; }

run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
log "daeva server installer"
log "  install-dir : $INSTALL_DIR"
log "  data-dir    : $DATA_DIR"
log "  port        : $PORT"
log "  user        : $SERVICE_USER"
log "  skip-podman : $SKIP_PODMAN"
log "  skip-service: $SKIP_SERVICE"
log "  dry-run     : $DRY_RUN"
echo

# ---------------------------------------------------------------------------
# Step 1: Node.js check
# ---------------------------------------------------------------------------
if [[ "$SKIP_NODE_CHECK" == "false" ]]; then
  log "Checking Node.js version..."
  if ! command -v node &>/dev/null; then
    die "Node.js not found. Install Node.js >= 20 from https://nodejs.org or use nvm/fnm."
  fi
  NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
  if [[ "$NODE_VER" -lt 20 ]]; then
    die "Node.js >= 20 required (found: $(node --version)). Upgrade via nvm or fnm."
  fi
  log "  Node.js $(node --version) — OK"
fi

# ---------------------------------------------------------------------------
# Step 2: Podman check / setup
# ---------------------------------------------------------------------------
if [[ "$SKIP_PODMAN" == "false" ]]; then
  log "Checking Podman..."
  if command -v podman &>/dev/null; then
    log "  Podman $(podman --version | awk '{print $3}') — found"
  else
    warn "Podman not found. Container-based pods will not function."
    warn "Install with: sudo apt-get install podman  OR  sudo dnf install podman"
    warn "Re-run without --skip-podman once installed, or pass --skip-podman to ignore."
    if [[ "$DRY_RUN" == "false" ]]; then
      read -r -p "Continue without Podman? [y/N] " yn
      [[ "$yn" =~ ^[Yy]$ ]] || die "Aborting."
    fi
  fi

  # Ensure user lingering is enabled so rootless containers survive logout
  if command -v loginctl &>/dev/null && [[ "$SKIP_SERVICE" == "false" ]]; then
    log "Enabling user lingering for $SERVICE_USER..."
    run loginctl enable-linger "$SERVICE_USER" 2>/dev/null || warn "loginctl enable-linger failed (may need sudo)"
  fi
else
  log "Skipping Podman setup (--skip-podman)."
fi

# ---------------------------------------------------------------------------
# Step 3: Install the orchestrator package
# ---------------------------------------------------------------------------
log "Installing orchestrator into $INSTALL_DIR..."
run mkdir -p "$INSTALL_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ_ROOT="$(dirname "$SCRIPT_DIR")"

if [[ -f "$PROJ_ROOT/package.json" ]]; then
  # Running from the project source tree
  log "  Detected source tree install — running npm install + build"
  run npm --prefix "$PROJ_ROOT" ci --omit=dev 2>/dev/null || run npm --prefix "$PROJ_ROOT" install --omit=dev
  run npm --prefix "$PROJ_ROOT" run build
  # Symlink or copy dist
  if [[ "$DRY_RUN" == "false" ]]; then
    if [[ "$(realpath "$PROJ_ROOT")" != "$(realpath "$INSTALL_DIR")" ]]; then
      cp -r "$PROJ_ROOT/dist" "$INSTALL_DIR/"
      cp "$PROJ_ROOT/package.json" "$INSTALL_DIR/"
      cp "$PROJ_ROOT/package-lock.json" "$INSTALL_DIR/" 2>/dev/null || true
    fi
  else
    echo "[dry-run] copy dist + package.json -> $INSTALL_DIR"
  fi
else
  # Running from a release archive or npm global install — assume npm is enough
  log "  Installing from npm..."
  run npm install -g daeva
fi

# ---------------------------------------------------------------------------
# Step 4: Data directory
# ---------------------------------------------------------------------------
log "Creating data directory: $DATA_DIR"
run mkdir -p "$DATA_DIR"

# ---------------------------------------------------------------------------
# Step 5: Environment file
# ---------------------------------------------------------------------------
ENV_FILE="$INSTALL_DIR/.env"
log "Writing environment file: $ENV_FILE"
if [[ "$DRY_RUN" == "false" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    cat > "$ENV_FILE" <<EOF
# daeva environment
PORT=$PORT
HOST=127.0.0.1
DATA_DIR=$DATA_DIR
EOF
    log "  Created $ENV_FILE"
  else
    log "  $ENV_FILE already exists — skipping (edit manually if needed)"
  fi
else
  echo "[dry-run] write $ENV_FILE (PORT=$PORT, HOST=127.0.0.1, DATA_DIR=$DATA_DIR)"
fi

# ---------------------------------------------------------------------------
# Step 6: Systemd user service (optional)
# ---------------------------------------------------------------------------
if [[ "$SKIP_SERVICE" == "false" ]]; then
  SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  SERVICE_FILE="$SERVICE_DIR/daeva.service"
  log "Installing systemd user service: $SERVICE_FILE"

  # Resolve the binary
  if command -v daeva &>/dev/null; then
    BIN_PATH="$(command -v daeva)"
  else
    BIN_PATH="node $INSTALL_DIR/dist/src/cli.js"
  fi

  run mkdir -p "$SERVICE_DIR"
  if [[ "$DRY_RUN" == "false" ]]; then
    cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=daeva HTTP service
After=network.target

[Service]
Type=simple
ExecStart=$BIN_PATH
EnvironmentFile=-$ENV_FILE
WorkingDirectory=$INSTALL_DIR
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF
    log "  Reloading systemd user daemon..."
    systemctl --user daemon-reload 2>/dev/null || warn "systemctl --user daemon-reload failed"
    log "  Enabling service..."
    systemctl --user enable daeva 2>/dev/null || warn "systemctl --user enable failed"
    log ""
    log "  To start now:   systemctl --user start daeva"
    log "  To view logs:   journalctl --user -fu daeva"
  else
    echo "[dry-run] write $SERVICE_FILE and reload systemd"
  fi
else
  log "Skipping service install (--skip-service)."
  log "  To run manually: PORT=$PORT node $INSTALL_DIR/dist/src/cli.js"
fi

# ---------------------------------------------------------------------------
# Step 7: MCP server hint
# ---------------------------------------------------------------------------
log ""
log "MCP server (stdio) is available at: dist/src/mcp-cli.js"
log "  To configure in an MCP client, add:"
log '    { "command": "node", "args": ["'"$INSTALL_DIR"'/dist/src/mcp-cli.js", "--base-url", "http://127.0.0.1:'"$PORT"'"] }'
log ""
log "Install complete."
