# Scalebox Refactoring Plan v4

This plan transforms firecracker-api into **scalebox** with self-contained provisioning, systemd service management, ephemeral test VMs, and a CLI.

## Architecture Overview

### Executables

| Binary | Type | Purpose |
|--------|------|---------|
| `scaleboxd` | Compiled Bun binary | Server daemon - runs the HTTP API, manages VMs |
| `scalebox` | Bash script | CLI - interacts with the API via curl |

### Directory Structure

```
# SOURCE (tracked in git):
src/                      # TypeScript server source
scripts/                  # Distribution scripts
├── install.sh            # Self-contained installer (ALL provisioning logic)
├── scaleboxd.service     # Systemd unit file
└── scalebox              # CLI bash script

# GENERATED (fully gitignored):
builds/                   # Entire directory gitignored
├── scaleboxd             # Compiled server binary
├── scalebox              # CLI script (copied)
├── scaleboxd.service     # Systemd unit (copied)
└── install.sh            # Installer (copied)

# DEPRECATED (delete after migration):
provision/                # Old provision scripts - DELETE
```

### Build Process

```bash
./do build
```

1. Clean `builds/` directory
2. Compile TypeScript → `builds/scaleboxd`
3. Copy `scripts/*` → `builds/`
4. Done.

---

## Phase 0: Prerequisites

**Goal**: Ensure development environment is ready.

### Checklist

```bash
# gcloud CLI
gcloud --version
gcloud auth list

# GCP project
gcloud config get-value project

# Permissions
gcloud compute instances list

# Bun
bun --version
```

### Create Firewall Rule (one-time)

```bash
gcloud compute firewall-rules create scalebox-test-allow \
  --allow=tcp:8080,tcp:22001-32000 \
  --target-tags=scalebox-test \
  --description="Allow scalebox API and SSH proxy ports"
```

### Verification

All commands succeed.

---

## Phase 1: Rename and Consolidate

**Goal**: Rename to scalebox, update paths, create single install script.

### 1.1 Update `package.json`

```json
{ "name": "scalebox" }
```

### 1.2 Update `src/config.ts`

Change default paths from `/var/lib/firecracker` to `/var/lib/scalebox`:

```typescript
export const config = {
  apiPort: Number(process.env.API_PORT) || 8080,
  apiToken: process.env.API_TOKEN || "dev-token",
  dataDir: process.env.DATA_DIR || "/var/lib/scalebox",
  kernelPath: process.env.KERNEL_PATH || "/var/lib/scalebox/kernel/vmlinux",
  portMin: Number(process.env.PORT_MIN) || 22001,
  portMax: Number(process.env.PORT_MAX) || 32000,
  defaultVcpuCount: Number(process.env.DEFAULT_VCPU_COUNT) || 2,
  defaultMemSizeMib: Number(process.env.DEFAULT_MEM_SIZE_MIB) || 512,
  protectedTemplates: ["debian-base"],
};
```

### 1.3 Update `src/index.ts`

Change startup message:

```typescript
console.log(`Scaleboxd started on http://${host}:${config.apiPort}`);
```

### 1.4 Create `scripts/` directory

```bash
mkdir -p scripts
```

### 1.5 Create `scripts/install.sh`

```bash
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
DATA_DIR="${DATA_DIR:-/var/lib/scalebox}"
API_PORT="${API_PORT:-8080}"
API_TOKEN="${API_TOKEN:-}"
INSTALL_DIR="${INSTALL_DIR:-/opt/scalebox}"

FC_VERSION="1.10.1"
KERNEL_URL="https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/x86_64/kernels/vmlinux.bin"

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
}

