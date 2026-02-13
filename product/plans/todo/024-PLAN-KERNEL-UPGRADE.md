# Kernel Upgrade to 5.10 Plan

## Overview

Upgrade the Firecracker kernel from 4.14.174 to 5.10.245. The current kernel (4.14) is too old for modern Bun-based tools like Claude Code, which require Linux kernel 5.6+. Kernel 5.10 is the primary Firecracker-supported kernel version and satisfies this requirement.

Additionally, introduce kernel version tracking so that `scalebox-update` can detect outdated kernels and upgrade them automatically.

**Kernel URL verified:** `https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.14/x86_64/vmlinux-5.10.245` returns HTTP 200, Content-Length 39669712 bytes (~38MB), Last-Modified 2025-11-18.

**Firecracker compatibility:** The kernel URL path contains `v1.14` (Firecracker CI version used to build the kernel), but Scalebox installs Firecracker `v1.10.1`. Firecracker kernel configs are backward compatible across versions — the 5.10 kernel config is stable and works with any Firecracker version that supports kernel 5.10 (which v1.10.1 does, per Firecracker's kernel support matrix of 4.14–6.1).

## Acceptance Criteria

| # | Criterion | Acceptance Test |
|---|-----------|-----------------|
| 1 | VMs boot with kernel 5.10.x on both fresh installs and upgrades | `test/integration.test.ts`: `VM boots with kernel 5.10` |

This single test covers both the fresh install path (`./do check`) and the upgrade path (`./do check-update`), since both pipelines run the full integration test suite after provisioning.

---

## Phase 1: Acceptance Test Scaffold

### Goal

Create the kernel version acceptance test as a skipped stub.

### Changes

| File | Action | Details |
|------|--------|---------|
| `test/integration.test.ts` | Modify | Add one skipped test after the "Phase 5: SSH Access" section |

Insert after line 188 (the closing `);` of the `can execute command via SSH` test), before the `// === Phase 6: Snapshots ===` comment at line 190:

```typescript
	// === Kernel Version ===
	test.skip(
		"VM boots with kernel 5.10",
		async () => {
			const vm = await sbVmCreate("debian-base");
			createdVmIds.push(vm.id as string);

			await waitForSsh(vm.ssh_port as number, 90000);
			const output = await sshExec(vm.ssh_port as number, "uname -r");
			expect(output.trim()).toMatch(/^5\.10\./);
		},
		{ timeout: 90000 },
	);
```

### Verification

- Test exists and is skipped
- Run `./do lint` — passes

---

## Phase 2: Kernel Upgrade Implementation

### Goal

Update the kernel download URL to 5.10.245, add version tracking, and add automatic kernel upgrade to `scalebox-update`.

### Acceptance Test (Red)

Unskip the test by changing `test.skip(` to `test(` for `"VM boots with kernel 5.10"`.

Note: The red step cannot be executed locally because tests require a provisioned Firecracker server. It is confirmed by inspection — the old kernel URL downloads kernel 4.14, so `uname -r` would return `4.14.174` which does not match `/^5\.10\./`.

### Changes

| File | Action | Details |
|------|--------|---------|
| `scripts/install.sh` | Modify | Update `KERNEL_URL` and add `KERNEL_VERSION`, write version file after download |
| `scripts/scalebox-update` | Modify | Add `REQUIRED_KERNEL_VERSION`, `KERNEL_URL`, and `upgrade_kernel()` function |

#### `scripts/install.sh`

**1. Replace line 22** — Replace the kernel URL and add a version constant:

```bash
# Old (line 22):
KERNEL_URL="https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/x86_64/kernels/vmlinux.bin"

# New (lines 22-23):
KERNEL_VERSION="5.10.245"
KERNEL_URL="https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.14/x86_64/vmlinux-${KERNEL_VERSION}"
```

**2. Replace lines 118-121** in the `install_firecracker()` function — Write the kernel version file after downloading the kernel:

```bash
# Old (lines 118-121):
  if [[ ! -f "$kernel_path" ]]; then
    log "Downloading kernel..."
    wget -q "$KERNEL_URL" -O "$kernel_path"
  fi

# New:
  if [[ ! -f "$kernel_path" ]]; then
    log "Downloading kernel ${KERNEL_VERSION}..."
    wget -q "$KERNEL_URL" -O "$kernel_path"
    echo "$KERNEL_VERSION" > "$DATA_DIR/kernel/version"
  fi
```

**Error handling note:** `install.sh` runs with `set -euo pipefail`. If the kernel download fails, the entire installation aborts. This is intentional — a server with no kernel cannot run VMs. In contrast, `scalebox-update` handles download failure gracefully (see below) because the existing kernel still works.

**Existing installations note:** The version file is only written when the kernel is downloaded (inside the `if` block). Servers where the kernel file already exists will not get a version file from `install.sh`. This is handled by `scalebox-update`'s `upgrade_kernel()` function, which treats a missing version file as "needs upgrade" and downloads the new kernel (writing the version file in the process). This is a one-time extra download on the first update after this change.

#### `scripts/scalebox-update`

**1. Add kernel constants** — Insert after line 13 (`SCALEBOXD_BIN="/usr/local/bin/scaleboxd"`), before line 14 (`SERVICE_FILE=...`):

```bash
REQUIRED_KERNEL_VERSION="5.10.245"
KERNEL_URL="https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.14/x86_64/vmlinux-${REQUIRED_KERNEL_VERSION}"
```

**Duplication note:** The kernel URL and version appear in both `install.sh` and `scalebox-update`. This follows the same pattern as `REQUIRED_TEMPLATE_VERSION` (which is also defined in `scalebox-update` separately). The duplication is pragmatic — `scalebox-update` runs on servers where `install.sh` is not present. Both files must be updated together when the kernel version changes.

**2. Add `upgrade_kernel()` function** — Insert after the `cleanup()` function (after line 162, before the blank line 163):

```bash
upgrade_kernel() {
  local kernel_path="$DATA_DIR/kernel/vmlinux"
  local version_file="$DATA_DIR/kernel/version"
  local current_version=""

  if [[ -f "$version_file" ]]; then
    current_version=$(cat "$version_file")
  fi

  if [[ "$current_version" == "$REQUIRED_KERNEL_VERSION" ]]; then
    return 0
  fi

  log "Upgrading kernel to ${REQUIRED_KERNEL_VERSION}..."
  if wget -q "$KERNEL_URL" -O "${kernel_path}.new"; then
    mv "${kernel_path}.new" "$kernel_path"
    echo "$REQUIRED_KERNEL_VERSION" > "$version_file"
    log "Kernel upgraded (new VMs will use 5.10, existing VMs unaffected until recreated)"
  else
    rm -f "${kernel_path}.new"
    log "WARNING: Kernel download failed. Continuing with current kernel."
  fi
}
```

The `if wget ...; then` conditional prevents `set -euo pipefail` from aborting the entire update on download failure. A failed kernel download is non-fatal because the existing kernel still works.

**3. Call `upgrade_kernel` in `main()`** — Insert between `install_new "$temp_dir"` (line 294) and `migrate_caddy_config` (line 295):

```bash
  install_new "$temp_dir"
  upgrade_kernel
  migrate_caddy_config
```

This runs while the service is stopped (service was stopped at line 293), so no new VMs can be created during the kernel replacement.

### Verification

- `./do check` passes — fresh install uses kernel 5.10.245, acceptance test passes
- `./do check-update` passes — upgrade from old version downloads new kernel, acceptance test passes
- Run `./do lint` — passes

---

## Phase 3: DDD Documentation Updates

### Goal

Update domain documentation to reflect the kernel version tracking.

### Changes

| File | Action | Details |
|------|--------|---------|
| `product/DDD/glossary.md` | Modify | Update Kernel entry, add Kernel Version File entry |
| `product/DDD/contexts/hypervisor.md` | Modify | Add kernel version file to External Dependencies table |

#### `product/DDD/glossary.md`

**1. Replace the `### Kernel` entry** (line 86 is `### Kernel`, line 87 is the description). Replace both lines:

```markdown
### Kernel
The Linux kernel image (`vmlinux`) booted by Firecracker. Shared by all VMs. Minimum kernel 5.6+ is required for Bun runtime compatibility. The installed version is tracked by a kernel version file for automated upgrades.
```

**2. Add `### Kernel Version File` entry** — Insert after the updated Kernel entry (after the blank line following the Kernel description):

```markdown
### Kernel Version File
A file at `/var/lib/scalebox/kernel/version` containing the kernel version string (e.g., `5.10.245`). Created during installation and checked by `scalebox-update` to detect when a kernel upgrade is needed. Absent on pre-024 installations, which triggers an automatic upgrade.
```

#### `product/DDD/contexts/hypervisor.md`

**Update the External Dependencies table** (lines 255-259). Add a row for the kernel version file:

```markdown
| Dependency | Purpose | Location |
|------------|---------|----------|
| `firecracker` | Hypervisor binary | PATH (installed by install.sh) |
| `curl` | API communication | System utility |
| Linux kernel | VM boot image | `/var/lib/scalebox/kernel/vmlinux` |
| Kernel version file | Tracks installed kernel version | `/var/lib/scalebox/kernel/version` |
| KVM | Hardware virtualization | `/dev/kvm` |
```

### Verification

- Review documentation for accuracy and completeness

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `test/integration.test.ts` | Modify | Add kernel version acceptance test |
| `scripts/install.sh` | Modify | Update kernel URL to 5.10.245, add version tracking |
| `scripts/scalebox-update` | Modify | Add automatic kernel upgrade during updates |
| `product/DDD/glossary.md` | Modify | Document kernel version and version file |
| `product/DDD/contexts/hypervisor.md` | Modify | Add kernel version file to dependencies table |

---

## End-to-End Verification

After all phases are complete:

1. All acceptance tests pass (none skipped)
2. `./do check` passes — fresh install provisions with kernel 5.10.245
3. `./do check-update` passes — upgrade from last release installs new kernel
4. Manual verification: SSH into a VM and run `uname -r` — output starts with `5.10`

---

## Update Considerations

How will this feature behave when updating from an older version?

- **Config changes**: None. `KERNEL_PATH` in `/etc/scaleboxd/config` is unchanged.
- **Storage changes**: New file `/var/lib/scalebox/kernel/version` created on demand by `scalebox-update`. New kernel binary replaces old one at existing path.
- **Dependency changes**: None. Uses existing `wget` (already a dependency).
- **Migration needed**: No. `scalebox-update` handles kernel replacement automatically.
- **Backwards compatibility**: Running VMs are unaffected — they already loaded the old kernel into memory. Only new VMs created after the upgrade use the new kernel. The old kernel binary is replaced in-place (same path, new content).
