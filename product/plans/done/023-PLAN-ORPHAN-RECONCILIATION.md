# Orphan Reconciliation Plan

## Overview

When scaleboxd restarts, orphaned resources (Firecracker processes, TAP devices, rootfs files) may exist on the host from:

- VMs created before state persistence was added (plan 018)
- Corrupted or deleted `state.json`
- scaleboxd crashes that didn't trigger `saveState()`

Additionally, the systemd service file uses default `KillMode=control-group`, which kills all Firecracker child processes when scaleboxd stops — making VMs unable to survive restarts despite state persistence from plan 018.

This plan:
1. Fixes `KillMode=process` so VMs actually survive scaleboxd restarts
2. Adds system-level resource discovery on startup that finds and cleans up orphaned resources not tracked in `state.json`

## Acceptance Criteria

| # | Criterion | Acceptance Test |
|---|-----------|-----------------|
| 1 | VMs survive scaleboxd restart when state.json is intact | `./do`: `test_reconciliation` — restart sub-test |
| 2 | Orphaned Firecracker processes (not in state.json) are killed on startup | `./do`: `test_reconciliation` — orphan cleanup sub-test |
| 3 | Orphaned TAP devices (not belonging to known VMs) are deleted on startup | `./do`: `test_reconciliation` — orphan cleanup sub-test |
| 4 | Orphaned rootfs files (not belonging to known VMs) are deleted on startup | `./do`: `test_reconciliation` — orphan cleanup sub-test |
| 5 | Each cleanup action is logged with `[reconcile]` prefix identifying the resource | `./do`: `test_reconciliation` — log verification sub-test |
| 6 | Known VMs recovered from state.json are not affected by reconciliation | `./do`: `test_reconciliation` — restart sub-test (VM still accessible after restart + reconciliation) |

---

## Phase 1: Acceptance Test Scaffolds

### Goal

Create the acceptance test shell function as a skipped stub in `./do`. After this phase, `./do check` passes with the stub included.

### Changes

| File | Action | Details |
|------|--------|---------|
| `./do` | Modify | Add `test_reconciliation()` function and call it from `do_check()` |

### Implementation Details

Add this function before `do_check()` (after the existing `check_firewall_rule()` function):

```bash
test_reconciliation() {
  local token=$1
  echo "==> SKIP: reconciliation tests (not yet implemented)"
  return 0
}
```

In `do_check()`, add the reconciliation test call at the end of the function, after the existing `echo "==> All tests passed!"` line. The end of `do_check()` becomes:

```bash
  echo ""
  echo "==> All tests passed!"

  echo "==> Running reconciliation tests..."
  test_reconciliation "$token"
}
```

### Verification

- `./do check` passes
- Output includes "SKIP: reconciliation tests"

---

## Phase 2: KillMode=process

### Goal

Fix the systemd service file so `systemctl stop scaleboxd` only sends SIGTERM to scaleboxd, not to Firecracker child processes. This makes VMs actually survive scaleboxd restarts.

### Acceptance Test (Red)

Replace the entire `test_reconciliation()` function with the restart sub-test (including the Phase 3 placeholder at the end):

