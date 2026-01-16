#!/usr/bin/env bash
set -euo pipefail

VM_HOST="${VM_HOST:-34.40.56.57}"
VM_USER="${VM_USER:-dev}"
REMOTE_DIR="/home/${VM_USER}/firecracker-api"

case "${1:-}" in
  check)
    echo "==> Running linter..."
    bun run lint
    echo "==> Deploying to VM..."
    "$0" deploy
    echo "==> Restarting server on VM..."
    "$0" stop
    "$0" start
    sleep 2  # Give server time to start
    echo "==> Running integration tests..."
    bun test
    ;;
  lint)
    bun run lint
    ;;
  test)
    bun test
    ;;
  build)
    bun build --compile --outfile=firecracker-api ./src/index.ts
    ;;
  deploy)
    # Sync code to remote VM (excludes node_modules, .git, etc.)
    rsync -avz --delete \
      --exclude 'node_modules' \
      --exclude '.git' \
      --exclude '*.log' \
      ./ "${VM_USER}@${VM_HOST}:${REMOTE_DIR}/"
    # Install dependencies on remote
    ssh "${VM_USER}@${VM_HOST}" "cd ${REMOTE_DIR} && bun install"
    ;;
  provision)
    # Run provisioning scripts on remote VM
    ssh "${VM_USER}@${VM_HOST}" "cd ${REMOTE_DIR} && sudo ./provision/setup.sh"
    ;;
  start)
    # Start the API server on remote VM (in background)
    ssh "${VM_USER}@${VM_HOST}" "cd ${REMOTE_DIR} && nohup bun run src/index.ts > server.log 2>&1 &"
    echo "Server started on ${VM_HOST}:8080"
    ;;
  stop)
    # Stop the API server on remote VM
    ssh "${VM_USER}@${VM_HOST}" "pkill -f 'bun run src/index.ts' || true"
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
