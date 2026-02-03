# Scalebox Update Mechanism Plan

## Overview

Enable updating Scalebox on running servers after initial bootstrap installation. The mechanism should be:
- **Simple**: Single command run by admin on the server
- **Testable**: CI can verify updates work
- **Resilient**: Automatic rollback on failure
- **Minimal**: Reuse existing infrastructure, no code duplication

## Key Insight: Server-Side Tool

The `scalebox` CLI is a **user-facing tool** that runs on the user's machine and communicates with the Scalebox API remotely. It is NOT on the server.

The update mechanism needs a **separate server-side tool**:
- Installed to `/usr/local/bin/scalebox-update` during bootstrap
- Admin workflow: SSH into server, run `sudo scalebox-update`
- Self-contained: downloads tarball, backs up, replaces, restarts, verifies

## Architecture

```
Admin workflow:
    ssh admin@scalebox-server
    sudo scalebox-update
        │
        ▼
┌─────────────────────────────────────┐
│  /usr/local/bin/scalebox-update     │
│  - Fetch latest release URL         │
│  - Download tarball to /tmp         │
│  - Backup current scaleboxd         │
│  - Install new binaries             │
│  - Restart service                  │
│  - Health check                     │
│  - Rollback if unhealthy            │
└─────────────────────────────────────┘
```

## Phase 1: Create scalebox-update Script

**Goal**: A focused server-side script that updates binaries with rollback capability.

### File: `scripts/scalebox-update`

This single script handles everything: download, backup, install, restart, verify, rollback.

