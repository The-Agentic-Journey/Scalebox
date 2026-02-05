# Connect Command with Mosh and Managed SSH Keys

## Overview

Add a `connect` command to the `sb` CLI that connects to VMs via mosh. This includes:

1. **UDP proxy** - Forward mosh traffic to VMs via iptables NAT
2. **Managed SSH key** - CLI generates and uses its own ed25519 key automatically
3. **mosh in base template** - Pre-install mosh-server for immediate connectivity

The result is seamless VM access:
```bash
sb vm create -t debian-base   # Auto-generates and injects sb's SSH key
sb connect my-vm              # Connects via mosh using sb's key
```

---

## Domain Analysis

### Access Context Extension

Current Access Context provides:
1. **TCP Proxy** - `host:22001 → vm:22` for SSH
2. **HTTPS Gateway** - Caddy reverse proxy for web traffic

This plan adds:
3. **UDP Proxy** - `host:22001 → vm:22001` for mosh

### Mosh Protocol Analysis

```
1. Client runs: mosh --ssh="ssh -p 22001" --port=22001 root@host

2. SSH Phase (through existing TCP proxy):
   Client ──TCP 22001──▶ Host ──TCP proxy──▶ VM:22
   └─ Runs: mosh-server new -p 22001
   └─ Server outputs: MOSH CONNECT 22001 <session-key>
   └─ SSH disconnects

3. UDP Phase (through new UDP proxy):
   Client ──UDP 22001──▶ Host ──UDP proxy──▶ VM:22001
   └─ Encrypted mosh session using session-key
   └─ Bidirectional UDP datagrams
```

### Key Insight: Port Reuse

TCP and UDP are independent protocols. Port 22001 can simultaneously handle:
- **TCP** connections → SSH proxy → VM port 22
- **UDP** datagrams → mosh proxy → VM port 22001

No new port allocation needed. Each VM's existing SSH port doubles as its mosh port.

### Network Architecture with Mosh

```
┌──────────────────────────────────────────────────────────────────────┐
│                              HOST                                     │
│                                                                       │
│   ┌────────────────────────────────────────────────────────────────┐ │
│   │                    Port 22001                                   │ │
│   │   ┌─────────────┐              ┌─────────────┐                 │ │
│   │   │ TCP Proxy   │              │ UDP Proxy   │                 │ │
│   │   │ (existing)  │              │ (new)       │                 │ │
│   │   └──────┬──────┘              └──────┬──────┘                 │ │
│   └──────────┼───────────────────────────┼─────────────────────────┘ │
│              │ TCP                        │ UDP                       │
│              ▼                            ▼                           │
│   ┌──────────────────────────────────────────────────────────────┐   │
│   │                    VM (172.16.0.2)                            │   │
│   │         Port 22 (SSH)          Port 22001 (mosh-server)       │   │
│   └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Phase 0: API Support for VM Lookup by Name

### Goal
Enable API endpoints to accept VM name (e.g., `very-silly-penguin`) in addition to VM ID (e.g., `vm-a1b2c3d4e5f6`).

### Problem

Currently, all `/vms/:id` endpoints use direct Map lookup:
```typescript
const vm = vms.get(c.req.param("id"));  // Only works with ID!
```

This means `sb connect my-vm-name` will always return 404 because the name is not a Map key.

### Modify: `src/services/vm.ts`

Add helper function to find VM by ID or name:

```typescript
export function findVm(idOrName: string): VM | undefined {
  // First try direct ID lookup (fast path)
  const byId = vms.get(idOrName);
  if (byId) return byId;

  // Fall back to name search (guard against undefined name)
  for (const vm of vms.values()) {
    if (vm.name && vm.name === idOrName) return vm;
  }
  return undefined;
}
```

### Modify: `src/index.ts`

Update all `/vms/:id` endpoints to use `findVm()`:

```typescript
import { findVm } from "./services/vm";

// GET /vms/:id
app.get("/vms/:id", (c) => {
  const vm = findVm(c.req.param("id"));
  if (!vm) return c.json({ error: "VM not found" }, 404);
  return c.json(vmToResponse(vm));
});

// DELETE /vms/:id
app.delete("/vms/:id", async (c) => {
  const vm = findVm(c.req.param("id"));
  if (!vm) return c.json({ error: "VM not found" }, 404);
  await deleteVm(vm.id);  // Use actual ID for deletion
  return c.json({ success: true });
});

// POST /vms/:id/snapshot
app.post("/vms/:id/snapshot", async (c) => {
  const vm = findVm(c.req.param("id"));
  if (!vm) return c.json({ error: "VM not found" }, 404);

  try {
    const body = await c.req.json();
    const templateName = body.template_name;

    if (!templateName) {
      return c.json({ error: "template_name is required" }, 400);
    }

    const result = await snapshotVm(vm, templateName);
    return c.json(result, 201);
  } catch (e: unknown) {
    console.error("Snapshot creation failed:", e);
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message || "Unknown error" }, err.status || 500);
  }
});
```

### Verification

```bash
# Create a VM
response=$(sb vm create -t debian-base)
name=$(echo "$response" | jq -r '.name')
id=$(echo "$response" | jq -r '.id')

# Both should work
sb vm get "$name"   # By name
sb vm get "$id"     # By ID

