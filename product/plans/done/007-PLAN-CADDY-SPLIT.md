# Plan: Split Caddyfile into Static and Dynamic Parts

## Overview

The current Caddy configuration is managed by two systems: `install.sh` writes the initial Caddyfile with API domain, and `caddy.ts` regenerates the entire file on VM changes (losing the API domain). This causes the API to become inaccessible after the first VM is created.

**Solution:** Split the Caddyfile into static (install-time) and dynamic (runtime) parts using Caddy's `import` directive.

## Architecture

### Current (broken)

```
install.sh → writes Caddyfile (API + VM domain)
                    ↓
           VM created/deleted
                    ↓
caddy.ts → overwrites entire Caddyfile (VM domain only, API domain lost!)
```

### Proposed

```
install.sh → writes /etc/caddy/Caddyfile (static: global options + API domain + import)
           → creates /etc/caddy/vms.caddy (empty stub)

caddy.ts → writes /etc/caddy/vms.caddy only (dynamic: VM routes)
```

## File Structure

### /etc/caddy/Caddyfile (static, managed by install.sh)

```caddy
{
    on_demand_tls {
        ask http://localhost:8080/caddy/check
    }
}

# API domain (only if API_DOMAIN is set)
sbapi.example.com {
    reverse_proxy localhost:8080
}

# Import dynamic VM routes
import /etc/caddy/vms.caddy
```

### /etc/caddy/vms.caddy (dynamic, managed by scaleboxd)

```caddy
# VM domain wildcard (only if VM_DOMAIN is set)
*.vms.example.com {
    tls {
        on_demand
    }

    @vm-name host vm-name.vms.example.com
    handle @vm-name {
        reverse_proxy 172.16.0.2:8080
    }

    handle {
        respond "VM not found" 404
    }
}
```

## Phases

### Phase 1: Add apiDomain to config

**Goal:** Make API domain available at runtime.

**Changes:**

1. `src/config.ts` - Add `apiDomain` field:
   ```typescript
   apiDomain: process.env.API_DOMAIN || "",
   ```

2. `scripts/install.sh` - Add `API_DOMAIN` to scaleboxd config file:
   ```bash
   # In install_service()
   API_DOMAIN=$API_DOMAIN
   ```

**Verification:** Config loads correctly with new field.

### Phase 2: Update install.sh to write split Caddyfile

**Goal:** Install creates static Caddyfile with import statement.

**Changes:**

1. `scripts/install.sh` - Rewrite `install_caddy()` function:
   - Write static `/etc/caddy/Caddyfile` with global options + API domain + import
   - Create empty `/etc/caddy/vms.caddy` stub (so Caddy can start)
   - Don't write VM wildcard block here (that's dynamic)

**Caddyfile template:**
```caddy
{
    on_demand_tls {
        ask http://localhost:8080/caddy/check
    }
}

$API_DOMAIN_BLOCK

import /etc/caddy/vms.caddy
```

Where `$API_DOMAIN_BLOCK` is conditionally included if `API_DOMAIN` is set.

**Verification:** Fresh install creates both files, Caddy starts successfully.

### Phase 3: Update caddy.ts to write only vms.caddy

**Goal:** scaleboxd only manages the dynamic VM routes file.

**Changes:**

1. `src/services/caddy.ts` - Update `updateCaddyConfig()`:
   - Write to `/etc/caddy/vms.caddy` instead of `/etc/caddy/Caddyfile`
   - Only include VM wildcard block and routes
   - Handle case when `vmDomain` is not set (write comment-only file)
   - Use atomic writes (write to .tmp, then rename)
   - Rollback on Caddy reload failure

**Updated function signature:**
```typescript
const VMSFILE = "/etc/caddy/vms.caddy";
const VMSFILE_TMP = "/etc/caddy/vms.caddy.tmp";

export async function updateCaddyConfig(): Promise<void> {
  // Build content
  const content = buildVmsCaddyContent();

  // Read current content for potential rollback
  let previousContent: string | null = null;
  try {
    previousContent = await readFile(VMSFILE, "utf-8");
  } catch {
    // File doesn't exist yet, no rollback needed
  }

  // Atomic write: write to .tmp then rename
  await writeFile(VMSFILE_TMP, content);
  await rename(VMSFILE_TMP, VMSFILE);

  // Reload Caddy
  try {
    await exec("systemctl reload caddy");
  } catch (error) {
    // Rollback on failure
    if (previousContent !== null) {
      await writeFile(VMSFILE, previousContent);
    }
    console.error("Caddy reload failed, rolled back vms.caddy:", error);
    // Don't throw - VM operation should still succeed
  }
}
```

**Content when vmDomain is set:**
```caddy
# Managed by scaleboxd - do not edit manually
*.${vmDomain} {
    tls {
        on_demand
    }

    ${vmRoutes}

    handle {
        respond "VM not found" 404
    }
}
```

**Content when vmDomain is NOT set:**
```caddy
# Managed by scaleboxd - do not edit manually
# VM routes are added here when VM_DOMAIN is configured
```

**Verification:**
- Create VM → vms.caddy updated atomically, Caddyfile unchanged
- API still accessible after VM creation
- Simulate Caddy reload failure → vms.caddy rolled back, VM still created

