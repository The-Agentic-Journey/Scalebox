# Docker Base Image, VM Hostname, Snapshot Overwrite Plan

## Overview

Three improvements to Scalebox:

1. **Docker-based base image**: Replace `debootstrap` with `crane export` to create the base template from a hosted Docker image. Configurable via `BASE_IMAGE` in `/etc/scaleboxd/config`, defaulting to `ghcr.io/the-agentic-journey/agenticbaseimage:latest`. This simplifies the build process and lets users bring their own pre-built images.

2. **VM hostname**: Set each VM's hostname to its generated three-word name (e.g., `very-silly-penguin`) during creation, so `hostname` inside the VM returns the expected name.

3. **Snapshot overwrite**: When snapshotting to a template name that already exists, instead of failing with 409, the API accepts an `overwrite: true` flag. The CLI prompts interactively for confirmation, or accepts `--overwrite` to skip the prompt.

## Acceptance Criteria

| # | Criterion | Acceptance Test |
|---|-----------|-----------------|
| 1 | Snapshot of existing template name returns 409 without overwrite flag | `test/integration.test.ts`: `snapshot existing template returns 409` |
| 2 | Snapshot with `overwrite: true` replaces existing template successfully | `test/integration.test.ts`: `snapshot with overwrite replaces existing template` |
| 3 | VM hostname inside the guest matches the generated VM name | `test/integration.test.ts`: `VM hostname matches generated name` |
| 4 | `/info` endpoint returns `base_image` field with the configured Docker image | `test/integration.test.ts`: `info returns base_image` |

---

## Phase 1: Acceptance Test Scaffolds

### Goal

Create all acceptance tests as skipped stubs. After this phase, `./do check` passes with skipped tests.

### Changes

| File | Action | Details |
|------|--------|---------|
| `test/integration.test.ts` | Modify | Add 4 skipped test stubs (see below) |
| `test/helpers.ts` | Modify | Add `sbVmSnapshotRaw` helper function |

#### Import changes in `test/integration.test.ts`

Add `sbVmSnapshotRaw` to the import statement (line 1-24). Add it after `sbVmSnapshot` in the import list from `./helpers`.

#### Test stubs to add in `test/integration.test.ts`

Add the following after the existing "Phase 6: Snapshots" section (before "Phase 7: Cleanup"):

```typescript
// === Snapshot Overwrite ===
test.skip("snapshot existing template returns 409", async () => {
  // Create VM, snapshot, attempt duplicate snapshot → 409
});

test.skip("snapshot with overwrite replaces existing template", async () => {
  // Create VM, snapshot, overwrite snapshot → 201
});
```

Add the following after the existing "VM boots with kernel 5.10" test (before "Phase 6: Snapshots"):

```typescript
test.skip("VM hostname matches generated name", async () => {
  // Create VM, SSH in, run hostname, compare to vm.name
});
```

Add the following in the "Phase 2: Health & Auth" section (after "auth rejects invalid token"):

```typescript
test.skip("info returns base_image", async () => {
  // GET /info, check base_image field exists
});
```

#### `sbVmSnapshotRaw` helper in `test/helpers.ts`

Add after the existing `sbVmSnapshot` function:

```typescript
export async function sbVmSnapshotRaw(
	nameOrId: string,
	templateName: string,
	options?: { overwrite?: boolean },
): Promise<{ exitCode: number; data: Record<string, unknown> | null; error: string | null }> {
	const args = ["vm", "snapshot", nameOrId, "-n", templateName];
	if (options?.overwrite) args.push("--overwrite");
	return sbCmd(...args);
}
```

Also update the existing `sbVmSnapshot` function signature to accept an optional `overwrite` parameter:

```typescript
export async function sbVmSnapshot(
	nameOrId: string,
	templateName: string,
	options?: { overwrite?: boolean },
): Promise<Record<string, unknown>> {
	const args = ["vm", "snapshot", nameOrId, "-n", templateName];
	if (options?.overwrite) args.push("--overwrite");
	const result = await sbCmd(...args);
	if (result.exitCode !== 0 || !result.data) {
		throw new Error(`Failed to snapshot VM: ${result.error}`);
	}
	return result.data;
}
```

