# Storage Context

**Classification:** Infrastructure Domain
**Source:** `src/services/storage.ts`

---

## Purpose

The Storage context manages VM disk images (rootfs) and performs filesystem operations like copying, mounting, and rootfs initialization. It leverages btrfs copy-on-write for efficient storage utilization.

---

## Domain Concepts

### Rootfs (Root Filesystem)

An ext4 disk image containing a VM's complete filesystem.

**Locations:**
- Templates: `/var/lib/scalebox/templates/{name}.ext4`
- VMs: `/var/lib/scalebox/vms/{vm-id}.ext4`

**Typical Size:** 1-10 GB

### Reflink Copy

A btrfs feature enabling instant, zero-copy file duplication. Files share data blocks until modified (copy-on-write).

**Command:** `cp --reflink=auto`
**Benefit:** VM creation is instant regardless of template size

### Mount Point

Temporary directory used to access rootfs contents for modification.

**Pattern:** `/tmp/mount-{timestamp}`
**Lifecycle:** Created before mount, deleted after unmount

---

## Domain Services

### copyRootfs(templateName: string, vmId: string): Promise<string>

Creates a VM rootfs by copying from a template.

```
1. Construct source path: /var/lib/scalebox/templates/{templateName}.ext4
2. Verify template exists → 404 if not
3. Create vms directory if needed
4. Copy with reflink: cp --reflink=auto {source} {dest}
5. Return destination path
```

**Returns:** Path to new rootfs (`/var/lib/scalebox/vms/{vmId}.ext4`)

### initializeRootfs(rootfsPath: string, options: InitializeRootfsOptions): Promise<void>

Prepares a VM's rootfs before boot by performing all initialization in a single mount/unmount cycle.

```typescript
interface InitializeRootfsOptions {
  sshPublicKey: string;           // Required: SSH key for access
  hostname?: string;              // Optional: VM hostname
  envVars?: Record<string, string>; // Optional: environment variables
  files?: Array<{                 // Optional: files to inject
    path: string;                 //   Absolute path in VM
    content: string;              //   Base64-encoded content
  }>;
  initScript?: string;            // Optional: bash script for first boot
}
```

```
1. Create temporary mount point
2. Mount rootfs: sudo mount -o loop {rootfsPath} {mountPoint}
3. Create /root/.ssh directory with mode 700
4. Write authorized_keys with mode 600
5. Set hostname in /etc/hostname (if provided)
6. Write env vars to /home/user/.ssh/environment (if provided)
7. Create files at specified paths, owned by user:user, mode 640 (if provided)
8. Write init script to /opt/scalebox/init.sh, mode 755 (if provided)
9. Unmount rootfs
10. Clean up mount point
```

**Design:** All operations happen within a single mount/unmount cycle for efficiency. Previous versions used separate `injectSshKey()` and `setHostname()` calls, each requiring their own mount cycle.

**Security:** Uses sudo for mount operations. SSH keys get proper permissions (700/600). VM files are owned by `user:user` (UID 1000) with mode `640`. Init script runs as root on first boot and self-disables after execution.

### deleteRootfs(rootfsPath: string): Promise<void>

Removes a VM's rootfs file.

```
rm -f {rootfsPath}
```

**Resilience:** Ignores errors if file doesn't exist.

### copyRootfsToTemplate(rootfsPath: string, templateName: string): Promise<string>

Creates a template from a VM's rootfs (used during snapshotting).

```
1. Construct destination: /var/lib/scalebox/templates/{templateName}.ext4
2. Create templates directory if needed
3. Copy with reflink: cp --reflink=auto {source} {dest}
4. Return template path
```

### clearAuthorizedKeys(rootfsPath: string): Promise<void>

Removes SSH keys from a rootfs (used to clean templates after snapshotting).

```
1. Create temporary mount point
2. Mount rootfs
3. Truncate /root/.ssh/authorized_keys to zero bytes
4. Unmount rootfs
5. Clean up mount point
```

**Purpose:** Ensures templates don't contain user-specific SSH keys.

---

## Directory Structure

```
/var/lib/scalebox/
├── kernel/
│   └── vmlinux              # Linux kernel (shared by all VMs)
├── templates/
│   ├── debian-base.ext4     # Base template (protected)
│   └── my-snapshot.ext4     # User-created template
└── vms/
    ├── vm-a1b2c3d4e5f6.ext4 # Running VM's rootfs
    └── vm-f6e5d4c3b2a1.ext4 # Another VM's rootfs
```