```bash
#!/bin/bash
#
# Scalebox Update Script
# Run on the server: sudo scalebox-update
#
set -euo pipefail

REPO="The-Agentic-Journey/Scalebox"
SCALEBOXD_BIN="/usr/local/bin/scaleboxd"
SCALEBOX_CLI="/usr/local/bin/scalebox"
SERVICE_FILE="/etc/systemd/system/scaleboxd.service"
HEALTH_URL="http://localhost:8080/health"
HEALTH_RETRIES=15
HEALTH_DELAY=2

log() { echo "[scalebox-update] $1"; }
die() { echo "[scalebox-update] ERROR: $1" >&2; exit 1; }

check_root() {
  [[ $EUID -eq 0 ]] || die "Must run as root. Try: sudo scalebox-update"
}

check_installed() {
  [[ -f "$SCALEBOXD_BIN" ]] || die "Scalebox not installed. Run bootstrap first."
  systemctl is-active scaleboxd &>/dev/null || die "scaleboxd service not running"
}

check_deps() {
  for cmd in curl jq tar; do
    command -v "$cmd" &>/dev/null || die "Required command not found: $cmd"
  done
}

get_release_url() {
  # Allow override for testing
  if [[ -n "${SCALEBOX_RELEASE_URL:-}" ]]; then
    echo "$SCALEBOX_RELEASE_URL"
    return
  fi

  local api_url="https://api.github.com/repos/$REPO/releases/latest"
  local download_url
  download_url=$(curl -sSL "$api_url" | jq -r '.assets[] | select(.name | endswith(".tar.gz")) | .browser_download_url' | head -1)

  if [[ -z "$download_url" || "$download_url" == "null" ]]; then
    die "Could not find latest release. Check https://github.com/$REPO/releases"
  fi

  echo "$download_url"
}

download_release() {
  local url=$1
  local temp_dir=$2

  log "Downloading: $url"
  curl -sSL "$url" | tar -xz -C "$temp_dir"

  # Verify required files exist
  [[ -f "$temp_dir/scaleboxd" ]] || die "scaleboxd not found in release"
  [[ -f "$temp_dir/scalebox" ]] || die "scalebox not found in release"
  [[ -f "$temp_dir/scaleboxd.service" ]] || die "scaleboxd.service not found in release"
}

backup_current() {
  log "Backing up current binary..."
  cp "$SCALEBOXD_BIN" "${SCALEBOXD_BIN}.prev"
}

install_new() {
  local temp_dir=$1

  log "Installing new scaleboxd..."
  cp "$temp_dir/scaleboxd" "$SCALEBOXD_BIN"
  chmod +x "$SCALEBOXD_BIN"

  log "Installing new scalebox CLI..."
  cp "$temp_dir/scalebox" "$SCALEBOX_CLI"
  chmod +x "$SCALEBOX_CLI"

  # Update scalebox-update itself
  if [[ -f "$temp_dir/scalebox-update" ]]; then
    log "Installing new scalebox-update..."
    cp "$temp_dir/scalebox-update" "/usr/local/bin/scalebox-update"
    chmod +x "/usr/local/bin/scalebox-update"
  fi

  # Only update service file if different
  if ! diff -q "$temp_dir/scaleboxd.service" "$SERVICE_FILE" &>/dev/null; then
    log "Updating systemd service file..."
    cp "$temp_dir/scaleboxd.service" "$SERVICE_FILE"
    systemctl daemon-reload
  fi
}

restart_service() {
  log "Restarting scaleboxd..."
  systemctl restart scaleboxd
}

health_check() {
  log "Waiting for health check..."
  local i=0
  while [[ $i -lt $HEALTH_RETRIES ]]; do
    if curl -sf "$HEALTH_URL" &>/dev/null; then
      log "Health check passed"
      return 0
    fi
    sleep $HEALTH_DELAY
    ((i++)) || true
  done
  return 1
}

rollback() {
  log "Rolling back to previous version..."
  if [[ -f "${SCALEBOXD_BIN}.prev" ]]; then
    cp "${SCALEBOXD_BIN}.prev" "$SCALEBOXD_BIN"
    systemctl restart scaleboxd
    if health_check; then
      log "Rollback successful"
    else
      die "Rollback failed - manual intervention required"
    fi
  else
    die "No backup found - manual intervention required"
  fi
}

cleanup() {
  rm -f "${SCALEBOXD_BIN}.prev" 2>/dev/null || true
}

main() {
  log "Starting Scalebox update..."

  check_root
  check_deps
  check_installed

  # Create temp directory for download
  local temp_dir
  temp_dir=$(mktemp -d)
  trap "rm -rf $temp_dir" EXIT

  # Get and download release
  local release_url
  release_url=$(get_release_url)
  download_release "$release_url" "$temp_dir"

  # Perform update with rollback on failure
  backup_current
  install_new "$temp_dir"
  restart_service

  if health_check; then
    cleanup
    log "Update complete!"
  else
    log "Health check failed after update"
    rollback
    die "Update failed - rolled back to previous version"
  fi
}

main "$@"
```

### Changes Required

**1. Add to `scripts/` directory:**
- Create `scripts/scalebox-update` with the above content

**2. Update `do_build()` in `./do`:**
```bash
# Add to existing copy commands:
cp scripts/scalebox-update builds/
chmod +x builds/scalebox-update
```

**3. Update `scripts/install.sh` to install scalebox-update:**
```bash
# In the install binaries section:
log "Installing scalebox-update..."
cp "$INSTALL_DIR/scalebox-update" /usr/local/bin/scalebox-update
chmod +x /usr/local/bin/scalebox-update
```

### Verification

- `./do build` includes scalebox-update in builds/
- `./do tarball` includes scalebox-update
- After bootstrap, `/usr/local/bin/scalebox-update` exists
- `sudo scalebox-update` works on running server

---

## Phase 2: CI Testing Strategy

**Goal**: Test both fresh installs and upgrades, with parallel CI execution.

### Two Commands, Clear Separation

| Command | What It Tests | When to Run |
|---------|---------------|-------------|
| `./do check` | Fresh install of current build | Locally + CI |
| `./do check-update` | Upgrade from last release → current | CI only (parallel) |

### CI Pipeline (Parallel Execution)

```yaml
# .github/workflows/ci.yml
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Fresh install test
        run: ./do check

  check-update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Upgrade test
        run: ./do check-update
```

Both jobs run **in parallel** on separate workers. Both must pass for PR to merge.

