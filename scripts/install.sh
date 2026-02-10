#!/bin/bash
#
# Scalebox Installer
#
# Usage:
#   Local:  sudo bash /opt/scalebox/install.sh
#   Remote: curl -sSL https://example.com/install.sh | sudo bash
#
set -euo pipefail

# === Configuration ===
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$SCRIPT_DIR}"
DATA_DIR="${DATA_DIR:-/var/lib/scalebox}"
API_PORT="${API_PORT:-8080}"
API_TOKEN="${API_TOKEN:-}"
API_DOMAIN="${API_DOMAIN:-}"
VM_DOMAIN="${VM_DOMAIN:-}"
ACME_STAGING="${ACME_STAGING:-false}"

FC_VERSION="1.10.1"
KERNEL_URL="https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/x86_64/kernels/vmlinux.bin"
TEMPLATE_VERSION=4

# === Helpers ===
log() { echo "[scalebox] $1"; }
die() { echo "[scalebox] ERROR: $1" >&2; exit 1; }

# === Cleanup trap for failed installs ===
TEMP_DIRS=()
cleanup_temps() {
  for dir in "${TEMP_DIRS[@]}"; do
    rm -rf "$dir" 2>/dev/null || true
  done
}
trap cleanup_temps EXIT

# === Checks ===
check_root() {
  [[ $EUID -eq 0 ]] || die "Must run as root"
}

check_os() {
  [[ -f /etc/debian_version ]] || die "Only Debian/Ubuntu supported"
}

check_kvm() {
  [[ -e /dev/kvm ]] || die "/dev/kvm not found. Enable nested virtualization."
  [[ -r /dev/kvm && -w /dev/kvm ]] || die "/dev/kvm not accessible. Check permissions."
}

# === Install System Dependencies ===
install_deps() {
  log "Installing system dependencies..."
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    curl wget jq iptables iproute2 btrfs-progs \
    debootstrap qemu-utils e2fsprogs openssh-client openssl
}

# === Setup Storage ===
setup_storage() {
  local img_path="/var/lib/scalebox.img"

  if mountpoint -q "$DATA_DIR" 2>/dev/null; then
    log "Storage already mounted at $DATA_DIR"
    return
  fi

  log "Setting up btrfs storage..."
  mkdir -p "$DATA_DIR"

  if [[ ! -f "$img_path" ]]; then
    # Calculate recommended size (80% of available space)
    local available_gb=$(df -BG /var/lib --output=avail | tail -1 | tr -d ' G')
    local recommended=$((available_gb * 80 / 100))

    # Enforce bounds
    if [[ $recommended -lt 20 ]]; then
      die "Insufficient disk space. Need at least 25GB free, found ${available_gb}GB"
    fi
    [[ $recommended -gt 4096 ]] && recommended=4096

    # Allow override via env var, default to auto-calculated
    local size="${STORAGE_SIZE:-${recommended}G}"

    log "Creating ${size} btrfs storage pool (${available_gb}GB available on host)..."
    truncate -s "$size" "$img_path"
    mkfs.btrfs "$img_path"
  fi

  mount -o loop "$img_path" "$DATA_DIR"

  if ! grep -q "$img_path" /etc/fstab; then
    echo "$img_path $DATA_DIR btrfs loop,nofail 0 0" >> /etc/fstab
  fi

  mkdir -p "$DATA_DIR/templates" "$DATA_DIR/vms" "$DATA_DIR/kernel"
}

