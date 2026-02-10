# Auto Script Installation Plan

## Problem

New scripts added to `scripts/` can be forgotten in `scalebox-update`, causing them to not be installed on servers. This requires manual intervention and creates inconsistency.

## Solution: Unified Install Manifest

Create a single manifest file that defines all installable files. Both `install.sh` and `scalebox-update` read from this manifest, ensuring consistency.

### Manifest Format

**`scripts/INSTALL_MANIFEST`:**
```
# Executables -> /usr/local/bin/
bin:scalebox
bin:scalebox-update
bin:scalebox-rebuild-template
bin:scalebox-resize-storage

# Libraries -> /usr/local/lib/scalebox/
lib:template-build.sh

# Services -> /etc/systemd/system/
service:scaleboxd.service
```

Format: `type:filename` where type is `bin`, `lib`, or `service`.

### Shared Install Function

Both scripts use the same logic to process the manifest:

```bash
install_from_manifest() {
  local src_dir=$1
  local manifest="$src_dir/INSTALL_MANIFEST"

  while read -r entry; do
    [[ -z "$entry" || "$entry" == \#* ]] && continue

    local type="${entry%%:*}"
    local name="${entry#*:}"
    [[ -f "$src_dir/$name" ]] || continue

    case "$type" in
      bin)
        log "Installing $name..."
        cp "$src_dir/$name" "/usr/local/bin/${name}.new"
        chmod +x "/usr/local/bin/${name}.new"
        mv "/usr/local/bin/${name}.new" "/usr/local/bin/$name"
        ;;
      lib)
        log "Installing $name library..."
        mkdir -p /usr/local/lib/scalebox
        cp "$src_dir/$name" "/usr/local/lib/scalebox/${name}.new"
        chmod 644 "/usr/local/lib/scalebox/${name}.new"
        mv "/usr/local/lib/scalebox/${name}.new" "/usr/local/lib/scalebox/$name"
        ;;
      service)
        if ! diff -q "$src_dir/$name" "/etc/systemd/system/$name" &>/dev/null; then
          log "Installing $name..."
          cp "$src_dir/$name" "/etc/systemd/system/$name"
          systemctl daemon-reload
        fi
        ;;
    esac
  done < "$manifest"
}
```

## Implementation Plan

### Phase 1: Create Manifest

1. Create `scripts/INSTALL_MANIFEST` with all current installable files
2. Include comments for clarity

### Phase 2: Update scalebox-update

1. Add `install_from_manifest()` function
2. Replace individual script installation blocks with single call
3. Keep scaleboxd binary installation separate (it's the main binary, not a script)

### Phase 3: Update install.sh

1. Add same `install_from_manifest()` function
2. Replace hardcoded script copies with manifest-based installation

### Phase 4: CI Safety Net

1. Add check to `./do check` that verifies:
   - All `scripts/scalebox-*` files are in manifest
   - All manifest entries exist in `scripts/`

```bash
check_manifest() {
  local manifest="scripts/INSTALL_MANIFEST"

  # Check all scalebox-* scripts are in manifest
  for script in scripts/scalebox-*; do
    name=$(basename "$script")
    grep -q "^bin:$name$" "$manifest" || {
      echo "ERROR: $name missing from INSTALL_MANIFEST"
      return 1
    }
  done

  # Check all manifest entries exist
  while read -r entry; do
    [[ -z "$entry" || "$entry" == \#* ]] && continue
    name="${entry#*:}"
    [[ -f "scripts/$name" ]] || {
      echo "ERROR: $name in manifest but not in scripts/"
      return 1
    }
  done < "$manifest"
}
```

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| scripts/INSTALL_MANIFEST | Create | Single source of truth for installable files |
| scripts/scalebox-update | Modify | Use manifest for installation |
| scripts/install.sh | Modify | Use manifest for installation |
| do | Modify | Add manifest validation check |

## Benefits

1. **Single source of truth** - One file defines what gets installed
2. **Can't forget** - CI check catches missing entries
3. **Consistency** - Install and update always install the same files
4. **Self-documenting** - Manifest shows exactly what gets deployed
5. **Easy to extend** - New file types can be added (e.g., `config:`)

## Verification

1. Create manifest with current files
2. Run `./do check` - should pass
3. Add a test script to `scripts/` without adding to manifest
4. Run `./do check` - should fail
5. Add to manifest, run `./do check` - should pass
6. Deploy and verify all scripts install correctly

## Update Considerations

- **Backwards compatible**: Old servers without manifest support will continue working until they update to a version with manifest support
- **No migration needed**: The manifest is read from the release tarball, not from the server
