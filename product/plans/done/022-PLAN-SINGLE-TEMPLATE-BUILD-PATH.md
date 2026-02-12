# Single Template Build Code Path

## Problem

There are two issues causing CI failures:

### Issue 1: Duplicated Template Build Code

`install.sh` has a fallback code path (lines 254-328) that duplicates template building logic instead of using `template-build.sh`. This causes:

- `./do check` uses the simple fallback code (no Claude install, no npm, etc.)
- `check-update` uses `template-build.sh` via `scalebox-rebuild-template`
- Bugs in `template-build.sh` are never caught by `./do check`

### Issue 2: npm Fails During debootstrap

The debootstrap `--include` list contains `nodejs,npm` but npm's postinst script fails because:

1. **npm requires a writable HOME directory** - doesn't exist during debootstrap's second stage
2. **npm may need /dev, /proc, /sys** - not mounted during debootstrap

This causes:
```
W: Failure while configuring base packages. This will be re-attempted up to five times.
W: See /tmp/rootfs-.../debootstrap/debootstrap.log for details (possibly the package npm is at fault)
```

After 5 retries, debootstrap continues but the chroot is in a broken state, causing:
```
sudo: unable to execute /usr/bin/bash: Permission denied
```

## Solution

### Part 1: Fix npm Installation

Move nodejs, npm, and other problematic packages OUT of debootstrap `--include` and install them AFTER bind mounts are set up.

**File: `scripts/template-build.sh`**

Change debootstrap from:
```bash
debootstrap --include=openssh-server,iproute2,iputils-ping,haveged,netcat-openbsd,mosh,locales,sudo,curl,wget,vim,nodejs,npm,python3,python3-pip,python3-venv \
  bookworm "$rootfs_dir" http://deb.debian.org/debian
```

To minimal packages only:
```bash
debootstrap --include=openssh-server,iproute2,iputils-ping,haveged,netcat-openbsd,mosh,locales,sudo,curl,wget,vim \
  bookworm "$rootfs_dir" http://deb.debian.org/debian
```

Then in `configure_rootfs()`, AFTER `setup_chroot_mounts()`, install the remaining packages:
```bash
setup_chroot_mounts "$rootfs_dir"

# Install packages that need proper chroot environment (nodejs, npm, python3-pip)
# These fail if included in debootstrap because their postinst scripts need /dev, /proc, /sys
echo "[template-build] Installing development packages..."
chroot "$rootfs_dir" apt-get update
chroot "$rootfs_dir" apt-get install -y nodejs npm python3-pip python3-venv

chroot "$rootfs_dir" /bin/bash <<'CHROOT'
# ... existing root configuration ...
CHROOT
```

### Part 2: Single Template Build Path in install.sh

Make `install.sh` use `template-build.sh` from the tarball instead of duplicated fallback code.

**File: `scripts/install.sh`**

The tarball contains `template-build.sh` in `INSTALL_DIR`. Change `create_rootfs()` to:

```bash
create_rootfs() {
  local template_path="$DATA_DIR/templates/debian-base.ext4"

  if [[ -f "$template_path" ]]; then
    log "Base template already exists"
    return
  fi

  log "Creating Debian base template (this takes a few minutes)..."

  # Source template-build.sh from install directory (shipped in tarball)
  # This ensures install.sh and scalebox-rebuild-template use identical code
  source "$INSTALL_DIR/template-build.sh"
  build_debian_base "$DATA_DIR"
}
```

Remove the entire fallback section (lines 254-328 approximately) that duplicates template building logic.

### Part 3: Install template-build.sh Library Earlier

Ensure `template-build.sh` is installed to `/usr/local/lib/scalebox/` BEFORE `create_rootfs()` is called, so subsequent rebuilds work.

In `install.sh`, move the library installation before template creation:

```bash
install_template_library() {
  log "Installing template-build.sh library..."
  mkdir -p /usr/local/lib/scalebox
  cp "$INSTALL_DIR/template-build.sh" /usr/local/lib/scalebox/
  chmod 644 /usr/local/lib/scalebox/template-build.sh
}

# In main():
install_template_library  # Before create_rootfs
create_rootfs
```

## Implementation Order

1. **Phase 1**: Fix template-build.sh
   - Remove nodejs, npm, python3-pip, python3-venv from debootstrap --include
   - Add apt-get install for these packages after setup_chroot_mounts()

2. **Phase 2**: Simplify install.sh
   - Remove duplicated fallback template code
   - Source template-build.sh from INSTALL_DIR
   - Install template-build.sh library early

3. **Phase 3**: Test
   - `./do check` should now exercise the same code path as `check-update`
   - Both should succeed

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| scripts/template-build.sh | Modify | Remove npm from debootstrap, install via apt-get after mounts |
| scripts/install.sh | Modify | Use template-build.sh instead of fallback code |

## Verification

```bash
# Both should pass and use the same template building code
./do check
./do check-update
```

## Why This Works

1. **npm installs correctly** because apt-get runs AFTER bind mounts provide /dev, /proc, /sys, and a proper HOME directory exists

2. **Single code path** ensures any bug in template building is caught by `./do check`, not just `check-update`

3. **No code duplication** - template-build.sh is the single source of truth

## Update Considerations

- **Config changes**: None
- **Storage changes**: None
- **Dependency changes**: None
- **Migration needed**: No - existing templates continue to work, new templates built with fixed code
