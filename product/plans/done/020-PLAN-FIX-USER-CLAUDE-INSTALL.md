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
4. `~/.local/bin` is not in the default PATH for new user accounts

## Solution

### Phase 1: Configure User PATH

Before installing Claude, ensure `~/.local/bin` is in the user's PATH by adding it to `.bashrc`:

**File: `scripts/template-build.sh`**

Add to the chroot section (before Claude installation):
```bash
# Configure PATH for user to include ~/.local/bin (where Claude installs)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/user/.bashrc
chown user:user /home/user/.bashrc
```

### Phase 2: Use runuser Instead of su

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

### Phase 3: Fail Loudly on Error

The template build must fail immediately if Claude installation fails, so errors are caught in CI/testing:

```bash
# Install Claude Code CLI for user
echo "[template-build] Installing Claude Code CLI for user..."
if ! runuser -u user -- bash -l -c 'curl -fsSL https://claude.ai/install.sh | bash'; then
  echo "[template-build] ERROR: Claude Code CLI installation failed for user"
  exit 1
fi
echo "[template-build] Claude Code CLI installed successfully for user"
```

## Combined Implementation

The final chroot section should look like:

```bash
# Configure PATH for user to include ~/.local/bin (where Claude installs)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/user/.bashrc
chown user:user /home/user/.bashrc

# Install Claude Code CLI for user
# Use runuser instead of su - it works better in chroot without PAM
# MUST fail loudly so errors are caught in testing
echo "[template-build] Installing Claude Code CLI for user..."
if ! runuser -u user -- bash -l -c 'curl -fsSL https://claude.ai/install.sh | bash'; then
  echo "[template-build] ERROR: Claude Code CLI installation failed for user"
  exit 1
fi
echo "[template-build] Claude Code CLI installed successfully for user"
```

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| scripts/template-build.sh | Modify | Add PATH config and fix Claude installation |

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
echo $PATH  # Should include ~/.local/bin
```

## Update Considerations

- **Config changes**: None
- **Storage changes**: None
- **Dependency changes**: None
- **Migration needed**: No - just rebuild template after update
