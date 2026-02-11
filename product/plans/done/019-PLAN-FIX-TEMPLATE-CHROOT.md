# Fix Template Chroot Environment Plan

## Problem

Claude Code installation fails during template build with:
```
/dev/null: Permission denied
Either curl or wget is required but neither is installed
```

The chroot environment is incomplete - missing bind mounts for `/dev`, `/proc`, `/sys` which are required for:
- Accessing `/dev/null` (used by many commands)
- Running installers that check system info via `/proc`
- Running `curl` which needs network access

## Solution

### Phase 1: Add Bind Mounts Before Chroot

**File: `scripts/template-build.sh`**

Add a function to set up and tear down bind mounts:

```bash
setup_chroot_mounts() {
  local rootfs_dir="$1"
  mount --bind /dev "$rootfs_dir/dev"
  mount --bind /dev/pts "$rootfs_dir/dev/pts"
  mount --bind /proc "$rootfs_dir/proc"
  mount --bind /sys "$rootfs_dir/sys"
  # Copy resolv.conf for network access
  cp /etc/resolv.conf "$rootfs_dir/etc/resolv.conf"
}

teardown_chroot_mounts() {
  local rootfs_dir="$1"
  umount "$rootfs_dir/sys" 2>/dev/null || true
  umount "$rootfs_dir/proc" 2>/dev/null || true
  umount "$rootfs_dir/dev/pts" 2>/dev/null || true
  umount "$rootfs_dir/dev" 2>/dev/null || true
}
```

### Phase 2: Update configure_rootfs to Use Mounts

**File: `scripts/template-build.sh`**

Modify `configure_rootfs()` to set up mounts before chroot and tear down after:

```bash
configure_rootfs() {
  local rootfs_dir="$1"

  # Set up chroot environment
  setup_chroot_mounts "$rootfs_dir"

  # Run configuration in chroot
  chroot "$rootfs_dir" /bin/bash <<'CHROOT'
  # ... existing configuration ...
CHROOT

  # Tear down chroot environment
  teardown_chroot_mounts "$rootfs_dir"
}
```

### Phase 3: Update Cleanup to Handle Mounts

**File: `scripts/template-build.sh`**

Update `cleanup_build()` to also unmount chroot bind mounts in case of failure:

```bash
cleanup_build() {
  local rootfs_dir="$1"
  local mount_dir="$2"
  # Unmount chroot bind mounts first
  teardown_chroot_mounts "$rootfs_dir"
  # Then unmount ext4 image
  umount "$mount_dir" 2>/dev/null || true
  rm -rf "$rootfs_dir" "$mount_dir" 2>/dev/null || true
}
```

### Phase 4: Install Claude for Both Root and User

The Claude installer installs to `~/.claude/`. We need it for both root and the `user` account:

```bash
# Install Claude Code CLI for root
curl -fsSL https://claude.ai/install.sh | bash

# Install Claude Code CLI for user
su - user -c 'curl -fsSL https://claude.ai/install.sh | bash'
```

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| scripts/template-build.sh | Modify | Add bind mounts for proper chroot environment |

## Verification

```bash
# Rebuild template
scalebox-rebuild-template

# Should complete without errors
# Should show: "Installing Claude Code..."

# Create VM and verify
sb go
claude --version  # Should work
```

## Update Considerations

- **Config changes**: None
- **Storage changes**: None
- **Dependency changes**: None
- **Migration needed**: No - just rebuild template
