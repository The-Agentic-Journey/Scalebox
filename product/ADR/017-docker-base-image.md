# ADR 017: Docker-Based Template Build

## Status
Accepted

## Context
The base template (`debian-base.ext4`) was previously built using `debootstrap` to bootstrap a Debian rootfs from scratch, followed by extensive chroot-based customization (SSH configuration, user creation, package installation, Claude Code CLI setup). This process was:

- Slow (2-3 minutes for debootstrap + package installation)
- Fragile (chroot environment setup with bind mounts, package postinst scripts)
- Hard to customize (changes required modifying bash scripts with chroot logic)
- Not reproducible (package versions varied by build time)

## Decision
Replace `debootstrap` with `crane export` to pull a Docker image and extract its filesystem directly. The Docker image reference is configurable via the `BASE_IMAGE` environment variable (default: `ghcr.io/the-agentic-journey/agenticbaseimage:latest`).

**Tool choice:** `crane` from Google's go-containerregistry project — a single static binary (~30MB) that can pull and export Docker images without requiring Docker daemon, containerd, or any runtime. Downloaded and installed the same way as the Firecracker binary.

## Consequences

### Positive
- Users can bring pre-built Docker images with all customizations baked in
- Template creation is faster (just pull + extract, no chroot configuration)
- Build process is simpler and more reliable
- Docker images are versioned and reproducible

### Negative
- Requires `crane` as an additional binary dependency
- The default image must include SSH server, user account, and other Scalebox prerequisites — if users switch to a minimal image, VM access features will not work
- The `configure_rootfs` customization pipeline is no longer used (remains in code for reference but is dead code)

### Neutral
- Template version bumped to 7; existing installations are prompted to rebuild
- `scalebox-update` installs `crane` automatically on upgrade
