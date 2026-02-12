#!/bin/bash
# Template build script - used by install.sh and scalebox-rebuild-template
# Installed to: /usr/local/lib/scalebox/template-build.sh
#
# This is a library script (designed to be sourced, not executed directly)
# Usage:
#   source /usr/local/lib/scalebox/template-build.sh
#   build_debian_base "/var/lib/scalebox"

TEMPLATE_VERSION=6

# Set up bind mounts for chroot environment
setup_chroot_mounts() {
  local rootfs_dir="$1"
  mount --bind /dev "$rootfs_dir/dev"
  mount --bind /dev/pts "$rootfs_dir/dev/pts"
  mount --bind /proc "$rootfs_dir/proc"
  mount --bind /sys "$rootfs_dir/sys"
  # Copy resolv.conf for network access
  cp /etc/resolv.conf "$rootfs_dir/etc/resolv.conf"
}

# Tear down bind mounts from chroot environment
teardown_chroot_mounts() {
  local rootfs_dir="$1"
  umount "$rootfs_dir/sys" 2>/dev/null || true
  umount "$rootfs_dir/proc" 2>/dev/null || true
  umount "$rootfs_dir/dev/pts" 2>/dev/null || true
  umount "$rootfs_dir/dev" 2>/dev/null || true
}

# Cleanup function for build directories
cleanup_build() {
  local rootfs_dir="$1"
  local mount_dir="$2"
  # Unmount chroot mounts if still mounted
  teardown_chroot_mounts "$rootfs_dir"
  # Unmount if still mounted
  umount "$mount_dir" 2>/dev/null || true
  rm -rf "$rootfs_dir" "$mount_dir" 2>/dev/null || true
}

# Configure the rootfs with SSH, networking, etc.
configure_rootfs() {
  local rootfs_dir="$1"

  # Set up bind mounts for chroot environment
  setup_chroot_mounts "$rootfs_dir"

  chroot "$rootfs_dir" /bin/bash <<'CHROOT'
# Configure locale for mosh
sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen
locale-gen
echo 'LANG=en_US.UTF-8' > /etc/default/locale

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

# Create user with passwordless sudo
useradd -m -s /bin/bash user
echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/user
chmod 440 /etc/sudoers.d/user

# Enable services - explicitly disable ssh.socket to avoid socket activation issues
# Socket activation can cause SSH to not respond if sshd spawn is delayed
systemctl disable ssh.socket 2>/dev/null || true
systemctl enable ssh.service
systemctl enable haveged.service
systemctl enable serial-getty@ttyS0.service
CHROOT

  # Create user setup script
  cat > "$rootfs_dir/tmp/setup-user.sh" <<'USERSCRIPT'
#!/bin/bash
set -e

# Configure PATH for ~/.local/bin (where Claude installs)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

# Install Claude Code CLI
curl -fsSL https://claude.ai/install.sh | bash

# Verify installation
~/.local/bin/claude --version
USERSCRIPT

  # Run user setup (MUST fail loudly for CI)
  # Use "bash /tmp/setup-user.sh" instead of direct execution to bypass noexec on /tmp
  echo "[template-build] Running user setup script..."
  if ! chroot "$rootfs_dir" sudo -u user bash /tmp/setup-user.sh; then
    echo "[template-build] ERROR: User setup failed"
    exit 1
  fi
  echo "[template-build] User setup completed successfully"
  rm -f "$rootfs_dir/tmp/setup-user.sh"

  # Tear down bind mounts after chroot completes
  teardown_chroot_mounts "$rootfs_dir"
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
  debootstrap --include=openssh-server,iproute2,iputils-ping,haveged,netcat-openbsd,mosh,locales,sudo,curl,wget,vim,nodejs,npm,python3,python3-pip,python3-venv \
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