# Delete by name should work
sb vm delete "$name"
```

### Notes

**Benefits all commands**: This fix benefits ALL existing CLI commands that accept `<name|id>`:
- `sb vm get`
- `sb vm delete`
- `sb vm snapshot`
- `sb vm wait`
- `sb connect` (new)

**Name uniqueness assumption**: `findVm()` returns the first VM matching the name. This is correct because the name generator already ensures uniqueness (see `src/services/nameGenerator.ts` which checks `isNameInUse()` before assigning). If somehow duplicate names existed, the behavior would be deterministic but arbitrary (returns whichever VM is iterated first).

---

## Phase 1: UDP Proxy Service

### Goal
Create a UDP proxy using iptables NAT that forwards mosh traffic to VMs.

### Firewall Prerequisites

If a host firewall is active, UDP ports must be opened:

```bash
# UFW
sudo ufw allow 22001:32000/udp

# firewalld
sudo firewall-cmd --add-port=22001-32000/udp --permanent
sudo firewall-cmd --reload
```

Cloud providers (AWS, GCP, Azure) require security group updates to allow UDP ingress on ports 22001-32000.

### New file: `src/services/udpProxy.ts`

```typescript
import { $ } from "bun";
import { config } from "../config";

interface UdpRule {
  localPort: number;
  targetIp: string;
  targetPort: number;
  extIf: string;  // Store interface to ensure consistent cleanup
}

// Track active rules for cleanup and state management
const activeRules = new Map<string, UdpRule>();

function log(msg: string): void {
  console.log(`[udp-proxy] ${msg}`);
}

// Get external interface (same robust logic as install.sh)
async function getExternalInterface(): Promise<string> {
  const result = await $`ip route | awk '/default/ {for(i=1;i<=NF;i++) if($i=="dev") print $(i+1); exit}'`.text();
  const iface = result.trim();
  if (!iface) {
    log("WARNING: Could not detect external interface, falling back to eth0");
    return "eth0";
  }
  return iface;
}

export async function startUdpProxy(
  vmId: string,
  localPort: number,
  targetIp: string,
  targetPort: number
): Promise<void> {
  // Mosh requires the same port for client and server (--port flag sets both)
  if (localPort !== targetPort) {
    throw new Error(
      `UDP proxy port mismatch: localPort=${localPort} but targetPort=${targetPort}. ` +
      `Mosh requires identical ports.`
    );
  }

  const extIf = await getExternalInterface();

  // Track the rule BEFORE adding iptables rules so cleanup works if verification fails
  // (iptables commands may succeed but verification may fail)
  activeRules.set(vmId, { localPort, targetIp, targetPort, extIf });

  try {
    // Add DNAT rule for incoming UDP (specify interface to avoid internal traffic)
    await $`sudo iptables -t nat -A PREROUTING -i ${extIf} -p udp --dport ${localPort} -j DNAT --to-destination ${targetIp}:${targetPort}`.quiet();

    // Add MASQUERADE for return traffic
    await $`sudo iptables -t nat -A POSTROUTING -p udp -d ${targetIp} --dport ${targetPort} -j MASQUERADE`.quiet();

    // Verify rules were actually created (iptables can fail silently with .quiet())
    const rules = await $`sudo iptables-save -t nat`.text().catch(() => "");
    const expectedDnat = `--to-destination ${targetIp}:${targetPort}`;
    const expectedMasq = `-d ${targetIp}`;
    if (!rules.includes(expectedDnat) || !rules.includes(expectedMasq)) {
      throw new Error(`Failed to create UDP proxy rules for ${targetIp}:${targetPort}`);
    }

    log(`UDP proxy started: ${extIf}:${localPort} -> ${targetIp}:${targetPort}`);
  } catch (err) {
    // Clean up tracking and any rules that may have been created
    activeRules.delete(vmId);
    await $`sudo iptables -t nat -D PREROUTING -i ${extIf} -p udp --dport ${localPort} -j DNAT --to-destination ${targetIp}:${targetPort}`.quiet().nothrow();
    await $`sudo iptables -t nat -D POSTROUTING -p udp -d ${targetIp} --dport ${targetPort} -j MASQUERADE`.quiet().nothrow();
    throw err;
  }
}

export async function stopUdpProxy(vmId: string): Promise<void> {
  const rule = activeRules.get(vmId);
  if (!rule) {
    log(`No UDP rule found for ${vmId}`);
    return;
  }

  // Use stored interface (avoids race condition if interface changes)
  const { localPort, targetIp, targetPort, extIf } = rule;

  // Remove DNAT rule
  await $`sudo iptables -t nat -D PREROUTING -i ${extIf} -p udp --dport ${localPort} -j DNAT --to-destination ${targetIp}:${targetPort}`.quiet().nothrow();

  // Remove MASQUERADE rule
  await $`sudo iptables -t nat -D POSTROUTING -p udp -d ${targetIp} --dport ${targetPort} -j MASQUERADE`.quiet().nothrow();

  activeRules.delete(vmId);
  log(`UDP proxy stopped: port ${localPort}`);
}