### Local Development

Developers only need to run `./do check` locally:
```bash
./do check           # Fast feedback, tests fresh install
```

The upgrade test runs automatically in CI - no need to run locally unless debugging an upgrade issue.

### New function: `do_check_update()` in `./do`

```bash
REPO="The-Agentic-Journey/Scalebox"

get_last_release_url() {
  local api_url="https://api.github.com/repos/$REPO/releases/latest"
  curl -sSL "$api_url" | jq -r '.assets[] | select(.name | endswith(".tar.gz")) | .browser_download_url' | head -1
}

do_check_update() {
  trap cleanup EXIT

  ensure_bun
  ensure_deps
  check_gcloud_project
  check_firewall_rule

  # Check for previous release
  echo "==> Fetching last release URL..."
  local old_release_url
  old_release_url=$(get_last_release_url 2>/dev/null || echo "")

  if [[ -z "$old_release_url" || "$old_release_url" == "null" ]]; then
    echo "==> No previous release found on GitHub"
    echo "==> Skipping upgrade test (expected for first release)"
    echo "==> check-update: SKIPPED"
    exit 0
  fi

  echo "==> Will bootstrap with last release: $old_release_url"

  echo "==> Building current tarball..."
  do_tarball

  ensure_gcs_bucket

  echo "==> Creating test VM..."
  create_vm
  wait_for_ssh
  create_dns_record

  # Bootstrap with LAST RELEASE (the old version)
  echo "==> Running bootstrap with LAST RELEASE..."
  provision_vm_bootstrap "$old_release_url"

  echo "==> Verifying initial install..."
  gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="systemctl is-active scaleboxd"

  # Upload CURRENT BUILD for update
  echo "==> Uploading current build for update..."
  local update_url
  update_url=$(upload_tarball "scalebox-test.tar.gz")

  echo "==> Running scalebox-update (last release → current build)..."
  gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="sudo SCALEBOX_RELEASE_URL='$update_url' scalebox-update"

  echo "==> Verifying update succeeded..."
  gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="curl -sf http://localhost:8080/health"

  # Run full test suite against updated system
  echo "==> Getting API token..."
  local token
  token=$(get_api_token)

  echo "==> Running integration tests against updated system..."
  VM_HOST="$VM_FQDN" USE_HTTPS=true API_TOKEN="$token" "$BUN_BIN" test

  echo "==> check-update: PASSED (last release → current build)"
}
```

### Add to case statement in `./do`

```bash
check-update)
  shift || true
  [[ "${1:-}" == "--keep-vm" ]] && KEEP_VM=true
  do_check_update
  ;;
```

### Behavior When No Previous Release

For the very first release (no releases on GitHub yet), `check-update`:
- Detects no previous release exists
- Prints clear message explaining why
- Exits with code 0 (success) - this is expected, not an error
- CI shows "SKIPPED" status

Once a release exists, `check-update` will automatically start testing upgrades.

### What Each Test Catches

| Issue | Caught By |
|-------|-----------|
| Code doesn't compile | `check` |
| Fresh install broken | `check` |
| Integration tests fail | `check` |
| New config key without default | `check-update` |
| Missing storage directory on upgrade | `check-update` |
| API changes break old clients | `check-update` |
| Rollback mechanism broken | `check-update` |

### Verification

- `./do check` works as before (no changes needed)
- `./do check-update` skips gracefully when no release exists
- `./do check-update` bootstraps with last release when available
- `./do check-update` updates to current build
- `./do check-update` runs full integration tests after update
- Both commands support `--keep-vm` flag for debugging

---

## Phase 3: Documentation

**Goal**: Document the update mechanism in the DDD glossary.

### Add to `product/DDD/glossary.md`

