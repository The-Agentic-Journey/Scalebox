# Base Image Package Updates Plan

## Overview

Add essential development tools to the debian-base template:
- Basic utilities: curl, wget, vim
- Node.js runtime (Debian built-in)
- Python 3 with pip and venv
- Claude Code CLI (native installer)

## Current State

The debian-base template is built via `scripts/template-build.sh` using debootstrap with these packages:
- openssh-server, iproute2, iputils-ping, haveged, netcat-openbsd, mosh, locales, sudo

Template version is tracked via `TEMPLATE_VERSION` constant (currently 4).

## Changes

### Phase 1: Add Packages to Debootstrap

**File: `scripts/template-build.sh`**

Add to the `--include=` list in `build_debian_base()`:
- `curl` - HTTP client
- `wget` - HTTP client
- `vim` - Text editor
- `nodejs` - Node.js runtime (Debian bookworm includes v18)
- `npm` - Node package manager
- `python3` - Python runtime
- `python3-pip` - Package installer
- `python3-venv` - Virtual environment support

### Phase 2: Install Claude Code

**File: `scripts/template-build.sh`**

In `configure_rootfs()`, install Claude Code using the native installer:
```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Note: The native installer doesn't require Node.js. It installs a standalone binary.

### Phase 3: Bump Template Version

**File: `scripts/template-build.sh`**

Increment `TEMPLATE_VERSION` from 4 to 5.

This triggers rebuild notification on existing installations via `scalebox-update`.

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| scripts/template-build.sh | Modify | Add packages to template build |

## Verification

```bash
# Rebuild template on test server
scalebox-rebuild-template

# Create a VM and verify packages
sb go
# Inside VM:
curl --version
wget --version
vim --version
python3 --version
pip3 --version
python3 -m venv --help
node --version
npm --version
claude --version
```

## Update Considerations

- **Config changes**: None
- **Storage changes**: None
- **Dependency changes**: None (debootstrap handles package installation)
- **Migration needed**: No - existing VMs unaffected. New template version triggers rebuild prompt.
- **Template size**: Will increase from ~500MB to ~900MB due to additional packages
