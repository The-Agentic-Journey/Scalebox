# Template Update Mechanism Plan

## Overview

When Scalebox is updated, the `debian-base` template may need to be recreated to include new packages (like mosh). Currently, `scalebox-update` only updates binaries and never touches templates, treating them as persistent data. This plan adds a mechanism to detect when template recreation is needed and perform it safely.

## Problem Statement

1. Phase 5 of the Connect Command plan added mosh to `install.sh` for new template creation
2. `scalebox-update` doesn't recreate templates - they're treated as persistent data
3. Existing servers still have old `debian-base` without mosh
4. Users get confusing errors: "mosh-server: command not found"

## Design Principles

1. **Backwards compatible** - Old templates must continue to work
2. **Safe** - Never break existing VMs or lose user data
3. **Explicit** - Template recreation requires explicit action, not automatic
4. **Versioned** - Track template versions to know when updates are needed

## Phases

### Phase 1: Template Versioning

**Goal:** Track template versions to detect when updates are needed.

**Changes:**

1. Add version file to template directory:
   ```
   /var/lib/scalebox/templates/debian-base.version
   ```
   Contains: `1` (initial version), `2` (with mosh), etc.

2. Update `install.sh` to write version file when creating template:
   ```bash
   TEMPLATE_VERSION=2  # Increment when template contents change

   create_rootfs() {
     # ... existing template creation ...

     # Write version file
     echo "$TEMPLATE_VERSION" > "$DATA_DIR/templates/debian-base.version"
   }
   ```

3. Add version constant to `scalebox-update`:
   ```bash
   REQUIRED_TEMPLATE_VERSION=2
   ```

**Verification:**
- Fresh install creates version file with current version
- Version file is readable

**Files:**
| File | Action | Purpose |
|------|--------|---------|
| `scripts/install.sh` | Modify | Write version file after template creation |
| `scripts/scalebox-update` | Modify | Add version constant |

---

### Phase 2: Template Update Detection

**Goal:** Detect when template needs updating and inform the user.

**Changes:**

1. Add `check_template_version()` function to `scalebox-update`:
   ```bash
   check_template_version() {
     local version_file="$DATA_DIR/templates/debian-base.version"
     local current_version=0

     if [[ -f "$version_file" ]]; then
       current_version=$(cat "$version_file")
     fi

     if [[ "$current_version" -lt "$REQUIRED_TEMPLATE_VERSION" ]]; then
       echo ""
       echo "==> Template update available"
       echo "    Current: v${current_version}, Required: v${REQUIRED_TEMPLATE_VERSION}"
       echo "    Run: scalebox-rebuild-template"
       echo ""
       return 1
     fi
     return 0
   }
   ```

2. Call this check after successful update:
   ```bash
   # After health check passes
   check_template_version || true  # Warn but don't fail
   ```

**Verification:**
- Update on server with old template shows warning message
- Update on server with current template shows no warning

**Files:**
| File | Action | Purpose |
|------|--------|---------|
| `scripts/scalebox-update` | Modify | Add version check and warning |

---

### Phase 3: Template Rebuild Command

**Goal:** Create a separate `scalebox-rebuild-template` command to safely recreate the base template.

**Changes:**

1. Create `scripts/scalebox-rebuild-template`:
   ```bash
   #!/bin/bash
   set -euo pipefail

   # Scalebox Template Rebuild Tool
   # Recreates the debian-base template with latest packages

   DATA_DIR="/var/lib/scalebox"
   TEMPLATE_VERSION=2

   log() { echo "==> $1"; }
   die() { echo "Error: $1" >&2; exit 1; }

   check_root() {
     [[ $EUID -eq 0 ]] || die "Must be run as root"
   }

   rebuild_template() {
     local template_path="$DATA_DIR/templates/debian-base.ext4"
     local backup_path="$DATA_DIR/templates/debian-base.ext4.old"

     log "Rebuilding debian-base template..."

     # Check for running VMs (they're fine - btrfs COW handles it)
     # But inform the user about the situation
     if systemctl is-active scaleboxd &>/dev/null; then
       local vm_count
       vm_count=$(curl -sf -H "Authorization: Bearer $(grep API_TOKEN /etc/scaleboxd/config | cut -d= -f2)" \
         "http://localhost:8080/vms" 2>/dev/null | jq '.vms | length' || echo "0")
       if [[ "$vm_count" -gt 0 ]]; then
         echo "Note: $vm_count VM(s) currently running."
         echo "      They will continue to work (btrfs copy-on-write)."
         echo "      New VMs will use the updated template."
         echo ""
       fi
     fi

     # Backup existing template
     if [[ -f "$template_path" ]]; then
       log "Backing up existing template..."
       mv "$template_path" "$backup_path"
     fi

     # Recreate template using shared build script
     log "Creating new template (this takes 2-3 minutes)..."
     if ! source /usr/local/lib/scalebox/template-build.sh && build_debian_base "$DATA_DIR"; then
       # Restore backup on failure
       if [[ -f "$backup_path" ]]; then
         log "Template creation failed, restoring backup..."
         mv "$backup_path" "$template_path"
       fi
       die "Template rebuild failed"
     fi

     # Remove backup on success
     rm -f "$backup_path"

     log "Template rebuilt successfully (v${TEMPLATE_VERSION})"
   }

   main() {
     check_root
     rebuild_template
   }

   main "$@"
   ```

