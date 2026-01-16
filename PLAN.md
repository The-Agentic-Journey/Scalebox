# Firecracker VM API - Implementation Plan

## Overview

A REST API service for managing Firecracker microVMs on a dedicated host. Supports creating VMs from templates, snapshotting VMs, and SSH access via TCP proxy.

**Target Environment:** GCP n1-standard-2 with nested virtualization (dev), Hetzner dedicated server (prod)

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

## Phase 0: Project Foundation

### Goal
Set up the repository structure, tooling, and write the full integration test upfront (ATDD).

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

#### 0.3 Write Full Integration Test (Will Fail Initially)

The test defines the complete expected behavior:

```typescript
// test/integration.test.ts
describe('Firecracker API', () => {
  test('full workflow: create VM → snapshot → create from snapshot', async () => {
    // 1. Health check
    // 2. Verify base template exists
    // 3. Create VM from template with SSH key
    // 4. Wait for VM to boot
    // 5. SSH into VM, create marker file
    // 6. Snapshot VM to new template
    // 7. Delete original VM
    // 8. Create new VM from snapshot template
    // 9. SSH into new VM, verify marker file exists
    // 10. Cleanup: delete VM and snapshot template
  });
});
```

#### 0.4 Linter Setup (Biome)
- TypeScript strict mode
- No unused variables
- Consistent formatting

#### 0.5 Configuration Module
```typescript
// src/config.ts
export const config = {
  // Server
  apiPort: parseInt(process.env.API_PORT || '8080'),
  apiToken: process.env.API_TOKEN || 'dev-token',

  // Storage
  dataDir: process.env.DATA_DIR || '/var/lib/firecracker',
  kernelPath: process.env.KERNEL_PATH || '/var/lib/firecracker/kernel/vmlinux',

  // Networking
  portMin: parseInt(process.env.PORT_MIN || '22001'),
  portMax: parseInt(process.env.PORT_MAX || '32000'),

  // Protected templates - cannot be deleted via API
  protectedTemplates: ['debian-base'],
};
```

### Verification
- `./do check` runs (test fails, but linter passes)
- Project compiles with `bun build`

### Done Criteria
- [ ] Git repo initialized with .gitignore
- [ ] package.json with dependencies (bun types, test framework)
- [ ] tsconfig.json with strict settings
- [ ] biome.json configured
- [ ] `do` script executable and working
- [ ] Integration test file exists (fails when run)
- [ ] `./do lint` passes
- [ ] Initial commit made

---

## Phase 1: Host Provisioning

### Goal
Create reusable provisioning scripts that set up any fresh Ubuntu/Debian VM for Firecracker.

### Prerequisites
- SSH access to target VM as root
- VM has nested virtualization enabled (GCP) or is bare metal

### Steps

#### 1.1 Base System Setup (`provision/setup.sh`)
```bash
#!/usr/bin/env bash
# Main entry point - runs all provisioning steps
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
- Download latest Firecracker release binary
- Install to /usr/local/bin/firecracker
- Verify /dev/kvm exists and is accessible
- Download compatible Linux kernel (5.10 recommended)

```bash
#!/usr/bin/env bash
set -euo pipefail

# Check KVM access
if [[ ! -e /dev/kvm ]]; then
  echo "ERROR: /dev/kvm not found. Is KVM enabled?"
  exit 1
fi

# Download Firecracker binary
FC_VERSION="1.7.0"
curl -L -o /usr/local/bin/firecracker \
  "https://github.com/firecracker-microvm/firecracker/releases/download/v${FC_VERSION}/firecracker-v${FC_VERSION}-x86_64"
chmod +x /usr/local/bin/firecracker

# Download compatible kernel
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