### Verification

- All 4 new acceptance tests exist and are skipped
- Existing tests are unchanged
- Run `./do check` — passes (skipped tests don't fail)

---

## Phase 2: Snapshot Overwrite

### Goal

Add `overwrite` support to the snapshot API and CLI. When a snapshot target template already exists, the API returns 409 (existing behavior). With `overwrite: true` in the request body, the existing template is deleted and replaced. The CLI prompts interactively on 409, or accepts `--overwrite` to skip the prompt.

### Acceptance Tests (Red)

Unskip and implement:

| Test | Criterion | Expected Behavior |
|------|-----------|-------------------|
| `snapshot existing template returns 409` | #1 | Create VM → snapshot as "X" → snapshot as "X" again → 409 status |
| `snapshot with overwrite replaces existing template` | #2 | Create VM → snapshot as "X" → snapshot as "X" with overwrite → 201, template updated |

#### Test implementation for `snapshot existing template returns 409`:

```typescript
test(
  "snapshot existing template returns 409",
  async () => {
    const vm = await sbVmCreate("debian-base");
    createdVmIds.push(vm.id as string);
    await sbVmWait(vm.id as string, 90);

    const templateName = `overwrite-test-${Date.now()}`;
    createdTemplates.push(templateName);
    await sbVmSnapshot(vm.id as string, templateName);

    // Second snapshot with same name should return 409
    const result = await sbVmSnapshotRaw(vm.id as string, templateName);
    expect(result.exitCode).not.toBe(0);
    expect(result.data?.status).toBe(409);
  },
  { timeout: 90000 },
);
```

#### Test implementation for `snapshot with overwrite replaces existing template`:

```typescript
test(
  "snapshot with overwrite replaces existing template",
  async () => {
    const vm = await sbVmCreate("debian-base");
    createdVmIds.push(vm.id as string);
    await sbVmWait(vm.id as string, 90);

    const templateName = `overwrite-replace-${Date.now()}`;
    createdTemplates.push(templateName);
    await sbVmSnapshot(vm.id as string, templateName);

    // Overwrite should succeed
    const snapshot = await sbVmSnapshot(vm.id as string, templateName, { overwrite: true });
    expect(snapshot.template).toBe(templateName);
    expect(snapshot.size_bytes).toBeGreaterThan(0);
  },
  { timeout: 90000 },
);
```

Verify both tests **fail** before implementing production code.

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/services/vm.ts` | Modify | Add `overwrite` parameter to `snapshotVm`, delete existing template when `overwrite` is true |
| `src/index.ts` | Modify | Extract `overwrite` from request body and pass to `snapshotVm` |
| `scripts/sb` | Modify | Add `--overwrite` flag and interactive 409 prompt to `cmd_vm_snapshot` |

#### `src/services/vm.ts` changes

Add `unlink` to the existing `node:fs/promises` import (line 3):

```typescript
import { stat, unlink } from "node:fs/promises";
```

Change the `snapshotVm` function signature (line 342) from:

```typescript
export async function snapshotVm(vm: VM, templateName: string): Promise<SnapshotResponse> {
```

to:

```typescript
export async function snapshotVm(vm: VM, templateName: string, overwrite = false): Promise<SnapshotResponse> {
```

Replace the template existence check (lines 351-355) from:

```typescript
	// Check if template already exists
	const templatePath = `${config.dataDir}/templates/${templateName}.ext4`;
	if (existsSync(templatePath)) {
		throw { status: 409, message: "Template already exists" };
	}
```

to:

```typescript
	// Check if template already exists
	const templatePath = `${config.dataDir}/templates/${templateName}.ext4`;
	if (existsSync(templatePath)) {
		if (!overwrite) {
			throw { status: 409, message: "Template already exists" };
		}
		// Prevent overwriting protected templates (e.g., debian-base)
		if (config.protectedTemplates.includes(templateName)) {
			throw { status: 403, message: "Cannot overwrite protected template" };
		}
		// Delete existing template before overwriting (ensures proper btrfs reflink on new copy)
		await unlink(templatePath);
	}
```

#### `src/index.ts` changes

In the snapshot endpoint (line 170), extract `overwrite` from the request body and pass it to `snapshotVm`. Change:

```typescript
		const body = await c.req.json();
		const templateName = body.template_name;

		if (!templateName) {
			return c.json({ error: "template_name is required" }, 400);
		}

		const result = await snapshotVm(vm, templateName);
```

to:

```typescript
		const body = await c.req.json();
		const templateName = body.template_name;
		const overwrite = body.overwrite === true;

		if (!templateName) {
			return c.json({ error: "template_name is required" }, 400);
		}

		const result = await snapshotVm(vm, templateName, overwrite);
```

#### `scripts/sb` changes

Replace the entire `cmd_vm_snapshot` function (lines 439-462) with:

```bash
cmd_vm_snapshot() {
  need_config
  local id="${1:-}"
  local name=""
  local overwrite=false
  shift || true

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -n|--name) name="$2"; shift 2 ;;
      --overwrite) overwrite=true; shift ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  [[ -n "$id" ]] || die "Usage: sb vm snapshot <name|id> -n TEMPLATE_NAME [--overwrite]"
  [[ -n "$name" ]] || die "Template name required: -n NAME"

  local json_body
  if [[ "$overwrite" == "true" ]]; then
    json_body=$(jq -n --arg n "$name" '{template_name:$n, overwrite:true}')
  else
    json_body=$(jq -n --arg n "$name" '{template_name:$n}')
  fi

  local response
  if response=$(api POST "/vms/$id/snapshot" -d "$json_body"); then
    echo "$response" | output_single
  else
    # Check for 409 conflict - prompt for overwrite in interactive mode
    local status
    status=$(echo "$response" | jq -r '.status // 0' 2>/dev/null)
    if [[ "$status" == "409" && "$JSON_OUTPUT" != "true" ]]; then
      printf "Template '%s' already exists. Overwrite? [y/N] " "$name"
      read -r confirm
      if [[ "$confirm" == "y" || "$confirm" == "Y" ]]; then
        local overwrite_body
        overwrite_body=$(jq -n --arg n "$name" '{template_name:$n, overwrite:true}')
        if response=$(api POST "/vms/$id/snapshot" -d "$overwrite_body"); then
          echo "$response" | output_single
        else
          echo "$response"
          return 1
        fi
      else
        echo "Aborted."
        return 1
      fi
    else
      echo "$response"
      return 1
    fi
  fi
}
```

### Verification

- Both acceptance tests pass (green)
- `sb vm snapshot <id> -n existing-name` returns 409 error
- `sb vm snapshot <id> -n existing-name --overwrite` succeeds
- In non-JSON mode, 409 triggers interactive prompt; "y" retries with overwrite, anything else aborts
- In `--json` mode, 409 returns JSON error without prompting
- Run `./do check` — all checks pass

---

## Phase 3: VM Hostname

### Goal

Set the VM's hostname to its generated three-word name during creation. This writes `/etc/hostname` and updates `/etc/hosts` inside the rootfs before Firecracker boots the VM.

### Acceptance Test (Red)

Unskip and implement:

| Test | Criterion | Expected Behavior |
|------|-----------|-------------------|
| `VM hostname matches generated name` | #3 | Create VM → SSH in → `hostname` output equals `vm.name` |

#### Test implementation:

```typescript
test(
  "VM hostname matches generated name",
  async () => {
    const vm = await sbVmCreate("debian-base");
    createdVmIds.push(vm.id as string);

    await waitForSsh(vm.ssh_port as number, 90000);
    const hostname = await sshExec(vm.ssh_port as number, "hostname");
    expect(hostname.trim()).toBe(vm.name);
  },
  { timeout: 90000 },
);
```

Verify the test **fails** before implementing production code.

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/services/storage.ts` | Modify | Add `setHostname` function |
| `src/services/vm.ts` | Modify | Call `setHostname` during VM creation |

#### `src/services/storage.ts` — add `setHostname` function

**Design note:** This performs a separate mount/unmount cycle from `injectSshKey`. This is intentional — it keeps each function self-contained and follows the existing pattern where `injectSshKey` and `clearAuthorizedKeys` are independent mount operations. The overhead of a second mount/unmount (~50ms) is negligible compared to VM boot time.

Add the following function after the existing `injectSshKey` function (after line 59):

```typescript
export async function setHostname(rootfsPath: string, hostname: string): Promise<void> {
	const mountPoint = `/tmp/mount-${Date.now()}`;
	await mkdir(mountPoint, { recursive: true });

	try {
		await $`sudo mount -o loop ${rootfsPath} ${mountPoint}`;

		// Write /etc/hostname
		const tempFile = `/tmp/hostname_${Date.now()}`;
		await writeFile(tempFile, `${hostname}\n`);
		await $`sudo cp ${tempFile} ${mountPoint}/etc/hostname`;
		await $`rm -f ${tempFile}`;

		// Update /etc/hosts — remove any existing 127.0.1.1 line and add new one
		await $`sudo sed -i '/^127\\.0\\.1\\.1/d' ${mountPoint}/etc/hosts`.quiet().nothrow();
		const tempHostsLine = `/tmp/hosts_line_${Date.now()}`;
		await writeFile(tempHostsLine, `127.0.1.1\t${hostname}\n`);
		await $`cat ${tempHostsLine} | sudo tee -a ${mountPoint}/etc/hosts`.quiet();
		await $`rm -f ${tempHostsLine}`;
	} finally {
		try {
			await $`sudo umount ${mountPoint}`;
		} catch {
			// Ignore unmount errors
		}
		try {
			await $`rmdir ${mountPoint}`.quiet();
		} catch {
			// Ignore rmdir errors
		}
	}
}
```

#### `src/services/vm.ts` — call `setHostname` during VM creation

Add `setHostname` to the imports from `./storage` (line 27):

```typescript
import {
	checkAvailableSpace,
	clearAuthorizedKeys,
	copyRootfs,
	copyRootfsToTemplate,
	deleteRootfs,
	injectSshKey,
	resizeRootfs,
	setHostname,
} from "./storage";
```

In the `createVm` function, after the SSH key injection (after line 222), add:

```typescript
		// Set hostname to VM name
		if (name) {
			console.log(`[${vmId}] Setting hostname to ${name}...`);
			await setHostname(rootfsPath, name);
		}
```

### Verification

- Acceptance test passes (green)
- `hostname` command inside a new VM returns the three-word name
- VMs with custom names also get correct hostname
- Run `./do check` — all checks pass

---

## Phase 4: Docker Base Image

### Goal

Replace `debootstrap` with `crane export` for creating the base template from a Docker image. Install the `crane` binary during installation and updates. Add `BASE_IMAGE` to the configuration (default: `ghcr.io/the-agentic-journey/agenticbaseimage:latest`). Expose `base_image` in the `/info` API endpoint.

**Note:** The default image `ghcr.io/the-agentic-journey/agenticbaseimage:latest` includes SSH server, user account, mosh, haveged, locale, Claude Code CLI, and all other packages needed for full Scalebox compatibility. All existing tests (including SSH-dependent ones) should pass with this image.

### Acceptance Test (Red)

Unskip and implement:

| Test | Criterion | Expected Behavior |
|------|-----------|-------------------|
| `info returns base_image` | #4 | `GET /info` response includes `base_image` field as a non-empty string |

#### Test implementation:

```typescript
test("info returns base_image", async () => {
  const status = await sbStatus();
  expect(status.base_image).toBeDefined();
  expect(typeof status.base_image).toBe("string");
  expect((status.base_image as string).length).toBeGreaterThan(0);
});
```

Verify the test **fails** before implementing production code.

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/config.ts` | Modify | Add `baseImage` config key |
| `src/index.ts` | Modify | Expose `base_image` in `/info` response |
| `scripts/install.sh` | Modify | Add `install_crane` function, add `BASE_IMAGE` to config file, call `install_crane` |
| `scripts/scalebox-update` | Modify | Add `install_crane` function, call it during update |
| `scripts/template-build.sh` | Modify | Replace `debootstrap` with `crane export`, skip `configure_rootfs`, bump `TEMPLATE_VERSION` to 7 |
| `scripts/scalebox-rebuild-template` | Modify | Source config to get `BASE_IMAGE` |

#### `src/config.ts` — add `baseImage`

Add after line 20 (before the closing `};`):

```typescript
	// Docker image used to create the base template (used by template-build.sh)
	baseImage: process.env.BASE_IMAGE || "ghcr.io/the-agentic-journey/agenticbaseimage:latest",