// Clean up ALL orphaned rules on startup
// Since VMs don't survive restart (in-memory state), all rules targeting our VM subnet are orphans
//
// Uses iptables-save format which is stable across versions, then deletes by subnet match.
// This is more robust than regex parsing of iptables -L output.
//
// NOTE: Cleanup is best-effort. If it fails (permissions, iptables busy, etc.):
// - Orphan rules are harmless (they forward to non-existent VMs, traffic is dropped)
// - New VMs get fresh rules that work correctly
// - Manual cleanup: sudo iptables -t nat -F (flushes all NAT rules - use with caution)
export async function cleanupOrphanedUdpRules(): Promise<void> {
  const extIf = await getExternalInterface();

  // Use iptables-save format for reliable parsing
  const rules = await $`sudo iptables-save -t nat`.text().catch((err) => {
    log(`WARNING: Failed to read iptables rules for cleanup: ${err.message || err}`);
    return "";
  });

  if (!rules) {
    log("Skipping orphan cleanup (no rules to process)");
    return;
  }

  for (const line of rules.split('\n')) {
    // Match PREROUTING DNAT rules targeting our VM subnet (172.16.x.x)
    // Format: -A PREROUTING -i eth0 -p udp -m udp --dport 22001 -j DNAT --to-destination 172.16.0.2:22001
    if (line.includes('-A PREROUTING') && line.includes('-p udp') && line.includes('172.16.')) {
      const portMatch = line.match(/--dport (\d+)/);
      const destMatch = line.match(/--to-destination (172\.16\.\d+\.\d+:\d+)/);
      if (portMatch && destMatch) {
        log(`Cleaning up orphaned PREROUTING rule for port ${portMatch[1]}`);
        await $`sudo iptables -t nat -D PREROUTING -i ${extIf} -p udp --dport ${portMatch[1]} -j DNAT --to-destination ${destMatch[1]}`.quiet().nothrow();
      }
    }

    // Match POSTROUTING MASQUERADE rules targeting our VM subnet
    // Format: -A POSTROUTING -d 172.16.0.2/32 -p udp -m udp --dport 22001 -j MASQUERADE
    if (line.includes('-A POSTROUTING') && line.includes('-p udp') && line.includes('-d 172.16.') && line.includes('MASQUERADE')) {
      const destMatch = line.match(/-d (172\.16\.\d+\.\d+)/);
      const portMatch = line.match(/--dport (\d+)/);
      if (destMatch && portMatch) {
        log(`Cleaning up orphaned POSTROUTING rule for ${destMatch[1]}:${portMatch[1]}`);
        await $`sudo iptables -t nat -D POSTROUTING -p udp -d ${destMatch[1]} --dport ${portMatch[1]} -j MASQUERADE`.quiet().nothrow();
      }
    }
  }
}
```

### Why iptables NAT (not application-level proxy)

| Approach | Pros | Cons |
|----------|------|------|
| **iptables NAT** ✓ | Kernel-level, efficient, handles return routing | Requires sudo |
| Application UDP relay | No sudo | Complex client tracking, Bun UDP immature |
| socat | Simple | Extra process per VM |

### Verification

```bash
# Create a VM
sb vm create -t debian-base

# Check iptables rules exist (note: interface specified)
sudo iptables -t nat -L PREROUTING -n | grep 22001
# Should show: DNAT udp -- 0.0.0.0/0 0.0.0.0/0 udp dpt:22001 to:172.16.0.2:22001

sudo iptables -t nat -L POSTROUTING -n | grep 22001
# Should show: MASQUERADE udp -- 0.0.0.0/0 172.16.0.2 udp dpt:22001
```

---

## Phase 2: VM Lifecycle Integration

### Goal
Start/stop UDP proxy alongside TCP proxy during VM creation/deletion. Clean up orphaned rules on startup.

### Modify: `src/services/vm.ts`

Import the new UDP proxy:
```typescript
import { startUdpProxy, stopUdpProxy } from "./udpProxy";
```

In `createVm()`, after starting TCP proxy:
```typescript
// Start TCP proxy for SSH (existing)
await startProxy(vmId, port, ip, 22);

// Start UDP proxy for mosh (new)
// Use same host port, forward to same port number on VM
await startUdpProxy(vmId, port, ip, port);
```

In `createVm()` catch block, fix existing bug AND add UDP cleanup:

**Note**: The existing code has a bug - TCP proxy is started but not cleaned up on failure. This phase fixes both the existing TCP proxy cleanup bug AND adds UDP cleanup. The TCP fix is a prerequisite for reliable operation, not just a "nice to have".

```typescript
} catch (e) {
  // ... existing cleanup (deleteTapDevice, releaseIp, releasePort, etc.) ...

  // FIX EXISTING BUG: Clean up TCP proxy if it was started
  try {
    stopProxy(vmId);
  } catch {}

  // NEW: Clean up UDP proxy if it was started
  try {
    await stopUdpProxy(vmId);
  } catch {}

  // ... rest of cleanup ...
}
```

In `deleteVm()`, before stopping TCP proxy:
```typescript
// Stop UDP proxy for mosh (new) - uses tracked state, no params needed
await stopUdpProxy(vmId);

// Stop TCP proxy for SSH (existing)
stopProxy(vmId);
```

### Modify: `src/index.ts`

Import and clean up orphaned iptables rules on startup:
```typescript
import { cleanupOrphanedUdpRules } from "./services/udpProxy";