# === Install Firecracker ===
install_firecracker() {
  local fc_bin="/usr/local/bin/firecracker"
  local kernel_path="$DATA_DIR/kernel/vmlinux"
  local arch
  arch=$(uname -m)

  if [[ -f "$fc_bin" ]]; then
    log "Firecracker already installed"
  else
    log "Installing Firecracker v${FC_VERSION}..."
    wget -q "https://github.com/firecracker-microvm/firecracker/releases/download/v${FC_VERSION}/firecracker-v${FC_VERSION}-${arch}.tgz" -O /tmp/fc.tgz
    tar -xzf /tmp/fc.tgz -C /tmp
    mv "/tmp/release-v${FC_VERSION}-${arch}/firecracker-v${FC_VERSION}-${arch}" "$fc_bin"
    chmod +x "$fc_bin"
    rm -rf /tmp/fc.tgz /tmp/release-*
  fi

  if [[ ! -f "$kernel_path" ]]; then
    log "Downloading kernel..."
    wget -q "$KERNEL_URL" -O "$kernel_path"
  fi
}

# === Setup Network (systemd-networkd) ===
setup_network() {
  local bridge="br0"

  # Check if bridge already exists and is configured
  if ip link show "$bridge" &>/dev/null; then
    log "Bridge $bridge already exists"
  else
    log "Setting up network..."
  fi

  # Configure NetworkManager to ignore br0 (if present) instead of disabling it
  # This prevents disconnecting the primary interface on GCE
  if command -v nmcli &>/dev/null; then
    mkdir -p /etc/NetworkManager/conf.d
    cat > /etc/NetworkManager/conf.d/scalebox.conf <<'EOF'
[keyfile]
unmanaged-devices=interface-name:br0;interface-name:tap*
EOF
    systemctl reload NetworkManager 2>/dev/null && sleep 3 || true
  fi

  # Enable IP forwarding
  sysctl -w net.ipv4.ip_forward=1 >/dev/null
  cat > /etc/sysctl.d/99-scalebox.conf <<'EOF'
net.ipv4.ip_forward=1
EOF

  # Configure bridge via systemd-networkd (persistent across reboots)
  mkdir -p /etc/systemd/network

  cat > /etc/systemd/network/10-br0.netdev <<'EOF'
[NetDev]
Name=br0
Kind=bridge
EOF

  cat > /etc/systemd/network/20-br0.network <<'EOF'
[Match]
Name=br0

[Network]
Address=172.16.0.1/16
ConfigureWithoutCarrier=yes
EOF

  # Enable and start systemd-networkd
  systemctl enable systemd-networkd
  systemctl restart systemd-networkd

  # Wait for bridge to come up
  local retries=10
  while [[ $retries -gt 0 ]]; do
    if ip link show "$bridge" &>/dev/null; then
      break
    fi
    sleep 1
    ((retries--)) || true
  done

  # Get default interface (with retry for cloud-init timing)
  local default_if=""
  local if_retries=30
  while [[ $if_retries -gt 0 && -z "$default_if" ]]; do
    default_if=$(ip route | awk '/default/ {for(i=1;i<=NF;i++) if($i=="dev") print $(i+1); exit}')
    if [[ -z "$default_if" ]]; then
      sleep 1
      ((if_retries--)) || true
    fi
  done
  [[ -n "$default_if" ]] || die "Could not determine default interface"

  # Setup iptables rules (idempotent - remove first, then add)
  # NAT for outbound traffic
  iptables -t nat -D POSTROUTING -s 172.16.0.0/16 -o "$default_if" -j MASQUERADE 2>/dev/null || true
  iptables -t nat -A POSTROUTING -s 172.16.0.0/16 -o "$default_if" -j MASQUERADE

  # FORWARD rules (required for VM traffic to flow)
  iptables -D FORWARD -i br0 -o "$default_if" -j ACCEPT 2>/dev/null || true
  iptables -D FORWARD -i "$default_if" -o br0 -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
  iptables -A FORWARD -i br0 -o "$default_if" -j ACCEPT
  iptables -A FORWARD -i "$default_if" -o br0 -m state --state RELATED,ESTABLISHED -j ACCEPT

  # Save iptables rules
  mkdir -p /etc/iptables
  iptables-save > /etc/iptables/rules.v4

  # Create systemd service to restore iptables on boot
  cat > /etc/systemd/system/iptables-restore.service <<'EOF'
[Unit]
Description=Restore iptables rules
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/iptables-restore /etc/iptables/rules.v4
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable iptables-restore
}

