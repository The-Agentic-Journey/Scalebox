# ADR-011: Self-Contained Installation Script

## Status

Accepted

## Context

The system needs to be installed on fresh hosts. Installation involves:
- System dependencies (curl, jq, iptables, etc.)
- btrfs storage setup
- Firecracker binary and kernel
- Network configuration (bridge, NAT)
- Base template creation
- Service installation

Options:

1. **Single install script** - All logic in one bash script
2. **Multiple scripts** - Separate scripts per component
3. **Ansible/Terraform** - Infrastructure-as-code tools
4. **Container image** - Package everything in Docker
5. **Package manager** - Create .deb/.rpm packages

## Decision

We chose a **single self-contained installation script** (`install.sh`).

## Rationale

### Why Single Script

1. **Simplicity** - One file to copy, one command to run: `sudo bash install.sh`

2. **Portable** - No dependencies beyond bash and curl. Works on fresh Debian/Ubuntu.

3. **Transparent** - All logic visible in one place. Easy to audit and modify.

4. **Idempotent** - Safe to re-run. Skips already-completed steps.

5. **Self-documenting** - Comments explain each section. Script IS the documentation.

### Why Not Alternatives

- **Multiple scripts**: Ordering complexity. Partial failures harder to handle.
- **Ansible**: Requires Ansible installed. YAML abstraction hides logic.
- **Terraform**: For cloud resources, not host configuration.
- **Container**: Firecracker needs KVM access. Container adds complexity.
- **Packages**: Build infrastructure overhead. Version management complexity.

## Implementation

### Script Structure

```bash
#!/bin/bash
set -euo pipefail

# === Configuration ===
DATA_DIR="${DATA_DIR:-/var/lib/scalebox}"
API_TOKEN="${API_TOKEN:-}"
# ...

# === Helpers ===
log() { echo "[scalebox] $1"; }
die() { echo "[scalebox] ERROR: $1" >&2; exit 1; }

# === Checks ===
check_root()
check_os()
check_kvm()
preflight_check()

# === Installation Steps ===
install_deps()      # apt packages
setup_storage()     # btrfs mount
install_firecracker()
setup_network()     # bridge, iptables
create_rootfs()     # base template
install_caddy()     # optional HTTPS
install_binary()    # scaleboxd
install_cli()       # scalebox
install_service()   # systemd
start_service()

# === Main ===
main() {
  check_root
  check_os
  check_kvm
  preflight_check

  install_deps
  setup_storage
  # ...

  log "Installation complete!"
}
```

### Idempotency Patterns

```bash
# Check before creating
if [[ -f "$fc_bin" ]]; then
  log "Firecracker already installed"
else
  # Install firecracker
fi

# Check before mounting
if mountpoint -q "$DATA_DIR" 2>/dev/null; then
  log "Storage already mounted"
  return
fi

# Remove then add (iptables)
iptables -D FORWARD ... 2>/dev/null || true
iptables -A FORWARD ...
```

### Cleanup on Failure

```bash
TEMP_DIRS=()
cleanup_temps() {
  for dir in "${TEMP_DIRS[@]}"; do
    rm -rf "$dir" 2>/dev/null || true
  done
}
trap cleanup_temps EXIT
```

## Usage

### Local Installation

```bash
# Copy builds to host
scp -r builds/* user@host:/opt/scalebox/

# Run installer
ssh user@host "sudo bash /opt/scalebox/install.sh"
```

### Remote Installation (Future)

```bash
curl -sSL https://example.com/install.sh | sudo bash
```

### With Options

```bash
API_TOKEN="my-token" DOMAIN="api.example.com" sudo bash install.sh
```

## Consequences

### Positive

- Minimal prerequisites
- Easy to understand and modify
- Works on any Debian/Ubuntu
- Re-runnable for updates

### Negative

- Bash scripting limitations (error handling, testing)
- Long script (~480 lines)
- Debian/Ubuntu only (hardcoded package names)

### Neutral

- Could be refactored to multiple files if complexity grows
- Could add support for other distros if needed

## References

- Install script: `scripts/install.sh`
- Plan: `product/plans/done/002-PLAN-SCALEBOX.md`