# === Install System Dependencies ===
install_deps() {
  log "Installing system dependencies..."
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    curl wget jq iptables iproute2 btrfs-progs \
    debootstrap qemu-utils e2fsprogs openssh-client
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
    truncate -s 50G "$img_path"
    mkfs.btrfs "$img_path"
  fi

  mount -o loop "$img_path" "$DATA_DIR"

  if ! grep -q "$img_path" /etc/fstab; then
    echo "$img_path $DATA_DIR btrfs loop 0 0" >> /etc/fstab
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

  # Disable NetworkManager if present (conflicts with systemd-networkd)
  if systemctl is-active --quiet NetworkManager 2>/dev/null; then
    log "Disabling NetworkManager..."
    systemctl disable --now NetworkManager 2>/dev/null || true
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
    ((retries--))
  done

  # Setup NAT with iptables
  local default_if
  default_if=$(ip route | awk '/default/ {print $5; exit}')

  # Remove existing rule if present (idempotent)
  iptables -t nat -D POSTROUTING -s 172.16.0.0/16 -o "$default_if" -j MASQUERADE 2>/dev/null || true
  iptables -t nat -A POSTROUTING -s 172.16.0.0/16 -o "$default_if" -j MASQUERADE

  # Save iptables rules
  mkdir -p /etc/iptables
  iptables-save > /etc/iptables/rules.v4

  # Create systemd service to restore iptables on boot
  cat > /etc/systemd/system/iptables-restore.service <<'EOF'
[Unit]
Description=Restore iptables rules
Before=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=/sbin/iptables-restore /etc/iptables/rules.v4
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable iptables-restore
}