// At server startup, before starting the HTTP server
// VMs don't survive restart, so all rules in our port range are orphans
await cleanupOrphanedUdpRules();
```

### Port Constraint (Critical)

**Important**: The external port and VM mosh port **MUST** be the same number. This is because mosh's `--port` flag sets both:
1. The port mosh-server listens on inside the VM
2. The port the client connects to

Since we forward `host:22001 → vm:22001`, this works correctly.

**Implementation Note**: In `createVm()`, we call:
```typescript
await startUdpProxy(vmId, port, ip, port);  // localPort == targetPort (required!)
```

The `port` variable is used for both `localPort` and `targetPort`. This is intentional, not a bug. Changing either would break mosh connectivity. The TCP proxy uses different ports (`port → 22`) because SSH doesn't have this constraint.

### Verification

```bash
# Create VM
vm=$(sb vm create -t debian-base)
port=$(echo "$vm" | jq -r '.ssh_port')

# Verify both TCP and UDP are set up
sudo iptables -t nat -L PREROUTING -n | grep $port   # UDP DNAT
ss -tlnp | grep $port                                  # TCP proxy listening

# Delete VM
sb vm delete $(echo "$vm" | jq -r '.name')

# Verify cleanup
sudo iptables -t nat -L PREROUTING -n | grep $port   # Should be gone

# Test orphan cleanup: restart scaleboxd
sudo systemctl restart scaleboxd
# Orphan rules from crashed VMs should be cleaned up
```

---

## Phase 3: CLI Managed SSH Key

### Goal
Generate and manage an ed25519 SSH key automatically for seamless VM access.

### Key Storage

```
~/.config/scalebox/
├── config              # Existing: SCALEBOX_HOST, SCALEBOX_TOKEN
├── id_ed25519          # NEW: Private key (mode 600)
└── id_ed25519.pub      # NEW: Public key
```

### Multi-Machine Limitation

**Important**: The managed SSH key is per-machine. If you use `sb` from multiple machines (laptop + desktop), each generates its own key. VMs are only accessible from the machine that created them.

**Workarounds**:
- Sync `~/.config/scalebox/id_ed25519*` between machines manually
- Use `-k @path/to/shared/key.pub` when creating VMs to use a shared key
- Use `-i path/to/key` when connecting from a different machine

This is acceptable because VMs are short-lived. For long-lived VMs needing multi-machine access, use explicit shared keys.

### Modify: `scripts/sb`

Add key management functions with validation:

```bash
# Generate SSH key if not present, validate if exists
ensure_ssh_key() {
  local key_file="$SCALEBOX_CONFIG_DIR/id_ed25519"
  local pub_file="${key_file}.pub"

  # Check if both files exist
  if [[ -f "$key_file" && -f "$pub_file" ]]; then
    # Fix permissions FIRST (ssh-keygen -l may fail if permissions are wrong)
    chmod 600 "$key_file" 2>/dev/null || true
    chmod 644 "$pub_file" 2>/dev/null || true

    # Then validate key format
    if ssh-keygen -l -f "$key_file" &>/dev/null; then
      return 0
    else
      echo "Warning: Existing SSH key is invalid, regenerating..." >&2
      rm -f "$key_file" "$pub_file"
    fi
  elif [[ -f "$key_file" || -f "$pub_file" ]]; then
    # One file exists but not the other - corrupted state
    echo "Warning: Incomplete SSH key pair, regenerating..." >&2
    rm -f "$key_file" "$pub_file"
  fi

  # Generate new key
  echo "Generating SSH key for Scalebox..." >&2
  mkdir -p "$SCALEBOX_CONFIG_DIR" || die "Failed to create config directory"
  chmod 700 "$SCALEBOX_CONFIG_DIR" || die "Failed to set config directory permissions"

  if ! ssh-keygen -t ed25519 -f "$key_file" -N "" -C "scalebox" >/dev/null 2>&1; then
    die "Failed to generate SSH key"
  fi

  chmod 600 "$key_file" || die "Failed to set private key permissions"
  chmod 644 "$pub_file" || die "Failed to set public key permissions"
}

# Get public key content
get_ssh_pubkey() {
  local key_file="$SCALEBOX_CONFIG_DIR/id_ed25519.pub"
  ensure_ssh_key
  cat "$key_file"
}

# Get private key path
get_ssh_keyfile() {
  local key_file="$SCALEBOX_CONFIG_DIR/id_ed25519"
  ensure_ssh_key
  echo "$key_file"
}
```

### Modify: `cmd_vm_create()`

Use managed key by default, allow override with `-k`:

```bash
cmd_vm_create() {
  need_config
  local template="" key="" key_file=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -t|--template) template="$2"; shift 2 ;;
      -k|--key)
        if [[ "$2" == @* ]]; then
          key_file="${2:1}"
          # Expand tilde (bash doesn't expand ~ inside quotes)
          key_file="${key_file/#\~/$HOME}"
          [[ -f "$key_file" ]] || die "Key file not found: $key_file"
          key=$(cat "$key_file")
        else
          key="$2"
        fi
        shift 2
        ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  [[ -n "$template" ]] || die "Template required: -t TEMPLATE"

  # Use managed key if none provided
  if [[ -z "$key" ]]; then
    key=$(get_ssh_pubkey)
  fi

  local response
  if response=$(api POST /vms -d "$(jq -n --arg t "$template" --arg k "$key" '{template:$t,ssh_public_key:$k}')"); then
    echo "$response" | output_single
  else
    echo "$response"
    return 1
  fi
}
```

### Update `cmd_help()` (Phase 3 changes):

Update the `vm create` line:
```
  vm create -t TPL [-k KEY]     Create VM (uses managed key if -k omitted)
