# Default VM Swap Plan

## Overview

Firecracker VMs are getting OOM-killed overnight because they have no swap. When a VM's 2 GiB memory fills up, the guest kernel kills the heaviest processes (builds, language servers, etc.) while lightweight processes like tmux survive. Adding a default 2 GiB swapfile to every VM gives the kernel a pressure valve — slow is better than dead.

The swapfile is created during template build (in `template-build.sh`) on the mounted ext4 image, after the rootfs has been copied into it. This avoids the `cp -a --sparse=auto` problem where zero-filled files become sparse on copy — `swapon` rejects swap files with holes. By creating the swapfile directly on the ext4 mount, the blocks are properly allocated.

This works with both the current `debootstrap` flow and the upcoming Docker-based flow from Plan 028.

The swap size is configurable via `DEFAULT_SWAP_SIZE_MIB` (default: 2048). Setting it to 0 disables swap.

## Acceptance Criteria

| # | Criterion | Acceptance Test |
|---|-----------|-----------------|
| 1 | New VMs have swap enabled with expected size | `test/integration.test.ts`: `VM has swap enabled` |
| 2 | `/info` endpoint returns `default_swap_size_mib` field | `test/integration.test.ts`: `info returns default_swap_size_mib` |

---

## Phase 1: Acceptance Test Scaffolds

### Goal

Create all acceptance tests as skipped stubs. After this phase, `./do check` passes with skipped tests.

### Changes

| File | Action | Details |
|------|--------|---------|
| `test/integration.test.ts` | Modify | Add 2 skipped test stubs |

#### Test stubs to add

Add the following after the "VM boots with kernel 5.10" test block (after line 218, before the `// === Phase 6: Snapshots ===` comment on line 220):

```typescript
	// === Swap ===
	test.skip("VM has swap enabled", async () => {
		// Create VM, SSH in, check swapon --show
	});

	test.skip("info returns default_swap_size_mib", async () => {
		// GET /info, check default_swap_size_mib field
	});
```

### Verification

