# Fix Caddy Binary Deletion During Update Plan

## Overview

`./do check-update` CI job fails because `dpkg --remove caddy` deletes the custom Caddy binary that was just placed at `/usr/bin/caddy`. The update migration downloads the custom Caddy binary first, then runs `dpkg --remove caddy` to clean up apt metadata — but `dpkg --remove` also deletes all files belonging to the package, including `/usr/bin/caddy`. This leaves no Caddy binary on disk, so Caddy never starts after the update.

### Root Cause

In `scripts/scalebox-update` `migrate_caddy_binary()`:

```bash
# Current (broken) order:
curl ... -o /usr/bin/caddy.new
mv /usr/bin/caddy.new /usr/bin/caddy    # Step 1: custom binary placed
dpkg --remove caddy                      # Step 2: dpkg DELETES /usr/bin/caddy
```

`dpkg --remove` removes all files listed in `/var/lib/dpkg/info/caddy.list`, which includes `/usr/bin/caddy`. It doesn't know the file was replaced — it just deletes everything the package owns.

### Impact

- `./do check-update` always fails: after `scalebox-update`, Caddy never starts, port 443 is never served, integration tests fail with "Failed to connect to https://..."
- `./do check` is unaffected (fresh install uses `install.sh` which never uses apt for Caddy)
- Real-world updates from any pre-026 release to 026+ would have the same broken Caddy

## Acceptance Criteria

| # | Criterion | Acceptance Test |
|---|-----------|-----------------|
| 1 | `scalebox-update` `migrate_caddy_binary()` preserves the custom Caddy binary after removing apt metadata | `./do check-update`: integration tests pass against the updated system |

The acceptance test is the existing `./do check-update` CI pipeline. No new test scaffolds are needed — the bug is that this existing pipeline fails.

---

## Phase 1: Fix dpkg removal order in migrate_caddy_binary()

### Goal

Reorder `migrate_caddy_binary()` so that `dpkg --remove caddy` runs BEFORE downloading the custom binary, ensuring the custom binary survives on disk.

### Changes

| File | Action | Details |
|------|--------|---------|
| `scripts/scalebox-update` | Modify | Reorder `migrate_caddy_binary()`: move `dpkg --remove` before the custom binary download |

### Specific Change

Replace the body of `migrate_caddy_binary()` (lines 281-301) with:

```bash
migrate_caddy_binary() {
  # Check if current Caddy has acmeproxy module
  if /usr/bin/caddy list-modules 2>/dev/null | grep -q "dns.providers.acmeproxy"; then
    return 0
  fi

  log "Upgrading Caddy to custom build with acmeproxy module..."

  # Download custom binary to a temp location FIRST (before touching the existing install).
  # This ensures that if the download fails, the old apt-installed Caddy is still intact.
  local caddy_url="https://caddyserver.com/api/download?os=linux&arch=$(dpkg --print-architecture)&p=github.com/caddy-dns/acmeproxy"
  curl -sSL "$caddy_url" -o /usr/bin/caddy.new
  chmod +x /usr/bin/caddy.new

  # Remove apt package metadata. dpkg --remove deletes all files owned by the
  # package (including /usr/bin/caddy), so this MUST run after download but
  # BEFORE we move the custom binary into place.
  if dpkg -l caddy &>/dev/null; then
    dpkg --remove --force-remove-reinstreq caddy 2>/dev/null || true
  fi

  # Now move the pre-downloaded binary into place (safe — dpkg already ran)
  mv /usr/bin/caddy.new /usr/bin/caddy

  log "Caddy upgraded successfully"
}
```

**Key ordering**: download to `.new` → `dpkg --remove` (deletes old binary) → `mv .new` into place. This avoids both failure modes: dpkg can't delete our binary (it's still `.new`), and if download fails the old binary survives.

### Verification

- `./do check` passes (lint, build, deploy, integration tests)
- `./do check-update` passes (bootstrap with last release, update to current build, integration tests pass against updated system)

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `scripts/scalebox-update` | Modify | Reorder `dpkg --remove` before custom binary download in `migrate_caddy_binary()` |

---

## End-to-End Verification

After the fix:

1. `./do check` passes — fresh install still works
2. `./do check-update` passes — update from last release works, Caddy starts with custom binary, HTTPS serves traffic, integration tests pass

---

## Update Considerations

- **Config changes**: None
- **Storage changes**: None
- **Dependency changes**: None
- **Migration needed**: No — this fixes the migration itself
- **Backwards compatibility**: This fixes the update path from pre-026 releases. No impact on fresh installs.