---

## Copy-on-Write Efficiency

```
Before VM Creation:
┌─────────────────────────────┐
│  debian-base.ext4 (2 GB)    │
│  [Block A][Block B][Block C]│
└─────────────────────────────┘

After VM Creation (reflink copy):
┌─────────────────────────────┐
│  debian-base.ext4 (2 GB)    │
│  [Block A][Block B][Block C]│
└──────┬──────┬──────┬────────┘
       │      │      │
       ▼      ▼      ▼   (shared references)
┌─────────────────────────────┐
│  vm-abc123.ext4 (0 bytes*)  │
│  [  →A  ][  →B  ][  →C  ]   │
└─────────────────────────────┘
* Apparent size 2GB, actual disk usage ~0

After VM Modifies Block B:
┌─────────────────────────────┐
│  debian-base.ext4           │
│  [Block A][Block B][Block C]│
└──────┬─────────────┬────────┘
       │             │
       ▼             ▼
┌─────────────────────────────┐
│  vm-abc123.ext4             │
│  [  →A  ][Block B'][  →C  ] │
└─────────────────────────────┘
Only modified block uses additional space
```

---

## Mount Operations

### Sequence Diagram

```
initializeRootfs()
      │
      ▼
┌─────────────┐
│ mkdir /tmp/ │
│ mount-{ts}  │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────┐
│ sudo mount -o loop          │
│ {rootfs} {mountpoint}       │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Write SSH key to            │
│ {mount}/root/.ssh/          │
│ authorized_keys             │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Set hostname in             │
│ {mount}/etc/hostname        │
│ (if provided)               │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Write env vars to           │
│ {mount}/home/user/.ssh/     │
│ environment (if provided)   │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Create files at specified   │
│ paths, owned by user:user   │
│ mode 640 (if provided)      │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ Write init script to        │
│ {mount}/opt/scalebox/       │
│ init.sh (if provided)       │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ sudo umount {mountpoint}    │
└──────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ rmdir {mountpoint}          │
└─────────────────────────────┘
```

### Error Handling

Both `initializeRootfs` and `clearAuthorizedKeys` use try/finally to ensure cleanup:

```typescript
try {
  await mount();
  // ... operations ...
} finally {
  try { await unmount(); } catch {}
  try { await rmdir(); } catch {}
}
```

---

## External Dependencies

| Dependency | Purpose | Required Permissions |
|------------|---------|---------------------|
| `cp` | File copying | Read source, write dest |
| `sudo mount` | Rootfs mounting | Root via sudo |
| `sudo umount` | Rootfs unmounting | Root via sudo |
| `sudo mkdir` | SSH directory creation | Root via sudo |
| `sudo cp` | Authorized_keys writing | Root via sudo |
| `sudo chmod` | Permission setting | Root via sudo |
| `sudo truncate` | Key clearing | Root via sudo |
| btrfs | COW efficiency | Filesystem must be btrfs |

---

## Error Handling

| Scenario | Handling |
|----------|----------|
| Template not found | Throws `{ status: 404, message: "Template not found" }` |
| Mount fails | Exception propagates |
| Unmount fails | Silently ignored (logged) |
| Delete fails | Silently ignored |
| Directory creation fails | Exception propagates |

---

## Integration Points

### Called By: VM Lifecycle

```typescript
// VM creation
rootfsPath = await copyRootfs(req.template, vmId);
await initializeRootfs(rootfsPath, {
  sshPublicKey: req.ssh_public_key,
  hostname: vm.name,
  envVars: req.env_vars,
  files: req.files,
  initScript: req.init_script,
});

// VM deletion
await deleteRootfs(vm.rootfsPath);

// VM snapshotting
await copyRootfsToTemplate(vm.rootfsPath, templateName);
await clearAuthorizedKeys(templatePath);
```

### Called By: Template Context

Template context reads from the templates directory but doesn't call Storage services directly (uses filesystem APIs).

---

## Code Location

| Component | File | Lines |
|-----------|------|-------|
| copyRootfs | `src/services/storage.ts` | 6-21 |
| injectSshKey | `src/services/storage.ts` | 23-55 |
| deleteRootfs | `src/services/storage.ts` | 57-63 |
| copyRootfsToTemplate | `src/services/storage.ts` | 65-78 |
| clearAuthorizedKeys | `src/services/storage.ts` | 80-107 |
