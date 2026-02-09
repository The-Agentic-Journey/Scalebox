# Locale Configuration Fix Plan

## Overview

Mosh requires UTF-8 locales to be properly configured on the server. Currently, the debian-base template doesn't have locales set up, causing mosh-server to fail with "needs a UTF-8 native locale to run" errors.

## Problem Statement

When users run `sb connect <vm>`, mosh fails because:
1. The `locales` package isn't installed in the template
2. No UTF-8 locales are generated
3. mosh-server falls back to US-ASCII and refuses to start

Error seen:
```
mosh-server needs a UTF-8 native locale to run.
The client-supplied environment (LANG=de_DE.UTF-8) specifies
the character set "US-ASCII".
```

## Solution

Configure UTF-8 locales in the template during creation. Generate `en_US.UTF-8` as the default locale - this works regardless of the client's locale setting because mosh just needs *some* UTF-8 locale available on the server.

## Phase 1: Update Template Build

**Goal:** Add locale configuration to the template creation process.

**Changes:**

1. Update `scripts/template-build.sh`:
   - Add `locales` to the debootstrap package list
   - Generate `en_US.UTF-8` locale after debootstrap
   - Set `en_US.UTF-8` as the default locale
   - Increment `TEMPLATE_VERSION` to 3

2. Update `scripts/install.sh`:
   - Add `locales` to the debootstrap package list (for fallback inline code)
   - Add locale generation to `configure_rootfs()`
   - Update `TEMPLATE_VERSION` to 3

3. Update `scripts/scalebox-update`:
   - Update `REQUIRED_TEMPLATE_VERSION` to 3

4. Update `scripts/scalebox-rebuild-template`:
   - Update `TEMPLATE_VERSION` to 3

**Locale configuration commands:**
```bash
# In chroot during template creation:
sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen
locale-gen
echo 'LANG=en_US.UTF-8' > /etc/default/locale
```

**Verification:**
- Create a new template with `scalebox-rebuild-template`
- Create a VM from the new template
- Run `sb connect <vm>` - mosh should connect successfully
- Inside VM, run `locale` - should show en_US.UTF-8

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `scripts/template-build.sh` | Modify | Add locales package and generation |
| `scripts/install.sh` | Modify | Add locales to fallback inline code |
| `scripts/scalebox-update` | Modify | Bump REQUIRED_TEMPLATE_VERSION to 3 |
| `scripts/scalebox-rebuild-template` | Modify | Bump TEMPLATE_VERSION to 3 |

## Update Considerations

- **Config changes**: None
- **Storage changes**: None
- **Dependency changes**: None (locales is a standard Debian package)
- **Migration needed**: Yes - users must run `scalebox-rebuild-template` after update
- **Template version**: Bumped from 2 to 3