**For GCP (loop device approach):**
```bash
# Create 50GB sparse file
truncate -s 50G /var/lib/firecracker.img

# Format as btrfs
mkfs.btrfs /var/lib/firecracker.img

# Mount
mkdir -p /var/lib/firecracker
mount -o loop /var/lib/firecracker.img /var/lib/firecracker

# Add to fstab for persistence
echo '/var/lib/firecracker.img /var/lib/firecracker btrfs loop,defaults 0 0' >> /etc/fstab
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

```bash
# Create rootfs (use explicit Debian version for reproducibility)
apt-get install -y debootstrap
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
truncate -s 2G /var/lib/firecracker/templates/debian-base.ext4
mkfs.ext4 /var/lib/firecracker/templates/debian-base.ext4
mkdir -p /mnt/rootfs
mount /var/lib/firecracker/templates/debian-base.ext4 /mnt/rootfs
cp -a /tmp/rootfs/* /mnt/rootfs/
umount /mnt/rootfs
rm -rf /tmp/rootfs
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
Create the HTTP server skeleton and implement health check endpoint.

### Steps

#### 2.1 HTTP Server with Bun
- Use Bun's built-in HTTP server or Hono framework
- Listen on port 8080
- Bearer token authentication middleware
- JSON request/response handling

```typescript
// src/index.ts
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';

const app = new Hono();

// Auth middleware
app.use('/*', bearerAuth({ token: process.env.API_TOKEN || 'dev-token' }));

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// Routes
app.route('/vms', vmsRouter);
app.route('/templates', templatesRouter);

export default {
  port: 8080,
  fetch: app.fetch,
};
```

#### 2.2 Update Integration Test
- Test health endpoint
- Test authentication (valid token works, invalid fails)

### Verification
- API starts and responds to /health
- Auth rejects invalid tokens
- `./do check` - linter passes, test partially passes (health check works)

### Done Criteria
- [ ] HTTP server running on :8080
- [ ] Bearer token auth working
- [ ] GET /health returns 200
- [ ] Integration test health check passes
- [ ] Committed

---

## Phase 3: Template Management

### Goal
Implement template listing. The base template was created during provisioning.

### Steps

#### 3.1 Template Listing
```
GET /templates

Response:
{
  "templates": [
    {
      "name": "debian-base",
      "size_bytes": 2147483648,
      "created_at": "2025-01-15T10:00:00Z"
    }
  ]
}
```

- Read /var/lib/firecracker/templates/ directory
- Return metadata for each .ext4 file

#### 3.2 Template Deletion (for cleanup)
```
DELETE /templates/:name

Response: 204 No Content

Errors:
- 404 Not Found: Template doesn't exist
- 403 Forbidden: Cannot delete protected template
- 409 Conflict: Template in use by running VM(s)
```

**Implementation:**
```typescript
async function deleteTemplate(name: string): Promise<void> {
  const templatePath = `${config.dataDir}/templates/${name}.ext4`;

  // Check template exists
  if (!await Bun.file(templatePath).exists()) {
    throw new NotFoundError(`Template '${name}' not found`);
  }

  // Check if protected (defined in config.ts)
  if (config.protectedTemplates.includes(name)) {
    throw new ForbiddenError(`Cannot delete protected template '${name}'`);
  }

  // Check no running VMs use this template
  const vmsUsingTemplate = Array.from(vms.values()).filter(vm => vm.template === name);
  if (vmsUsingTemplate.length > 0) {
    throw new ConflictError(`Template '${name}' is in use by ${vmsUsingTemplate.length} VM(s)`);
  }

  // Delete the file
  await unlink(templatePath);
}
```

### Verification
- GET /templates returns debian-base
- DELETE /templates/debian-base returns 403
- DELETE /templates/nonexistent returns 404
- Integration test template listing passes

### Done Criteria
- [ ] GET /templates working
- [ ] DELETE /templates/:name working (except debian-base)
- [ ] Integration test passes template checks
- [ ] Committed

---

## Phase 4: VM Creation & Lifecycle

### Goal
Implement VM creation, listing, and deletion.

### Steps

#### 4.1 VM Data Structures
```typescript
interface VM {
  id: string;           // "vm-" + random hex
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
```

#### 4.2 IP Allocation
- Pool: 172.16.0.2 - 172.16.255.254
- Track allocated IPs in memory
- On startup: scan running VMs to rebuild allocation state

#### 4.3 Port Allocation (Hash-based with Collision Detection)
```typescript
const PORT_MIN = 22001;
const PORT_MAX = 32000;

function vmIdToPort(vmId: string): number {
  const hash = createHash('sha256').update(vmId).digest();
  const num = hash.readUInt32BE(0);
  return PORT_MIN + (num % (PORT_MAX - PORT_MIN + 1));
}

// Collision-safe allocation: if hash collides, linear probe to next free port
function allocatePort(vmId: string, usedPorts: Set<number>): number {
  let port = vmIdToPort(vmId);
  const startPort = port;

  while (usedPorts.has(port)) {
    port = port + 1 > PORT_MAX ? PORT_MIN : port + 1;
    if (port === startPort) {
      throw new Error('No available ports');
    }
  }

  usedPorts.add(port);
  return port;
}
```

Note: `usedPorts` is derived from in-memory VM state, rebuilt on startup.

#### 4.4 VM Creation
```
POST /vms
{
  "template": "debian-base",
  "name": "my-vm",
  "ssh_public_key": "ssh-ed25519 AAAA..."
}

Response: 201 Created
{
  "id": "vm-a1b2c3d4",
  "name": "my-vm",
  "template": "debian-base",
  "ip": "172.16.0.2",
  "ssh_port": 22547,
  "ssh": "ssh -p 22547 root@<host>",
  "status": "running",
  "created_at": "2025-01-15T10:30:00Z"
}
```

**MAC Address Generation:**
```typescript
// Generate unique MAC from VM ID: AA:FC:xx:xx:xx:xx
function vmIdToMac(vmId: string): string {
  const hash = createHash('sha256').update(vmId).digest();
  return `AA:FC:${hash.subarray(0, 4).toString('hex').match(/.{2}/g)!.join(':')}`;
}
// Example: vm-abc123 → AA:FC:3a:f2:91:c7
```

**Steps:**
1. Validate template exists
2. Allocate IP from pool
3. Generate VM ID
4. Calculate SSH port from ID (with collision detection)
5. Generate MAC address from ID
6. Copy template rootfs with reflink: `cp --reflink=auto`
7. Mount rootfs, inject SSH public key into /root/.ssh/authorized_keys, unmount
8. Create TAP device, attach to bridge
9. Start Firecracker process with Unix socket
10. Configure VM via Firecracker API (kernel, rootfs, network with MAC, machine config)
11. Start VM instance
12. Start TCP proxy for SSH port
13. Return VM details

#### 4.5 VM Listing
```
GET /vms

Response:
{
  "vms": [
    { "id": "vm-a1b2c3d4", "name": "my-vm", "ip": "172.16.0.2", ... }
  ]
}
```

#### 4.6 VM Details
```
GET /vms/:id

Response:
{ "id": "vm-a1b2c3d4", ... }
```

#### 4.7 VM Deletion
```
DELETE /vms/:id

Response: 204 No Content
```

**Steps:**
1. Stop TCP proxy for this VM
2. Send InstanceHalt to Firecracker API (or kill process)
3. Remove TAP device
4. Delete rootfs file
5. Release IP back to pool
6. Remove from in-memory state

### Verification
- Create VM returns valid response
- VM appears in GET /vms
- Firecracker process is running
- TAP device exists
- VM has IP connectivity (ping from host)
- Delete removes everything cleanly

### Done Criteria
- [ ] POST /vms creates working VM
- [ ] GET /vms lists VMs
- [ ] GET /vms/:id returns VM details
- [ ] DELETE /vms/:id cleans up completely
- [ ] Integration test: create/list/delete cycle passes
- [ ] Committed

---

## Phase 5: TCP Proxy for SSH

### Goal
Implement TCP proxy so external clients can SSH to VMs via allocated ports.

### Steps

#### 5.1 TCP Proxy Implementation
```typescript
// src/proxy.ts
import * as net from 'net';

const proxies = new Map<string, net.Server>();
const connections = new Map<string, Set<net.Socket>>();

export function startProxy(vmId: string, localPort: number, targetIp: string, targetPort: number) {
  const sockets = new Set<net.Socket>();
  connections.set(vmId, sockets);

  const server = net.createServer((clientSocket) => {
    const vmSocket = net.createConnection(targetPort, targetIp);

    // Track both sockets for cleanup
    sockets.add(clientSocket);
    sockets.add(vmSocket);

    clientSocket.pipe(vmSocket);
    vmSocket.pipe(clientSocket);

    const cleanup = () => {
      sockets.delete(clientSocket);
      sockets.delete(vmSocket);
      clientSocket.destroy();
      vmSocket.destroy();
    };

    clientSocket.on('error', cleanup);
    clientSocket.on('close', cleanup);
    vmSocket.on('error', cleanup);
    vmSocket.on('close', cleanup);
  });

  server.listen(localPort, '0.0.0.0');
  proxies.set(vmId, server);
}

export function stopProxy(vmId: string) {
  // First: destroy all active connections (prevents zombie sessions)
  const sockets = connections.get(vmId);
  if (sockets) {
    for (const socket of sockets) {
      socket.destroy();
    }
    connections.delete(vmId);
  }

  // Then: close the server (stops accepting new connections)
  const server = proxies.get(vmId);
  if (server) {
    server.close();
    proxies.delete(vmId);
  }
}
```

**Why track connections:** `server.close()` only stops accepting new connections. Existing SSH sessions would become zombies, leaking file descriptors. By tracking sockets, we ensure clean termination when a VM is deleted.

#### 5.2 Integrate with VM Lifecycle
- Start proxy when VM is created
- Stop proxy when VM is deleted

### Verification
- SSH to host:port connects to VM
- Multiple concurrent SSH sessions work
- Proxy cleans up on VM deletion

### Done Criteria
- [ ] TCP proxy starts on VM creation
- [ ] SSH through proxy works
- [ ] Proxy stops on VM deletion
- [ ] Integration test: SSH into VM passes
- [ ] Committed

---

## Phase 6: VM Snapshots

### Goal
Implement snapshotting a VM's rootfs to create a new template.

### Steps

#### 6.1 Snapshot Endpoint
```
POST /vms/:id/snapshot
{
  "template_name": "my-snapshot"
}

Response: 201 Created
{
  "template": "my-snapshot",
  "source_vm": "vm-a1b2c3d4",
  "size_bytes": 2147483648,
  "created_at": "2025-01-15T11:00:00Z"
}
```

**Steps:**
1. Validate VM exists
2. Validate template_name (alphanumeric, hyphens, underscores only - prevent path traversal)
3. Validate template_name doesn't already exist
4. **Pause VM** via Firecracker API to ensure filesystem consistency
5. Copy rootfs to templates directory with reflink
6. **Resume VM** via Firecracker API
7. Clear SSH authorized_keys in the template copy (so next VM gets fresh injection)
8. Return template metadata

**Template Name Validation (prevent path traversal):**
```typescript
if (!/^[a-zA-Z0-9_-]+$/.test(templateName)) {
  throw new Error('Invalid template name: only alphanumeric, hyphens, underscores allowed');
}
```

#### 6.2 Full Snapshot Implementation
```typescript
async function snapshotVm(vm: VM, templateName: string): Promise<Template> {
  const templatePath = `${config.dataDir}/templates/${templateName}.ext4`;
  const mountPoint = `/mnt/template-${templateName}`;

  // Validate template name
  if (!/^[a-zA-Z0-9_-]+$/.test(templateName)) {
    throw new BadRequestError('Invalid template name');
  }

  // Check template doesn't already exist
  if (await Bun.file(templatePath).exists()) {
    throw new ConflictError(`Template '${templateName}' already exists`);
  }

  // Pause VM for consistent snapshot
  await pauseVm(vm);

  try {
    // Copy rootfs with reflink (instant COW copy)
    await $`cp --reflink=auto ${vm.rootfsPath} ${templatePath}`;
  } finally {
    // Always resume VM, even if copy fails
    await resumeVm(vm);
  }

  // Clear SSH keys from template (not the running VM)
  try {
    await $`mkdir -p ${mountPoint}`;
    await $`mount ${templatePath} ${mountPoint}`;
    await $`truncate -s 0 ${mountPoint}/root/.ssh/authorized_keys`;
  } finally {
    // Always unmount and cleanup, even on error
    await $`umount ${mountPoint} 2>/dev/null || true`;
    await $`rmdir ${mountPoint} 2>/dev/null || true`;
  }

  const stats = await Bun.file(templatePath).stat();
  return {
    name: templateName,
    size_bytes: stats.size,
    created_at: new Date().toISOString(),
  };
}

async function pauseVm(vm: VM): Promise<void> {
  await fetch('http://localhost/vm', {
    method: 'PATCH',
    // @ts-ignore - Bun supports socketPath
    unix: vm.socketPath,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'Paused' }),
  });
}

async function resumeVm(vm: VM): Promise<void> {
  await fetch('http://localhost/vm', {
    method: 'PATCH',
    // @ts-ignore - Bun supports socketPath
    unix: vm.socketPath,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'Resumed' }),
  });
}
```

**Key points:**
- Uses `try/finally` to ensure VM is always resumed, even if copy fails
- Uses unique mount point per template to avoid collisions
- Clears SSH keys so new VMs get fresh key injection
- Total VM pause time ~100ms (reflink copy is instant)

### Verification
- Snapshot creates new template file
- New template appears in GET /templates
- New VMs can be created from snapshot

### Done Criteria
- [ ] POST /vms/:id/snapshot creates template
- [ ] Template appears in listing
- [ ] VM can be created from snapshot
- [ ] Integration test: snapshot workflow passes
- [ ] Committed

---

## Phase 7: Full Integration Test

### Goal
Complete the integration test to verify the full workflow.

### Test Helpers

#### API Client with Authentication
```typescript
// test/helpers.ts
const API_URL = `http://${process.env.VM_HOST}:8080`;
const API_TOKEN = process.env.API_TOKEN || 'dev-token';

export const api = {
  async get(path: string) {
    const res = await fetch(`${API_URL}${path}`, {
      headers: { 'Authorization': `Bearer ${API_TOKEN}` }
    });
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
    return res.json();
  },

  async post(path: string, body: unknown) {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`POST ${path}: ${res.status}`);
    return res.json();
  },

  async delete(path: string) {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${API_TOKEN}` }
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`DELETE ${path}: ${res.status}`);
    }
  }
};
```

#### VM Readiness Helper
```typescript
// Wait for VM's SSH to become available
async function waitForVm(ip: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await $`nc -z ${ip} 22`.quiet();
      return;
    } catch {
      await Bun.sleep(500);
    }
  }
  throw new Error(`VM ${ip} did not become ready within ${timeoutMs}ms`);
}
```

### Test Flow
```typescript
test('full workflow', async () => {
  // 1. Health check
  const health = await api.get('/health');
  expect(health.status).toBe(200);

  // 2. List templates, verify debian-base exists
  const templates = await api.get('/templates');
  expect(templates.templates).toContainEqual(
    expect.objectContaining({ name: 'debian-base' })
  );

  // 3. Create VM from debian-base
  const vm1 = await api.post('/vms', {
    template: 'debian-base',
    name: 'test-vm-1',
    ssh_public_key: TEST_PUBLIC_KEY
  });
  expect(vm1.id).toBeDefined();
  expect(vm1.ssh_port).toBeGreaterThan(22000);

  // 4. Wait for VM to boot (poll or fixed delay)
  await waitForVm(vm1.ip);

  // 5. SSH into VM, create marker file
  await sshExec(vm1.ssh_port, 'echo "test-marker" > /root/marker.txt');

  // 6. Verify marker file
  const marker1 = await sshExec(vm1.ssh_port, 'cat /root/marker.txt');
  expect(marker1.trim()).toBe('test-marker');

  // 7. Snapshot VM to new template
  const snapshot = await api.post(`/vms/${vm1.id}/snapshot`, {
    template_name: 'test-snapshot'
  });
  expect(snapshot.template).toBe('test-snapshot');

  // 8. Delete original VM
  await api.delete(`/vms/${vm1.id}`);

  // 9. Verify VM is gone
  const vms = await api.get('/vms');
  expect(vms.vms.find(v => v.id === vm1.id)).toBeUndefined();

  // 10. Create new VM from snapshot
  const vm2 = await api.post('/vms', {
    template: 'test-snapshot',
    name: 'test-vm-2',
    ssh_public_key: TEST_PUBLIC_KEY
  });

  // 11. Wait for boot
  await waitForVm(vm2.ip);

  // 12. Verify marker file persisted
  const marker2 = await sshExec(vm2.ssh_port, 'cat /root/marker.txt');
  expect(marker2.trim()).toBe('test-marker');

  // 13. Cleanup
  await api.delete(`/vms/${vm2.id}`);
  await api.delete('/templates/test-snapshot');

  // 14. Verify cleanup
  const finalVms = await api.get('/vms');
  expect(finalVms.vms).toHaveLength(0);
});
```

### SSH Helper for Tests
```typescript
import { $ } from 'bun';

const TEST_KEY_PATH = process.env.TEST_SSH_KEY || './test/id_ed25519';

/**
 * Execute a command on a VM via SSH.
 *
 * LIMITATION: Use only for simple, single commands. The command is passed
 * directly to the remote shell, so complex commands with quotes or special
 * characters may not work as expected. For test purposes, keep commands simple:
 *   - OK: 'cat /root/marker.txt'
 *   - OK: 'echo test > /root/file.txt'
 *   - AVOID: 'echo "hello world"' (nested quotes)
 */