```markdown
---

## Operations Terms

### Update
The process of replacing the scaleboxd binary and related files on a running server with a newer version. Performed by running `scalebox-update` as root on the server.

### Rollback
Automatic restoration of the previous scaleboxd binary if a health check fails after an update. The previous binary is saved as `scaleboxd.prev` during the update process.

### scalebox-update
A server-side administration tool (installed at `/usr/local/bin/scalebox-update`) that handles updating Scalebox. Downloads the latest release, backs up the current binary, installs new files, restarts the service, and rolls back automatically if health checks fail.

**Note:** This is different from the `scalebox` CLI, which is a user-facing tool for interacting with the Scalebox API.
```

### Clarify existing CLI entry

Add note to make the distinction clear:

```markdown
### scalebox CLI
The user-facing command-line tool for interacting with the Scalebox API. Runs on the **user's machine**, not on the Scalebox server. Used for creating VMs, listing templates, etc.

**Note:** For server administration (updates, etc.), use `scalebox-update` directly on the server.
```

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `scripts/scalebox-update` | Create | Server-side update tool |
| `scripts/install.sh` | Modify | Install scalebox-update to /usr/local/bin |
| `do` | Modify | Add scalebox-update to build, add `check-update` command |
| `product/DDD/glossary.md` | Modify | Document update/rollback terms |

## What Gets Updated vs Preserved

### Updated (replaced):
- `/usr/local/bin/scaleboxd` - Main binary
- `/usr/local/bin/scalebox` - CLI script (for remote users)
- `/usr/local/bin/scalebox-update` - Update tool itself
- `/etc/systemd/system/scaleboxd.service` - Service file (if changed)

### Preserved (never touched):
- `/etc/scaleboxd/config` - API token, domains, etc.
- `/var/lib/scalebox/` - btrfs storage, templates, VMs
- `/usr/local/bin/firecracker` - Hypervisor binary
- Network config (bridge, iptables, etc.)
- Caddy config

## Admin Workflow

```bash
# SSH into server
ssh admin@scalebox-server

# Check current health
curl localhost:8080/health

# Run update
sudo scalebox-update

# Or update from specific URL (testing)
sudo SCALEBOX_RELEASE_URL=https://example.com/scalebox.tar.gz scalebox-update
```

## Error Scenarios

| Scenario | Behavior |
|----------|----------|
| Health check fails after update | Automatic rollback to .prev |
| No network to download | Error before any changes |
| Corrupt tarball | Error before any changes |
| No previous version (first update) | .prev created, rollback available |
| Service fails to restart | Rollback triggered |
| scalebox-update itself broken | Use SCALEBOX_RELEASE_URL to download fixed version |

## Verification Checklist

1. [ ] `scripts/scalebox-update` created with correct permissions
2. [ ] `./do build` includes scalebox-update in builds/
3. [ ] `./do tarball` includes scalebox-update
4. [ ] `install.sh` installs scalebox-update to /usr/local/bin/
5. [ ] After bootstrap, `scalebox-update` is executable on server
6. [ ] `sudo scalebox-update` works on running system
7. [ ] Update with bad binary rolls back automatically
8. [ ] `./do check-update` passes in CI
9. [ ] Config is preserved after update
10. [ ] Running VMs survive update (service restart is brief)
11. [ ] DDD glossary updated with operations terms

---

## Phase 4: Development Guidelines

**Goal**: Ensure developers think about backwards compatibility during feature development.

### Add to CLAUDE.md

Add new section after "Questions to Ask Before Major Changes":