```

#### `src/index.ts` — expose in `/info`

In the `/info` response object (around line 39), add `base_image` field. Add after `base_domain: config.baseDomain,` (line 41):

```typescript
		base_image: config.baseImage,
```

#### `scripts/install.sh` — install crane + config

Add `CRANE_VERSION` to the configuration section (after line 24, after the `KERNEL_URL` line):

```bash
CRANE_VERSION="0.20.3"
CRANE_URL="https://github.com/google/go-containerregistry/releases/download/v${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz"
```

Add `BASE_IMAGE` variable initialization (after line 20, near the other config vars):

```bash
BASE_IMAGE="${BASE_IMAGE:-ghcr.io/the-agentic-journey/agenticbaseimage:latest}"
```

Add `install_crane` function (after the `install_firecracker` function, around line 125):

```bash
# === Install crane (container image tool) ===
install_crane() {
  local crane_bin="/usr/local/bin/crane"

  if [[ -f "$crane_bin" ]]; then
    log "crane already installed"
    return
  fi

  log "Installing crane v${CRANE_VERSION}..."
  wget -q "$CRANE_URL" -O /tmp/crane.tar.gz
  tar -xzf /tmp/crane.tar.gz -C /tmp crane
  mv /tmp/crane "$crane_bin"
  chmod +x "$crane_bin"
  rm -f /tmp/crane.tar.gz
}
```

Add `BASE_IMAGE` to the config file template in `install_service()` (line 473, after the `ACME_STAGING` line):

```bash
BASE_IMAGE=$BASE_IMAGE
```

Call `install_crane` in the main install flow. In the main function body (around line 535, after `install_firecracker`), add:

```bash
  install_crane
