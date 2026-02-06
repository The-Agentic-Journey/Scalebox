# CLI Context

**Classification:** External Client
**Source:** `scripts/sb`

---

## Purpose

The CLI (`sb`) provides user-friendly access to the Scalebox API from developer machines. It is not installed on the server - it runs on user laptops/desktops and communicates with Scalebox over HTTPS.

---

## Client-Side State

The CLI maintains local state in `~/.config/scalebox/`:

| File | Purpose | Created |
|------|---------|---------|
| `config` | Host URL and API token | On `sb login` |
| `id_ed25519` | Private SSH key (mode 600) | On first `sb vm create` |
| `id_ed25519.pub` | Public SSH key | On first `sb vm create` |

---

## Domain Concepts

### Managed SSH Key

An ed25519 key pair automatically generated and stored for seamless VM access.

**Lifecycle:**
1. Generated on first `sb vm create` (if no `-k` flag provided)
2. Public key injected into VM's `authorized_keys`
3. Private key used automatically by `sb connect`

**Limitation:** Per-machine. VMs created from one machine are not accessible from another unless keys are synced or explicit keys are used.

### Connection Command

Abstracts mosh/SSH connection details:
- Uses managed SSH key automatically
- Retrieves port from API
- Falls back to SSH if mosh unavailable
- Handles host key verification for ephemeral VMs

---

## Key Operations

### Login

Stores API credentials for subsequent commands:
```bash
sb login
# Prompts for host URL and token
# Saves to ~/.config/scalebox/config
```

### VM Creation

Creates VM using managed key by default:
```bash
sb vm create -t debian-base
# 1. Ensures SSH key exists (generates if needed)
# 2. Sends public key to API
# 3. Returns VM details including SSH port
```

### Connect

Connects to VM via mosh (with SSH fallback):
```bash
sb connect my-vm
# 1. Fetches VM details from API
# 2. Uses managed SSH key
# 3. Connects via mosh --port={ssh_port}
# 4. Falls back to SSH if mosh unavailable
```

---

## Host Key Handling

VMs are ephemeral, so host key checking is adjusted:
- `StrictHostKeyChecking=accept-new` - Accept new keys, warn on changes
- `UserKnownHostsFile=/dev/null` - Don't store ephemeral VM keys in known_hosts

This prevents conflicts when a new VM gets the same port as a previously deleted VM.

---

## Relationships

| Context | Relationship | Description |
|---------|--------------|-------------|
| API | Upstream | CLI consumes REST API |
| Access | Indirect | CLI uses TCP/UDP proxies via allocated ports |

The CLI has no special access - it uses the same API endpoints as any authenticated client.

---

## Multi-Machine Limitation

The managed SSH key is per-machine. If you use `sb` from multiple machines (laptop + desktop), each generates its own key. VMs are only accessible from the machine that created them.

**Workarounds:**
- Sync `~/.config/scalebox/id_ed25519*` between machines manually
- Use `-k @path/to/shared/key.pub` when creating VMs to use a shared key
- Use `-i path/to/key` when connecting from a different machine

This is acceptable because VMs are short-lived. For long-lived VMs needing multi-machine access, use explicit shared keys.

---

## Code Location

| Component | File |
|-----------|------|
| CLI script | `scripts/sb` |
| SSH key management | `scripts/sb` (ensure_ssh_key, get_ssh_pubkey, get_ssh_keyfile) |
| Connect command | `scripts/sb` (cmd_connect) |
| Host extraction | `scripts/sb` (get_ssh_host) |
