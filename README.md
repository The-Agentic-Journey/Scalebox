# Scalebox

**Instant sandbox VMs for AI agents.**

Spin up isolated sandboxes from snapshots. Perfect for AI agents, CI runners, and dev environments.

## Install

```bash
curl -sSL https://raw.githubusercontent.com/The-Agentic-Journey/Scalebox/main/scripts/bootstrap.sh | sudo bash
```

The installer prompts for configuration and handles everything: Firecracker, networking, storage, and a base Debian template.

**Requirements:** Debian/Ubuntu with KVM support.

## CLI Installation (for clients)

Install the `sb` CLI on your Mac or Linux machine:

```bash
curl -fsSL https://raw.githubusercontent.com/The-Agentic-Journey/Scalebox/main/scripts/install-sb.sh | bash
```

Then configure it:

```bash
sb login https://your-server.example.com
# Paste your API token when prompted
```

The CLI installs to `~/.local/bin` and requires no root access.

## Quick Start

```bash
# Create a VM (boots in ~1 second)
scalebox vm create -t debian-base -k "$(cat ~/.ssh/id_rsa.pub)"
# → {"id": "vm-a1b2c3", "name": "happy-red-panda", "ssh_port": 22001, ...}

# SSH into it
ssh -p 22001 root@your-server

# Or access via HTTPS (if VM_DOMAIN configured)
curl https://happy-red-panda.vms.example.com

# Snapshot it as a new template
scalebox vm snapshot vm-a1b2c3 -n my-configured-app

# Spin up 10 identical VMs from that snapshot
for i in {1..10}; do
  scalebox vm create -t my-configured-app -k "$(cat ~/.ssh/id_rsa.pub)"
done

# Clean up
scalebox vm delete vm-a1b2c3
```

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                       Host Server                           │
│                                                             │
│  :443 ───── Caddy ───── HTTPS for API + VMs                 │
│  :8080 ──── scaleboxd ─ REST API                            │
│  :22xxx ─── TCP Proxy ─ SSH to VMs                          │
│                                                             │
│  br0 (172.16.0.1/16)                                        │
│    ├── tap0 ── VM 1 (172.16.0.2) ── happy-red-panda         │
│    ├── tap1 ── VM 2 (172.16.0.3) ── silly-blue-fox          │
│    └── tap2 ── VM 3 (172.16.0.4) ── quick-green-owl         │
│                                                             │
│  /var/lib/scalebox/                                         │
│    ├── templates/  ─ Golden images (btrfs, instant clone)   │
│    └── vms/        ─ Running VM disks                       │
└─────────────────────────────────────────────────────────────┘
```

VMs boot from copy-on-write clones of templates. Creating a VM = clone template + inject SSH key + start Firecracker. Takes ~1 second.

## Configuration

### Domains (optional)

| Variable | Purpose | Example |
|----------|---------|---------|
| `API_DOMAIN` | HTTPS for the Scalebox API | `scalebox.example.com` |
| `VM_DOMAIN` | HTTPS for VMs (wildcard DNS required) | `vms.example.com` |

Without domains, the API runs on `http://server:8080` and VMs are SSH-only.

### Config Files

The installer creates these automatically:

**Daemon config** (`/etc/scaleboxd/config`):
```bash
API_PORT=8080
API_TOKEN=sb-xxx...  # Auto-generated, shown after install
DATA_DIR=/var/lib/scalebox
VM_DOMAIN=vms.example.com
```

**CLI config** (`~/.config/scalebox/config` or `/etc/scalebox/config`):
```bash
SCALEBOX_URL=https://scalebox.example.com
SCALEBOX_TOKEN=sb-xxx...
```

The CLI searches: env vars → `~/.config/scalebox/config` → `/etc/scalebox/config`

## CLI Reference

```bash
scalebox status                        # Health check
scalebox vm list                       # List all VMs
scalebox vm create -t TPL -k "KEY"     # Create VM from template
scalebox vm get <id>                   # Get VM details
scalebox vm delete <id>                # Delete VM
scalebox vm snapshot <id> -n NAME      # Snapshot VM to template
scalebox template list                 # List templates
scalebox template delete <name>        # Delete template
```

## REST API

All endpoints except `/health` require `Authorization: Bearer <token>`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/templates` | List templates |
| DELETE | `/templates/:name` | Delete template |
| GET | `/vms` | List VMs |
| POST | `/vms` | Create VM |
| GET | `/vms/:id` | Get VM details |
| DELETE | `/vms/:id` | Delete VM |
| POST | `/vms/:id/snapshot` | Snapshot to template |

### Example: Create VM

```bash
curl -X POST https://scalebox.example.com/vms \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"template": "debian-base", "ssh_public_key": "ssh-rsa AAAA..."}'
```

## Development

```bash
./do lint      # Lint
./do build     # Build binary
./do check     # Full CI: lint, build, test on GCE
```

## License

See LICENSE file.
