# Firecracker VM API - Implementation Plan

## Overview

A REST API service for managing Firecracker microVMs on a dedicated host. Supports creating VMs from templates, snapshotting VMs, and SSH access via TCP proxy.

**Target Environment:** GCP n1-standard-2 with nested virtualization (dev), Hetzner dedicated server (prod)

**Development VM:**
- Host: `34.40.56.57`
- User: `dev` (passwordless sudo)
- SSH: `ssh dev@34.40.56.57`
- Dev Token: `dev-5a30aabffc0d8308ec749c49d94164705fc2d4b57c50b800`

**Tech Stack:**
- Runtime: Bun (TypeScript, single-binary compilation)
- Storage: btrfs with reflink copies for COW efficiency
- Networking: Bridge + NAT, TCP proxy for SSH access
- Guest OS: Debian minimal + SSH

---

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │            Host Server              │
                    │                                     │
  Internet ─────────┤ eth0 (public IP)                    │
                    │   │                                 │
                    │   ├─ :22 ─── Host SSH (admin only)  │
                    │   │                                 │
                    │   └─ :8080 ─ REST API               │
                    │        │                            │
                    │        └─ TCP Proxy                 │
                    │             :22001 → 172.16.0.2:22  │
                    │             :22002 → 172.16.0.3:22  │
                    │                                     │
                    │ br0 (172.16.0.1/16)                 │
                    │   ├── tap0 ── VM 1 (172.16.0.2)     │
                    │   └── tap1 ── VM 2 (172.16.0.3)     │
                    │                                     │
                    │ /var/lib/firecracker/               │
                    │   ├── templates/   (btrfs)          │
                    │   ├── vms/         (btrfs)          │
                    │   └── kernel/                       │
                    └─────────────────────────────────────┘
```

---

## Development Methodology: Tight ATDD Loops

**Core Principle:** Every code change is preceded by a test assertion. `./do check` MUST pass before every commit.

### The Loop

Each implementation step follows this pattern:

```
1. Write ONE test assertion (initially skipped with test.skip or .todo)
2. Run ./do check → MUST PASS (skipped tests don't fail)
3. Commit: "Add test: <what the test checks>"

4. Implement JUST enough code to pass the assertion
5. Unskip the test assertion
6. Run ./do check → MUST PASS
7. Commit: "Implement: <what was implemented>"
```

### Rules

1. **No failing tests in commits** - Every commit must have `./do check` passing
2. **One assertion at a time** - Don't write multiple assertions before implementing
3. **Minimal implementation** - Only write code needed to pass the current test
4. **Immediate feedback** - If a test fails, fix it before moving on

### Test Organization

Tests are organized as individual `test()` blocks, not one giant test:

```typescript
describe('Firecracker API', () => {
  test('health check returns ok', async () => { ... });
  test('auth rejects invalid token', async () => { ... });
  test('lists templates including debian-base', async () => { ... });
  // ... each assertion is a separate test
});
```

This allows:
- Running specific tests during development
- Clear failure messages
- Gradual enabling of tests as features are implemented

---

## Phase 0: Project Foundation

### Goal
Set up the repository structure, tooling, and create test infrastructure (empty tests that pass).

### Steps

#### 0.1 Initialize Bun Project
```
firecracker-api/
  src/
    index.ts           # HTTP server entry point
    vm.ts              # VM lifecycle management
    template.ts        # Template management
    network.ts         # TAP devices, IP allocation
    proxy.ts           # TCP proxy for SSH
    firecracker.ts     # Firecracker process management
    storage.ts         # btrfs operations, rootfs mounting
    config.ts          # Configuration (including protected templates)
  provision/
    setup.sh           # Main provisioning script
    firecracker.sh     # Firecracker installation
    network.sh         # Network setup (bridge, NAT)
    storage.sh         # btrfs setup
    rootfs.sh          # Base Debian rootfs creation
  test/
    integration.test.ts  # Full integration test
  do                   # Task runner script
  package.json
  tsconfig.json
  biome.json           # Linter config
  PLAN.md
```

#### 0.2 Create `do` Script
```bash
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  check)
    echo "==> Running linter..."
    bun run lint
    echo "==> Running integration test..."
    bun test
    ;;
  lint)
    bun run lint
    ;;
  test)
    bun test
    ;;
  build)
    bun build --compile --outfile=firecracker-api ./src/index.ts
    ;;
  *)
    echo "Usage: ./do {check|lint|test|build}"
    exit 1
    ;;
esac
```

#### 0.3 Create Test Infrastructure (All Tests Skipped)

Create the test file with ALL planned tests as `test.skip()`. This documents the full expected behavior while keeping `./do check` passing.

```typescript
// test/integration.test.ts
import { describe, test, afterEach, expect } from 'bun:test';

describe('Firecracker API', () => {
  // === Test Helpers & Cleanup (implement in 0.4) ===
  const createdVmIds: string[] = [];
  const createdTemplates: string[] = [];

  afterEach(async () => {
    // Cleanup implementation added later
  });

  // === Phase 2: Health & Auth ===
  test.skip('health check returns ok', async () => {});
  test.skip('auth rejects missing token', async () => {});
  test.skip('auth rejects invalid token', async () => {});

  // === Phase 3: Templates ===
  test.skip('lists templates', async () => {});
  test.skip('debian-base template exists', async () => {});
  test.skip('delete protected template returns 403', async () => {});
  test.skip('delete nonexistent template returns 404', async () => {});

  // === Phase 4: VM Lifecycle ===
  test.skip('create VM returns valid response', async () => {});
  test.skip('created VM appears in list', async () => {});
  test.skip('get VM by id returns details', async () => {});
  test.skip('delete VM returns 204', async () => {});
  test.skip('deleted VM not in list', async () => {});

  // === Phase 5: SSH Access ===
  test.skip('VM becomes reachable via SSH', async () => {});
  test.skip('can execute command via SSH', async () => {});

  // === Phase 6: Snapshots ===
  test.skip('snapshot VM creates template', async () => {});
  test.skip('snapshot appears in template list', async () => {});
  test.skip('can create VM from snapshot', async () => {});
  test.skip('snapshot preserves filesystem state', async () => {});

  // === Phase 7: Cleanup ===
  test.skip('can delete snapshot template', async () => {});
});
```

**Key:** All tests are `test.skip()` so `./do check` passes immediately.

#### 0.4 Test Helpers & Fixtures

Create test helpers that will be used throughout. Since no tests use them yet, `./do check` still passes.

```typescript
// test/helpers.ts
import { readFileSync } from 'fs';
import { join } from 'path';