async function sshExec(port: number, command: string): Promise<string> {
  const host = process.env.VM_HOST;
  const result = await $`ssh -p ${port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${TEST_KEY_PATH} root@${host} ${command}`.text();
  return result;
}
```

### Verification
- Full test passes end-to-end
- `./do check` passes completely

### Done Criteria
- [ ] Integration test runs full workflow
- [ ] All assertions pass
- [ ] `./do check` exits 0
- [ ] Committed

---

## Phase 8: Polish & Hardening

### Goal
Production-readiness improvements.

### Steps

#### 8.1 Error Handling
- Proper HTTP error responses (400, 404, 500)
- Cleanup on partial failures (e.g., VM creation fails midway)
- Graceful shutdown (stop all VMs, proxies)

#### 8.2 Logging
- Request logging
- VM lifecycle events
- Error logging with context

#### 8.3 Process Management
- Handle Firecracker process crashes
- Recover state on API restart
- systemd service file for production

#### 8.4 Configuration
- Environment variables for all settings
- API_TOKEN, API_PORT, DATA_DIR, etc.

#### 8.5 Single Binary Build
```bash
bun build --compile --outfile=firecracker-api ./src/index.ts
```

### Verification
- Service recovers from restart
- Errors return proper HTTP codes
- Logs are useful for debugging

### Done Criteria
- [ ] Error handling comprehensive
- [ ] Logging in place
- [ ] State recovery on restart
- [ ] Single binary builds
- [ ] systemd service file created
- [ ] Committed

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
Request: { "template": string, "name"?: string, "ssh_public_key": string }
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
│   └── helpers.ts
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
API_TOKEN=<bearer-token>           # API authentication

# Required for integration tests
VM_HOST=<ip-of-target-machine>     # Host running the API
API_TOKEN=<bearer-token>           # Must match server token
TEST_SSH_KEY=./test/id_ed25519     # Path to SSH private key for test VMs

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
curl -H "Authorization: Bearer dev-token" http://localhost:8080/health
```
