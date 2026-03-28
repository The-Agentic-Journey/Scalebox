# Scalebox

**Instant sandbox VMs for AI agents.**

Spin up isolated sandboxes from snapshots. Perfect for AI agents, CI runners, and dev environments.

## Install

```bash
curl -sSL https://raw.githubusercontent.com/The-Agentic-Journey/Scalebox/main/scripts/bootstrap.sh | sudo bash
```

The installer prompts for your domain and server IP, then handles everything: Firecracker, networking, storage, DNS, TLS, and a base Debian template.

Or install non-interactively:

```bash
curl -sSL https://raw.githubusercontent.com/The-Agentic-Journey/Scalebox/main/scripts/bootstrap.sh \
  | sudo BASE_DOMAIN=scalebox.example.com HOST_IP=203.0.113.42 bash
```

**Requirements:** Debian/Ubuntu with KVM support. Port 53 and 443 open for DNS and HTTPS.

## CLI Installation (for clients)

Install the `sb` CLI on your Mac or Linux machine:

```bash
curl -fsSL https://raw.githubusercontent.com/The-Agentic-Journey/Scalebox/main/scripts/install-sb.sh | bash
```

Then configure it:

```bash
sb login https://api.scalebox.example.com
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

# Or access via HTTPS
curl https://happy-red-panda.vm.scalebox.example.com

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
│  :53 ────── DNS Server ─ Authoritative for BASE_DOMAIN      │
│  :443 ───── Caddy ────── HTTPS for API + VMs                │
│  :8080 ──── scaleboxd ── REST API                           │
│  :22xxx ─── TCP Proxy ── SSH to VMs                         │
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

### Domain and DNS Setup

Scalebox includes a built-in authoritative DNS server. When you configure a `BASE_DOMAIN`, Scalebox handles all DNS resolution and TLS certificate issuance automatically using a single wildcard certificate via DNS-01 challenges.

The installer prompts for two values:

| Setting | Purpose | Example |
|---------|---------|---------|
| `BASE_DOMAIN` | Root domain for HTTPS access | `scalebox.example.com` |
| `HOST_IP` | Public IP of the server | `203.0.113.42` |

This gives you:
- **API**: `https://api.scalebox.example.com`
- **VMs**: `https://{vm-name}.vm.scalebox.example.com`

Without a domain, the API runs on `http://server:8080` and VMs are SSH-only.

#### DNS Record

You need **one NS record** at your DNS provider to delegate your base domain to the Scalebox server:

```
scalebox.example.com.     IN  NS  ns.scalebox.example.com.
ns.scalebox.example.com.  IN  A   203.0.113.42
```

This tells the internet "ask `203.0.113.42` for any DNS queries about `*.scalebox.example.com`." Scalebox's DNS server then:
- Resolves all subdomains (`api.*`, `*.vm.*`) to your server IP
- Answers ACME challenge queries so Caddy can obtain wildcard TLS certificates from Let's Encrypt

#### Firewall

Port **53** (UDP + TCP) must be open — Let's Encrypt queries it during certificate validation. Port **443** must also be open for HTTPS.

### TLS Options

| Variable | Purpose | Default |
|----------|---------|---------|
| `ACME_STAGING` | Use Let's Encrypt staging environment | `false` |

Set `ACME_STAGING=true` to use Let's Encrypt's staging servers for certificate issuance. This is useful for testing and CI environments since staging has no rate limits. **Note:** Staging certificates are not browser-trusted and will show security warnings.

### Config Files

The installer creates these automatically:

**Daemon config** (`/etc/scaleboxd/config`):
```bash
API_PORT=8080
API_TOKEN=sb-xxx...       # Auto-generated, shown after install
DATA_DIR=/var/lib/scalebox
BASE_DOMAIN=scalebox.example.com
HOST_IP=203.0.113.42
ACME_PROXY_PASSWORD=xxx   # Internal, auto-generated
ACME_STAGING=false
```

**CLI config** (`~/.config/scalebox/config` or `/etc/scalebox/config`):
```bash
SCALEBOX_URL=https://api.scalebox.example.com
SCALEBOX_TOKEN=sb-xxx...
```

The CLI searches: env vars → `~/.config/scalebox/config` → `/etc/scalebox/config`

## Template Management

### Rebuilding the Base Template

After certain updates, the `debian-base` template may need to be rebuilt to include new packages. The `scalebox-update` command will notify you when this is needed:

```
==> Template update available
    Current: v1, Required: v2
    Run: scalebox-rebuild-template
```

To rebuild the template:

```bash
sudo scalebox-rebuild-template
```

This recreates the `debian-base` template with the latest packages (takes 2-3 minutes).

**Running VMs are not affected** - they continue using their existing rootfs copies due to btrfs copy-on-write. Only new VMs created after the rebuild will use the updated template.

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
curl -X POST https://api.scalebox.example.com/vms \
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