```

#### `scripts/scalebox-update` — install crane during update

Add `CRANE_VERSION` and `CRANE_URL` to the top of the file (after line 16, after `HEALTH_DELAY`):

```bash
CRANE_VERSION="0.20.3"
CRANE_URL="https://github.com/google/go-containerregistry/releases/download/v${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz"
```

Add `install_crane` function (after the `upgrade_kernel` function, around line 188):

```bash
install_crane() {
  local crane_bin="/usr/local/bin/crane"

  if [[ -f "$crane_bin" ]]; then
    return
  fi

  log "Installing crane v${CRANE_VERSION}..."
  if wget -q "$CRANE_URL" -O /tmp/crane.tar.gz; then
    tar -xzf /tmp/crane.tar.gz -C /tmp crane
    mv /tmp/crane "$crane_bin"
    chmod +x "$crane_bin"
    rm -f /tmp/crane.tar.gz
    log "crane installed"
  else
    rm -f /tmp/crane.tar.gz
    log "WARNING: crane download failed. Template rebuild will require crane."
  fi
}
```

Call `install_crane` in the update flow (after `upgrade_kernel`, in the main update sequence around line 400):

```bash
  install_crane
```

Also add a migration to append `BASE_IMAGE` to existing configs if not present. Add a `migrate_base_image` function (after the other `migrate_*` functions):

```bash
migrate_base_image() {
  local config_file="/etc/scaleboxd/config"
  if ! grep -q "^BASE_IMAGE=" "$config_file" 2>/dev/null; then
    echo "BASE_IMAGE=ghcr.io/the-agentic-journey/agenticbaseimage:latest" >> "$config_file"
    log "Added BASE_IMAGE to config"
  fi
}
```

Call it in the update flow alongside the other migrations.

#### `scripts/template-build.sh` — use crane instead of debootstrap

Bump `TEMPLATE_VERSION` on line 10:

```bash
TEMPLATE_VERSION=7
```

Replace the `build_debian_base` function body. The new function:

```bash
build_debian_base() {
  local data_dir="${1:-/var/lib/scalebox}"
  local template_path="$data_dir/templates/debian-base.ext4"
  local version_path="$data_dir/templates/debian-base.version"

  # Read base image from config (set by /etc/scaleboxd/config or environment)
  local base_image="${BASE_IMAGE:-ghcr.io/the-agentic-journey/agenticbaseimage:latest}"

  # Verify crane is installed
  if ! command -v crane &>/dev/null; then
    echo "[template-build] ERROR: crane not found. Install it first." >&2
    exit 1
  fi

  # Create temp directories in data_dir to avoid /tmp noexec issues
  local build_dir="$data_dir/build"
  mkdir -p "$build_dir"
  local rootfs_dir
  local mount_dir
  rootfs_dir=$(mktemp -d "$build_dir/rootfs-XXXXXX")
  mount_dir=$(mktemp -d "$build_dir/mount-XXXXXX")
  chmod 755 "$rootfs_dir" "$mount_dir"

  # Set up cleanup trap
  trap "cleanup_build '$rootfs_dir' '$mount_dir'" EXIT

  # Pull and extract Docker image filesystem
  echo "[template-build] Pulling and extracting $base_image..."
  if ! crane export "$base_image" - | tar -xf - -C "$rootfs_dir"; then
    echo "[template-build] ERROR: Failed to pull or extract Docker image '$base_image'" >&2
    exit 1
  fi

  # Create ext4 image
  create_ext4_image "$rootfs_dir" "$mount_dir" "$template_path"

  # Write version file
  echo "$TEMPLATE_VERSION" > "$version_path"

  # Clear trap and cleanup
  trap - EXIT
  cleanup_build "$rootfs_dir" "$mount_dir"

  echo "[scalebox] Base template created from $base_image: $template_path"
}
```

**Key differences from old version:**
- `debootstrap` call replaced with `crane export "$base_image" - | tar -xf - -C "$rootfs_dir"`
- `configure_rootfs` call removed entirely
- `BASE_IMAGE` read from environment with default `ghcr.io/the-agentic-journey/agenticbaseimage:latest`
- `crane` presence verified before starting

The `configure_rootfs`, `setup_chroot_mounts`, and `teardown_chroot_mounts` functions remain in the file but are no longer called by `build_debian_base`. They can be removed in a future cleanup.

#### `scripts/scalebox-rebuild-template` — source config

Add config sourcing before the rebuild, so `BASE_IMAGE` is available. In the `rebuild_template` function, before the build step (before line 43), add:

```bash
  # Source config to get BASE_IMAGE
  if [[ -f /etc/scaleboxd/config ]]; then
    # shellcheck source=/dev/null
    source /etc/scaleboxd/config
  fi