```bash
test_reconciliation() {
  local token=$1

  # --- Sub-test: VM survives restart ---
  echo "==> Test: VMs survive scaleboxd restart..."

  local create_result
  create_result=$(curl -sk -X POST "https://$VM_FQDN/vms" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "{\"template\": \"debian-base\", \"ssh_public_key\": \"$(cat test/fixtures/test_key.pub)\"}")

  local vm_id
  vm_id=$(echo "$create_result" | jq -r '.id')
  [[ "$vm_id" == vm-* ]] || die "Failed to create VM for reconciliation test: $create_result"
  echo "    Created VM: $vm_id"

  # Restart scaleboxd (state.json stays intact)
  echo "    Restarting scaleboxd..."
  gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="sudo systemctl restart scaleboxd" \
    --quiet

  # Wait for health
  echo "    Waiting for scaleboxd..."
  local retries=30
  while [[ $retries -gt 0 ]]; do
    if curl -sk "https://$VM_FQDN/health" 2>/dev/null | jq -e '.status == "ok"' >/dev/null 2>&1; then
      break
    fi
    sleep 2
    ((retries--)) || true
  done
  [[ $retries -gt 0 ]] || die "scaleboxd did not become healthy after restart"

  # Verify VM survived
  local list_after
  list_after=$(curl -sk "https://$VM_FQDN/vms" -H "Authorization: Bearer $token")
  echo "$list_after" | jq -e ".vms[] | select(.id == \"$vm_id\")" >/dev/null \
    || die "VM $vm_id not found after restart — VM did not survive"
  echo "    PASS: VM survived restart"

  # Clean up the test VM
  curl -sk -X DELETE "https://$VM_FQDN/vms/$vm_id" \
    -H "Authorization: Bearer $token" >/dev/null

  # --- Placeholder for Phase 3 orphan cleanup test ---
  echo "==> SKIP: orphan cleanup test (not yet implemented)"

  echo "==> Reconciliation tests PASSED"
}
```

Verify the test **fails** (red) — with current `KillMode=control-group`, the VM is killed during restart and `recoverVms()` finds a dead process, so the VM is cleaned up instead of recovered.

### Changes

| File | Action | Details |
|------|--------|---------|
| `scripts/scaleboxd.service` | Modify | Add `KillMode=process` under `[Service]` |
| `./do` | Modify | Implement restart sub-test in `test_reconciliation()` |

#### `scripts/scaleboxd.service`

Add `KillMode=process` after the `RestartSec=5` line. The full `[Service]` section becomes:

```ini
[Service]
Type=simple
ExecStart=/usr/local/bin/scaleboxd
EnvironmentFile=/etc/scaleboxd/config
Restart=on-failure
RestartSec=5
KillMode=process
```

This tells systemd to only send SIGTERM to the main scaleboxd process (PID 1 of the unit), leaving Firecracker child processes running. Firecracker (written in Rust) ignores SIGPIPE by default, so it continues running even when scaleboxd's pipe readers die.

### Verification

- Acceptance test passes (green): VM survives `systemctl restart scaleboxd`
- `./do check` passes

---

## Phase 3: Orphan Reconciliation

### Goal

Create `src/services/reconcile.ts` that discovers and cleans up orphaned system resources on startup. Integrate into the startup sequence in `src/index.ts`. Implement the orphan cleanup acceptance test.

### Acceptance Test (Red)

Replace the placeholder in `test_reconciliation()` (the line `echo "==> SKIP: orphan cleanup test (not yet implemented)"`) with the orphan cleanup sub-test:

