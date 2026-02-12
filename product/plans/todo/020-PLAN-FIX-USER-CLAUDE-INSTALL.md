# Fix Claude Installation for User Account

## Problem

Claude Code CLI is not available to the `user` account in VMs, even though the template build script attempts to install it. The current approach uses:

```bash
su - user -c 'curl -fsSL https://claude.ai/install.sh | bash'
```

This likely fails silently inside the chroot environment because:
1. `su -` (login shell) requires proper PAM session setup which isn't available in chroot
2. The login shell may fail to initialize properly without `/dev/pts` terminal allocation
3. Error output may be swallowed, making debugging difficult

## Solution

### Phase 1: Use runuser Instead of su

Replace `su - user` with `runuser` which is designed for non-interactive user switching and doesn't require PAM:

**File: `scripts/template-build.sh`**

Change from:
```bash
# Install Claude Code CLI for user
su - user -c 'curl -fsSL https://claude.ai/install.sh | bash'
```

To:
```bash
# Install Claude Code CLI for user
# Use runuser instead of su - it works better in chroot without PAM
runuser -u user -- bash -l -c 'curl -fsSL https://claude.ai/install.sh | bash'
```

The `-l` flag ensures bash runs as a login shell to set up PATH correctly.

### Phase 2: Add Error Handling

Add explicit error checking to catch installation failures:

```bash
# Install Claude Code CLI for user
echo "[template-build] Installing Claude Code CLI for user..."
if ! runuser -u user -- bash -l -c 'curl -fsSL https://claude.ai/install.sh | bash'; then
  echo "[template-build] WARNING: Claude Code CLI installation failed for user"
fi
```

### Phase 3: Verify Installation

Add a verification step after installation:

```bash
# Verify Claude installation for user
if runuser -u user -- bash -l -c 'command -v claude >/dev/null 2>&1'; then
  echo "[template-build] Claude Code CLI installed successfully for user"
else
  echo "[template-build] WARNING: Claude Code CLI not found in user PATH"
fi
```

## Alternative Approach (if runuser fails)

If `runuser` doesn't work, manually set up the environment:

```bash
# Install Claude Code CLI for user (manual environment setup)
HOME=/home/user USER=user sudo -u user bash -c '
  export HOME=/home/user
  export PATH="$HOME/.local/bin:$PATH"
  curl -fsSL https://claude.ai/install.sh | bash
'
```

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| scripts/template-build.sh | Modify | Fix user Claude installation |

## Verification

```bash
# Rebuild template
scalebox-rebuild-template

# Create VM
sb vm create -t debian-base

# Connect and verify
sb connect <vm-name>
su - user
claude --version
which claude
```

## Update Considerations

- **Config changes**: None
- **Storage changes**: None
- **Dependency changes**: None
- **Migration needed**: No - just rebuild template after update