2. Install to `/usr/local/bin/scalebox-rebuild-template` during update.

**Verification:**
- `scalebox-rebuild-template` recreates template
- Running VMs continue to work during and after rebuild
- New VMs use the new template
- Template version file is updated

**Files:**
| File | Action | Purpose |
|------|--------|---------|
| `scripts/scalebox-rebuild-template` | Create | Standalone rebuild command |
| `scripts/scalebox-update` | Modify | Install the new script during updates |

---

### Phase 4: Shared Template Build Logic

**Goal:** Extract template creation into a reusable script.

**Changes:**

1. Create `scripts/template-build.sh` with the template creation logic:
   ```bash
   #!/bin/bash
   # Template build script - used by install.sh and scalebox-rebuild-template
   # Installed to: /usr/local/lib/scalebox/template-build.sh

   TEMPLATE_VERSION=2

   build_debian_base() {
     local data_dir="${1:-/var/lib/scalebox}"
     local template_path="$data_dir/templates/debian-base.ext4"
     local version_path="$data_dir/templates/debian-base.version"

     # Create temp directories
     local rootfs_dir=$(mktemp -d /tmp/rootfs-XXXXXX)
     local mount_dir=$(mktemp -d /tmp/mount-XXXXXX)
     trap "cleanup_build '$rootfs_dir' '$mount_dir'" EXIT

     # Run debootstrap with all required packages
     debootstrap --include=openssh-server,iproute2,iputils-ping,haveged,netcat-openbsd,mosh \
       bookworm "$rootfs_dir" http://deb.debian.org/debian

     # Configure the rootfs
     configure_rootfs "$rootfs_dir"

     # Create ext4 image
     create_ext4_image "$rootfs_dir" "$mount_dir" "$template_path"

     # Write version file
     echo "$TEMPLATE_VERSION" > "$version_path"

     trap - EXIT
     cleanup_build "$rootfs_dir" "$mount_dir"
   }

   # ... helper functions (configure_rootfs, create_ext4_image, cleanup_build) ...
   ```

2. Update `install.sh` to source and use this script:
   ```bash
   source "$(dirname "$0")/template-build.sh"

   create_rootfs() {
     if [[ -f "$template_path" ]]; then
       log "Base template already exists"
       return
     fi
     build_debian_base "$DATA_DIR"
   }
   ```

3. Update `scalebox-update` to install the shared script:
   ```bash
   install_new() {
     # ... existing installs ...

     # Install shared library
     mkdir -p /usr/local/lib/scalebox
     install -m 644 "$temp_dir/template-build.sh" /usr/local/lib/scalebox/

     # Install rebuild command
     install -m 755 "$temp_dir/scalebox-rebuild-template" /usr/local/bin/
   }
   ```

**Verification:**
- Fresh install uses shared script
- `scalebox-rebuild-template` uses shared script
- Both produce identical templates

**Files:**
| File | Action | Purpose |
|------|--------|---------|
| `scripts/template-build.sh` | Create | Shared template creation logic |
| `scripts/scalebox-rebuild-template` | Create | Standalone rebuild command |
| `scripts/install.sh` | Modify | Use shared script |
| `scripts/scalebox-update` | Modify | Install shared script and rebuild command |

---

### Phase 5: Documentation

**Goal:** Document the template update mechanism.

**Changes:**

1. Update `product/DDD/glossary.md`:
   - Add "Template Version" term
   - Add "Template Rebuild" term

2. Update `README.md` (or create operations guide):
   - Document `scalebox-rebuild-template`
   - Explain when template rebuilds are needed
   - Note that running VMs are not affected

3. Update `product/ADR/` if needed:
   - Document the design decision for explicit template rebuilds

**Files:**
| File | Action | Purpose |
|------|--------|---------|
| `product/DDD/glossary.md` | Modify | Add new terms |
| `README.md` | Modify | Document template rebuild |

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `scripts/template-build.sh` | Create | Shared template creation logic |
| `scripts/scalebox-rebuild-template` | Create | Standalone rebuild command |
| `scripts/install.sh` | Modify | Use shared script, write version |
| `scripts/scalebox-update` | Modify | Add version check, install rebuild command |
| `product/DDD/glossary.md` | Modify | Add new terms |
| `README.md` | Modify | Document template operations |

## Verification

1. **Fresh install:**
   - Template created with version file
   - Version matches TEMPLATE_VERSION constant

2. **Update on old server:**
   - Shows "template update available" warning
   - Provides command to rebuild

3. **Template rebuild:**
   - `scalebox-rebuild-template` works
   - Running VMs continue to work
   - New VMs have mosh installed
   - Version file updated

4. **Integration test:**
   - Add test that verifies mosh is installed in debian-base

## Update Considerations

- **Config changes**: None
- **Storage changes**: New version file (created on demand)
- **Dependency changes**: None (debootstrap already installed)
- **Migration needed**: No - explicit user action via `scalebox-rebuild-template`
- **New files installed**: `/usr/local/bin/scalebox-rebuild-template`, `/usr/local/lib/scalebox/template-build.sh`

## Alternative Considered: Automatic Rebuild

We could automatically rebuild templates during update, but this is rejected because:

1. **Time**: Template creation takes 2-3 minutes
2. **Complexity**: Need to handle failures, rollback
3. **User expectations**: Updates should be fast and predictable
4. **Safety**: Explicit is better than implicit for data operations

The chosen approach (warn + explicit command) is safer and more transparent.