```bash
  # --- Sub-test: Orphan cleanup ---
  echo "==> Test: Orphan cleanup on startup..."

  # Create a VM (this will become an orphan)
  local orphan_result
  orphan_result=$(curl -sk -X POST "https://$VM_FQDN/vms" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "{\"template\": \"debian-base\", \"ssh_public_key\": \"$(cat test/fixtures/test_key.pub)\"}")

  local orphan_id
  orphan_id=$(echo "$orphan_result" | jq -r '.id')
  [[ "$orphan_id" == vm-* ]] || die "Failed to create orphan VM: $orphan_result"
  echo "    Created orphan VM: $orphan_id"

  # Stop scaleboxd, delete state.json, start scaleboxd
  # This simulates the pre-persistence era: VM resources exist but scaleboxd has no record
  echo "    Simulating orphan scenario (deleting state.json)..."
  gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="sudo systemctl stop scaleboxd && sudo rm -f /var/lib/scalebox/vms/state.json && sudo systemctl start scaleboxd" \
    --quiet

  # Wait for health
  echo "    Waiting for scaleboxd..."
  local retries=30
  while [[ $retries -gt 0 ]]; do
    if curl -sk "https://$VM_FQDN/health" 2>/dev/null | jq -e '.status == "ok"' >/dev/null 2>&1; then
      break
    fi
    sleep 2
    ((retries--)) || true
  done
  [[ $retries -gt 0 ]] || die "scaleboxd did not become healthy after orphan test restart"

  # Note: reconciliation runs synchronously during startup (before HTTP server starts),
  # so by the time the health check passes, reconciliation has already completed.

  # Verify: no VMs listed (the orphan should have been cleaned up)
  local vm_count
  vm_count=$(curl -sk "https://$VM_FQDN/vms" -H "Authorization: Bearer $token" | jq '.vms | length')
  [[ "$vm_count" == "0" ]] || die "Expected 0 VMs after orphan cleanup, got $vm_count"
  echo "    PASS: No VMs listed"

  # Verify: no orphaned Firecracker processes
  local fc_count
  fc_count=$(gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="pgrep -c firecracker 2>/dev/null || echo 0" \
    --quiet)
  fc_count=$(echo "$fc_count" | tr -d '[:space:]')
  [[ "$fc_count" == "0" ]] || die "Expected 0 Firecracker processes, got $fc_count"
  echo "    PASS: No orphaned Firecracker processes"

  # Verify: no orphaned TAP devices
  local tap_count
  tap_count=$(gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="ip -o link show | grep -c 'tap-' || echo 0" \
    --quiet)
  tap_count=$(echo "$tap_count" | tr -d '[:space:]')
  [[ "$tap_count" == "0" ]] || die "Expected 0 TAP devices, got $tap_count"
  echo "    PASS: No orphaned TAP devices"

  # Verify: no orphaned rootfs files
  local rootfs_count
  rootfs_count=$(gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="ls /var/lib/scalebox/vms/*.ext4 2>/dev/null | wc -l" \
    --quiet)
  rootfs_count=$(echo "$rootfs_count" | tr -d '[:space:]')
  [[ "$rootfs_count" == "0" ]] || die "Expected 0 rootfs files, got $rootfs_count"
  echo "    PASS: No orphaned rootfs files"

  # Verify: reconciliation log messages exist
  local logs
  logs=$(gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="sudo journalctl -u scaleboxd --no-pager -n 50" \
    --quiet)
  echo "$logs" | grep -q "\[reconcile\] Found orphaned" \
    || die "Expected '[reconcile] Found orphaned' log entries in scaleboxd journal"
  echo "$logs" | grep -q "\[reconcile\] Cleaned up:" \
    || die "Expected '[reconcile] Cleaned up:' summary in scaleboxd journal"
  echo "    PASS: Reconciliation log messages present"
```

Verify the test **fails** (red) — no `reconcileOrphans()` function exists, so orphaned resources are not cleaned up.

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/services/reconcile.ts` | Create | Orphan discovery and cleanup |
| `src/index.ts` | Modify | Import and call `reconcileOrphans()` after `recoverVms()` |
| `./do` | Modify | Replace orphan cleanup placeholder with full test |

#### `src/services/reconcile.ts` — complete file:

```typescript
import { readdir } from "node:fs/promises";
import { $ } from "bun";
import { config } from "../config";
import { stopFirecracker } from "./firecracker";
import { deleteTapDevice } from "./network";
import { deleteRootfs } from "./storage";
import { vms } from "./vm";

function log(msg: string): void {
	console.log(`[reconcile] ${msg}`);
}

