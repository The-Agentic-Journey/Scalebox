# Scalebox

A REST API service for managing Firecracker microVMs with self-contained provisioning, automatic HTTPS, and friendly VM names.

## Vision

Scalebox provides a simple HTTP API to create, manage, and snapshot Firecracker microVMs. Each VM gets a unique three-word name (e.g., "very-silly-penguin") and is automatically exposed via HTTPS at `https://{name}.{domain}`. The project emphasizes:

- **Fast VM creation** via btrfs copy-on-write templates
- **Zero-config networking** with automatic bridge setup and NAT
- **Automatic HTTPS** via Caddy reverse proxy with Let's Encrypt
- **Simple deployment** via a single installer script

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │            Host Server              │
                    │                                     │
  Internet ─────────┤ eth0 (public IP)                    │
                    │   │                                 │
                    │   ├─ :443 ─── Caddy (HTTPS proxy)   │
                    │   │             *.domain → VM:8080  │
                    │   │                                 │
                    │   ├─ :8080 ── REST API (scaleboxd)  │
                    │   │                                 │
                    │   └─ :22xxx ─ TCP Proxy (SSH)       │
                    │             :22001 → 172.16.0.2:22  │
                    │             :22002 → 172.16.0.3:22  │
                    │                                     │
                    │ br0 (172.16.0.1/16)                 │
                    │   ├── tap0 ── VM 1 (172.16.0.2)     │
                    │   └── tap1 ── VM 2 (172.16.0.3)     │
                    │                                     │
                    │ /var/lib/scalebox/                  │
                    │   ├── templates/   (btrfs)          │
                    │   ├── vms/         (btrfs)          │
                    │   └── kernel/                       │
                    └─────────────────────────────────────┘
```

## Components

| Component | Description |
|-----------|-------------|
| **scaleboxd** | HTTP API server (compiled Bun binary) - manages VMs, templates, and networking |
| **scalebox** | CLI tool (bash script) - interacts with the API via curl |
| **Caddy** | Reverse proxy for automatic HTTPS with Let's Encrypt |
| **Firecracker** | MicroVM hypervisor providing fast, secure VM isolation |

### Source Structure

```
src/
├── index.ts              # HTTP API routes (Hono framework)
├── config.ts             # Environment configuration
├── types.ts              # TypeScript type definitions
└── services/
    ├── vm.ts             # VM lifecycle management
    ├── firecracker.ts    # Firecracker process control
    ├── template.ts       # Template listing/deletion
    ├── storage.ts        # btrfs COW operations
    ├── network.ts        # Bridge/TAP/NAT setup
    ├── proxy.ts          # TCP proxy for SSH access
    ├── caddy.ts          # Caddy configuration updates
    ├── nameGenerator.ts  # Three-word unique name generation
    └── wordlists.ts      # Word lists for name generation
```

## Installation

### Prerequisites

- Debian/Ubuntu host with KVM support (nested virtualization or bare metal)
- Root access
- btrfs filesystem for `/var/lib/scalebox` (for COW efficiency)

### Quick Install

```bash
# Download latest release
curl -L https://github.com/OWNER/scalebox/releases/latest/download/scalebox-build-LATEST.tar.gz -o scalebox.tar.gz
tar xzf scalebox.tar.gz
sudo ./install.sh
```

Or download a specific version from the [Releases page](https://github.com/OWNER/scalebox/releases).

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `8080` | Port for the REST API |
| `API_TOKEN` | (required) | Bearer token for authentication |
| `BASE_DOMAIN` | (optional) | Domain for VM subdomains (e.g., `vms.example.com`) |
| `DATA_DIR` | `/var/lib/scalebox` | Storage location for VMs and templates |

## Usage

### CLI

```bash
# List VMs
scalebox list

# Create a VM from template
scalebox create debian-base

# Delete a VM
scalebox delete <vm-id>

# Create a snapshot/template
scalebox snapshot <vm-id> my-template
```

### REST API

All endpoints (except `/health` and `/caddy/check`) require bearer token authentication.

```bash
# Health check
curl http://localhost:8080/health

# List templates
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/templates

# Create VM
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"template": "debian-base"}' \
  http://localhost:8080/vms

# List VMs
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/vms

# Delete VM
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/vms/<id>

# Snapshot VM to template
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"template_name": "my-snapshot"}' \
  http://localhost:8080/vms/<id>/snapshot
```

### VM Access

Each VM is accessible via:

1. **SSH** through TCP proxy: `ssh -p 22001 user@host`
2. **HTTPS** (if `BASE_DOMAIN` configured): `https://very-silly-penguin.vms.example.com`

## Development

### Prerequisites

- [Bun](https://bun.sh) runtime
- Access to a host with KVM/Firecracker

### Commands

```bash
# Run linter
./do lint

# Run tests
./do test

# Build binaries
./do build

# Deploy to remote host
./do deploy
```

### Development Workflow

Code is developed locally and deployed to a remote VM with KVM support for testing:

1. Write code locally
2. Deploy via `./do deploy`
3. Run tests via `./do test`
4. Tests hit the remote API with real Firecracker VMs

## License

See LICENSE file for details.