```

### Verification

```bash
# First vm create generates key automatically
sb vm create -t debian-base
# Output: "Generating SSH key for Scalebox..."

# Key files created
ls -la ~/.config/scalebox/id_ed25519*

# Subsequent creates reuse key
sb vm create -t debian-base
# No key generation message

# Can still override with explicit key
sb vm create -t debian-base -k @~/.ssh/id_rsa.pub
```

---

## Phase 4: CLI Connect Command

### Goal
Add `sb connect` command that connects via mosh (with SSH fallback) using the managed SSH key.

### Modify: `scripts/sb`

Add helper to extract host from URL:

```bash
# Extract hostname from SCALEBOX_HOST URL
get_ssh_host() {
  # Extract hostname from URL, handling:
  # - Protocol: https://host -> host
  # - Auth: user:pass@host -> host
  # - Port: host:8080 -> host
  # - Path: host/path -> host
  local host="$SCALEBOX_HOST"
  host="${host#*://}"      # Remove protocol
  host="${host##*@}"       # Remove userinfo (user:pass@)
  host="${host%%:*}"       # Remove port (keep first part before :)
  host="${host%%/*}"       # Remove path
  echo "$host"
}
```

Add `cmd_connect()` function:

```bash
cmd_connect() {
  need_config
  local id="${1:-}"
  shift || true

  local user="root"
  local identity=""
  local use_ssh=false
  local ssh_opts=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ssh) use_ssh=true; shift ;;
      -l|--user) user="$2"; shift 2 ;;
      -i|--identity)
        identity="$2"
        # Expand tilde (bash doesn't expand ~ inside quotes)
        identity="${identity/#\~/$HOME}"
        shift 2
        ;;
      -o) ssh_opts+=("-o" "$2"); shift 2 ;;
      --) shift; ssh_opts+=("$@"); break ;;  # Pass remaining args to SSH
      *) die "Unknown option: $1. Use -- to pass args to SSH." ;;
    esac
  done

  [[ -n "$id" ]] || die "Usage: sb connect <name|id> [--ssh] [-l USER] [-i KEYFILE] [-- SSH_ARGS...]"

  # Use managed key if none provided
  if [[ -z "$identity" ]]; then
    identity=$(get_ssh_keyfile)
  fi

  # Get VM details
  local vm_data ssh_port
  vm_data=$(api GET "/vms/$id") || { echo "$vm_data"; return 1; }
  ssh_port=$(echo "$vm_data" | jq -r '.ssh_port')

  # Extract host from SCALEBOX_HOST
  local ssh_host
  ssh_host=$(get_ssh_host)

  # Common SSH options for ephemeral VMs:
  # - StrictHostKeyChecking=accept-new: Accept new keys, warn on changes
  # - UserKnownHostsFile=/dev/null: Don't pollute known_hosts with ephemeral VM keys
  local base_ssh_opts="-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null"

  if [[ "$use_ssh" == "true" ]]; then
    # Direct SSH connection (fallback if mosh doesn't work)
    # Use array to preserve quoting for paths with spaces
    exec ssh -p "$ssh_port" -i "$identity" $base_ssh_opts "${ssh_opts[@]}" "${user}@${ssh_host}"
  else
    # Check mosh is installed locally
    if ! command -v mosh &>/dev/null; then
      echo "mosh not installed locally, falling back to SSH..." >&2
      echo "Install mosh for better experience: apt install mosh (or brew install mosh)" >&2
      exec ssh -p "$ssh_port" -i "$identity" $base_ssh_opts "${ssh_opts[@]}" "${user}@${ssh_host}"
    fi

    # Note: If mosh-server is missing on the VM, mosh will fail with:
    #   "mosh-server: command not found"
    # This shouldn't happen with debian-base (Phase 5 installs mosh),
    # but custom templates might not have it. Use --ssh fallback in that case.

    # Build SSH command for mosh
    # Use printf %q to safely quote paths with spaces for shell expansion inside mosh --ssh
    # Note: base_ssh_opts is safe to expand directly (no special chars, known values)
    local quoted_identity
    quoted_identity=$(printf '%q' "$identity")
    local ssh_cmd="ssh -p ${ssh_port} -i ${quoted_identity}"
    ssh_cmd+=" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null"
    for opt in "${ssh_opts[@]}"; do
      ssh_cmd+=" $(printf '%q' "$opt")"
    done

    # Connect via mosh
    # --port tells mosh-server which port to use AND which port client connects to
    exec mosh --ssh="$ssh_cmd" --port="$ssh_port" "${user}@${ssh_host}"
  fi
}
```

Update main() case statement:

```bash
connect) shift; cmd_connect "$@" ;;
```

### Update `cmd_help()` (Phase 4 changes):

Add the connect command and update version:
```bash
# In cmd_help(), add after vm commands:
  connect <name|id> [options]    Connect to VM via mosh (or SSH with --ssh)
    Options:
      --ssh                      Force SSH instead of mosh
      -l, --user USER            Connect as USER (default: root)
      -i, --identity FILE        Use specific SSH key
      --                         Pass remaining args to SSH (e.g., -o ForwardAgent=yes)