const FIXTURES_DIR = join(import.meta.dir, 'fixtures');

// API client
const API_URL = `http://${process.env.VM_HOST || '34.40.56.57'}:8080`;
const API_TOKEN = process.env.API_TOKEN || 'dev-5a30aabffc0d8308ec749c49d94164705fc2d4b57c50b800';

export const api = {
  async get(path: string) {
    const res = await fetch(`${API_URL}${path}`, {
      headers: { 'Authorization': `Bearer ${API_TOKEN}` }
    });
    return { status: res.status, data: res.ok ? await res.json() : null };
  },
  async post(path: string, body: unknown) {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: res.status, data: res.ok ? await res.json() : null };
  },
  async delete(path: string) {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${API_TOKEN}` }
    });
    return { status: res.status };
  },
  async getRaw(path: string, token?: string) {
    const res = await fetch(`${API_URL}${path}`, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {}
    });
    return { status: res.status };
  }
};

// SSH helpers (to be used later)
export const TEST_PRIVATE_KEY_PATH = join(FIXTURES_DIR, 'test_key');
export const TEST_PUBLIC_KEY = ''; // Loaded when fixture exists
```

Generate test SSH keys:
```bash
mkdir -p test/fixtures
ssh-keygen -t ed25519 -f test/fixtures/test_key -N "" -C "firecracker-api-test"
```

#### 0.5 Linter Setup (Biome)
- TypeScript strict mode
- No unused variables
- Consistent formatting

#### 0.6 Configuration Module
```typescript
// src/config.ts
export const config = {
  // Server
  apiPort: parseInt(process.env.API_PORT || '8080'),
  apiToken: process.env.API_TOKEN || 'dev-5a30aabffc0d8308ec749c49d94164705fc2d4b57c50b800',

  // Storage
  dataDir: process.env.DATA_DIR || '/var/lib/firecracker',
  kernelPath: process.env.KERNEL_PATH || '/var/lib/firecracker/kernel/vmlinux',

  // Networking
  // Note: Port range (22001-32000 = ~10k ports) is the effective VM limit,
  // not the IP range (172.16.0.0/16 = ~65k IPs)
  portMin: parseInt(process.env.PORT_MIN || '22001'),
  portMax: parseInt(process.env.PORT_MAX || '32000'),

  // VM defaults
  defaultVcpuCount: parseInt(process.env.DEFAULT_VCPU_COUNT || '2'),
  defaultMemSizeMib: parseInt(process.env.DEFAULT_MEM_SIZE_MIB || '512'),

  // Protected templates - cannot be deleted via API
  protectedTemplates: ['debian-base'],
};
```

### Verification
- `./do check` passes (all tests skipped = pass)
- `./do lint` passes
- Project compiles with `bun build`

### Done Criteria
- [ ] Git repo initialized with .gitignore
- [ ] package.json with dependencies
- [ ] tsconfig.json with strict settings
- [ ] biome.json configured
- [ ] `do` script executable and working
- [ ] Integration test file with all tests skipped
- [ ] Test helpers created
- [ ] Test SSH keys generated
- [ ] **`./do check` passes**
- [ ] Committed

---

## Phase 1: Host Provisioning

### Goal
Create reusable provisioning scripts that set up any fresh Ubuntu/Debian VM for Firecracker.

### Prerequisites
- SSH access to target VM with sudo privileges (e.g., `dev@34.40.56.57`)
- VM has nested virtualization enabled (GCP) or is bare metal
- Run provisioning scripts with sudo: `sudo ./provision/setup.sh`

### Steps

#### 1.1 Base System Setup (`provision/setup.sh`)

**All provisioning scripts are idempotent** - safe to re-run without destroying existing data.

```bash
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
```

#### 1.2 Firecracker Installation (`provision/firecracker.sh`)
- Download Firecracker release binary (idempotent - safe to re-run for updates)
- Install to /usr/local/bin/firecracker
- Verify /dev/kvm exists and is accessible
- Download compatible Linux kernel (5.10 recommended)

**Note on updates:** Firecracker is not a daemon. Each VM spawns its own process.
Updating the binary only affects *new* VMs - running VMs continue with the old binary.
To fully migrate, delete and recreate VMs after updating.

```bash
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
```

**Manual Verification:**
```bash
# Check KVM access
ls -la /dev/kvm

# Check Firecracker binary
firecracker --version

# Check kernel exists
ls -la /var/lib/firecracker/kernel/vmlinux
```

#### 1.3 Storage Setup (`provision/storage.sh`)
- Create /var/lib/firecracker directory structure
- Set up btrfs filesystem (loop device for dev, dedicated partition for prod)
- Create subdirectories: templates/, vms/, kernel/
- **Idempotent:** Safe to re-run, skips if already set up

**For GCP (loop device approach):**
```bash
#!/usr/bin/env bash
set -euo pipefail

IMG_FILE="/var/lib/firecracker.img"
MOUNT_POINT="/var/lib/firecracker"

# Create and format only if image doesn't exist
if [[ ! -f "$IMG_FILE" ]]; then
  echo "Creating 50GB sparse file..."
  truncate -s 50G "$IMG_FILE"
  echo "Formatting as btrfs..."
  mkfs.btrfs "$IMG_FILE"
else
  echo "Image file already exists, skipping creation"
fi

# Mount only if not already mounted
mkdir -p "$MOUNT_POINT"
if ! mountpoint -q "$MOUNT_POINT"; then
  echo "Mounting btrfs filesystem..."
  mount -o loop "$IMG_FILE" "$MOUNT_POINT"
else
  echo "Already mounted, skipping"
fi

# Create subdirectories (idempotent)
mkdir -p "$MOUNT_POINT"/{templates,vms,kernel}

# Add to fstab only if not already present
if ! grep -q 'firecracker.img' /etc/fstab; then
  echo "Adding to /etc/fstab..."
  echo "$IMG_FILE $MOUNT_POINT btrfs loop,defaults 0 0" >> /etc/fstab
else
  echo "Already in /etc/fstab, skipping"
fi

echo "Storage setup complete"
```

**Manual Verification:**
```bash
# Verify btrfs
df -T /var/lib/firecracker  # Should show btrfs

# Test reflink copy
touch /var/lib/firecracker/test
cp --reflink=auto /var/lib/firecracker/test /var/lib/firecracker/test2
rm /var/lib/firecracker/test /var/lib/firecracker/test2
```

#### 1.4 Network Setup (`provision/network.sh`)
- Create bridge br0 with IP 172.16.0.1/16
- Enable IP forwarding
- Set up NAT (MASQUERADE) for outbound traffic
- Make settings persistent across reboot

```bash
#!/usr/bin/env bash
set -euo pipefail

# Detect primary network interface (works on GCP, Hetzner, etc.)
PRIMARY_IFACE=$(ip route | grep default | awk '{print $5}' | head -1)
echo "Detected primary interface: $PRIMARY_IFACE"

# Create bridge (if not exists)
if ! ip link show br0 &>/dev/null; then
  ip link add br0 type bridge
fi
ip addr add 172.16.0.1/16 dev br0 2>/dev/null || true
ip link set br0 up

# Enable forwarding
echo 1 > /proc/sys/net/ipv4/ip_forward
grep -q 'net.ipv4.ip_forward=1' /etc/sysctl.conf || echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf

# NAT for outbound (using detected interface)
iptables -t nat -C POSTROUTING -s 172.16.0.0/16 -o "$PRIMARY_IFACE" -j MASQUERADE 2>/dev/null || \
  iptables -t nat -A POSTROUTING -s 172.16.0.0/16 -o "$PRIMARY_IFACE" -j MASQUERADE
iptables -C FORWARD -i br0 -o "$PRIMARY_IFACE" -j ACCEPT 2>/dev/null || \
  iptables -A FORWARD -i br0 -o "$PRIMARY_IFACE" -j ACCEPT
iptables -C FORWARD -i "$PRIMARY_IFACE" -o br0 -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \
  iptables -A FORWARD -i "$PRIMARY_IFACE" -o br0 -m state --state RELATED,ESTABLISHED -j ACCEPT

# Persist bridge config via systemd-networkd
mkdir -p /etc/systemd/network
cat > /etc/systemd/network/br0.netdev <<EOF
[NetDev]
Name=br0
Kind=bridge
EOF

cat > /etc/systemd/network/br0.network <<EOF
[Match]
Name=br0

[Network]
Address=172.16.0.1/16
EOF

# Persist iptables rules
apt-get install -y iptables-persistent
netfilter-persistent save

echo "Network setup complete"
```

**Manual Verification:**
```bash
# Check bridge
ip addr show br0

# Check NAT rule
iptables -t nat -L -n | grep MASQUERADE
```

#### 1.5 Base Rootfs Creation (`provision/rootfs.sh`)
- Create minimal Debian rootfs using debootstrap
- Configure for Firecracker (serial console, networking)
- Install OpenSSH server
- Configure for SSH key injection (empty authorized_keys, will be populated per-VM)
- Save as debian-base template
- **Idempotent:** Skips if debian-base.ext4 already exists

```bash
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
debootstrap --include=openssh-server,iproute2,iputils-ping bookworm /tmp/rootfs http://deb.debian.org/debian

# Configure for Firecracker
chroot /tmp/rootfs /bin/bash <<'EOF'
# Enable serial console
systemctl enable serial-getty@ttyS0.service

# Configure SSH
mkdir -p /root/.ssh
chmod 700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

# Allow root login with key
sed -i 's/#PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config

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
EOF

# Create ext4 image
truncate -s 2G "$TEMPLATE_PATH"
mkfs.ext4 "$TEMPLATE_PATH"
mkdir -p /mnt/rootfs
mount "$TEMPLATE_PATH" /mnt/rootfs
cp -a /tmp/rootfs/* /mnt/rootfs/
umount /mnt/rootfs
rm -rf /tmp/rootfs

echo "debian-base template created"
```

**Manual Verification:**
```bash
# Check template exists
ls -la /var/lib/firecracker/templates/debian-base.ext4
```

#### 1.6 Manual Firecracker Test

Boot a test VM to verify everything works:

```bash
# Create test rootfs copy
cp --reflink=auto /var/lib/firecracker/templates/debian-base.ext4 /tmp/test-vm.ext4

# Create TAP device
ip tuntap add tap-test mode tap
ip link set tap-test master br0
ip link set tap-test up

# Start Firecracker (in separate terminal or background)
rm -f /tmp/firecracker.sock
firecracker --api-sock /tmp/firecracker.sock &

# Configure VM via API
curl --unix-socket /tmp/firecracker.sock -X PUT \
  http://localhost/boot-source \
  -H 'Content-Type: application/json' \
  -d '{
    "kernel_image_path": "/var/lib/firecracker/kernel/vmlinux",
    "boot_args": "console=ttyS0 reboot=k panic=1 pci=off ip=172.16.0.2::172.16.0.1:255.255.0.0::eth0:off"
  }'

curl --unix-socket /tmp/firecracker.sock -X PUT \
  http://localhost/drives/rootfs \
  -H 'Content-Type: application/json' \
  -d '{
    "drive_id": "rootfs",
    "path_on_host": "/tmp/test-vm.ext4",
    "is_root_device": true,
    "is_read_only": false
  }'

curl --unix-socket /tmp/firecracker.sock -X PUT \
  http://localhost/network-interfaces/eth0 \
  -H 'Content-Type: application/json' \
  -d '{
    "iface_id": "eth0",
    "guest_mac": "AA:FC:00:00:00:01",
    "host_dev_name": "tap-test"
  }'

curl --unix-socket /tmp/firecracker.sock -X PUT \
  http://localhost/machine-config \
  -H 'Content-Type: application/json' \
  -d '{
    "vcpu_count": 2,
    "mem_size_mib": 512
  }'

# Start the VM
curl --unix-socket /tmp/firecracker.sock -X PUT \
  http://localhost/actions \
  -H 'Content-Type: application/json' \
  -d '{"action_type": "InstanceStart"}'

# Test connectivity
ping -c 3 172.16.0.2

# Cleanup
pkill firecracker
ip link del tap-test
rm /tmp/test-vm.ext4
```

### Verification
- All provision scripts run without error
- /dev/kvm accessible
- btrfs mounted with reflink support
- Bridge br0 exists with correct IP
- NAT rules in place
- debian-base.ext4 template exists
- Manual Firecracker test VM boots and responds to ping

### Done Criteria
- [ ] provision/setup.sh runs end-to-end on fresh VM
- [ ] Firecracker binary installed and working
- [ ] btrfs filesystem mounted at /var/lib/firecracker
- [ ] Network bridge and NAT configured
- [ ] debian-base template created
- [ ] Manual VM boot test successful
- [ ] Provisioning scripts committed

---

## Phase 2: API Skeleton & Health Check

### Goal
Create HTTP server with health check and authentication.

**Prerequisites:** Phase 1 complete (host provisioned), API server can be started on target.

---

### Step 2.1: Test health check returns ok

**Test:**
```typescript
test('health check returns ok', async () => {
  const { status, data } = await api.get('/health');
  expect(status).toBe(200);
  expect(data.status).toBe('ok');
});
```

**Implement:**
```typescript
// src/index.ts
import { Hono } from 'hono';
import { config } from './config';

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));

export default { port: config.apiPort, fetch: app.fetch };
```

**Verify:** `./do check` passes → **Commit**

---

### Step 2.2: Test auth rejects missing token

**Test:**
```typescript
test('auth rejects missing token', async () => {
  const { status } = await api.getRaw('/health'); // no token
  expect(status).toBe(401);
});
```

**Implement:** Add bearer auth middleware (exclude /health initially, then realize we want auth on everything except the test above needs adjustment - actually health should be unauthed, so:)

Actually, let's keep /health unauthenticated for probes. Test a protected endpoint:

**Test (revised):**
```typescript
test('auth rejects missing token', async () => {
  const { status } = await api.getRaw('/templates'); // no token
  expect(status).toBe(401);
});
```

**Implement:**
```typescript
import { bearerAuth } from 'hono/bearer-auth';

// Health check (no auth)
app.get('/health', (c) => c.json({ status: 'ok' }));

// Protected routes
app.use('/*', bearerAuth({ token: config.apiToken }));
app.get('/templates', (c) => c.json({ templates: [] })); // stub
```

**Verify:** `./do check` passes → **Commit**

---

### Step 2.3: Test auth rejects invalid token

**Test:**
```typescript
test('auth rejects invalid token', async () => {
  const { status } = await api.getRaw('/templates', 'wrong-token');
  expect(status).toBe(401);
});
```

**Implement:** Already covered by bearer auth middleware.

**Verify:** `./do check` passes → **Commit**

---

### Phase 2 Complete
- [ ] Health check works (unauthenticated)
- [ ] Protected routes reject missing/invalid tokens
- [ ] `./do check` passes

---

## Phase 3: Template Management

### Goal
Implement template listing and deletion.

---

### Step 3.1: Test lists templates

**Test:**
```typescript
test('lists templates', async () => {
  const { status, data } = await api.get('/templates');
  expect(status).toBe(200);
  expect(Array.isArray(data.templates)).toBe(true);
});
```

**Implement:**
```typescript
// src/services/template.ts
import { readdir, stat } from 'fs/promises';
import { config } from '../config';

export async function listTemplates() {
  const dir = `${config.dataDir}/templates`;
  const files = await readdir(dir);
  const templates = await Promise.all(
    files.filter(f => f.endsWith('.ext4')).map(async (f) => {
      const path = `${dir}/${f}`;
      const stats = await stat(path);
      return {
        name: f.replace('.ext4', ''),
        size_bytes: stats.size,
        created_at: stats.mtime.toISOString()
      };
    })
  );
  return templates;
}

// In routes:
app.get('/templates', async (c) => {
  const templates = await listTemplates();
  return c.json({ templates });
});
```

**Verify:** `./do check` passes → **Commit**

---

### Step 3.2: Test debian-base template exists

**Test:**
```typescript
test('debian-base template exists', async () => {
  const { data } = await api.get('/templates');
  const names = data.templates.map((t: any) => t.name);
  expect(names).toContain('debian-base');
});
```

**Implement:** Already works if provisioning was done correctly.

**Verify:** `./do check` passes → **Commit**

---

### Step 3.3: Test delete protected template returns 403

**Test:**
```typescript
test('delete protected template returns 403', async () => {
  const { status } = await api.delete('/templates/debian-base');
  expect(status).toBe(403);
});
```

**Implement:**
```typescript
// src/services/template.ts
export async function deleteTemplate(name: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw { status: 400, message: 'Invalid template name' };
  }
  if (config.protectedTemplates.includes(name)) {
    throw { status: 403, message: 'Cannot delete protected template' };
  }
  // ... rest of implementation
}

// In routes:
app.delete('/templates/:name', async (c) => {
  try {
    await deleteTemplate(c.req.param('name'));
    return c.body(null, 204);
  } catch (e: any) {
    return c.json({ error: e.message }, e.status || 500);
  }
});
```

**Verify:** `./do check` passes → **Commit**

---

### Step 3.4: Test delete nonexistent template returns 404

**Test:**
```typescript
test('delete nonexistent template returns 404', async () => {
  const { status } = await api.delete('/templates/does-not-exist');
  expect(status).toBe(404);
});
```

**Implement:**
```typescript
// In deleteTemplate():
const templatePath = `${config.dataDir}/templates/${name}.ext4`;
if (!existsSync(templatePath)) {
  throw { status: 404, message: 'Template not found' };
}
await unlink(templatePath);
```

**Verify:** `./do check` passes → **Commit**

---

### Phase 3 Complete
- [ ] GET /templates lists templates with metadata
- [ ] debian-base exists after provisioning
- [ ] DELETE /templates/:name respects protected list (403)
- [ ] DELETE /templates/:name returns 404 for missing
- [ ] `./do check` passes

---

## Phase 4: VM Creation & Lifecycle

### Goal
Implement VM creation, listing, and deletion.

### Reference: Data Structures & Helpers

These are implemented incrementally as tests require them:

```typescript
// VM interface
interface VM {
  id: string;           // "vm-" + 12 hex chars
  name?: string;
  template: string;
  ip: string;           // 172.16.x.x
  port: number;         // SSH proxy port
  pid: number;          // Firecracker process PID
  socketPath: string;   // /tmp/firecracker-{id}.sock
  rootfsPath: string;   // /var/lib/firecracker/vms/{id}.ext4
  tapDevice: string;    // tap-{id}
  createdAt: Date;
}

// ID generation
function generateVmId(): string {
  return `vm-${randomBytes(6).toString('hex')}`;
}

// Port allocation (hash-based with collision detection)
// Note: Port range (22001-32000 = ~10k) is effective VM limit
function allocatePort(vmId: string, usedPorts: Set<number>): number { ... }

// MAC address from VM ID
function vmIdToMac(vmId: string): string { ... }

// Kernel command line
function buildKernelArgs(ip: string): string { ... }

// Mutex for concurrent VM creation
async function withVmCreationLock<T>(fn: () => Promise<T>): Promise<T> { ... }
```

---

### Step 4.1: Test create VM returns valid response

**Test:**
```typescript
test('create VM returns valid response', async () => {
  const { status, data } = await api.post('/vms', {
    template: 'debian-base',
    name: 'test-vm',
    ssh_public_key: TEST_PUBLIC_KEY
  });
  if (data?.id) createdVmIds.push(data.id); // cleanup tracking

  expect(status).toBe(201);
  expect(data.id).toMatch(/^vm-[a-f0-9]{12}$/);
  expect(data.template).toBe('debian-base');
  expect(data.ip).toMatch(/^172\.16\.\d+\.\d+$/);
  expect(data.ssh_port).toBeGreaterThan(22000);
});
```

**Implement:** This is the big one. Implement VM creation:
1. Validate template exists
2. Generate VM ID, allocate IP and port
3. Copy rootfs with reflink
4. Inject SSH key
5. Create TAP device
6. Start Firecracker, configure and boot
7. Start TCP proxy
8. Return VM details

```typescript
// POST /vms handler
app.post('/vms', async (c) => {
  return withVmCreationLock(async () => {
    const body = await c.req.json();
    const vm = await createVm(body);
    return c.json(vmToResponse(vm), 201);
  });
});
```

**Verify:** `./do check` passes → **Commit**

---

### Step 4.2: Test created VM appears in list

**Test:**
```typescript
test('created VM appears in list', async () => {
  // Create a VM first
  const { data: created } = await api.post('/vms', {
    template: 'debian-base',
    ssh_public_key: TEST_PUBLIC_KEY
  });
  createdVmIds.push(created.id);

  // List VMs
  const { status, data } = await api.get('/vms');
  expect(status).toBe(200);
  expect(data.vms.some((v: any) => v.id === created.id)).toBe(true);
});
```

**Implement:**
```typescript
app.get('/vms', (c) => {
  return c.json({ vms: Array.from(vms.values()).map(vmToResponse) });
});
```

**Verify:** `./do check` passes → **Commit**

---

### Step 4.3: Test get VM by id returns details

**Test:**
```typescript
test('get VM by id returns details', async () => {
  const { data: created } = await api.post('/vms', {
    template: 'debian-base',
    ssh_public_key: TEST_PUBLIC_KEY
  });
  createdVmIds.push(created.id);

  const { status, data } = await api.get(`/vms/${created.id}`);
  expect(status).toBe(200);
  expect(data.id).toBe(created.id);
});
```

**Implement:**
```typescript
app.get('/vms/:id', (c) => {
  const vm = vms.get(c.req.param('id'));
  if (!vm) return c.json({ error: 'VM not found' }, 404);
  return c.json(vmToResponse(vm));
});
```

**Verify:** `./do check` passes → **Commit**

---

### Step 4.4: Test delete VM returns 204

**Test:**
```typescript
test('delete VM returns 204', async () => {
  const { data: created } = await api.post('/vms', {
    template: 'debian-base',
    ssh_public_key: TEST_PUBLIC_KEY
  });
  // Don't add to cleanup - we're testing delete

  const { status } = await api.delete(`/vms/${created.id}`);
  expect(status).toBe(204);
});
```

**Implement:** VM deletion:
1. Stop TCP proxy
2. Kill Firecracker process
3. Remove TAP device
4. Delete rootfs
5. Release IP
6. Remove from state

```typescript
app.delete('/vms/:id', async (c) => {
  const vm = vms.get(c.req.param('id'));
  if (!vm) return c.json({ error: 'VM not found' }, 404);
  await deleteVm(vm);
  return c.body(null, 204);
});
```

**Verify:** `./do check` passes → **Commit**

---

### Step 4.5: Test deleted VM not in list

**Test:**
```typescript
test('deleted VM not in list', async () => {
  const { data: created } = await api.post('/vms', {
    template: 'debian-base',
    ssh_public_key: TEST_PUBLIC_KEY
  });
  await api.delete(`/vms/${created.id}`);

  const { data } = await api.get('/vms');
  expect(data.vms.some((v: any) => v.id === created.id)).toBe(false);
});
```

**Implement:** Already works if deleteVm removes from state.

**Verify:** `./do check` passes → **Commit**

---

### Phase 4 Complete
- [ ] POST /vms creates VM and returns details
- [ ] GET /vms lists all VMs
- [ ] GET /vms/:id returns specific VM
- [ ] DELETE /vms/:id removes VM
- [ ] `./do check` passes

---

## Phase 5: SSH Access

### Goal
Verify SSH connectivity through TCP proxy (proxy implemented in Phase 4 as part of VM creation).

---

### Step 5.1: Test VM becomes reachable via SSH

**Test:**
```typescript
test('VM becomes reachable via SSH', async () => {
  const { data: vm } = await api.post('/vms', {
    template: 'debian-base',
    ssh_public_key: TEST_PUBLIC_KEY
  });
  createdVmIds.push(vm.id);

  // Wait for SSH to be ready (VM boot + SSH daemon start)
  await waitForSsh(vm.ssh_port, 30000);
});

// Helper in test/helpers.ts
async function waitForSsh(port: number, timeoutMs: number): Promise<void> {
  const host = process.env.VM_HOST || 'localhost';
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await $`nc -z ${host} ${port}`.quiet();
      return;
    } catch {
      await Bun.sleep(500);
    }
  }
  throw new Error(`SSH not ready on port ${port} within ${timeoutMs}ms`);
}
```

**Implement:** Proxy should already work from Phase 4. This test verifies it.

**Verify:** `./do check` passes → **Commit**

---

### Step 5.2: Test can execute command via SSH

**Test:**
```typescript
test('can execute command via SSH', async () => {
  const { data: vm } = await api.post('/vms', {
    template: 'debian-base',
    ssh_public_key: TEST_PUBLIC_KEY
  });
  createdVmIds.push(vm.id);

  await waitForSsh(vm.ssh_port, 30000);

  const output = await sshExec(vm.ssh_port, 'echo hello');
  expect(output.trim()).toBe('hello');
});

// Helper in test/helpers.ts
async function sshExec(port: number, command: string): Promise<string> {
  const host = process.env.VM_HOST || 'localhost';
  return await $`ssh -p ${port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${TEST_PRIVATE_KEY_PATH} root@${host} ${command}`.text();
}
```

**Implement:** Already works if SSH key injection and proxy work.

**Verify:** `./do check` passes → **Commit**

---

### Phase 5 Complete
- [ ] VM SSH port becomes reachable after boot
- [ ] Can execute commands via SSH
- [ ] `./do check` passes

### Reference: Proxy Implementation

```typescript
// src/proxy.ts
export function startProxy(vmId: string, localPort: number, targetIp: string, targetPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((clientSocket) => {
      const vmSocket = net.createConnection(targetPort, targetIp);
      clientSocket.pipe(vmSocket);
      vmSocket.pipe(clientSocket);
      // ... error handling, socket tracking
    });
    server.on('error', reject);
    server.listen(localPort, '0.0.0.0', () => {
      proxies.set(vmId, server);
      resolve();
    });
  });
}

export function stopProxy(vmId: string) {
  // Destroy active connections, then close server
}
```

---

## Phase 6: VM Snapshots

### Goal
Implement snapshotting a VM's rootfs to create a new template.

---

### Step 6.1: Test snapshot VM creates template

**Test:**
```typescript
test('snapshot VM creates template', async () => {
  const { data: vm } = await api.post('/vms', {
    template: 'debian-base',
    ssh_public_key: TEST_PUBLIC_KEY
  });
  createdVmIds.push(vm.id);

  const { status, data } = await api.post(`/vms/${vm.id}/snapshot`, {
    template_name: 'test-snapshot'
  });
  createdTemplates.push('test-snapshot'); // cleanup tracking

  expect(status).toBe(201);
  expect(data.template).toBe('test-snapshot');
  expect(data.source_vm).toBe(vm.id);
});
```

**Implement:**
```typescript
app.post('/vms/:id/snapshot', async (c) => {
  const vm = vms.get(c.req.param('id'));
  if (!vm) return c.json({ error: 'VM not found' }, 404);

  const { template_name } = await c.req.json();
  const template = await snapshotVm(vm, template_name);
  return c.json({
    template: template.name,
    source_vm: vm.id,
    size_bytes: template.size_bytes,
    created_at: template.created_at
  }, 201);
});

async function snapshotVm(vm: VM, templateName: string): Promise<Template> {
  // 1. Validate name (path traversal prevention)
  if (!/^[a-zA-Z0-9_-]+$/.test(templateName)) {
    throw { status: 400, message: 'Invalid template name' };
  }
  // 2. Check doesn't exist
  // 3. Pause VM
  // 4. Copy rootfs with reflink
  // 5. Resume VM
  // 6. Clear SSH keys (delete template on failure)
  // 7. Return metadata
}
```

**Verify:** `./do check` passes → **Commit**

---

### Step 6.2: Test snapshot appears in template list

**Test:**
```typescript
test('snapshot appears in template list', async () => {
  const { data: vm } = await api.post('/vms', {
    template: 'debian-base',
    ssh_public_key: TEST_PUBLIC_KEY
  });
  createdVmIds.push(vm.id);

  await api.post(`/vms/${vm.id}/snapshot`, { template_name: 'test-snap-list' });
  createdTemplates.push('test-snap-list');

  const { data } = await api.get('/templates');
  const names = data.templates.map((t: any) => t.name);
  expect(names).toContain('test-snap-list');
});
```

**Implement:** Already works if snapshot writes to templates directory.

**Verify:** `./do check` passes → **Commit**

---

### Step 6.3: Test can create VM from snapshot

**Test:**
```typescript
test('can create VM from snapshot', async () => {
  // Create VM and snapshot
  const { data: vm1 } = await api.post('/vms', {
    template: 'debian-base',
    ssh_public_key: TEST_PUBLIC_KEY
  });
  createdVmIds.push(vm1.id);

  await api.post(`/vms/${vm1.id}/snapshot`, { template_name: 'test-snap-create' });
  createdTemplates.push('test-snap-create');

  // Create VM from snapshot
  const { status, data: vm2 } = await api.post('/vms', {
    template: 'test-snap-create',
    ssh_public_key: TEST_PUBLIC_KEY
  });
  createdVmIds.push(vm2.id);

  expect(status).toBe(201);
  expect(vm2.template).toBe('test-snap-create');
});
```

**Implement:** Already works if VM creation reads from templates directory.

**Verify:** `./do check` passes → **Commit**

---

### Step 6.4: Test snapshot preserves filesystem state

**Test:**
```typescript
test('snapshot preserves filesystem state', async () => {
  // Create VM, write marker file
  const { data: vm1 } = await api.post('/vms', {
    template: 'debian-base',
    ssh_public_key: TEST_PUBLIC_KEY
  });
  createdVmIds.push(vm1.id);
  await waitForSsh(vm1.ssh_port, 30000);
  await sshExec(vm1.ssh_port, 'echo MARKER > /root/marker.txt');

  // Snapshot
  await api.post(`/vms/${vm1.id}/snapshot`, { template_name: 'test-snap-state' });
  createdTemplates.push('test-snap-state');

  // Create VM from snapshot
  const { data: vm2 } = await api.post('/vms', {
    template: 'test-snap-state',
    ssh_public_key: TEST_PUBLIC_KEY
  });
  createdVmIds.push(vm2.id);
  await waitForSsh(vm2.ssh_port, 30000);

  // Verify marker file exists
  const marker = await sshExec(vm2.ssh_port, 'cat /root/marker.txt');
  expect(marker.trim()).toBe('MARKER');
});
```

**Implement:** Already works if snapshot copies filesystem correctly.

**Verify:** `./do check` passes → **Commit**

---

### Phase 6 Complete
- [ ] POST /vms/:id/snapshot creates template
- [ ] Snapshot appears in template list
- [ ] Can create VM from snapshot
- [ ] Snapshot preserves filesystem state
- [ ] `./do check` passes

### Reference: Snapshot Implementation

```typescript
async function snapshotVm(vm: VM, templateName: string): Promise<Template> {
  // Validate, check doesn't exist
  await pauseVm(vm);
  try {
    await $`cp --reflink=auto ${vm.rootfsPath} ${templatePath}`;
  } finally {
    await resumeVm(vm);
  }
  // Clear SSH keys (delete template on failure)
  // Return metadata
}
```

---

## Phase 7: Cleanup & Final Tests

### Goal
Add final cleanup tests and verify all tests pass.

---

### Step 7.1: Test can delete snapshot template

**Test:**
```typescript
test('can delete snapshot template', async () => {
  // Create VM and snapshot
  const { data: vm } = await api.post('/vms', {
    template: 'debian-base',
    ssh_public_key: TEST_PUBLIC_KEY
  });
  createdVmIds.push(vm.id);

  await api.post(`/vms/${vm.id}/snapshot`, { template_name: 'test-snap-delete' });
  // Don't track - we're testing delete

  // Delete the snapshot template
  const { status } = await api.delete('/templates/test-snap-delete');
  expect(status).toBe(204);

  // Verify it's gone
  const { data } = await api.get('/templates');
  const names = data.templates.map((t: any) => t.name);
  expect(names).not.toContain('test-snap-delete');
});
```

**Implement:** Already works if deleteTemplate handles non-protected templates.

**Verify:** `./do check` passes → **Commit**

---

### Phase 7 Complete

At this point, all tests are enabled and passing:

```
✓ health check returns ok
✓ auth rejects missing token
✓ auth rejects invalid token
✓ lists templates
✓ debian-base template exists
✓ delete protected template returns 403
✓ delete nonexistent template returns 404
✓ create VM returns valid response
✓ created VM appears in list
✓ get VM by id returns details
✓ delete VM returns 204
✓ deleted VM not in list
✓ VM becomes reachable via SSH
✓ can execute command via SSH
✓ snapshot VM creates template
✓ snapshot appears in template list
✓ can create VM from snapshot
✓ snapshot preserves filesystem state
✓ can delete snapshot template
```

### Test Infrastructure Reference

**Test Fixtures:**
```
test/fixtures/
├── test_key       # Ed25519 private key
└── test_key.pub   # Ed25519 public key
```

**Test Helpers (test/helpers.ts):**
```typescript
// API client
export const api = { get, post, delete, getRaw };

// SSH
export const TEST_PRIVATE_KEY_PATH = '...';
export const TEST_PUBLIC_KEY = '...';
export async function waitForSsh(port: number, timeoutMs: number): Promise<void>;
export async function sshExec(port: number, command: string): Promise<string>;
```

**Cleanup Pattern:**
```typescript
describe('Firecracker API', () => {
  const createdVmIds: string[] = [];
  const createdTemplates: string[] = [];

  afterEach(async () => {
    // Clean up VMs first, then templates
    for (const vmId of createdVmIds) {
      try { await api.delete(`/vms/${vmId}`); } catch {}
    }
    createdVmIds.length = 0;
    for (const template of createdTemplates) {
      try { await api.delete(`/templates/${template}`); } catch {}
    }
    createdTemplates.length = 0;
  });
});
```

---

### Done Criteria
- [ ] All 19 tests enabled and passing
- [ ] `./do check` exits 0
- [ ] Committed

---

## Phase 8: Polish & Hardening

### Goal
Production-readiness improvements. These don't require new tests - they improve existing functionality.

**Rule:** Each improvement must keep `./do check` passing.

---

### Step 8.1: Error handling cleanup

- Ensure all errors return proper HTTP status codes
- Add cleanup on partial VM creation failures
- Add graceful shutdown (stop all VMs on SIGTERM)

**Verify:** `./do check` passes → **Commit**

---

### Step 8.2: Logging

- Add request logging middleware
- Log VM lifecycle events (create, delete, snapshot)
- Log errors with context

**Verify:** `./do check` passes → **Commit**

---

### Step 8.3: State recovery

- On startup, scan for orphaned Firecracker processes
- Rebuild in-memory state from running VMs
- Clean up stale TAP devices and rootfs files

**Verify:** `./do check` passes → **Commit**

---

### Step 8.4: systemd service

Create `firecracker-api.service`:
```ini
[Unit]
Description=Firecracker VM API
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/firecracker-api
Environment=API_TOKEN=<token>
Restart=always

[Install]
WantedBy=multi-user.target
```

**Verify:** `./do check` passes → **Commit**

---

### Step 8.5: Single binary build

```bash
bun build --compile --outfile=firecracker-api ./src/index.ts
```

**Verify:** Binary runs, `./do check` passes → **Commit**

---

### Phase 8 Complete
- [ ] Error handling comprehensive
- [ ] Logging in place
- [ ] State recovery on restart
- [ ] systemd service file created
- [ ] Single binary builds
- [ ] `./do check` passes

---

## API Reference

### Authentication
All endpoints require Bearer token authentication:
```
Authorization: Bearer <token>
```

### Endpoints

#### Health
```
GET /health
Response: { "status": "ok" }
```

#### Templates
```
GET /templates
Response: { "templates": [{ "name": string, "size_bytes": number, "created_at": string }] }

DELETE /templates/:name
Response: 204 No Content
```

#### VMs
```
GET /vms
Response: { "vms": [VM] }

GET /vms/:id
Response: VM

POST /vms
Request: { "template": string, "name"?: string, "ssh_public_key": string, "vcpu_count"?: number, "mem_size_mib"?: number }
Response: 201 Created, VM

DELETE /vms/:id
Response: 204 No Content

POST /vms/:id/snapshot
Request: { "template_name": string }
Response: 201 Created, { "template": string, "source_vm": string, "size_bytes": number }
```

#### VM Object
```typescript
{
  "id": string,
  "name": string | null,
  "template": string,
  "ip": string,
  "ssh_port": number,
  "ssh": string,  // Full SSH command
  "status": "running" | "stopped",
  "created_at": string
}
```

---

## File Structure (Final)

```
firecracker-api/
├── src/
│   ├── index.ts           # Entry point, HTTP server
│   ├── routes/
│   │   ├── health.ts
│   │   ├── vms.ts
│   │   └── templates.ts
│   ├── services/
│   │   ├── vm.ts          # VM lifecycle
│   │   ├── template.ts    # Template management
│   │   ├── firecracker.ts # Firecracker process
│   │   ├── network.ts     # TAP, IP allocation
│   │   ├── proxy.ts       # TCP proxy
│   │   └── storage.ts     # btrfs, rootfs mounting
│   ├── config.ts
│   └── types.ts
├── provision/
│   ├── setup.sh           # Main entry
│   ├── firecracker.sh
│   ├── network.sh
│   ├── storage.sh
│   └── rootfs.sh
├── test/
│   ├── integration.test.ts
│   ├── helpers.ts
│   └── fixtures/
│       ├── test_key         # Ed25519 private key (checked into git)
│       └── test_key.pub     # Ed25519 public key (checked into git)
├── do                     # Task runner
├── package.json
├── tsconfig.json
├── biome.json
├── .gitignore
├── .env.example
├── README.md
└── PLAN.md
```

---

## Environment Variables

```bash
# Required for server
API_TOKEN=dev-5a30aabffc0d8308ec749c49d94164705fc2d4b57c50b800

# Required for integration tests
VM_HOST=34.40.56.57
API_TOKEN=dev-5a30aabffc0d8308ec749c49d94164705fc2d4b57c50b800
# Note: SSH key is loaded from test/fixtures/test_key (checked into git)

# Optional server config (defaults shown)
API_PORT=8080
DATA_DIR=/var/lib/firecracker
KERNEL_PATH=/var/lib/firecracker/kernel/vmlinux
PORT_MIN=22001
PORT_MAX=32000
```

---

## Quick Reference: Commands

```bash
# Development
./do check          # Lint + integration test
./do lint           # Lint only
./do test           # Integration test only
./do build          # Compile single binary

# Provisioning (on target VM)
./provision/setup.sh    # Full setup

# Manual testing
curl -H "Authorization: Bearer dev-5a30aabffc0d8308ec749c49d94164705fc2d4b57c50b800" http://34.40.56.57:8080/health
```
