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
BASE_DOMAIN="${BASE_DOMAIN:-}"
ACME_PROXY_PASSWORD="${ACME_PROXY_PASSWORD:-}"
ACME_STAGING="${ACME_STAGING:-false}"
HOST_IP="${HOST_IP:-}"

FC_VERSION="1.10.1"
KERNEL_VERSION="5.10.245"
KERNEL_URL="https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.14/x86_64/vmlinux-${KERNEL_VERSION}"
CRANE_VERSION="0.20.3"
CRANE_URL="https://github.com/google/go-containerregistry/releases/download/v${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz"
BASE_IMAGE="${BASE_IMAGE:-ghcr.io/the-agentic-journey/agenticbaseimage:latest}"

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
    log "Downloading kernel ${KERNEL_VERSION}..."
    wget -q "$KERNEL_URL" -O "$kernel_path"
    echo "$KERNEL_VERSION" > "$DATA_DIR/kernel/version"
  fi
}

# === Install crane (container image tool) ===
install_crane() {
  local crane_bin="/usr/local/bin/crane"

  if [[ -f "$crane_bin" ]]; then
    log "crane already installed"
    return
  fi

  log "Installing crane v${CRANE_VERSION}..."
  wget -q "$CRANE_URL" -O /tmp/crane.tar.gz
  tar -xzf /tmp/crane.tar.gz -C /tmp crane
  mv /tmp/crane "$crane_bin"
  chmod +x "$crane_bin"
  rm -f /tmp/crane.tar.gz
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

# === Install Template Build Library ===
install_template_library() {
  log "Installing template-build.sh library..."
  mkdir -p /usr/local/lib/scalebox
  cp "$INSTALL_DIR/template-build.sh" /usr/local/lib/scalebox/
  chmod 644 /usr/local/lib/scalebox/template-build.sh
}

# === Create Base Template ===
create_rootfs() {
  local template_path="$DATA_DIR/templates/debian-base.ext4"

  if [[ -f "$template_path" ]]; then
    log "Base template already exists"
    return
  fi

  log "Creating Debian base template (this takes a few minutes)..."

  # Source template-build.sh from install directory (shipped in tarball)
  # This ensures install.sh and scalebox-rebuild-template use identical code
  # shellcheck source=/dev/null
  source "$INSTALL_DIR/template-build.sh"
  build_debian_base "$DATA_DIR"
}

# === Free Port 53 for Scalebox DNS Server ===
free_port_53() {
  if systemctl is-active --quiet systemd-resolved 2>/dev/null; then
    log "Disabling systemd-resolved to free port 53 for Scalebox DNS..."
    systemctl stop systemd-resolved
    systemctl disable systemd-resolved
    rm -f /etc/resolv.conf
    echo "nameserver 8.8.8.8" > /etc/resolv.conf
    echo "nameserver 8.8.4.4" >> /etc/resolv.conf
  fi
}

# === Install Caddy (HTTPS reverse proxy) ===
install_caddy() {
  [[ -n "$BASE_DOMAIN" ]] || return 0

  free_port_53

  log "Installing Caddy with acmeproxy module..."

  # Download custom Caddy binary with acmeproxy DNS module
  local caddy_url="https://caddyserver.com/api/download?os=linux&arch=$(dpkg --print-architecture)&p=github.com/caddy-dns/acmeproxy"
  curl -sSL "$caddy_url" -o /usr/bin/caddy
  chmod +x /usr/bin/caddy

  # Create caddy user/group if needed (normally done by apt package)
  if ! id caddy &>/dev/null; then
    groupadd --system caddy 2>/dev/null || true
    useradd --system --gid caddy --create-home --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy 2>/dev/null || true
  fi

  # Create config directory
  mkdir -p /etc/caddy

  # Install systemd unit for Caddy (if not already present)
  if [[ ! -f /etc/systemd/system/caddy.service ]]; then
    cat > /etc/systemd/system/caddy.service <<'CADDYSERVICEEOF'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=root
Group=root
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
CADDYSERVICEEOF
    systemctl daemon-reload
  fi

  # Write minimal placeholder Caddyfile (scaleboxd generates the real one on startup)
  cat > /etc/caddy/Caddyfile <<'CADDYEOF'
# Placeholder - scaleboxd generates the real config on startup
{
}
CADDYEOF

  # Create vms.caddy stub
  cat > /etc/caddy/vms.caddy <<'VMSCADDYEOF'
# Managed by scaleboxd - do not edit manually
VMSCADDYEOF

  systemctl enable caddy
  systemctl restart caddy
}

# === Wait for HTTPS Certificate ===
wait_for_https() {
  [[ -n "$BASE_DOMAIN" ]] || return 0

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
    if curl $curl_opts --resolve "api.$BASE_DOMAIN:443:127.0.0.1" "https://api.$BASE_DOMAIN/health" &>/dev/null; then
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
  host "api.$BASE_DOMAIN" 2>&1 || echo "(host command failed)"
  echo ""
  echo "--- Curl Error ---"
  curl -v --resolve "api.$BASE_DOMAIN:443:127.0.0.1" "https://api.$BASE_DOMAIN/health" 2>&1 | head -50 || true
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

  die "Failed to obtain TLS certificate for api.$BASE_DOMAIN"
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

  # Generate ACME proxy password if not set
  if [[ -z "$ACME_PROXY_PASSWORD" && -f /etc/scaleboxd/config ]]; then
    ACME_PROXY_PASSWORD=$(grep -E "^ACME_PROXY_PASSWORD=" /etc/scaleboxd/config 2>/dev/null | cut -d= -f2- || true)
  fi
  [[ -z "$ACME_PROXY_PASSWORD" ]] && ACME_PROXY_PASSWORD="$(openssl rand -hex 32)"

  # Write config with restricted permissions (token is sensitive)
  # Use umask to prevent brief window where file is world-readable
  (
    umask 077
    cat > /etc/scaleboxd/config <<EOF
API_PORT=$API_PORT
API_TOKEN=$API_TOKEN
DATA_DIR=$DATA_DIR
KERNEL_PATH=$DATA_DIR/kernel/vmlinux
BASE_DOMAIN=$BASE_DOMAIN
HOST_IP=$HOST_IP
ACME_PROXY_PASSWORD=$ACME_PROXY_PASSWORD
ACME_STAGING=$ACME_STAGING
BASE_IMAGE=$BASE_IMAGE
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
  install_crane
  setup_network
  install_template_library
  create_rootfs
  install_binary
  install_scripts
  install_service
  install_caddy
  start_service
  wait_for_https

  echo ""
  log "Installation complete!"
  echo ""
  if [[ -n "$BASE_DOMAIN" ]]; then
    echo "  API: https://api.$BASE_DOMAIN"
    echo "  VM URLs: https://{vm-name}.vm.$BASE_DOMAIN"
  else
    echo "  API: http://$(hostname -I | awk '{print $1}'):$API_PORT"
  fi
  echo "  Token: $API_TOKEN"
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