- Both acceptance tests exist and are skipped
- Run `./do check` — passes (skipped tests don't fail)

---

## Phase 2: Config and API

### Goal

Add `DEFAULT_SWAP_SIZE_MIB` to the configuration and expose it in the `/info` endpoint.

### Acceptance Test (Red)

Unskip and implement:

| Test | Criterion | Expected Behavior |
|------|-----------|-------------------|
| `info returns default_swap_size_mib` | #2 | `sbStatus()` response includes `default_swap_size_mib` as a number |

#### Test implementation for `info returns default_swap_size_mib`:

Replace the skipped stub with:

```typescript
	test("info returns default_swap_size_mib", async () => {
		const status = await sbStatus();
		expect(status.default_swap_size_mib).toBeDefined();
		expect(typeof status.default_swap_size_mib).toBe("number");
		expect(status.default_swap_size_mib).toBeGreaterThanOrEqual(0);
	});
```

Verify the test **fails** before implementing production code.

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/config.ts` | Modify | Add `defaultSwapSizeMib` config key |
| `src/index.ts` | Modify | Add `default_swap_size_mib` to `/info` response |
| `scripts/install.sh` | Modify | Add `DEFAULT_SWAP_SIZE_MIB` to config file template |
| `scripts/scalebox-update` | Modify | Add `migrate_swap_config` function |

#### `src/config.ts` — add `defaultSwapSizeMib`

Add after line 10 (after `defaultDiskSizeGib`). Use nullish coalescing to allow `0` to disable swap:

```typescript
	defaultSwapSizeMib: process.env.DEFAULT_SWAP_SIZE_MIB !== undefined ? Number(process.env.DEFAULT_SWAP_SIZE_MIB) : 2048,
```

#### `src/index.ts` — expose in `/info`

In the `/info` response object (lines 39-54), add `default_swap_size_mib` after `base_domain` on line 41. The result:

```typescript
	return c.json({
		host_ip: hostIp,
		base_domain: config.baseDomain,
		default_swap_size_mib: config.defaultSwapSizeMib,
		templates_count: templates.length,
		// ... rest unchanged
```

#### `scripts/install.sh` — add to config file template

Add `DEFAULT_SWAP_SIZE_MIB` variable initialization after line 20 (after `HOST_IP`):

```bash
DEFAULT_SWAP_SIZE_MIB="${DEFAULT_SWAP_SIZE_MIB:-2048}"
```

In the `install_service()` function, in the heredoc that writes `/etc/scaleboxd/config` (lines 465-474), add the following line after `ACME_STAGING=$ACME_STAGING` (line 473) and before `EOF` (line 474):

```bash
DEFAULT_SWAP_SIZE_MIB=$DEFAULT_SWAP_SIZE_MIB
```

#### `scripts/scalebox-update` — add migration

Add a `migrate_swap_config` function after the existing `migrate_host_ip` function (after line 378, before `run_migrations` on line 380):

```bash
migrate_swap_config() {
  local config_file="/etc/scaleboxd/config"
  if ! grep -q "^DEFAULT_SWAP_SIZE_MIB=" "$config_file" 2>/dev/null; then
    echo "DEFAULT_SWAP_SIZE_MIB=2048" >> "$config_file"
    log "Added DEFAULT_SWAP_SIZE_MIB=2048 to config"
  fi
}
```

Call it in the `run_migrations` function. Add `migrate_swap_config` after `migrate_caddy_config` (at the end of the function body, after line 386, before the closing `}` on line 387):

```bash
  migrate_swap_config
```

### Verification

- Acceptance test passes (green) — `/info` returns `default_swap_size_mib`
- Run `./do check` — all checks pass

---

## Phase 3: Swapfile in Template Build

### Goal

Create a swapfile on the mounted ext4 image during template build. The swapfile must be created **on the ext4 filesystem directly** (not in the rootfs staging directory) to avoid the `cp -a` sparse file problem — GNU coreutils `cp` defaults to `--sparse=auto`, which detects zero-filled blocks and creates holes. The Linux kernel rejects swap files with holes (`swapon: Invalid argument`).

The approach: modify `create_ext4_image` to accept an optional post-copy hook, then use that hook to create the swapfile on the mounted ext4.

Bump `TEMPLATE_VERSION` to trigger rebuild prompt on update.

### Acceptance Test (Red)

Unskip and implement:

| Test | Criterion | Expected Behavior |
|------|-----------|-------------------|
| `VM has swap enabled` | #1 | Create VM → SSH in → `swapon --show` shows `/swapfile` with ~2048 MiB |

#### Test implementation for `VM has swap enabled`:

Replace the skipped stub with:

```typescript
	test(
		"VM has swap enabled",
		async () => {
			const vm = await sbVmCreate("debian-base");
			createdVmIds.push(vm.id as string);

			await waitForSsh(vm.ssh_port as number, 90000);
			const output = await sshExec(
				vm.ssh_port as number,
				"swapon --show=NAME,SIZE --noheadings --bytes",
			);
			// Expected output: /swapfile <size_in_bytes>
			expect(output.trim()).not.toBe("");
			const fields = output.trim().split(/\s+/);
			expect(fields[0]).toBe("/swapfile");
			// Size in bytes — 2048 MiB = 2147483648 bytes.
			// mkswap reserves a small header (~4 KiB), so usable size is slightly less.
			const sizeBytes = Number.parseInt(fields[1], 10);
			expect(sizeBytes).toBeGreaterThan(2147483648 - 1024 * 1024);
			expect(sizeBytes).toBeLessThanOrEqual(2147483648);
		},
		{ timeout: 90000 },
	);
```

Verify the test **fails** before implementing production code.

### Changes

| File | Action | Details |
|------|--------|---------|
| `scripts/template-build.sh` | Modify | Add `setup_swap` function, modify `create_ext4_image` to call it, bump `TEMPLATE_VERSION` |

#### `scripts/template-build.sh` — bump `TEMPLATE_VERSION`

Change line 10 from `TEMPLATE_VERSION=6` to the current value plus 1. If the current value is still `6`, change to:

```bash
TEMPLATE_VERSION=7
```

If Plan 028 has already bumped it to `7`, change to `8`.

#### `scripts/template-build.sh` — add `setup_swap` function

Add the following function after the `create_ext4_image` function (after line 138, before `build_debian_base`):

```bash
# Create swapfile on mounted ext4 image and configure fstab
# Must run on the mounted ext4 (not the staging rootfs_dir) to avoid
# cp -a creating a sparse file that swapon would reject.
setup_swap() {
  local mount_dir="$1"
  local swap_size_mib="${DEFAULT_SWAP_SIZE_MIB:-2048}"

  if [[ "$swap_size_mib" -eq 0 ]]; then
    echo "[template-build] Swap disabled (DEFAULT_SWAP_SIZE_MIB=0)"
    return
  fi

  echo "[template-build] Creating ${swap_size_mib}MiB swapfile..."
  dd if=/dev/zero of="$mount_dir/swapfile" bs=1M count="$swap_size_mib" status=none
  chmod 600 "$mount_dir/swapfile"
  mkswap "$mount_dir/swapfile" >/dev/null

  # Add swap entry to fstab (create fstab if it doesn't exist)
  if [[ ! -f "$mount_dir/etc/fstab" ]]; then
    echo "# /etc/fstab: static file system information" > "$mount_dir/etc/fstab"
  fi
  echo "/swapfile none swap sw 0 0" >> "$mount_dir/etc/fstab"

  echo "[template-build] Swap configured: ${swap_size_mib}MiB"
}
```

#### `scripts/template-build.sh` — modify `create_ext4_image` to call `setup_swap`

The current `create_ext4_image` function (lines 121-138):

```bash
create_ext4_image() {
  local rootfs_dir="$1"
  local mount_dir="$2"
  local template_path="$3"

  # Create ext4 image (use .tmp for atomic creation)
  # 10G is the default VM size, accommodates nodejs, npm, python3, and Claude Code
  local tmp_path="${template_path}.tmp"
  truncate -s 10G "$tmp_path"
  mkfs.ext4 -F "$tmp_path" >/dev/null

  mount -o loop "$tmp_path" "$mount_dir"
  cp -a "$rootfs_dir"/* "$mount_dir"/
  umount "$mount_dir"

  # Atomic rename to final path
  mv "$tmp_path" "$template_path"
}
```

Change to:

```bash
create_ext4_image() {
  local rootfs_dir="$1"
  local mount_dir="$2"
  local template_path="$3"

  # Create ext4 image (use .tmp for atomic creation)
  # 10G is the default VM size, accommodates nodejs, npm, python3, and Claude Code
  local tmp_path="${template_path}.tmp"
  truncate -s 10G "$tmp_path"
  mkfs.ext4 -F "$tmp_path" >/dev/null

  mount -o loop "$tmp_path" "$mount_dir"
  cp -a "$rootfs_dir"/* "$mount_dir"/

  # Create swapfile on the mounted ext4 (not in rootfs_dir) to ensure
  # blocks are properly allocated — cp -a would create a sparse copy.
  setup_swap "$mount_dir"

  umount "$mount_dir"

  # Atomic rename to final path
  mv "$tmp_path" "$template_path"
}
```

The key change: `setup_swap "$mount_dir"` is called between `cp -a` and `umount`, so the swapfile is created directly on the ext4 filesystem with properly allocated blocks.

**No changes needed in `build_debian_base`** — the swap setup happens inside `create_ext4_image`, which is called by `build_debian_base` regardless of whether the rootfs was populated by `debootstrap` or `crane export`.

### Verification

- Acceptance test passes (green) — VM has swap enabled
- `swapon --show` inside a new VM shows `/swapfile` with ~2 GiB
- `free -m` inside a new VM shows swap available
- Run `./do check` — all checks pass

---

## Phase 4: `scalebox-rebuild-template` sources config

### Goal

Ensure `scalebox-rebuild-template` sources the scaleboxd config before building, so `DEFAULT_SWAP_SIZE_MIB` is available to `template-build.sh`.

### Changes

| File | Action | Details |
|------|--------|---------|
| `scripts/scalebox-rebuild-template` | Modify | Source `/etc/scaleboxd/config` before calling `build_debian_base` |

#### `scripts/scalebox-rebuild-template` — source config

First check: if the line `source /etc/scaleboxd/config` already exists in the file (Plan 028 may have added it), skip this change entirely.

If it does not exist, add the following in the `rebuild_template` function, before line 44 (the `if ! source /usr/local/lib/scalebox/template-build.sh` line):

```bash
  # Source config for DEFAULT_SWAP_SIZE_MIB (and other build-time settings)
  if [[ -f /etc/scaleboxd/config ]]; then
    # shellcheck source=/dev/null
    source /etc/scaleboxd/config
  fi
```

### Verification

- Running `scalebox-rebuild-template` on a server creates a template with swap
- The `DEFAULT_SWAP_SIZE_MIB` value from `/etc/scaleboxd/config` is respected
- Run `./do check` — all checks pass

---

## Phase 5: DDD — Glossary Update

### Goal

Document the new "Swapfile" infrastructure concept.

### Changes

| File | Action | Details |
|------|--------|---------|
| `product/DDD/glossary.md` | Modify | Add "Swapfile" term under Infrastructure Terms |

#### Glossary addition

Add under **Infrastructure Terms** (find the appropriate alphabetical position):

```markdown
### Swapfile

A 2 GiB (configurable via `DEFAULT_SWAP_SIZE_MIB`) swap file at `/swapfile` inside each VM's rootfs. Created during template build on the ext4 image to ensure proper block allocation. Enabled via `/etc/fstab` at boot. Provides OOM resilience — the guest kernel can swap cold pages to disk instead of killing processes. Setting `DEFAULT_SWAP_SIZE_MIB=0` disables swap in newly built templates.
```

### Verification

- Review documentation for accuracy and completeness

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `test/integration.test.ts` | Modify | Add 2 acceptance tests (swap enabled, info field) |
| `src/config.ts` | Modify | Add `defaultSwapSizeMib` config key (default 2048) |
| `src/index.ts` | Modify | Add `default_swap_size_mib` to `/info` response |
| `scripts/template-build.sh` | Modify | Add `setup_swap` function, call from `create_ext4_image`, bump version |
| `scripts/install.sh` | Modify | Add `DEFAULT_SWAP_SIZE_MIB` to config defaults and config file template |
| `scripts/scalebox-update` | Modify | Add `migrate_swap_config` migration |
| `scripts/scalebox-rebuild-template` | Modify | Source config for swap size |
| `product/DDD/glossary.md` | Modify | Add "Swapfile" term |

---

## End-to-End Verification

After all phases are complete:

1. All acceptance tests pass (none skipped)
2. `./do check` passes — full verification pipeline
3. On a fresh install:
   - `/etc/scaleboxd/config` contains `DEFAULT_SWAP_SIZE_MIB=2048`
   - Template is built with a 2 GiB swapfile
4. On an update from an older version:
   - `migrate_swap_config` adds `DEFAULT_SWAP_SIZE_MIB=2048` to config
   - `scalebox-update` prompts to run `scalebox-rebuild-template` (version bump)
5. New VMs:
   - `swapon --show` shows `/swapfile` with ~2 GiB
   - `free -m` shows swap available
6. `GET /info` returns `default_swap_size_mib: 2048`
7. Setting `DEFAULT_SWAP_SIZE_MIB=0` in config and rebuilding template creates VMs without swap

---

## Update Considerations

- **Config changes**: New `DEFAULT_SWAP_SIZE_MIB` key with default `2048` in `config.ts` and `/etc/scaleboxd/config`. Old configs without this key work fine (default applied in both TypeScript and bash). `migrate_swap_config` in `scalebox-update` appends the key.
- **Storage changes**: Template ext4 image will be ~2 GiB larger due to the embedded swapfile. The 10 GiB sparse ext4 image has sufficient capacity (rootfs is typically 2-3 GiB). VMs share swapfile blocks via btrfs reflink until swap is actually used, so per-VM disk cost is near zero until memory pressure occurs.
- **Dependency changes**: None. Uses `dd`, `mkswap`, and `chmod` which are standard Linux tools already present on all hosts.
- **Migration needed**: No data migration. `TEMPLATE_VERSION` bumped; `scalebox-update` prompts users to run `scalebox-rebuild-template`. Existing VMs are unaffected — only newly created VMs from the rebuilt template get swap.
- **Backwards compatibility**: Existing VMs without swap continue to work. Only new VMs created after template rebuild get swap. The API field `default_swap_size_mib` is additive.
