#!/bin/bash
# Template build script - used by install.sh and scalebox-rebuild-template
# Installed to: /usr/local/lib/scalebox/template-build.sh
#
# This is a library script (designed to be sourced, not executed directly)
# Usage:
#   source /usr/local/lib/scalebox/template-build.sh
#   build_debian_base "/var/lib/scalebox"

TEMPLATE_VERSION=2

# Cleanup function for build directories
cleanup_build() {
  local rootfs_dir="$1"
  local mount_dir="$2"
  # Unmount if still mounted
  umount "$mount_dir" 2>/dev/null || true
  rm -rf "$rootfs_dir" "$mount_dir" 2>/dev/null || true
}

# Configure the rootfs with SSH, networking, etc.
configure_rootfs() {
  local rootfs_dir="$1"

  chroot "$rootfs_dir" /bin/bash <<'CHROOT'
# Disable root password (key-only auth)
passwd -d root

# Configure SSH
mkdir -p /root/.ssh
chmod 700 /root/.ssh
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
# Explicitly listen on all interfaces
sed -i 's/^#\?ListenAddress.*/ListenAddress 0.0.0.0/' /etc/ssh/sshd_config
# Add ListenAddress if not present
grep -q "^ListenAddress" /etc/ssh/sshd_config || echo "ListenAddress 0.0.0.0" >> /etc/ssh/sshd_config

# Generate host keys
ssh-keygen -A

# Enable services - explicitly disable ssh.socket to avoid socket activation issues
# Socket activation can cause SSH to not respond if sshd spawn is delayed
systemctl disable ssh.socket 2>/dev/null || true
systemctl enable ssh.service
systemctl enable haveged.service
systemctl enable serial-getty@ttyS0.service
CHROOT
}

# Create ext4 image from rootfs directory
create_ext4_image() {
  local rootfs_dir="$1"
  local mount_dir="$2"
  local template_path="$3"

  # Create ext4 image (use .tmp for atomic creation)
  local tmp_path="${template_path}.tmp"
  truncate -s 2G "$tmp_path"
  mkfs.ext4 -F "$tmp_path" >/dev/null

  mount -o loop "$tmp_path" "$mount_dir"
  cp -a "$rootfs_dir"/* "$mount_dir"/
  umount "$mount_dir"

  # Atomic rename to final path
  mv "$tmp_path" "$template_path"
}

# Main function to build the debian-base template
# Arguments:
#   $1 - data_dir (e.g., /var/lib/scalebox)
build_debian_base() {
  local data_dir="${1:-/var/lib/scalebox}"
  local template_path="$data_dir/templates/debian-base.ext4"
  local version_path="$data_dir/templates/debian-base.version"

  # Create temp directories
  local rootfs_dir
  local mount_dir
  rootfs_dir=$(mktemp -d /tmp/rootfs-XXXXXX)
  mount_dir=$(mktemp -d /tmp/mount-XXXXXX)

  # Set up cleanup trap
  trap "cleanup_build '$rootfs_dir' '$mount_dir'" EXIT

  # Run debootstrap with all required packages
  debootstrap --include=openssh-server,iproute2,iputils-ping,haveged,netcat-openbsd,mosh \
    bookworm "$rootfs_dir" http://deb.debian.org/debian

  # Configure the rootfs
  configure_rootfs "$rootfs_dir"

  # Create ext4 image
  create_ext4_image "$rootfs_dir" "$mount_dir" "$template_path"

  # Write version file
  echo "$TEMPLATE_VERSION" > "$version_path"

  # Clear trap and cleanup
  trap - EXIT
  cleanup_build "$rootfs_dir" "$mount_dir"

  echo "[scalebox] Base template created: $template_path"
}