```

### Verification

- Acceptance test passes (green) — `/info` returns `base_image`
- `crane` binary is installed at `/usr/local/bin/crane`
- `BASE_IMAGE` appears in `/etc/scaleboxd/config`
- `scalebox-rebuild-template` creates a template from the Docker image
- Template file exists and is valid ext4
- A VM can be created from the Docker-based template (API returns 201)
- Run `./do check` — all tests pass (the default image includes SSH and all required packages)

---

## Phase 5: ADR — Docker-Based Template Build

### Goal

Record the architectural decision to switch from debootstrap to Docker images via crane for base template creation.

### Changes

| File | Action | Details |
|------|--------|---------|
| `product/ADR/017-docker-base-image.md` | Create | ADR documenting the switch from debootstrap to crane + Docker images |

#### ADR content:

```markdown
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
```

### Verification

- Review ADR for completeness (context, decision, rationale, consequences)

---

## Phase 6: DDD — Glossary Updates

### Goal

Document new domain concepts introduced by these features.

### Changes

| File | Action | Details |
|------|--------|---------|
| `product/DDD/glossary.md` | Modify | Add "Base Image" term, update "VM Creation" process, update "Template Rebuild" |

#### Glossary additions

Add under **Infrastructure Terms** (after the "COW" entry, before "ACME Staging"):

```markdown
### Base Image (BASE_IMAGE)
The Docker image used as the source for building the base template. Configured via `BASE_IMAGE` in `/etc/scaleboxd/config`. Default: `ghcr.io/the-agentic-journey/agenticbaseimage:latest`. The image is pulled and extracted using `crane` during template creation.

