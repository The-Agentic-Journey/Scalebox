#!/usr/bin/env bash
# Main entry point - runs all provisioning steps
# Idempotent: safe to re-run for updates or recovery
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Installing system dependencies..."
apt-get update
apt-get install -y curl wget jq iptables iproute2 btrfs-progs

# Add current user to kvm group (or create a service user)
if [ -n "${SUDO_USER:-}" ]; then
  usermod -a -G kvm "$SUDO_USER"
  echo "Added $SUDO_USER to kvm group"
fi

echo "==> Setting up Firecracker..."
"$SCRIPT_DIR/firecracker.sh"

echo "==> Setting up storage..."
"$SCRIPT_DIR/storage.sh"

echo "==> Setting up networking..."
"$SCRIPT_DIR/network.sh"

echo "==> Creating base rootfs..."
"$SCRIPT_DIR/rootfs.sh"

echo "==> Provisioning complete!"