```markdown
## Backwards Compatibility

Scalebox servers are updated in-place via `scalebox-update`. New code must work with old configurations and storage layouts.

### Rules for Config Changes

1. **New config keys MUST have defaults** in `src/config.ts`:
   ```typescript
   // GOOD: Has default, works with old configs
   newFeatureEnabled: process.env.NEW_FEATURE === "true" || false,

   // BAD: Crashes if not in config
   newFeatureEnabled: process.env.NEW_FEATURE === "true",
   ```

2. **Never rename config keys** - add new ones, deprecate old ones
3. **Document new config** in install.sh comments, but don't require it

### Rules for Storage Changes

1. **Create directories on demand**, not just in install.sh:
   ```typescript
   // GOOD: Creates if missing
   await fs.mkdir(newPath, { recursive: true });

   // BAD: Assumes directory exists
   await fs.writeFile(`${newPath}/file`, data);
   ```

2. **Never change existing paths** - old VMs/templates must still work

### Rules for Dependencies

1. **Prefer pure TypeScript** over system commands
2. **If new apt package needed**, add to update.sh:
   ```bash
   # In install_new():
   if ! command -v newcmd &>/dev/null; then
     apt-get install -y -qq newpackage
   fi
   ```

### Update Considerations Checklist

When planning a feature, ask:
- [ ] Does this add new config? → Add default in config.ts
- [ ] Does this need new directories? → Create on demand
- [ ] Does this need new system packages? → Add to update.sh
- [ ] Does this change API responses? → Is it additive only?
- [ ] Will `./do check-update` catch issues? → If not, add specific test
```

### Add to Plan Template

Update the plan template in CLAUDE.md to include update considerations:

```markdown
## Update Considerations

How will this feature behave when updating from an older version?

- **Config changes**: [New keys with defaults / None]
- **Storage changes**: [New directories created on demand / None]
- **Dependency changes**: [New packages in update.sh / None]
- **Migration needed**: [Yes - describe / No]
```

---

## Phase 5: Migration Support (Future)

**Goal**: Handle cases where backwards compatibility isn't enough.

For breaking changes that can't be made backwards-compatible, we may need migrations.

### Possible Approach

1. Add version tracking:
   ```bash
   # Written during install/update
   echo "1.2.3" > /etc/scaleboxd/version
   ```

2. Add migration runner to update.sh:
   ```bash
   run_migrations() {
     local current_version=$(cat /etc/scaleboxd/version 2>/dev/null || echo "0.0.0")
     local new_version=$(cat "$temp_dir/VERSION" 2>/dev/null || echo "0.0.0")

     # Run migrations for versions between current and new
     if version_lt "$current_version" "1.3.0"; then
       migrate_to_1_3_0
     fi
   }
   ```

**Not implementing now** - adds complexity. Only add if we have an actual breaking change.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `scripts/scalebox-update` | Create | Server-side update tool |
| `scripts/install.sh` | Modify | Install scalebox-update to /usr/local/bin |
| `do` | Modify | Add scalebox-update to build, add `check-update` command |
| `.github/workflows/ci.yml` | Create/Modify | Add parallel `check` and `check-update` jobs |
| `product/DDD/glossary.md` | Modify | Document update/rollback terms |
| `CLAUDE.md` | Modify | Add backwards compatibility guidelines + plan template |

## Verification Checklist

### Phase 1: scalebox-update script
1. [ ] `scripts/scalebox-update` created with correct permissions
2. [ ] `./do build` includes scalebox-update in builds/
3. [ ] `./do tarball` includes scalebox-update
4. [ ] `install.sh` installs scalebox-update to /usr/local/bin/
5. [ ] After bootstrap, `scalebox-update` is executable on server
6. [ ] `sudo scalebox-update` works on running system
7. [ ] Update with bad binary rolls back automatically
8. [ ] Config is preserved after update
9. [ ] Running VMs survive update (service restart is brief)

### Phase 2: CI Testing
10. [ ] `./do check` works as before (fresh install test)
11. [ ] `./do check-update` skips gracefully when no release exists
12. [ ] `./do check-update` bootstraps with LAST RELEASE when available
13. [ ] `./do check-update` updates to CURRENT BUILD
14. [ ] `./do check-update` runs integration tests after update
15. [ ] CI runs both jobs in parallel

### Phase 3: Documentation
16. [ ] DDD glossary updated with operations terms
17. [ ] CLAUDE.md updated with backwards compatibility guidelines
18. [ ] Plan template includes "Update Considerations" section

## Future Considerations

### Version Display (Optional Enhancement)
Could add `--version` flag to show current version and `--check` to show if update is available without applying it.

### Automatic Updates (Not Recommended)
Could add systemd timer for auto-updates, but manual control is safer for production systems.
