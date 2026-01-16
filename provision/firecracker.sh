#!/usr/bin/env bash
set -euo pipefail

# Check KVM access
if [[ ! -e /dev/kvm ]]; then
  echo "ERROR: /dev/kvm not found. Is KVM enabled?"
  exit 1
fi

# Download Firecracker binary (idempotent - overwrites existing)
FC_VERSION="1.7.0"
echo "Installing Firecracker v${FC_VERSION}..."
curl -L -o /usr/local/bin/firecracker \
  "https://github.com/firecracker-microvm/firecracker/releases/download/v${FC_VERSION}/firecracker-v${FC_VERSION}-x86_64"
chmod +x /usr/local/bin/firecracker

# Download compatible kernel (idempotent - overwrites existing)
KERNEL_VERSION="5.10.217"
mkdir -p /var/lib/firecracker/kernel
curl -L -o /var/lib/firecracker/kernel/vmlinux \
  "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.7/x86_64/vmlinux-${KERNEL_VERSION}"

echo "Firecracker $(firecracker --version) installed"
echo "Kernel downloaded to /var/lib/firecracker/kernel/vmlinux"
