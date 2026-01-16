#!/usr/bin/env bash
set -euo pipefail

TEMPLATE_PATH="/var/lib/firecracker/templates/debian-base.ext4"

# Skip if template already exists
if [[ -f "$TEMPLATE_PATH" ]]; then
  echo "debian-base template already exists, skipping"
  exit 0
fi

echo "Creating debian-base template..."

# Install debootstrap if needed
apt-get install -y debootstrap

# Clean up any previous failed attempt
rm -rf /tmp/rootfs

# Create rootfs (use explicit Debian version for reproducibility)
mkdir -p /tmp/rootfs
debootstrap --include=openssh-server,iproute2,iputils-ping,haveged bookworm /tmp/rootfs http://deb.debian.org/debian

# Configure for Firecracker
chroot /tmp/rootfs /bin/bash <<'CHROOT_EOF'
# Enable serial console
systemctl enable serial-getty@ttyS0.service

# Configure SSH
mkdir -p /root/.ssh
chmod 700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

# Allow root login with key
sed -i 's/#PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config

# Generate SSH host keys (required for sshd to start)
ssh-keygen -A

# Enable sshd service
systemctl enable ssh.service

# Enable haveged for entropy (required for SSH to start quickly)
systemctl enable haveged.service

# Set hostname
echo "firecracker-vm" > /etc/hostname

# Network is configured via kernel boot args, not /etc/network/interfaces
# Just configure loopback, eth0 gets IP from kernel cmdline
cat > /etc/network/interfaces <<'NETEOF'
auto lo
iface lo inet loopback
NETEOF

# Configure DNS (use Google's public DNS)
echo "nameserver 8.8.8.8" > /etc/resolv.conf

# Clean up
apt-get clean
rm -rf /var/lib/apt/lists/*
CHROOT_EOF

# Create ext4 image
truncate -s 2G "$TEMPLATE_PATH"
mkfs.ext4 "$TEMPLATE_PATH"
mkdir -p /mnt/rootfs
mount "$TEMPLATE_PATH" /mnt/rootfs
cp -a /tmp/rootfs/* /mnt/rootfs/
umount /mnt/rootfs
rm -rf /tmp/rootfs

echo "debian-base template created"