# Update version in cmd_version():
cmd_version() {
  echo "sb version 0.2.0"  # Bump from 0.1.0
}
```

### Host Key Handling

VMs are ephemeral, so host key checking is adjusted:
- `StrictHostKeyChecking=accept-new` - Accept new keys, warn on changes
- `UserKnownHostsFile=/dev/null` - Don't store ephemeral VM keys in known_hosts

This prevents conflicts when a new VM gets the same port as a previously deleted VM.

### Verification

```bash
# Connect to VM (uses mosh + managed key)
sb connect my-vm

# Connect as different user
sb connect my-vm -l ubuntu

# Connect with explicit identity file
sb connect my-vm -i ~/.ssh/other_key

# Force SSH if mosh fails (UDP blocked, etc.)
sb connect my-vm --ssh

# Pass additional SSH options (after --)
sb connect my-vm -- -o ForwardAgent=yes

# If mosh not installed, auto-falls back to SSH
```

---

## Phase 5: VM Template with Mosh (Essential)

### Goal
Pre-install mosh-server in the base template so `sb connect` works immediately.

**IMPORTANT**: This phase is essential for `sb connect` to work. Without mosh-server in the VM, the command will fail with "mosh-server: command not found". The `--ssh` fallback is available but defeats the purpose of this feature.

**Current state**: Mosh is NOT in the base image. The debootstrap command in `scripts/install.sh` only includes: `openssh-server, iproute2, iputils-ping, haveged, netcat-openbsd`.

### Modify: `scripts/install.sh`

Update the debootstrap command to include mosh:

```bash
debootstrap --include=openssh-server,iproute2,iputils-ping,haveged,netcat-openbsd,mosh \
  bookworm "$rootfs_dir" http://deb.debian.org/debian
```

Or add it in the rootfs configuration section:

```bash
# Inside chroot setup
apt-get install -y mosh
```

### Verification

```bash
# Create VM from base template
sb vm create -t debian-base

# Connect immediately works (no manual mosh installation needed)
sb connect <vm-name>
```

### Note on Custom Templates

Users creating custom templates should include mosh if they want `sb connect` to work:

```bash
# Inside VM before snapshotting
apt-get install -y mosh

# Then snapshot
sb vm snapshot my-vm -n my-custom-template
```

---

## Phase 6: Documentation

### New file: `product/DDD/contexts/cli.md`

Document the CLI as a bounded context:

```markdown
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

## Relationships

| Context | Relationship | Description |
|---------|--------------|-------------|
| API | Upstream | CLI consumes REST API |
| Access | Indirect | CLI uses TCP/UDP proxies via allocated ports |

The CLI has no special access - it uses the same API endpoints as any authenticated client.
```

### Modify: `product/DDD/context-map.md`

Add CLI to the bounded contexts list:

```markdown
## CLI Context (Client-Side)

**Type:** External Client
**Location:** `scripts/sb` (installed on user machines)

**Responsibilities:**
- User authentication (login/logout)
- SSH key management (generate, store, inject)
- VM lifecycle operations (create, delete, list)
- VM connectivity (mosh/SSH connection)

**Upstream:** API Context (consumes REST API)
```

### Modify: `product/DDD/contexts/access.md`

Add new sub-context:

```markdown
## Sub-Context: UDP Proxy (Mosh)

### Purpose

Forwards UDP traffic for mosh sessions, enabling roaming shell access with better latency handling than SSH.

### Architecture

```
External Client                    Host                         VM
      │                             │                            │
      │   mosh user@host           │                            │
      │   --port=22001             │                            │
      │                             │                            │
      │   1. SSH (TCP 22001)       │                            │
      │ ──────────────────────────▶│ TCP Proxy ────────────────▶│ :22
      │   Start mosh-server -p 22001                            │
      │◀──────────────────────────│◀────────────────────────────│
      │   MOSH CONNECT 22001 <key> │                            │
      │                             │                            │
      │   2. UDP (22001)           │                            │
      │ ──────────────────────────▶│ iptables DNAT ────────────▶│ :22001
      │◀─────────────────────────▶│◀───────────────────────────▶│
      │   Encrypted mosh session    │                            │
```

### Implementation

Uses iptables NAT rules (not application-level proxy):
- **DNAT**: Rewrites destination to VM IP
- **MASQUERADE**: Ensures return packets route correctly

### Port Sharing

The same port number serves both protocols:
- TCP 22001 → SSH (application proxy in scaleboxd)
- UDP 22001 → mosh (kernel-level NAT via iptables)

### Lifecycle

| Event | Action |
|-------|--------|
| VM Created | Add iptables DNAT + MASQUERADE rules |
| VM Deleted | Remove iptables rules |
```

### Modify: `product/DDD/glossary.md`

Add terms:

```markdown
### Mosh Port
The UDP port (same number as SSH port) used for mosh sessions. Forwarded via iptables NAT to the VM's mosh-server.