# === Create Base Template ===
create_rootfs() {
  local template_path="$DATA_DIR/templates/debian-base.ext4"

  if [[ -f "$template_path" ]]; then
    log "Base template already exists"
    return
  fi

  log "Creating Debian base template (this takes a few minutes)..."

  local rootfs_dir="/tmp/rootfs-$$"
  local mount_dir="/tmp/mount-$$"
  TEMP_DIRS+=("$rootfs_dir" "$mount_dir")

  mkdir -p "$rootfs_dir" "$mount_dir"

  # Debootstrap minimal Debian
  debootstrap --include=openssh-server,iproute2,iputils-ping,haveged \
    bookworm "$rootfs_dir" http://deb.debian.org/debian

  # Configure the rootfs
  chroot "$rootfs_dir" /bin/bash <<'CHROOT'
# Disable root password (key-only auth)
passwd -d root

# Configure SSH
mkdir -p /root/.ssh
chmod 700 /root/.ssh
sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
sed -i 's/#PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config

# Generate host keys
ssh-keygen -A

# Enable services
systemctl enable ssh.service
systemctl enable haveged.service
systemctl enable serial-getty@ttyS0.service
CHROOT

  # Create ext4 image
  truncate -s 2G "$template_path"
  mkfs.ext4 -F "$template_path" >/dev/null

  mount -o loop "$template_path" "$mount_dir"
  cp -a "$rootfs_dir"/* "$mount_dir"/
  umount "$mount_dir"

  # Cleanup
  rm -rf "$rootfs_dir" "$mount_dir"
  TEMP_DIRS=()

  log "Base template created: $template_path"
}

# === Install Scalebox Binary ===
install_binary() {
  log "Installing scaleboxd..."

  if [[ -f "$INSTALL_DIR/scaleboxd" ]]; then
    cp "$INSTALL_DIR/scaleboxd" /usr/local/bin/scaleboxd
    chmod +x /usr/local/bin/scaleboxd
  else
    die "scaleboxd binary not found at $INSTALL_DIR/scaleboxd"
  fi
}

# === Install CLI ===
install_cli() {
  if [[ -f "$INSTALL_DIR/scalebox" ]]; then
    log "Installing scalebox CLI..."
    cp "$INSTALL_DIR/scalebox" /usr/local/bin/scalebox
    chmod +x /usr/local/bin/scalebox
  fi
}

# === Install Systemd Service ===
install_service() {
  log "Installing systemd service..."

  mkdir -p /etc/scalebox

  # Generate token if not provided
  [[ -z "$API_TOKEN" ]] && API_TOKEN="sb-$(openssl rand -hex 24)"

  # Write config
  cat > /etc/scalebox/config <<EOF
API_PORT=$API_PORT
API_TOKEN=$API_TOKEN
DATA_DIR=$DATA_DIR
KERNEL_PATH=$DATA_DIR/kernel/vmlinux
EOF

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
  systemctl start scaleboxd

  # Wait for health check
  local retries=15
  while [[ $retries -gt 0 ]]; do
    if curl -sf "http://localhost:$API_PORT/health" &>/dev/null; then
      log "Service is running"
      return 0
    fi
    sleep 1
    ((retries--))
  done
  die "Service failed to start. Check: journalctl -u scaleboxd"
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

  install_deps
  setup_storage
  install_firecracker
  setup_network
  create_rootfs
  install_binary
  install_cli
  install_service
  start_service

  echo ""
  log "Installation complete!"
  echo ""
  echo "  API: http://$(hostname -I | awk '{print $1}'):$API_PORT"
  echo "  Token: $API_TOKEN"
  echo ""
  echo "  Commands:"
  echo "    systemctl status scaleboxd"
  echo "    journalctl -u scaleboxd -f"
  echo "    scalebox vm list"
  echo ""
  echo "  Save your API token - it won't be shown again!"
  echo ""
}

main "$@"
```

### 1.6 Create `scripts/scaleboxd.service`

```ini
[Unit]
Description=Scalebox VM Management API
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/scaleboxd
EnvironmentFile=/etc/scalebox/config
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 1.7 Create `scripts/scalebox` (CLI)

```bash
#!/bin/bash
set -euo pipefail

API_URL="${SCALEBOX_URL:-http://localhost:8080}"
API_TOKEN="${SCALEBOX_TOKEN:-}"

# Read token from config if not set
if [[ -z "$API_TOKEN" && -f /etc/scalebox/config ]]; then
  API_TOKEN=$(grep -E "^API_TOKEN=" /etc/scalebox/config 2>/dev/null | cut -d= -f2 || true)
fi

die() { echo "Error: $1" >&2; exit 1; }
need_token() { [[ -n "$API_TOKEN" ]] || die "SCALEBOX_TOKEN not set"; }

api() {
  local method=$1 path=$2; shift 2
  curl -sf -X "$method" -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" "$@" "${API_URL}${path}"
}

cmd_vm_create() {
  need_token
  local template="" key=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -t|--template) template=$2; shift 2 ;;
      -k|--key) key=$2; shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
  [[ -n "$template" && -n "$key" ]] || die "Usage: scalebox vm create -t TEMPLATE -k 'ssh-rsa ...'"
  api POST /vms -d "$(jq -n --arg t "$template" --arg k "$key" '{template:$t,ssh_public_key:$k}')" | jq .
}

cmd_vm_snapshot() {
  need_token
  local id="${1:-}"
  local name=""
  shift || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -n|--name) name=$2; shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
  [[ -n "$id" && -n "$name" ]] || die "Usage: scalebox vm snapshot <id> -n NAME"
  api POST "/vms/$id/snapshot" -d "$(jq -n --arg n "$name" '{template_name:$n}')" | jq .
}

case "${1:-help}" in
  status)
    curl -sf "$API_URL/health" | jq .
    ;;
  vm)
    case "${2:-}" in
      list)
        need_token
        api GET /vms | jq -r '.vms[] | [.id, .template, .ip, .ssh_port] | @tsv' | column -t 2>/dev/null || cat
        ;;
      create)
        shift 2
        cmd_vm_create "$@"
        ;;
      get)
        need_token
        [[ -n "${3:-}" ]] || die "Usage: scalebox vm get <id>"
        api GET "/vms/$3" | jq .
        ;;
      delete)
        need_token
        [[ -n "${3:-}" ]] || die "Usage: scalebox vm delete <id>"
        api DELETE "/vms/$3"
        echo "Deleted $3"
        ;;
      snapshot)
        shift 2
        cmd_vm_snapshot "$@"
        ;;
      *)
        die "Usage: scalebox vm [list|create|get|delete|snapshot]"
        ;;
    esac
    ;;
  template)
    case "${2:-}" in
      list)
        need_token
        api GET /templates | jq -r '.templates[] | [.name, .size_bytes] | @tsv' | column -t 2>/dev/null || cat
        ;;
      delete)
        need_token
        [[ -n "${3:-}" ]] || die "Usage: scalebox template delete <name>"
        api DELETE "/templates/$3"
        echo "Deleted $3"
        ;;
      *)
        die "Usage: scalebox template [list|delete]"
        ;;
    esac
    ;;
  help|--help|-h)
    cat <<'EOF'
Scalebox CLI

Usage: scalebox <command>

Commands:
  status                        Health check
  vm list                       List VMs
  vm create -t TPL -k KEY       Create VM from template (KEY is the public key content)
  vm get <id>                   Get VM details
  vm delete <id>                Delete VM
  vm snapshot <id> -n NAME      Snapshot VM to template
  template list                 List templates
  template delete <name>        Delete template

Environment:
  SCALEBOX_URL    API URL (default: http://localhost:8080)
  SCALEBOX_TOKEN  API token (reads /etc/scalebox/config if not set)

Examples:
  scalebox status
  scalebox vm create -t debian-base -k "$(cat ~/.ssh/id_rsa.pub)"
  scalebox vm list
  scalebox vm snapshot vm-abc123 -n my-snapshot
EOF
    ;;
  *)
    die "Unknown command: $1. Try: scalebox help"
    ;;
esac
```

### 1.8 Update `.gitignore`

Add:
```
builds/
```

### 1.9 Delete old provision scripts

```bash
rm -rf provision/
```

### Verification

```bash
./do build
ls -la builds/
# Should show: scaleboxd, scalebox, scaleboxd.service, install.sh
```

---

## Phase 2: Update Test Helpers

**Goal**: Tests use proxy ports instead of SSH ProxyJump.

### 2.1 Update `test/helpers.ts`

Replace entire file:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

// Configuration
export const VM_HOST = process.env.VM_HOST || "localhost";
export const API_PORT = process.env.API_PORT || "8080";
export const API_BASE_URL = `http://${VM_HOST}:${API_PORT}`;
const API_TOKEN = process.env.API_TOKEN || "dev-token";

// SSH
export const TEST_PRIVATE_KEY_PATH = join(FIXTURES_DIR, "test_key");
export const TEST_PUBLIC_KEY = readFileSync(join(FIXTURES_DIR, "test_key.pub"), "utf-8").trim();

// API client
export const api = {
  async get(path: string) {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    return { status: res.status, data: res.ok ? await res.json() : null };
  },
  async post(path: string, body: unknown) {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: res.ok ? await res.json() : null };
  },
  async delete(path: string) {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    return { status: res.status };
  },
  async getRaw(path: string, token?: string) {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status };
  },
};

// SSH via proxy port (connects to VM_HOST on the proxy port, not internal IP)
export async function waitForSsh(sshPort: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await $`ssh -p ${sshPort} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 -i ${TEST_PRIVATE_KEY_PATH} root@${VM_HOST} exit`.quiet();
      return;
    } catch {
      await Bun.sleep(1000);
    }
  }
  throw new Error(`SSH not ready on port ${sshPort} within ${timeoutMs}ms`);
}

export async function sshExec(sshPort: number, command: string): Promise<string> {
  return await $`ssh -p ${sshPort} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${TEST_PRIVATE_KEY_PATH} root@${VM_HOST} ${command}`.text();
}
```

### 2.2 Update `test/integration.test.ts`

**All occurrences to change** (14 total):

| Line | Change From | Change To |
|------|-------------|-----------|
| ~136 | `waitForSsh(data.ip, 30000)` | `waitForSsh(data.ssh_port, 30000)` |
| ~150 | `waitForSsh(data.ip, 30000)` | `waitForSsh(data.ssh_port, 30000)` |
| ~151 | `sshExec(data.ip, "echo hello")` | `sshExec(data.ssh_port, "echo hello")` |
| ~169 | `waitForSsh(vm.ip, 30000)` | `waitForSsh(vm.ssh_port, 30000)` |
| ~199 | `waitForSsh(vm.ip, 30000)` | `waitForSsh(vm.ssh_port, 30000)` |
| ~228 | `waitForSsh(vm1.ip, 30000)` | `waitForSsh(vm1.ssh_port, 30000)` |
| ~249 | `waitForSsh(vm2.ip, 30000)` | `waitForSsh(vm2.ssh_port, 30000)` |
| ~250 | `sshExec(vm2.ip, "echo hello")` | `sshExec(vm2.ssh_port, "echo hello")` |
| ~267 | `waitForSsh(vm1.ip, 30000)` | `waitForSsh(vm1.ssh_port, 30000)` |
| ~271 | `sshExec(vm1.ip, ...)` | `sshExec(vm1.ssh_port, ...)` |
| ~274 | `sshExec(vm1.ip, ...)` | `sshExec(vm1.ssh_port, ...)` |
| ~293 | `waitForSsh(vm2.ip, 30000)` | `waitForSsh(vm2.ssh_port, 30000)` |
| ~294 | `sshExec(vm2.ip, ...)` | `sshExec(vm2.ssh_port, ...)` |

**Search/replace pattern:**
- Find: `waitForSsh(data.ip,` → Replace: `waitForSsh(data.ssh_port,`
- Find: `waitForSsh(vm.ip,` → Replace: `waitForSsh(vm.ssh_port,`
- Find: `waitForSsh(vm1.ip,` → Replace: `waitForSsh(vm1.ssh_port,`
- Find: `waitForSsh(vm2.ip,` → Replace: `waitForSsh(vm2.ssh_port,`
- Find: `sshExec(data.ip,` → Replace: `sshExec(data.ssh_port,`
- Find: `sshExec(vm.ip,` → Replace: `sshExec(vm.ssh_port,`
- Find: `sshExec(vm1.ip,` → Replace: `sshExec(vm1.ssh_port,`
- Find: `sshExec(vm2.ip,` → Replace: `sshExec(vm2.ssh_port,`

### Verification

```bash
# TypeScript should compile without errors
./do lint
```

---

## Phase 3: Ephemeral Test VMs

**Goal**: `./do check` creates fresh GCE VM, provisions, tests, deletes.

### Replace `do` script entirely

```bash
#!/bin/bash
set -euo pipefail

GCLOUD_ZONE="${GCLOUD_ZONE:-us-central1-a}"
GCLOUD_PROJECT="${GCLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null || echo '')}"
VM_NAME=""
VM_IP=""
KEEP_VM="${KEEP_VM:-false}"

die() { echo "Error: $1" >&2; exit 1; }

cleanup() {
  if [[ -n "$VM_NAME" && "$KEEP_VM" != "true" ]]; then
    echo "==> Deleting VM: $VM_NAME"
    gcloud compute instances delete "$VM_NAME" \
      --zone="$GCLOUD_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --quiet 2>/dev/null || true
  fi
}

create_vm() {
  VM_NAME="scalebox-test-$(date +%s)-$$-$RANDOM"
  echo "==> Creating VM: $VM_NAME"

  gcloud compute instances create "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --machine-type=n2-standard-2 \
    --image-family=debian-12 \
    --image-project=debian-cloud \
    --boot-disk-size=50GB \
    --boot-disk-type=pd-ssd \
    --enable-nested-virtualization \
    --min-cpu-platform="Intel Haswell" \
    --tags=scalebox-test \
    --quiet

  VM_IP=$(gcloud compute instances describe "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --format='get(networkInterfaces[0].accessConfigs[0].natIP)')

  echo "==> VM IP: $VM_IP"
}

wait_for_ssh() {
  echo "==> Waiting for SSH..."
  local retries=30
  while [[ $retries -gt 0 ]]; do
    if gcloud compute ssh "$VM_NAME" \
         --zone="$GCLOUD_ZONE" \
         --project="$GCLOUD_PROJECT" \
         --command="echo ready" \
         --quiet 2>/dev/null; then
      return 0
    fi
    sleep 5
    ((retries--))
  done
  die "SSH not ready after 150s"
}

provision_vm() {
  echo "==> Creating target directory..."
  gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="sudo mkdir -p /opt/scalebox && sudo chmod 777 /opt/scalebox" \
    --quiet

  echo "==> Copying builds to VM..."
  gcloud compute scp --recurse builds/* "$VM_NAME:/opt/scalebox/" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --quiet

  echo "==> Running install script..."
  gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="sudo bash /opt/scalebox/install.sh" \
    --quiet
}

get_api_token() {
  gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="sudo grep API_TOKEN /etc/scalebox/config | cut -d= -f2" \
    --quiet
}

# === Commands ===

do_build() {
  echo "==> Building..."

  # Check scripts directory exists
  [[ -d scripts ]] || die "scripts/ directory not found. Run from project root."

  rm -rf builds
  mkdir -p builds

  # Compile server
  ~/.bun/bin/bun build src/index.ts --compile --outfile builds/scaleboxd

  # Verify binary was created
  [[ -f builds/scaleboxd ]] || die "Failed to compile scaleboxd"

  # Copy scripts
  cp scripts/install.sh builds/
  cp scripts/scalebox builds/
  cp scripts/scaleboxd.service builds/

  chmod +x builds/scaleboxd builds/scalebox builds/install.sh

  echo "==> Build complete"
  ls -la builds/
}

do_lint() {
  ~/.bun/bin/bun run lint
}

do_test() {
  ~/.bun/bin/bun test "$@"
}

do_check() {
  trap cleanup EXIT

  echo "==> Linting..."
  do_lint

  echo "==> Building..."
  do_build

  echo "==> Creating test VM..."
  create_vm
  wait_for_ssh
  provision_vm

  echo "==> Getting API token..."
  local token
  token=$(get_api_token)
  [[ -n "$token" ]] || die "Failed to get API token"

  echo "==> Running tests against $VM_IP..."
  VM_HOST="$VM_IP" API_TOKEN="$token" ~/.bun/bin/bun test

  echo ""
  echo "==> All tests passed!"
}

# === Main ===

case "${1:-help}" in
  build) do_build ;;
  lint) do_lint ;;
  test) shift; do_test "$@" ;;
  check)
    shift || true
    [[ "${1:-}" == "--keep-vm" ]] && KEEP_VM=true
    do_check
    ;;
  help|*)
    cat <<'EOF'
Scalebox Development Script

Usage: ./do <command>

Commands:
  build              Build scaleboxd binary and copy scripts to builds/
  lint               Run linter
  test               Run tests locally (requires VM_HOST and API_TOKEN)
  check              Full CI: lint, build, create VM, provision, test, cleanup
  check --keep-vm    Same but keep VM for debugging

Environment:
  GCLOUD_ZONE        GCE zone (default: us-central1-a)
  GCLOUD_PROJECT     GCE project (default: current gcloud config)
  KEEP_VM=true       Don't delete VM after tests
EOF
    ;;
esac
```

### Verification

```bash
# Test 1: Normal run - VM should be deleted after
./do check
gcloud compute instances list --filter="name~scalebox-test"
# Should be empty

# Test 2: Keep VM for debugging
./do check --keep-vm
gcloud compute instances list --filter="name~scalebox-test"
# Should show the VM

# Manual cleanup
gcloud compute instances delete scalebox-test-XXXXX --zone=us-central1-a --quiet
```

---

## Phase 4: Verify CLI

**Goal**: Manually verify CLI works on provisioned VM.

```bash
./do check --keep-vm

# SSH to VM
gcloud compute ssh scalebox-test-XXXXX --zone=us-central1-a

# Test CLI
scalebox status
scalebox template list
scalebox vm create -t debian-base -k "$(cat ~/.ssh/id_rsa.pub)"
scalebox vm list
scalebox vm delete <id>

# Cleanup
exit
gcloud compute instances delete scalebox-test-XXXXX --zone=us-central1-a --quiet
```

---

## Implementation Order

```
Phase 0: Prerequisites ──────────────────────────────────────────►
         │ verify gcloud, create firewall rule
         ▼
Phase 1: Rename + Consolidate ───────────────────────────────────►
         │ config.ts, scripts/, delete provision/
         │ Verify: ./do build works
         ▼
Phase 2: Update Test Helpers ────────────────────────────────────►
         │ proxy ports instead of ProxyJump
         │ Verify: ./do lint passes
         ▼
Phase 3: Ephemeral VMs ──────────────────────────────────────────►
         │ new do script with gcloud
         │ Verify: ./do check creates VM, tests pass, VM deleted
         ▼
Phase 4: CLI Verification ───────────────────────────────────────►
         │ manual testing
         │ Verify: all commands work
         ▼
         DONE
```

---

## Success Criteria

| Phase | Verification | Result |
|-------|--------------|--------|
| 0 | `gcloud compute instances list` | Works, firewall rule exists |
| 1 | `./do build && ls builds/` | 4 files: scaleboxd, scalebox, install.sh, scaleboxd.service |
| 2 | `./do lint` | No TypeScript errors |
| 3 | `./do check` | VM created, all tests pass, VM deleted |
| 4 | CLI commands | All work on provisioned VM |

---

## Files Summary

### New Files
- `scripts/install.sh` - Single, self-contained installer (~280 lines)
- `scripts/scalebox` - CLI bash script (~120 lines)
- `scripts/scaleboxd.service` - Systemd unit (~12 lines)

### Modified Files
- `package.json` - name: "scalebox"
- `src/config.ts` - paths to /var/lib/scalebox
- `src/index.ts` - startup message
- `test/helpers.ts` - proxy ports, remove SSH_HOST
- `test/integration.test.ts` - ssh_port instead of ip (14 changes)
- `do` - complete rewrite
- `.gitignore` - add builds/

### Deleted Files
- `provision/` - entire directory (replaced by scripts/install.sh)

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| GCE quota | Use dedicated project |
| No nested virt | n2-standard-2 in us-central1-a |
| Install fails midway | Cleanup trap for temp dirs |
| Token extraction fails | Explicit error before tests |
| Firewall blocks | Phase 0 creates rule |
| VM not deleted | trap EXIT + unique name with PID+RANDOM |
| Network conflicts | Disable NetworkManager, use systemd-networkd only |
| iptables not restored | systemd service instead of ifupdown hooks |
| Bridge not persistent | systemd-networkd manages bridge |
