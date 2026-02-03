# Scalebox

Firecracker microVM management with a simple REST API. Create VMs in seconds, access them via SSH or HTTPS.

## One-Line Install

```bash
curl -sSL https://raw.githubusercontent.com/The-Agentic-Journey/Scalebox/main/scripts/bootstrap.sh | sudo bash
```

The installer will:
- Prompt for your domain configuration
- Install all dependencies (Firecracker, Caddy, etc.)
- Set up networking and storage
- Create a base Debian template
- Start the API server
- Display your API token

**Requirements:** Debian/Ubuntu server with KVM support (bare metal or nested virtualization enabled).

## Quick Start

After installation, create your first VM:

```bash
# Create a VM with your SSH key
scalebox vm create -t debian-base -k "$(cat ~/.ssh/id_rsa.pub)"

# Output:
# {
#   "id": "vm-a1b2c3d4e5f6",
#   "name": "happy-red-panda",
#   "ip": "172.16.0.2",
#   "ssh_port": 22001,
#   ...
# }

# SSH into the VM
ssh -p 22001 root@your-server

# List all VMs
scalebox vm list

# Delete the VM
scalebox vm delete vm-a1b2c3d4e5f6
```

## What is Scalebox?

Scalebox provides a REST API to create, manage, and snapshot Firecracker microVMs. Each VM:
- Boots in ~1 second from copy-on-write templates
- Gets a unique three-word name (e.g., `happy-red-panda`)
- Is accessible via SSH through a proxy port
- Can optionally be exposed via HTTPS at `https://{name}.{domain}`

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

## Configuration

The installer prompts for two optional domain settings:

| Setting | Purpose | Example |
|---------|---------|---------|
| `DOMAIN` | HTTPS access to the API itself | `api.scalebox.example.com` |
| `BASE_DOMAIN` | HTTPS access to VMs via subdomains | `vms.example.com` |

**Without domains:** API is available at `http://server-ip:8080`, VMs via SSH only.

**With DOMAIN:** API gets automatic HTTPS via Let's Encrypt.

**With BASE_DOMAIN:** Each VM is accessible at `https://{vm-name}.{base-domain}` (port 8080 inside VM).

### Configuration File

Settings are stored in `/etc/scalebox/config`:

```bash
API_PORT=8080
API_TOKEN=sb-...  # Auto-generated, save this!
DATA_DIR=/var/lib/scalebox
BASE_DOMAIN=vms.example.com
```

## CLI Reference

```bash
scalebox status                           # Health check
scalebox vm list                          # List all VMs
scalebox vm create -t TPL -k "KEY"        # Create VM from template
scalebox vm get <id>                      # Get VM details
scalebox vm delete <id>                   # Delete VM
scalebox vm snapshot <id> -n NAME         # Snapshot VM to new template
scalebox template list                    # List templates
scalebox template delete <name>           # Delete template (not protected ones)
```

**Environment variables:**
- `SCALEBOX_URL` - API URL (default: `http://localhost:8080`)
- `SCALEBOX_TOKEN` - API token (auto-reads from `/etc/scalebox/config`)

## REST API

All endpoints except `/health` require `Authorization: Bearer <token>` header.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check (no auth) |
| GET | `/templates` | List templates |
| DELETE | `/templates/:name` | Delete template |
| GET | `/vms` | List VMs |
| POST | `/vms` | Create VM |
| GET | `/vms/:id` | Get VM details |
| DELETE | `/vms/:id` | Delete VM |
| POST | `/vms/:id/snapshot` | Snapshot VM to template |

### Create VM

```bash
curl -X POST https://api.example.com/vms \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "template": "debian-base",
    "ssh_public_key": "ssh-rsa AAAA..."
  }'
```

### Snapshot VM

```bash
curl -X POST https://api.example.com/vms/vm-abc123/snapshot \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"template_name": "my-configured-app"}'
```

## Development

### Prerequisites

- [Bun](https://bun.sh) runtime
- Access to a host with KVM support

### Commands

```bash
./do lint      # Run linter
./do build     # Build binary
./do test      # Run tests (requires VM_HOST, API_TOKEN)
./do check     # Full CI: lint, build, deploy to GCE, test
```

### Source Structure

```
src/
├── index.ts              # HTTP routes (Hono framework)
├── config.ts             # Environment configuration
├── types.ts              # TypeScript types
└── services/
    ├── vm.ts             # VM lifecycle (core domain)
    ├── template.ts       # Template management
    ├── firecracker.ts    # Firecracker process control
    ├── storage.ts        # Rootfs operations
    ├── network.ts        # Bridge/TAP/IP allocation
    ├── proxy.ts          # TCP proxy for SSH
    └── caddy.ts          # HTTPS gateway config
```

## License

See LICENSE file for details.
