# Template Version Synchronization Plan

## Problem

Template version is defined in 4 separate files that must stay in sync:
- `scripts/template-build.sh` - TEMPLATE_VERSION=5 (source of truth)
- `scripts/install.sh` - TEMPLATE_VERSION=4 (outdated)
- `scripts/scalebox-rebuild-template` - TEMPLATE_VERSION=4 (outdated)
- `scripts/scalebox-update` - REQUIRED_TEMPLATE_VERSION=4 (outdated)

When template-build.sh was updated to v5, the others weren't updated, so `scalebox-update` never warns about needing a rebuild.

## Solution

### Phase 1: Single Source of Truth

Make `template-build.sh` the only place where TEMPLATE_VERSION is defined. Other scripts should source it or extract the value.

**File: `scripts/scalebox-update`**

Replace hardcoded `REQUIRED_TEMPLATE_VERSION=4` with extraction from template-build.sh:
```bash
# Extract required template version from template-build.sh
REQUIRED_TEMPLATE_VERSION=$(grep -E '^TEMPLATE_VERSION=' /usr/local/lib/scalebox/template-build.sh | cut -d= -f2)
```

**File: `scripts/scalebox-rebuild-template`**

Remove local `TEMPLATE_VERSION=4`. The script already sources template-build.sh, so use that version:
```bash
# After sourcing template-build.sh, $TEMPLATE_VERSION is available
log "Template rebuilt successfully (v${TEMPLATE_VERSION})"
```

**File: `scripts/install.sh`**

Remove `TEMPLATE_VERSION=4`. Source template-build.sh to get the version:
```bash
# Source template-build.sh for TEMPLATE_VERSION
source "$(dirname "$0")/template-build.sh"
```

### Phase 2: Update Version File Write Location

Currently install.sh writes the version file separately. It should use the version from template-build.sh or just let build_debian_base() handle it (which it already does).

Remove this line from install.sh:
```bash
echo "$TEMPLATE_VERSION" > "$DATA_DIR/templates/debian-base.version"
```

The version file is already written by build_debian_base() in template-build.sh.

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| scripts/scalebox-update | Modify | Extract version from template-build.sh |
| scripts/scalebox-rebuild-template | Modify | Remove duplicate TEMPLATE_VERSION |
| scripts/install.sh | Modify | Source template-build.sh for version |

## Verification

```bash
# After update, scalebox-update should warn about template version mismatch
scalebox-update
# Expected: "[scalebox-update] Template rebuild recommended..."

# Verify version extraction works
grep TEMPLATE_VERSION /usr/local/lib/scalebox/template-build.sh
# Should show: TEMPLATE_VERSION=5
```

## Update Considerations

- **Config changes**: None
- **Storage changes**: None
- **Dependency changes**: None
- **Migration needed**: No
- **Breaking changes**: None - just consolidating version source
