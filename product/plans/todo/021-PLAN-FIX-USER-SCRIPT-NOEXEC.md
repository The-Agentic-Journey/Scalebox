# Fix User Setup Script Execution in CI

## Problem

The user setup script approach fails in GitHub Actions CI with:

```
sudo: unable to execute /tmp/setup-user.sh: Permission denied
```

This occurs because `/tmp` may be mounted with `noexec` option in the CI environment, preventing direct execution of scripts from `/tmp`.

## Solution

Instead of making the script executable and running it directly, invoke it through `bash`:

```bash
# Before (fails with noexec /tmp):
sudo -u user /tmp/setup-user.sh

# After (works regardless of noexec):
sudo -u user bash /tmp/setup-user.sh
```

This bypasses the `noexec` restriction because `bash` is the executable, and the script is just an argument (a file to read).

## Implementation

**File: `scripts/template-build.sh`**

Change line ~103 from:
```bash
if ! chroot "$rootfs_dir" sudo -u user /tmp/setup-user.sh; then
```

To:
```bash
if ! chroot "$rootfs_dir" sudo -u user bash /tmp/setup-user.sh; then
```

Also remove the now-unnecessary `chmod +x` line since we're not executing the script directly.

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| scripts/template-build.sh | Modify | Use `bash /tmp/setup-user.sh` instead of direct execution |

## Verification

The check-update CI job should pass after this change.

## Update Considerations

- **Config changes**: None
- **Storage changes**: None
- **Dependency changes**: None
- **Migration needed**: No
