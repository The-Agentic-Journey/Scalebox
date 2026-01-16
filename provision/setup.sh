#!/usr/bin/env bash
# Main entry point - runs all provisioning steps
# Idempotent: safe to re-run for updates or recovery
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Installing system dependencies..."
apt-get update
apt-get install -y curl wget jq iptables iproute2 btrfs-progs

echo "==> Setting up Firecracker..."
"$SCRIPT_DIR/firecracker.sh"

echo "==> Setting up storage..."
"$SCRIPT_DIR/storage.sh"

echo "==> Setting up networking..."
"$SCRIPT_DIR/network.sh"

echo "==> Creating base rootfs..."
"$SCRIPT_DIR/rootfs.sh"

echo "==> Provisioning complete!"