export async function reconcileOrphans(): Promise<void> {
	log("Scanning for orphaned resources...");

	const knownVmIds = new Set(vms.keys());
	const knownPids = new Set(Array.from(vms.values()).map((vm) => vm.pid));
	const knownTapDevices = new Set(
		Array.from(vms.values()).map((vm) => vm.tapDevice),
	);

	let cleanedProcesses = 0;
	let cleanedTapDevices = 0;
	let cleanedRootfsFiles = 0;

	// 1. Discover and kill orphaned Firecracker processes
	// Uses pgrep -a to get PID + full command line, then matches Scalebox socket pattern
	try {
		const output = await $`pgrep -a firecracker`.text();
		for (const line of output.trim().split("\n")) {
			if (!line.trim()) continue;

			const pidMatch = line.match(/^(\d+)/);
			if (!pidMatch) continue;
			const pid = parseInt(pidMatch[1]);

			// Only consider Scalebox-managed processes (socket path anchored to /tmp/)
			const socketMatch = line.match(
				/\/tmp\/firecracker-(vm-[0-9a-f]{12})\.sock/,
			);
			if (!socketMatch) continue;

			if (!knownPids.has(pid)) {
				const vmId = socketMatch[1];
				log(
					`Found orphaned Firecracker process PID ${pid} (${vmId}) — killing`,
				);
				await stopFirecracker(pid);
				cleanedProcesses++;
			}
		}
	} catch {
		// pgrep returns exit code 1 when no processes match — this is normal
	}

	// 2. Discover and delete orphaned TAP devices
	// Lists network interfaces via /sys/class/net/ and filters for tap-* pattern
	try {
		const output = await $`ls /sys/class/net/`.text();
		const tapDevices = output
			.split(/\s+/)
			.filter((name) => name.startsWith("tap-"));

		for (const tap of tapDevices) {
			if (!knownTapDevices.has(tap)) {
				log(`Found orphaned TAP device ${tap} — deleting`);
				await deleteTapDevice(tap);
				cleanedTapDevices++;
			}
		}
	} catch {
		// /sys/class/net/ read failure — skip TAP cleanup
	}

	// 3. Discover and delete orphaned rootfs files
	// Lists *.ext4 files in the vms directory and checks against known VM IDs
	try {
		const vmsDir = `${config.dataDir}/vms`;
		const files = await readdir(vmsDir);

		for (const file of files) {
			// Only consider files matching the exact Scalebox VM rootfs pattern
			if (!/^vm-[0-9a-f]{12}\.ext4$/.test(file)) continue;

			// Extract VM ID from filename: "vm-a1b2c3d4e5f6.ext4" -> "vm-a1b2c3d4e5f6"
			const vmId = file.replace(".ext4", "");

			if (!knownVmIds.has(vmId)) {
				const fullPath = `${vmsDir}/${file}`;
				log(`Found orphaned rootfs ${fullPath} — deleting`);
				await deleteRootfs(fullPath);
				cleanedRootfsFiles++;
			}
		}
	} catch {
		// vms directory may not exist on fresh install — skip rootfs cleanup
	}

	const total = cleanedProcesses + cleanedTapDevices + cleanedRootfsFiles;
	if (total === 0) {
		log("No orphaned resources found");
	} else {
		log(
			`Cleaned up: ${cleanedProcesses} process(es), ${cleanedTapDevices} TAP device(s), ${cleanedRootfsFiles} rootfs file(s)`,
		);
	}
}
```

#### `src/index.ts` changes:

Add import (after the existing `cleanupOrphanedUdpRules` import):

```typescript
import { reconcileOrphans } from "./services/reconcile";
```

Add the `await reconcileOrphans()` call between the existing `await recoverVms()` line and the `updateCaddyConfig().then(...)` line. The startup block becomes:

```typescript
await cleanupOrphanedUdpRules();
await recoverVms();
await reconcileOrphans();