### UDP Proxy
Kernel-level NAT (iptables DNAT + MASQUERADE) that forwards UDP datagrams to VMs for mosh connectivity.

### Managed SSH Key
An ed25519 SSH key pair automatically generated and stored by the `sb` CLI at `~/.config/scalebox/id_ed25519`. Used by default for VM creation and connection, removing the need for users to manage SSH keys manually.
```

---

## Phase 7: Integration Tests

### Goal
Add automated tests for the new functionality.

### Modify: `test/integration.test.ts`

Add tests for Phase 0 (API lookup by name):
```typescript
describe("VM lookup by name", () => {
  it("GET /vms/:name returns VM", async () => {
    const createRes = await api.post("/vms", { template: "debian-base", ssh_public_key: testKey });
    const vm = await createRes.json();

    const getRes = await api.get(`/vms/${vm.name}`);
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.id).toBe(vm.id);

    await api.delete(`/vms/${vm.name}`);
  });

  it("DELETE /vms/:name works", async () => {
    const createRes = await api.post("/vms", { template: "debian-base", ssh_public_key: testKey });
    const vm = await createRes.json();

    const deleteRes = await api.delete(`/vms/${vm.name}`);
    expect(deleteRes.status).toBe(200);

    const getRes = await api.get(`/vms/${vm.name}`);
    expect(getRes.status).toBe(404);
  });
});
```

Add tests for UDP proxy (requires root - may need separate test script):
```typescript
describe("UDP proxy", () => {
  it("creates iptables rules on VM creation", async () => {
    const createRes = await api.post("/vms", { template: "debian-base", ssh_public_key: testKey });
    const vm = await createRes.json();

    // Check iptables rules exist (requires root access)
    const rules = await $`sudo iptables -t nat -L PREROUTING -n`.text();
    expect(rules).toContain(`dpt:${vm.ssh_port}`);

    await api.delete(`/vms/${vm.id}`);
  });

  it("removes iptables rules on VM deletion", async () => {
    const createRes = await api.post("/vms", { template: "debian-base", ssh_public_key: testKey });
    const vm = await createRes.json();
    const port = vm.ssh_port;

    await api.delete(`/vms/${vm.id}`);

    const rules = await $`sudo iptables -t nat -L PREROUTING -n`.text();
    expect(rules).not.toContain(`dpt:${port}`);
  });
});
```

### Note on Test Environment

UDP proxy tests require:
- Root access for iptables commands
- May need to run separately from standard `./do test`

Consider adding `./do test-root` or skipping UDP tests in CI if root unavailable.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/services/vm.ts` | Modify | Add `findVm()` helper, integrate UDP proxy, fix rollback |
| `src/services/udpProxy.ts` | Create | iptables-based UDP forwarding with state tracking |
| `src/index.ts` | Modify | Use `findVm()` in endpoints, call orphan cleanup on startup |
| `scripts/sb` | Modify | Add SSH key management, update `vm create`, add `connect` command |
| `debian-base template` | Modify | Pre-install mosh-server |
| `test/integration.test.ts` | Modify | Add VM lookup and UDP proxy tests |
| `product/DDD/contexts/cli.md` | Create | Document CLI as bounded context |
| `product/DDD/contexts/access.md` | Modify | Document UDP proxy sub-context |
| `product/DDD/context-map.md` | Modify | Add CLI to context map |
| `product/DDD/glossary.md` | Modify | Add mosh/UDP/managed key terms |

---

## Implementation Verification

**IMPORTANT**: After implementing each phase, run:

```bash
./do check
```

This performs the full CI pipeline: lint, deploy to test VM, and run integration tests. Do not proceed to the next phase until `./do check` passes.

For phases that add new functionality, also add corresponding tests to `test/integration.test.ts` before running `./do check`.

---

## Verification Checklist

### Phase 0: API Lookup by Name
- [ ] `findVm()` helper works with both ID and name
- [ ] `GET /vms/:name` returns correct VM
- [ ] `DELETE /vms/:name` deletes correct VM
- [ ] `POST /vms/:name/snapshot` works with name
- [ ] Non-existent name returns 404

### Phase 1: UDP Proxy
- [ ] `startUdpProxy()` adds iptables rules with interface specification
- [ ] `stopUdpProxy()` removes iptables rules using tracked state
- [ ] Rules visible with `iptables -t nat -L PREROUTING -n`
- [ ] Rules specify external interface (not matching internal br0 traffic)
- [ ] `cleanupOrphanedUdpRules()` removes all rules in port range on startup
- [ ] Both PREROUTING and POSTROUTING rules cleaned up

### Phase 2: VM Lifecycle
- [ ] Creating VM adds both TCP proxy and UDP iptables rules
- [ ] Deleting VM removes both
- [ ] Multiple VMs have independent rules
- [ ] Restarting scaleboxd cleans up orphan UDP rules
- [ ] VM creation rollback cleans up UDP rules on failure

### Phase 3: Managed SSH Key
- [ ] First `sb vm create` generates key at `~/.config/scalebox/id_ed25519`
- [ ] Key permissions are correct (600 for private, 644 for public)
- [ ] Subsequent creates reuse existing key
- [ ] `-k` flag overrides managed key
- [ ] Corrupted/incomplete keys are regenerated with warning
- [ ] Key validation works (`ssh-keygen -l` check)

