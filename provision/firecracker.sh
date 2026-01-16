#!/usr/bin/env bash
set -euo pipefail

# Check KVM access
if [[ ! -e /dev/kvm ]]; then
  echo "ERROR: /dev/kvm not found. Is KVM enabled?"
  exit 1
fi

# Download Firecracker binary (idempotent - overwrites existing)
FC_VERSION="1.10.1"
ARCH="x86_64"
echo "Installing Firecracker v${FC_VERSION}..."
curl -L -o /tmp/firecracker-release.tgz \
  "https://github.com/firecracker-microvm/firecracker/releases/download/v${FC_VERSION}/firecracker-v${FC_VERSION}-${ARCH}.tgz"
tar -xzf /tmp/firecracker-release.tgz -C /tmp
cp /tmp/release-v${FC_VERSION}-${ARCH}/firecracker-v${FC_VERSION}-${ARCH} /usr/local/bin/firecracker
chmod +x /usr/local/bin/firecracker
rm -rf /tmp/firecracker-release.tgz /tmp/release-v${FC_VERSION}-${ARCH}

# Download compatible kernel
echo "Downloading kernel..."
mkdir -p /var/lib/firecracker/kernel
curl -fsSL -o /var/lib/firecracker/kernel/vmlinux \
  "https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/x86_64/kernels/vmlinux.bin"
chmod 644 /var/lib/firecracker/kernel/vmlinux

echo "Firecracker $(firecracker --version) installed"
echo "Kernel downloaded to /var/lib/firecracker/kernel/vmlinux"