// Initialize Caddy config on startup to ensure vms.caddy matches current VM state
updateCaddyConfig().then(() => {
```

The startup order is:
1. `cleanupOrphanedUdpRules()` — removes ALL iptables NAT rules for 172.16.x.x (clean slate)
2. `recoverVms()` — reads state.json, reconnects to running VMs, re-creates their proxies
3. `reconcileOrphans()` — discovers resources not in the recovered VM Map, cleans them up
4. `updateCaddyConfig()` — regenerates Caddy config from current VM state

Note: iptables cleanup stays before recovery (not after). Recovery re-creates iptables rules for known VMs via `startUdpProxy()`. This avoids duplicate rules that would occur if cleanup ran after recovery.

### Verification

- Orphan cleanup acceptance test passes (green)
- `./do check` passes
- Journal shows `[reconcile] Found orphaned ...` entries when orphans exist
- Journal shows `[reconcile] No orphaned resources found` on clean startup

---

## Phase 4: DDD — Update Glossary and VM Lifecycle Context

### Goal

Document the new reconciliation and orphan concepts in the domain documentation.

### Changes

| File | Action | Details |
|------|--------|---------|
| `product/DDD/glossary.md` | Modify | Add "Orphaned Resource" and "Reconciliation" definitions |
| `product/DDD/contexts/vm-lifecycle.md` | Modify | Update Repository section to reflect state persistence and reconciliation |

#### Glossary additions

Add these entries at the end of the file, after the "Template Rebuild" definition in the "Operations Terms" section:

```markdown
### Orphaned Resource
A system resource (Firecracker process, TAP device, rootfs file) that exists on the host but is not tracked in scaleboxd's in-memory VM state. Orphans occur when state.json is missing, corrupted, or predates the state persistence feature (plan 018). Orphaned resources are automatically discovered and cleaned up on startup by the reconciliation process.

### Reconciliation
The startup process that scans the host for system resources not tracked in state.json and cleans them up. Runs after VM recovery. Discovers orphaned Firecracker processes (via `pgrep`), TAP devices (via `/sys/class/net/`), and rootfs files (via directory listing). Each discovered orphan is logged with `[reconcile]` prefix and cleaned up automatically.
```

#### VM Lifecycle context update

Find and replace the section titled "## Repository (In-Memory)" in `product/DDD/contexts/vm-lifecycle.md` (which contains `const vms = new Map<string, VM>();` and bullets about "No persistence" and "Design decision") with:

```markdown
## Repository

```typescript
const vms = new Map<string, VM>();
```

- **Persisted to disk:** VM state is saved to `/var/lib/scalebox/vms/state.json` after every creation and deletion
- **Recovery on startup:** `recoverVms()` reads state.json, checks if Firecracker PIDs are alive, and reconnects or cleans up dead VMs
- **Reconciliation on startup:** `reconcileOrphans()` scans for system resources not tracked in the VM Map and cleans them up (orphaned processes, TAP devices, rootfs files)
- **Exported:** Accessed by Access context for Caddy configuration
```

### Verification

- Review documentation for accuracy and completeness
- Glossary terms are consistent with implementation

---

## Phase 5: ADR — Orphan Reconciliation on Startup

### Goal

Record the architectural decision to perform system-level resource discovery and cleanup on startup.

### Changes

| File | Action | Details |
|------|--------|---------|
| `product/ADR/014-orphan-reconciliation.md` | Create | ADR documenting reconciliation approach |

#### ADR content:

```markdown
# ADR 014: System-Level Orphan Reconciliation on Startup

## Status

Accepted

## Context

Scalebox manages system resources (Firecracker processes, TAP network devices, rootfs disk images) for each VM. Plan 018 added state persistence to `state.json` so VMs could survive scaleboxd restarts. However, resources created before state persistence was added, or when `state.json` is missing or corrupted, become "orphans" — they exist on the host but scaleboxd has no record of them.

Additionally, the systemd service file used the default `KillMode=control-group`, which sent SIGTERM to all processes in scaleboxd's cgroup (including Firecracker child processes) when the service was stopped. This made VMs unable to actually survive restarts despite state persistence.

## Decision

1. **Change `KillMode=process`** in `scaleboxd.service` so systemd only kills the scaleboxd process on stop/restart, leaving Firecracker child processes running.

2. **Add a reconciliation step** (`reconcileOrphans()`) that runs on startup after VM recovery. It scans the host for system resources not tracked in the recovered VM state:
   - Orphaned Firecracker processes: discovered via `pgrep -a firecracker`, matched by Scalebox socket path pattern, killed via SIGTERM/SIGKILL
   - Orphaned TAP devices: discovered via `/sys/class/net/tap-*`, deleted via `ip link del`
   - Orphaned rootfs files: discovered via `*.ext4` in `/var/lib/scalebox/vms/`, deleted

3. **Log all reconciliation actions** with `[reconcile]` prefix for operator visibility.

4. **Keep iptables cleanup before recovery** (existing order). Recovery re-creates iptables rules for known VMs, which is simpler than selective cleanup after recovery.

## Alternatives Considered

- **Re-adopt orphaned VMs**: Reconstruct VM state from running processes and system resources, bringing them back under management. Rejected: too fragile — IP, port, template name, and SSH key cannot be reliably recovered from a running Firecracker process.

- **Manual cleanup command only**: Require operators to run a cleanup command. Rejected: orphans should never accumulate silently; automatic cleanup is more operationally sound.

- **Move iptables cleanup after recovery**: Rejected because it would cause duplicate iptables rules (old rules persist + recovery adds new ones). The current order (clean all → re-create for known VMs) is cleaner.

## Consequences

- VMs survive scaleboxd restarts via `systemctl restart` (completing plan 018's goal)
- Orphaned resources from any cause are automatically cleaned up on next startup
- Operators see explicit `[reconcile]` log entries for every cleaned resource
- Slight startup overhead for scanning processes/devices/files (negligible for expected scale)
- Non-Scalebox Firecracker processes are safely ignored (only processes with `/tmp/firecracker-vm-*.sock` pattern are considered)

## Supersedes

- **ADR 005 (In-Memory VM State)**: ADR 005 stated "All Firecracker processes die (they're children of scaleboxd)". With `KillMode=process`, this is no longer true — Firecracker processes survive scaleboxd restarts. ADR 005's "Cleanup consideration" section anticipated this plan: "A future enhancement could scan for orphaned resources on startup."
```

### Verification

- Review ADR for completeness (context, decision, alternatives, consequences)

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `./do` | Modify | Add `test_reconciliation()` and call from `do_check()` |
| `scripts/scaleboxd.service` | Modify | Add `KillMode=process` so VMs survive restarts |
| `src/services/reconcile.ts` | Create | Orphan discovery and cleanup on startup |
| `src/index.ts` | Modify | Import and call `reconcileOrphans()` after `recoverVms()` |
| `product/DDD/glossary.md` | Modify | Add "Orphaned Resource" and "Reconciliation" terms |
| `product/DDD/contexts/vm-lifecycle.md` | Modify | Update Repository section |
| `product/ADR/014-orphan-reconciliation.md` | Create | Document reconciliation decision |

---

## End-to-End Verification

After all phases are complete:

1. All acceptance tests pass (none skipped)
2. `./do check` passes — full verification pipeline
3. Create VM → `systemctl restart scaleboxd` → VM still listed and accessible
4. Create VM → stop scaleboxd → delete state.json → start scaleboxd → orphan resources cleaned up
5. Journal shows `[reconcile] Found orphaned ...` entries when orphans exist
6. Journal shows `[reconcile] No orphaned resources found` on clean startup

---

## Update Considerations

- **Config changes**: None
- **Storage changes**: None (reconciliation reads existing directories)
- **Dependency changes**: None
- **Service file changes**: `KillMode=process` added — deployed automatically via `scalebox-update`'s manifest-based install. `systemctl daemon-reload` is called by `scalebox-update` when service file changes.
- **Migration needed**: No — reconciliation handles existing orphans automatically on next startup
- **Backwards compatibility**: Fully backwards compatible. Old installations without `KillMode=process` default to `control-group` (current behavior). Reconciliation is additive — if there are no orphans, it logs "No orphaned resources found" and does nothing.
