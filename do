#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VM_HOST="${VM_HOST:-34.40.56.57}"
VM_USER="${VM_USER:-dev}"
REMOTE_DIR="/home/${VM_USER}/firecracker-api"

# Local bun installation
BUN_DIR="$SCRIPT_DIR/.bun"
BUN_BIN="$BUN_DIR/bin/bun"

ensure_bun() {
  if [[ ! -x "$BUN_BIN" ]]; then
    echo "==> Installing bun locally..."
    BUN_INSTALL="$BUN_DIR" bash -c "$(curl -fsSL https://bun.sh/install)"
  fi
}

ensure_deps() {
  if [[ ! -d "$SCRIPT_DIR/node_modules" ]] || [[ "$SCRIPT_DIR/package.json" -nt "$SCRIPT_DIR/node_modules" ]]; then
    echo "==> Installing dependencies..."
    "$BUN_BIN" install
  fi
}

bun_run() {
  ensure_bun
  ensure_deps
  "$BUN_BIN" "$@"
}

case "${1:-}" in
  check)
    echo "==> Running linter..."
    bun_run run lint
    echo "==> Deploying to VM..."
    "$0" deploy
    echo "==> Restarting server on VM..."
    "$0" stop
    "$0" start
    sleep 2  # Give server time to start
    echo "==> Running integration tests..."
    bun_run test
    ;;
  lint)
    bun_run run lint
    ;;
  test)
    bun_run test
    ;;
  build)
    bun_run build --compile --outfile=firecracker-api ./src/index.ts
    ;;
  deploy)
    # Build single binary locally
    echo "Building binary..."
    bun_run build --compile --outfile=firecracker-api ./src/index.ts
    # Create remote directory and sync binary + provision scripts
    ssh "${VM_USER}@${VM_HOST}" "mkdir -p ${REMOTE_DIR}/provision"
    rsync -avz firecracker-api "${VM_USER}@${VM_HOST}:${REMOTE_DIR}/"
    rsync -avz provision/ "${VM_USER}@${VM_HOST}:${REMOTE_DIR}/provision/"
    ;;
  provision)
    # Run provisioning scripts on remote VM
    ssh "${VM_USER}@${VM_HOST}" "cd ${REMOTE_DIR} && sudo ./provision/setup.sh"
    ;;
  start)
    # Start the API server on remote VM (in background)
    ssh "${VM_USER}@${VM_HOST}" "cd ${REMOTE_DIR} && nohup ./firecracker-api > server.log 2>&1 &"
    echo "Server started on ${VM_HOST}:8080"
    ;;
  stop)
    # Stop the API server on remote VM
    # Use pattern that won't match the ssh/pkill command itself
    ssh "${VM_USER}@${VM_HOST}" "pkill -f '^./firecracker-api' || true"
    echo "Server stopped"
    ;;
  logs)
    # Tail server logs from remote VM
    ssh "${VM_USER}@${VM_HOST}" "tail -f ${REMOTE_DIR}/server.log"
    ;;
  ssh)
    # SSH into the remote VM
    ssh "${VM_USER}@${VM_HOST}"
    ;;
  *)
    echo "Usage: ./do {check|lint|test|build|deploy|provision|start|stop|logs|ssh}"
    exit 1
    ;;
esac