### crane
A CLI tool from Google's go-containerregistry project used to pull and export Docker images without requiring a Docker daemon. Installed at `/usr/local/bin/crane`. Used by `template-build.sh` to convert a Docker image into a rootfs directory.
```

Update the **VM Creation** definition under "Process Terms" to include hostname:

```markdown
### VM Creation
The orchestrated process of: allocate resources → copy rootfs → inject SSH key → set hostname → create TAP → start Firecracker → start proxy.
```

Update the **VM Snapshotting** definition under "Process Terms" to mention overwrite:

```markdown
### VM Snapshotting
The process of: pause VM → copy rootfs to templates → resume VM → clear SSH keys from template. If the target template already exists, the API returns 409 unless `overwrite: true` is specified, in which case the existing template is replaced. Protected templates cannot be overwritten.
```

Update the **Template Rebuild** definition under "Operations Terms":

```markdown
### Template Rebuild
The process of recreating the base template from the configured Docker image using `scalebox-rebuild-template`. The Docker image is pulled via `crane`, extracted to a rootfs directory, and packaged as an ext4 image. Running VMs are not affected due to btrfs copy-on-write.
```

### Verification

- Review documentation for accuracy and completeness

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `test/integration.test.ts` | Modify | Add 4 acceptance tests (scaffolds, then implementations) |
| `test/helpers.ts` | Modify | Add `sbVmSnapshotRaw`, update `sbVmSnapshot` for overwrite |
| `src/services/vm.ts` | Modify | Add `overwrite` to `snapshotVm`, call `setHostname` in `createVm` |
| `src/index.ts` | Modify | Pass `overwrite` to snapshot, add `base_image` to `/info` |
| `src/services/storage.ts` | Modify | Add `setHostname` function |
| `src/config.ts` | Modify | Add `baseImage` config key |
| `scripts/sb` | Modify | Add `--overwrite` flag and interactive prompt to `cmd_vm_snapshot` |
| `scripts/install.sh` | Modify | Add `install_crane`, `BASE_IMAGE` config, crane version vars |
| `scripts/scalebox-update` | Modify | Add `install_crane`, `migrate_base_image` |
| `scripts/template-build.sh` | Modify | Replace debootstrap with crane, skip configure_rootfs, bump version |
| `scripts/scalebox-rebuild-template` | Modify | Source config for `BASE_IMAGE` |
| `product/ADR/017-docker-base-image.md` | Create | ADR for Docker-based template build |
| `product/DDD/glossary.md` | Modify | Add Base Image, crane terms; update VM Creation, Template Rebuild |

---

## End-to-End Verification

After all phases are complete:

1. All 4 acceptance tests pass (none skipped)
2. `./do check` passes — full verification pipeline
3. On a fresh install:
   - `crane` is installed at `/usr/local/bin/crane`
   - `BASE_IMAGE=ghcr.io/the-agentic-journey/agenticbaseimage:latest` is in `/etc/scaleboxd/config`
   - `debian-base.ext4` template is created from the Docker image
4. `sb vm snapshot <id> -n existing --overwrite` replaces an existing template
5. `sb vm snapshot <id> -n existing` (without flag) prompts interactively on conflict
6. New VMs have their hostname set to the generated three-word name
7. `GET /info` returns `base_image` field

---

## Update Considerations

- **Config changes**: New `BASE_IMAGE` key with default `ghcr.io/the-agentic-journey/agenticbaseimage:latest` in `config.ts` and `/etc/scaleboxd/config`. Old configs without `BASE_IMAGE` work fine (default applied). `migrate_base_image` in `scalebox-update` appends the key.
- **Storage changes**: None — same template directory structure, same ext4 format
- **Dependency changes**: `crane` binary installed by `install_crane()` in both `install.sh` and `scalebox-update`. `debootstrap` is no longer required for template builds but remains installed.
- **Migration needed**: No data migration. `TEMPLATE_VERSION` bumped to 7; `scalebox-update` will prompt users to run `scalebox-rebuild-template` to get a Docker-based template.
- **Backwards compatibility**: Existing `debian-base.ext4` templates continue to work. Only newly built templates use Docker images. The `overwrite` API field is additive (existing clients don't send it, behavior unchanged). VM hostname setting is additive (no impact on existing VMs).
