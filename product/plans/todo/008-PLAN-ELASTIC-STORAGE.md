# Elastic Storage Plan

## Overview

Make storage configurable and elastic instead of hardcoded 50GB. The installer will auto-size the btrfs pool to 80% of available disk space, and VMs can request custom disk sizes.

## Current Limitations

| Constraint | Current Value | Problem |
|------------|---------------|---------|
| Storage pool | Fixed 50GB | Wastes space on large servers |
| Per-VM disk | Fixed 2GB | No flexibility per workload |
| Space checks | None | VM creation can fail mid-way |

## Phase 1: Auto-Size Storage Pool

**Goal:** Installer automatically sizes btrfs pool based on available disk space.

### Changes to `scripts/install.sh`

Update `setup_storage()` function:

```bash
setup_storage() {
  local img_path="/var/lib/scalebox.img"

  if mountpoint -q "$DATA_DIR" 2>/dev/null; then
    log "Storage already mounted at $DATA_DIR"
    return
  fi

  log "Setting up btrfs storage..."
  mkdir -p "$DATA_DIR"

  if [[ ! -f "$img_path" ]]; then
    # Calculate recommended size (80% of available space)
    local available_gb=$(df -BG /var/lib --output=avail | tail -1 | tr -d ' G')
    local recommended=$((available_gb * 80 / 100))

    # Enforce bounds
    if [[ $recommended -lt 20 ]]; then
      die "Insufficient disk space. Need at least 25GB free, found ${available_gb}GB"
    fi
    [[ $recommended -gt 4096 ]] && recommended=4096

    # Allow override via env var, default to auto-calculated
    local size="${STORAGE_SIZE:-${recommended}G}"

    log "Creating ${size} btrfs storage pool (${available_gb}GB available on host)..."
    truncate -s "$size" "$img_path"
    mkfs.btrfs "$img_path"
  fi

  mount -o loop "$img_path" "$DATA_DIR"

  if ! grep -q "$img_path" /etc/fstab; then
    echo "$img_path $DATA_DIR btrfs loop,nofail 0 0" >> /etc/fstab
  fi

  mkdir -p "$DATA_DIR/templates" "$DATA_DIR/vms" "$DATA_DIR/kernel"
}
```

### Verification

1. Fresh install on server with 500GB free should create ~400GB pool
2. `STORAGE_SIZE=100G` override should create 100GB pool
3. Server with <25GB free should fail with clear error

---

## Phase 2: Per-VM Disk Size

**Goal:** Allow specifying disk size when creating a VM.

### Changes to `src/types.ts`

Add `disk_size_gib` to CreateVMRequest:

```typescript
export interface CreateVMRequest {
  template: string;
  ssh_public_key: string;
  name?: string;
  vcpu_count?: number;
  mem_size_mib?: number;
  disk_size_gib?: number;  // NEW: defaults to template size
}
```

### Changes to `src/config.ts`

Add disk size configuration:

```typescript
export const config = {
  // ... existing config ...
  defaultDiskSizeGib: Number(process.env.DEFAULT_DISK_SIZE_GIB) || 2,
  maxDiskSizeGib: Number(process.env.MAX_DISK_SIZE_GIB) || 100,
};
```

### Changes to `src/services/storage.ts`

Add resize function:

```typescript
export async function resizeRootfs(rootfsPath: string, sizeGib: number): Promise<void> {
  // Expand the sparse file
  await $`truncate -s ${sizeGib}G ${rootfsPath}`;

  // Check and resize the ext4 filesystem
  await $`e2fsck -f -y ${rootfsPath}`.quiet().nothrow();
  await $`resize2fs ${rootfsPath}`.quiet();
}

export async function getAvailableSpaceGib(): Promise<number> {
  const result = await $`df -BG ${config.dataDir} --output=avail | tail -1`.text();
  return parseInt(result.replace('G', '').trim());
}
```

### Changes to `src/services/vm.ts`

Call resize after copying rootfs:

```typescript
// In createVm(), after copyRootfs:
rootfsPath = await copyRootfs(req.template, vmId);

// Resize if custom size requested
const diskSizeGib = req.disk_size_gib || config.defaultDiskSizeGib;
if (diskSizeGib > 2) {  // Only resize if larger than base template
  console.log(`[${vmId}] Resizing rootfs to ${diskSizeGib}GB...`);
  await resizeRootfs(rootfsPath, diskSizeGib);
}

await injectSshKey(rootfsPath, req.ssh_public_key);
```

### Changes to `src/index.ts`

Validate disk_size_gib in POST /vms:

```typescript
// Add validation
if (body.disk_size_gib !== undefined) {
  if (body.disk_size_gib < 1 || body.disk_size_gib > config.maxDiskSizeGib) {
    return c.json({ error: `disk_size_gib must be between 1 and ${config.maxDiskSizeGib}` }, 400);
  }
}
```

### Verification

1. Create VM with `disk_size_gib: 10` - should have 10GB disk
2. Create VM without disk_size_gib - should use default (2GB)
3. Create VM with `disk_size_gib: 200` - should fail validation (>100GB max)

---

## Phase 3: Pre-flight Space Check

**Goal:** Fail fast if insufficient space before starting VM creation.

### Changes to `src/services/storage.ts`

Add space check:

```typescript
export async function checkAvailableSpace(requiredGib: number): Promise<void> {
  const available = await getAvailableSpaceGib();
  const buffer = 2; // Keep 2GB buffer

  if (available < requiredGib + buffer) {
    throw {
      status: 507,  // Insufficient Storage
      message: `Insufficient storage: ${available}GB available, need ${requiredGib + buffer}GB`
    };
  }
}
```

### Changes to `src/services/vm.ts`

Add pre-flight check:

```typescript
// At start of createVm():
const diskSizeGib = req.disk_size_gib || config.defaultDiskSizeGib;
await checkAvailableSpace(diskSizeGib);
```

### Verification

1. Fill disk to near capacity, attempt VM creation - should fail with 507 error
2. Normal creation with plenty of space - should succeed

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `scripts/install.sh` | Modify | Auto-size btrfs pool to 80% of available |
| `src/config.ts` | Modify | Add defaultDiskSizeGib, maxDiskSizeGib |
| `src/types.ts` | Modify | Add disk_size_gib to CreateVMRequest |
| `src/services/storage.ts` | Modify | Add resizeRootfs, checkAvailableSpace, getAvailableSpaceGib |
| `src/services/vm.ts` | Modify | Call resize and space check |
| `src/index.ts` | Modify | Validate disk_size_gib parameter |

---

## API Changes

### POST /vms - New Optional Parameter

```json
{
  "template": "debian-base",
  "ssh_public_key": "ssh-ed25519 ...",
  "disk_size_gib": 10
}
```

### New Error Response (507)

```json
{
  "error": "Insufficient storage: 5GB available, need 12GB"
}
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STORAGE_SIZE` | auto (80%) | Override btrfs pool size at install |
| `DEFAULT_DISK_SIZE_GIB` | 2 | Default VM disk size |
| `MAX_DISK_SIZE_GIB` | 100 | Maximum allowed VM disk size |

---

## Verification Checklist

- [ ] Fresh install auto-sizes pool correctly
- [ ] STORAGE_SIZE override works
- [ ] VM creation with custom disk_size_gib works
- [ ] VM creation without disk_size_gib uses default
- [ ] Invalid disk_size_gib rejected with 400
- [ ] Low disk space returns 507 error
- [ ] Existing tests still pass