# === Create Base Template ===
# Try to use the shared template-build.sh library if available.
# Fall back to inline code for fresh installs before the library is installed.
_TEMPLATE_BUILD_LIB="/usr/local/lib/scalebox/template-build.sh"

create_rootfs() {
  local template_path="$DATA_DIR/templates/debian-base.ext4"

  if [[ -f "$template_path" ]]; then
    log "Base template already exists"
    return
  fi

  log "Creating Debian base template (this takes a few minutes)..."

  # Use shared library if available (installed by scalebox-update)
  if [[ -f "$_TEMPLATE_BUILD_LIB" ]]; then
    # shellcheck source=/dev/null
    source "$_TEMPLATE_BUILD_LIB"
    build_debian_base "$DATA_DIR"
    return
  fi

  # Fallback: inline template creation for fresh installs
  # This code is duplicated from template-build.sh to ensure install.sh
  # works standalone before the first update installs the library.
  local rootfs_dir="/tmp/rootfs-$$"
  local mount_dir="/tmp/mount-$$"
  TEMP_DIRS+=("$rootfs_dir" "$mount_dir")

  mkdir -p "$rootfs_dir" "$mount_dir"

  # Debootstrap minimal Debian
  debootstrap --include=openssh-server,iproute2,iputils-ping,haveged,netcat-openbsd,mosh,locales,sudo \
    bookworm "$rootfs_dir" http://deb.debian.org/debian

  # Configure the rootfs
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

  # Create ext4 image (use .tmp for atomic creation)
  local tmp_path="${template_path}.tmp"
  truncate -s 2G "$tmp_path"
  mkfs.ext4 -F "$tmp_path" >/dev/null

  mount -o loop "$tmp_path" "$mount_dir"
  cp -a "$rootfs_dir"/* "$mount_dir"/
  umount "$mount_dir"

  # Atomic rename to final path
  mv "$tmp_path" "$template_path"

  # Write version file
  echo "$TEMPLATE_VERSION" > "$DATA_DIR/templates/debian-base.version"

  # Cleanup
  rm -rf "$rootfs_dir" "$mount_dir"
  TEMP_DIRS=()

  log "Base template created: $template_path"
}

# === Install Caddy (HTTPS reverse proxy) ===
install_caddy() {
  [[ -n "$API_DOMAIN" || -n "$VM_DOMAIN" ]] || return 0

  log "Installing Caddy..."
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' 2>/dev/null | gpg --dearmor -o /usr/share/keyrings/caddy.gpg
  echo "deb [signed-by=/usr/share/keyrings/caddy.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" > /etc/apt/sources.list.d/caddy.list
  apt-get update -qq
  apt-get install -y -qq caddy

  # Create vms.caddy stub file (managed by scaleboxd at runtime)
  cat > /etc/caddy/vms.caddy <<'VMSCADDYEOF'
# Managed by scaleboxd - do not edit manually
# VM routes will be generated on scaleboxd startup
VMSCADDYEOF

  # Start Caddyfile with global options
  if [[ "$ACME_STAGING" == "true" ]]; then
    cat > /etc/caddy/Caddyfile <<'CADDYEOF'
{
    acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
    on_demand_tls {
        ask http://localhost:8080/caddy/check
    }
}
CADDYEOF
  else
    cat > /etc/caddy/Caddyfile <<'CADDYEOF'
{
    on_demand_tls {
        ask http://localhost:8080/caddy/check
    }
}
CADDYEOF
  fi

  # Add main API domain if set
  if [[ -n "$API_DOMAIN" ]]; then
      log "Configuring Caddy for $API_DOMAIN..."
      cat >> /etc/caddy/Caddyfile <<EOF

$API_DOMAIN {
    reverse_proxy localhost:$API_PORT
}
EOF
  fi

  # Add import for VM routes (managed by scaleboxd)
  cat >> /etc/caddy/Caddyfile <<'CADDYEOF'

import /etc/caddy/vms.caddy
CADDYEOF

  systemctl enable caddy
  systemctl restart caddy
}

# === Wait for HTTPS Certificate ===
wait_for_https() {
  [[ -n "$API_DOMAIN" ]] || return 0

  log "Waiting for HTTPS certificate..."
  local max_retries=60
  local attempt=1
  local curl_opts
  if [[ "$ACME_STAGING" == "true" ]]; then
    curl_opts="-sfk"
  else
    curl_opts="-sf"
  fi
  while [[ $attempt -le $max_retries ]]; do
    if curl $curl_opts "https://$API_DOMAIN/health" &>/dev/null; then
      log "HTTPS is ready"
      return 0
    fi
    # Show progress every 5 attempts (10 seconds)
    if (( attempt % 5 == 0 )); then
      log "Still waiting for certificate... (attempt $attempt/$max_retries)"
    fi
    sleep 2
    ((attempt++)) || true
  done

  # Certificate wait failed - capture debug info
  echo ""
  echo "=== HTTPS Certificate Debug Info ==="
  echo ""
  echo "--- DNS Resolution ---"
  host "$API_DOMAIN" 2>&1 || echo "(host command failed)"
  echo ""
  echo "--- Curl Error ---"
  curl -v "https://$API_DOMAIN/health" 2>&1 | head -50 || true
  echo ""
  echo "--- Caddy Service Status ---"
  systemctl status caddy --no-pager 2>&1 | head -20 || true
  echo ""
  echo "--- Caddy Logs (last 30 lines) ---"
  journalctl -u caddy -n 30 --no-pager 2>&1 || true
  echo ""
  echo "--- Caddyfile ---"
  cat /etc/caddy/Caddyfile 2>&1 || true
  echo ""
  echo "--- scaleboxd Health Check (localhost) ---"
  curl -sf http://localhost:8080/health 2>&1 || echo "(scaleboxd not responding)"
  echo ""
  echo "=== End Debug Info ==="
  echo ""

  die "Failed to obtain TLS certificate for $API_DOMAIN"
}

# === Install Scalebox Binary ===
install_binary() {
  log "Installing scaleboxd..."

  # Stop service if running (can't overwrite running binary)
  if systemctl is-active scaleboxd &>/dev/null; then
    log "Stopping scaleboxd for update..."
    systemctl stop scaleboxd
  fi

  if [[ -f "$INSTALL_DIR/scaleboxd" ]]; then
    cp "$INSTALL_DIR/scaleboxd" /usr/local/bin/scaleboxd
    chmod +x /usr/local/bin/scaleboxd
  else
    die "scaleboxd binary not found at $INSTALL_DIR/scaleboxd"
  fi
}

# === Install Scripts from Manifest ===
install_from_manifest() {
  local src_dir=$1
  local manifest="$src_dir/INSTALL_MANIFEST"

  [[ -f "$manifest" ]] || return 0  # No manifest = fresh install, skip

  while read -r entry; do
    [[ -z "$entry" || "$entry" == \#* ]] && continue

    local type="${entry%%:*}"
    local name="${entry#*:}"
    [[ -f "$src_dir/$name" ]] || continue

    case "$type" in
      bin)
        log "Installing $name..."
        cp "$src_dir/$name" "/usr/local/bin/${name}.new"
        chmod +x "/usr/local/bin/${name}.new"
        mv "/usr/local/bin/${name}.new" "/usr/local/bin/$name"
        ;;
      lib)
        log "Installing $name library..."
        mkdir -p /usr/local/lib/scalebox
        cp "$src_dir/$name" "/usr/local/lib/scalebox/${name}.new"
        chmod 644 "/usr/local/lib/scalebox/${name}.new"
        mv "/usr/local/lib/scalebox/${name}.new" "/usr/local/lib/scalebox/$name"
        ;;
      # service files handled by install_service()
    esac
  done < "$manifest"
}

install_scripts() {
  install_from_manifest "$INSTALL_DIR"
}

# === Install Systemd Service ===
install_service() {
  log "Installing systemd service..."

  mkdir -p /etc/scaleboxd

  # Preserve existing token on reinstall, or generate new one
  if [[ -z "$API_TOKEN" && -f /etc/scaleboxd/config ]]; then
    API_TOKEN=$(grep -E "^API_TOKEN=" /etc/scaleboxd/config 2>/dev/null | cut -d= -f2- || true)
  fi
  [[ -z "$API_TOKEN" ]] && API_TOKEN="sb-$(openssl rand -hex 24)"

  # Write config with restricted permissions (token is sensitive)
  # Use umask to prevent brief window where file is world-readable
  (
    umask 077
    cat > /etc/scaleboxd/config <<EOF
API_PORT=$API_PORT
API_TOKEN=$API_TOKEN
DATA_DIR=$DATA_DIR
KERNEL_PATH=$DATA_DIR/kernel/vmlinux
API_DOMAIN=$API_DOMAIN
VM_DOMAIN=$VM_DOMAIN
ACME_STAGING=$ACME_STAGING
EOF
  )

  # Copy service file
  if [[ -f "$INSTALL_DIR/scaleboxd.service" ]]; then
    cp "$INSTALL_DIR/scaleboxd.service" /etc/systemd/system/
  else
    die "scaleboxd.service not found at $INSTALL_DIR/"
  fi

  systemctl daemon-reload
  systemctl enable scaleboxd
}

# === Start Service ===
start_service() {
  log "Starting scaleboxd..."
  # Use restart to handle upgrades (start is no-op if already running)
  systemctl restart scaleboxd

  # Wait for health check
  local retries=15
  while [[ $retries -gt 0 ]]; do
    if curl -sf "http://localhost:$API_PORT/health" &>/dev/null; then
      log "Service is running"
      return 0
    fi
    sleep 1
    ((retries--)) || true
  done
  die "Service failed to start. Check: journalctl -u scaleboxd"
}

# === Pre-flight Check ===
preflight_check() {
  log "Running pre-flight checks..."
  local missing=()

  [[ -f "$INSTALL_DIR/scaleboxd" ]] || missing+=("scaleboxd binary")
  [[ -f "$INSTALL_DIR/scaleboxd.service" ]] || missing+=("scaleboxd.service")

  if [[ ${#missing[@]} -gt 0 ]]; then
    die "Missing required files in $INSTALL_DIR: ${missing[*]}"
  fi
}

# === Main ===
main() {
  echo ""
  echo "  ╔═══════════════════════════════════════╗"
  echo "  ║         Scalebox Installer            ║"
  echo "  ╚═══════════════════════════════════════╝"
  echo ""

  check_root
  check_os
  check_kvm
  preflight_check

  install_deps
  setup_storage
  install_firecracker
  setup_network
  create_rootfs
  install_binary
  install_scripts
  install_service
  start_service
  install_caddy
  wait_for_https

  echo ""
  log "Installation complete!"
  echo ""
  if [[ -n "$API_DOMAIN" ]]; then
    echo "  API: https://$API_DOMAIN"
  else
    echo "  API: http://$(hostname -I | awk '{print $1}'):$API_PORT"
  fi
  echo "  Token: $API_TOKEN"
  if [[ -n "$VM_DOMAIN" ]]; then
      echo "  VM URLs: https://{vm-name}.$VM_DOMAIN"
  fi
  echo ""
  echo "  Server commands:"
  echo "    systemctl status scaleboxd"
  echo "    journalctl -u scaleboxd -f"
  echo ""
  echo "  Install CLI on your machine:"
  echo "    curl -fsSL https://raw.githubusercontent.com/The-Agentic-Journey/Scalebox/main/scripts/install-sb.sh | bash"
  echo ""
  echo "  Save your API token - it won't be shown again!"
  echo ""
}

main "$@"