### Phase 4: CLI Connect
- [ ] `sb connect vm` connects via mosh using managed key
- [ ] `sb connect vm -l user` connects as specified user
- [ ] `sb connect vm -i keyfile` uses explicit key
- [ ] `sb connect vm --ssh` forces SSH instead of mosh
- [ ] Falls back to SSH if mosh not installed (with message)
- [ ] Host keys not stored (UserKnownHostsFile=/dev/null)

### Phase 5: Template
- [ ] `mosh-server` pre-installed in debian-base template

### Phase 6: Documentation
- [ ] `product/DDD/contexts/cli.md` created
- [ ] `product/DDD/context-map.md` updated with CLI context
- [ ] `product/DDD/contexts/access.md` updated with UDP proxy
- [ ] `product/DDD/glossary.md` updated with new terms

### Phase 7: Integration Tests
- [ ] VM lookup by name tests added
- [ ] UDP proxy creation/deletion tests added (if root available)
- [ ] Tests pass with `./do test`

### End-to-end Test
```bash
# Fresh start - no keys yet
rm -rf ~/.config/scalebox/id_ed25519*

# Create VM (generates key automatically)
sb vm create -t debian-base
# Should print: "Generating SSH key for Scalebox..."

# Wait for boot
sb vm wait <name> --ssh

# Connect via mosh (uses managed key automatically)
sb connect <name>

# Verify mosh survives network change
# (disconnect/reconnect wifi while in mosh session)

# Test SSH fallback
sb connect <name> --ssh

# Test from different machine (should fail without key sync)
# This documents the multi-machine limitation
```

---

## User Experience Summary

Before this feature:
```bash
sb vm create -t debian-base -k @~/.ssh/id_rsa.pub
ssh -p 22001 root@host
```

After this feature:
```bash
sb vm create -t debian-base
sb connect my-vm
```

- No SSH key management required
- No port numbers to remember
- Mosh provides roaming, better latency handling

---

## Update Considerations

- **Config changes**: None (key stored in existing config dir)
- **Storage changes**: `~/.config/scalebox/id_ed25519{,.pub}` created on demand
- **Dependency changes**: iptables (already required), mosh (client-side)
- **Migration needed**: No - existing VMs won't have UDP rules, users can recreate VMs. Managed key is opt-in (old `-k` flag still works).

---

## Security Considerations

### UDP Exposure

Each VM's mosh port is exposed to the internet. Mitigations:
- Mosh uses encrypted, authenticated protocol (AES-128-OCB)
- Session key exchanged over SSH (not exposed to UDP layer)
- No authentication bypass possible without SSH-exchanged key
- Port scanning can detect active mosh ports but cannot establish sessions

**Attack surface**: Equivalent to SSH - no additional authentication vectors.

### iptables Rule Management

Rules are added/removed per-VM. Mitigations:
- Rules tracked in memory (`activeRules` Map) for reliable cleanup
- Orphan rules cleaned up on scaleboxd startup
- Rule deletion uses `.nothrow()` to handle already-deleted rules gracefully
- iptables operations are atomic (no race conditions)

### Managed SSH Key Security

- Private key stored with mode 600 (owner read/write only)
- Config directory has mode 700
- Key never transmitted over network (only public key sent to API)
- No passphrase (tradeoff: convenience vs security for ephemeral VMs)

**Shared storage warning**: If `~/.config/scalebox/` is on a shared filesystem (NFS), synced to cloud storage (Dropbox, iCloud), or backed up unencrypted, the private key could be exposed. Users in these environments should:
- Use `-k @path/to/separate/key` with a key stored securely
- Or exclude `~/.config/scalebox/` from sync/backup

### Host Key Verification

- Uses `StrictHostKeyChecking=accept-new` (accept new, warn on change)
- Uses `UserKnownHostsFile=/dev/null` (don't persist ephemeral VM keys)
- Appropriate for ephemeral VMs where host keys change frequently
- Prevents "REMOTE HOST IDENTIFICATION HAS CHANGED" errors when ports are reused
- Users connecting to long-lived VMs should use standard SSH with strict checking

### IPv6

**Not supported** in this phase. All iptables rules are IPv4 only. VMs use IPv4 addresses (172.16.0.0/16). Document as limitation for future enhancement.

---

## Alternative Approaches Considered

### A: Application-level UDP proxy (rejected)

Build UDP relay in Bun similar to TCP proxy:
- **Pro**: No sudo/iptables dependency
- **Con**: Complex client tracking, inefficient for high-throughput
- **Con**: Bun's UDP support is less mature than TCP

### B: WireGuard VPN (rejected)

Give users VPN access to VM network:
- **Pro**: Full network access, any protocol
- **Con**: Per-user setup, different problem domain
- **Con**: Overkill for just mosh

### C: socat UDP relay (considered)

Run `socat UDP-LISTEN:22001,fork UDP:172.16.0.2:22001`:
- **Pro**: Simple, well-tested
- **Con**: Extra process per VM
- **Con**: Less efficient than kernel NAT

**Chosen: iptables NAT** - Most efficient, standard approach, no extra processes.