### Phase 4: Handle scaleboxd startup

**Goal:** Ensure vms.caddy is correct on scaleboxd restart.

**Changes:**

1. `src/index.ts` - Call `updateCaddyConfig()` on startup:
   - Regenerate vms.caddy from current VM state (empty on fresh start)
   - Ensures consistency after service restart

**Verification:** Restart scaleboxd, verify vms.caddy is regenerated correctly.

### Phase 5: Migration via scalebox-update

**Goal:** Existing servers with old single-file Caddyfile are migrated automatically.

**Update flow:**
```
scalebox-update runs
    ↓
Downloads new tarball (scaleboxd, scripts)
    ↓
Stops scaleboxd
    ↓
Installs new binary + scripts
    ↓
>>> Migrates Caddyfile if needed <<<
    ↓
Starts scaleboxd (which regenerates vms.caddy)
    ↓
Health check
```

**Migration logic in scalebox-update:**

```bash
migrate_caddy_config() {
  local caddyfile="/etc/caddy/Caddyfile"
  local vmsfile="/etc/caddy/vms.caddy"

  # Skip if already migrated (import statement exists)
  if grep -q "import /etc/caddy/vms.caddy" "$caddyfile" 2>/dev/null; then
    return 0
  fi

  log "Migrating Caddyfile to split format..."

  # Extract API_DOMAIN from scaleboxd config (if set)
  local api_domain=""
  if [[ -f /etc/scaleboxd/config ]]; then
    api_domain=$(grep -E "^API_DOMAIN=" /etc/scaleboxd/config | cut -d= -f2-)
  fi

  # Write new static Caddyfile
  cat > "$caddyfile" << EOF
{
    on_demand_tls {
        ask http://localhost:8080/caddy/check
    }
}
EOF

  # Add API domain block if configured
  if [[ -n "$api_domain" ]]; then
    cat >> "$caddyfile" << EOF

$api_domain {
    reverse_proxy localhost:8080
}
EOF
  fi

  # Add import statement
  cat >> "$caddyfile" << EOF

import /etc/caddy/vms.caddy
EOF

  # Create stub vms.caddy (scaleboxd will populate on startup)
  cat > "$vmsfile" << EOF
# Managed by scaleboxd - do not edit manually
# VM routes will be generated on scaleboxd startup
EOF

  log "Caddyfile migration complete"
}
```

**Call migration before starting service:**
```bash
# In scalebox-update main():
install_new "$temp_dir"
migrate_caddy_config      # <-- Add this
start_service
```

**Changes:**

1. `scripts/scalebox-update` - Add `migrate_caddy_config()` function
2. `scripts/install.sh` - Ensure API_DOMAIN is written to /etc/scaleboxd/config (already should be, verify)

**Verification:**
- Old server with single Caddyfile → run scalebox-update → split format created
- Already-migrated server → run scalebox-update → no changes to Caddyfile

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/config.ts` | Modify | Add `apiDomain` field |
| `src/services/caddy.ts` | Modify | Write to vms.caddy only |
| `src/index.ts` | Modify | Call updateCaddyConfig on startup |
| `scripts/install.sh` | Modify | Write split Caddyfile + empty vms.caddy |
| `scripts/scalebox-update` | Modify | Migrate old installs to split format |

## Verification

1. **Fresh install:** Both Caddy files created, API accessible
2. **Create VM:** vms.caddy updated, API still accessible
3. **Delete VM:** vms.caddy updated, API still accessible
4. **Restart scaleboxd:** vms.caddy regenerated correctly
5. **Update old install:** Migrated to split format, nothing breaks

## Update Considerations

- **Existing servers:** scalebox-update detects old format and migrates automatically
- **Config changes:** API_DOMAIN should already be in /etc/scaleboxd/config from install (verify in Phase 1)
- **File changes:** New `/etc/caddy/vms.caddy` file created by migration
- **Running VMs:** Migration creates stub vms.caddy; scaleboxd regenerates with actual VM routes on startup. Brief window where VM HTTPS routes are missing (between Caddy reload and scaleboxd startup). Acceptable since it's seconds.
- **Rollback scenario:** If new scaleboxd fails health check, scalebox-update rolls back binary. Caddyfile is already migrated but that's fine - the import statement is harmless even if vms.caddy is a stub.
- **Manual rollback:** If admin manually rolls back to old scaleboxd, it will overwrite entire Caddyfile again. Document that rollback requires also reverting Caddyfile, or accept that old version has the same bug.

## Design Decisions

1. **Empty vms.caddy:** Include a comment explaining the file's purpose:
   ```caddy
   # Managed by scaleboxd - do not edit manually
   # VM routes are added here when VM_DOMAIN is configured
   ```

2. **Atomic writes:** Yes - write to `/etc/caddy/vms.caddy.tmp` then `rename()` for atomicity. Prevents Caddy from reading partial files during reload.

3. **Rollback on failure:** Yes - if `systemctl reload caddy` fails:
   - Keep backup of previous vms.caddy content in memory
   - Restore previous content on reload failure
   - Log error but don't crash scaleboxd
   - VM creation/deletion should still succeed (just without HTTPS routing)
