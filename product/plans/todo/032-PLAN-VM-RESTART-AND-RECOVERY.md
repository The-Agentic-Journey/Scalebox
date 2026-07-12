# VM Restart & Disk-Preserving Recovery Plan

## Overview

Two related changes to the VM Lifecycle context:

1. **`POST /vms/:id/restart`** — a synchronous, in-place power-cycle of an existing VM. It reuses the VM's rootfs, IP, SSH proxy port, TAP device, and MAC, and produces a fresh Firecracker process. The request body may optionally override `disk_size_gib` (grow the rootfs), `vcpu_count`, and `mem_size_mib`. This is the supported way to recover a wedged/crashed guest or to resize a VM's disk without destroying it (the exact scenario behind the `quite-kind-newt` disk-full incident).

2. **Disk-preserving recovery** — change `recoverVms()` so that a VM whose Firecracker PID is dead but whose rootfs image still exists is **relaunched** (Firecracker restarted, proxies re-registered) instead of having its rootfs **deleted**. Today, `recoverVms()` calls `cleanupDeadVm()` → `deleteRootfs()` for any dead-PID VM, which permanently destroys the disk. Combined with the SIGTERM handler that persists in-memory PIDs on shutdown, this is a data-loss footgun: a crashed process, a manual `kill`, or a host reboot (which kills every Firecracker) would wipe VMs' disks on the next daemon start.

Supporting change required by both: **persist each VM's `vcpu_count` and `mem_size_mib`** in `state.json`, because restart and recovery both need to re-launch Firecracker with the VM's original CPU/memory sizing (the current `VM`/`state.json` schema does not store these).

### Why the two ship together

Restart inherently means "old PID dies, new PID appears." The disk-preserving recovery change removes the hazard that a badly-timed daemon restart during (or after a failed) restart could delete the disk. Persisting vCPU/memory is a shared prerequisite. Bundling them keeps the lifecycle coherent and lets one ADR capture the decision.

### Behavior change summary

- VMs now **survive host reboots** and process crashes: on daemon start, dead-PID VMs with an intact rootfs are relaunched rather than deleted. A VM's rootfs is only deleted by an explicit `DELETE /vms/:id`, or during recovery when the rootfs file is genuinely missing.
- `state.json` entries gain `vcpuCount` and `memSizeMib` fields (additive; old entries default to `config.defaultVcpuCount` / `config.defaultMemSizeMib`).

---

## Acceptance Criteria

| # | Criterion | Acceptance Test |
|---|-----------|-----------------|
| 1 | `POST /vms/:id/restart` on a running VM power-cycles it (guest `boot_id` changes), keeps the same IP/SSH port, and returns `200` with `status: "running"` | `test/integration.test.ts`: `restart power-cycles a running VM (boot_id changes)` |
| 2 | `POST /vms/:id/restart` with `disk_size_gib` grows the guest root filesystem | `test/integration.test.ts`: `restart with disk_size_gib grows guest disk` |
| 3 | `POST /vms/:id/restart` with `vcpu_count` changes the guest CPU count | `test/integration.test.ts`: `restart with vcpu_count changes nproc` |
| 4 | `POST /vms/:id/restart` with `mem_size_mib` changes the guest memory total | `test/integration.test.ts`: `restart with mem_size_mib changes MemTotal` |
| 5 | `POST /vms/:id/restart` on a nonexistent VM returns `404` | `test/integration.test.ts`: `restart nonexistent VM returns 404` |
| 6 | `POST /vms/:id/restart` with `disk_size_gib` smaller than the current size returns `400` | `test/integration.test.ts`: `restart rejects disk shrink` |
| 7 | `POST /vms/:id/restart` with out-of-range `disk_size_gib`/`vcpu_count`/`mem_size_mib` returns `400` | `test/integration.test.ts`: `restart rejects invalid overrides` |
| 8 | `sb vm restart <id>` power-cycles a VM (guest `boot_id` changes) | `test/integration.test.ts`: `CLI vm restart power-cycles a VM` |
| 9 | A VM whose Firecracker process died is relaunched (not deleted) on `scaleboxd` restart; its rootfs is preserved and the VM is reachable | `do` `test_reconciliation`: `VM with dead process is relaunched on restart` |
| 10 (regression) | A VM with a live Firecracker still reconnects on daemon restart; a true orphan (no `state.json`) is still fully cleaned up | Existing `do` `test_reconciliation` sub-tests (unchanged) |

---

## Phase 1: Acceptance Test Scaffolds

### Goal

Create all bun acceptance tests (criteria #1–#8) as **skipped** stubs, plus the two test helpers they depend on, so the suite compiles and `./do check` passes with the stubs skipped. (Criterion #9 is a shell sub-test in `do` and is delivered in Phase 5; criterion #10 is covered by existing sub-tests.)

### Changes

| File | Action | Details |
|------|--------|---------|
| `test/helpers.ts` | Modify | Add a `post` method to the exported `api` object: `async post(path, body, token) { const res = await apiFetch(path, { method: "POST", headers: { Authorization: \`Bearer ${token ?? API_TOKEN}\`, "Content-Type": "application/json" }, body: JSON.stringify(body) }); let json = null; try { json = await res.json(); } catch {} return { status: res.status, body: json }; }`. Add exported helper `sbVmRestart(nameOrId: string, opts: { diskSizeGib?: number; vcpuCount?: number; memSizeMib?: number } = {})` that builds `const args = ["vm","restart",nameOrId]`, appends `"--disk-size", String(opts.diskSizeGib)` when `opts.diskSizeGib !== undefined`, `"--vcpu", String(opts.vcpuCount)` when set, `"--mem", String(opts.memSizeMib)` when set, then — **exactly mirroring `sbVmSnapshot`** — calls `const result = await sbCmd(...args)` (note: `sbCmd` is variadic, so spread `args`), and `if (result.exitCode !== 0 || !result.data) throw new Error(\`Failed to restart VM: ${result.error}\`); return result.data;`. |
| `test/integration.test.ts` | Modify | Add `sbVmRestart` to the import list from `./helpers`. Add 8 tests using `test.skip(...)` for criteria #1–#8, with the exact names in the Acceptance Criteria table. Each stub body: `throw new Error("not implemented")`. VM-creating stubs must push created VM ids into the existing `createdVmIds` array so `afterEach` cleans them up. |

### Verification

- All 8 new tests exist and are `test.skip`.
- `./do lint` passes; TypeScript compiles (helpers referenced by stubs exist).
- `./do check` passes (skipped tests do not fail; existing tests unaffected).

---

## Phase 2: Persist vCPU/Memory in VM State

### Goal

Record each VM's `vcpu_count` and `mem_size_mib` in the in-memory `VM` record and in `state.json`, defaulting old persisted entries to config defaults on recovery. This is enabling work required by restart and recovery relaunch. No user-facing behavior changes yet.

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/types.ts` | Modify | In `interface VM`, add `vcpuCount: number;` and `memSizeMib: number;` (place after `pid: number;`). |
| `src/services/vm.ts` | Modify | In `interface PersistedVM`, add `vcpuCount: number;` and `memSizeMib: number;`. In `saveState()`, add `vcpuCount: vm.vcpuCount,` and `memSizeMib: vm.memSizeMib,` to the mapped object. In `createVm()`, replace the inline `vcpu_count`/`mem_size_mib` expressions: add `const vcpuCount = req.vcpu_count || config.defaultVcpuCount;` and `const memSizeMib = req.mem_size_mib || config.defaultMemSizeMib;` before the `startFirecracker` call; pass `vcpuCount` and `memSizeMib` into `startFirecracker`; and add `vcpuCount,` and `memSizeMib,` to the `const vm: VM = { ... }` record. In `recoverVms()`, in the running/reconnect branch's `vms.set(...)` object, add `vcpuCount: saved.vcpuCount ?? config.defaultVcpuCount,` and `memSizeMib: saved.memSizeMib ?? config.defaultMemSizeMib,`. |

### Verification

- `./do lint` passes; TypeScript compiles.
- `./do check` passes. In particular the existing `test_reconciliation` "VMs survive scaleboxd restart" sub-test still passes, and a freshly created VM's `state.json` entry now contains `vcpuCount` and `memSizeMib` (verify by reading `state.json` on the test host during a manual run, or trust the passing reconciliation test).
- Backwards compatibility: a `state.json` written by the previous version (no `vcpuCount`/`memSizeMib`) loads without error and defaults are applied.

---

## Phase 3: `restartVm` Power-Cycle + Endpoint + CLI

### Goal

Add `restartVm()` performing an in-place power-cycle (no override effects yet — reuses the VM's persisted vCPU/memory and does not resize), the `POST /vms/:id/restart` endpoint with **full request validation** (including override range checks and shrink rejection), and the `sb vm restart` CLI command.

### Acceptance Test (Red)

Unskip and implement:

| Test | Criterion | Expected Behavior |
|------|-----------|-------------------|
| `restart power-cycles a running VM (boot_id changes)` | #1 | Create VM (default template), `sbVmWait`/`waitForSsh`, read `bootId1 = sshExec(port, "cat /proc/sys/kernel/random/boot_id")`. `POST /vms/:id/restart` via `api.post(path, {})` returns `200` and body `status === "running"` with unchanged `ssh_port`. `waitForSsh` again (this second wait is load-bearing — it ensures the guest has finished rebooting before the next read), read `bootId2`; assert `bootId2 !== bootId1` and `bootId2` is a non-empty UUID string. (The changed `boot_id` — regenerated by the kernel on every real boot — is the authoritative proof of a power-cycle; the `status` field is currently always `"running"` and is only a smoke check.) |
| `restart nonexistent VM returns 404` | #5 | `api.post("/vms/vm-000000000000/restart", {})` returns `status === 404`. |
| `restart rejects disk shrink` | #6 | Create a VM, then `api.post(".../restart", { disk_size_gib: 1 })` returns `status === 400`. (The `debian-base` rootfs is 10 GiB and a default VM is not resized, so its current size is ~10 GiB; `1` is safely below the current size regardless of exact template size, so this exercises the shrink-rejection path — not the range check.) |
| `restart rejects invalid overrides` | #7 | For a created VM, each of these returns `status === 400`: `{ disk_size_gib: 0 }`, `{ disk_size_gib: 101 }` (one above the default `config.maxDiskSizeGib` of 100; the test host must not override `MAX_DISK_SIZE_GIB`), `{ vcpu_count: 0 }`, `{ vcpu_count: 33 }`, `{ mem_size_mib: 64 }`, `{ mem_size_mib: 70000 }`. |
| `CLI vm restart power-cycles a VM` | #8 | Create VM, read `bootId1` via `sshExec`, call `sbVmRestart(vm.id)`, assert returned object `status === "running"`, `waitForSsh` again, read `bootId2`, assert `bootId2 !== bootId1`. |

Verify #1, #5, #6, #7, #8 **fail** before implementing.

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/services/vm.ts` | Modify | Add and export `interface RestartVmOptions { diskSizeGib?: number; vcpuCount?: number; memSizeMib?: number; }`. Add and export `async function restartVm(vm: VM, opts: RestartVmOptions): Promise<VM>` with this exact body: (1) if `processExists(vm.pid)` call `await stopFirecracker(vm.pid)`; then loop `for (let i = 0; i < 50 && processExists(vm.pid); i++) await Bun.sleep(100)`; if `processExists(vm.pid)` still true, `throw { status: 500, message: "Failed to stop existing VM process" }`. (2) **Phase 3: do not resize and do not apply vcpu/mem overrides.** Compute `const vcpuCount = vm.vcpuCount;` and `const memSizeMib = vm.memSizeMib;`. (3) if `!existsSync(\`/sys/class/net/${vm.tapDevice}\`)` call `await createTapDevice(vm.tapDevice)`. (4) `const pid = await startFirecracker({ socketPath: vm.socketPath, kernelPath: config.kernelPath, rootfsPath: vm.rootfsPath, bootArgs: buildKernelArgs(vm.ip), tapDevice: vm.tapDevice, macAddress: vmIdToMac(vm.id), vcpuCount, memSizeMib })`. (5) `vm.pid = pid; vm.vcpuCount = vcpuCount; vm.memSizeMib = memSizeMib; vms.set(vm.id, vm); saveState();`. (6) `return vm;`. (Note: the `opts` parameter is accepted but its effects are wired in Phase 4; validation of `opts` happens in the endpoint.) Do **not** touch the TCP/UDP proxies (IP is unchanged; existing in-process listeners reconnect to the guest automatically). Do **not** call `updateCaddyConfig` (name/IP unchanged). Do **not** add console-scanner or metrics wiring: `startFirecracker` already calls `watchConsole` internally (idempotent — `watchConsole` no-ops if a watcher for the vmId already exists), and per-VM metrics keyed by `vm.id` are intentionally preserved across a restart (proxy-health `degraded` state naturally recovers as new connections succeed). |
| `src/index.ts` | Modify | Add `import { statSync } from "node:fs";` at the top. Add `restartVm` and `RestartVmOptions` to the existing import from `./services/vm`. Add the route below the `DELETE /vms/:id` route (see "Endpoint contract" below). |
| `scripts/sb` | Modify | Add `cmd_vm_restart` function (see "CLI contract" below). In the `vm)` dispatch block, add `restart) shift 2; cmd_vm_restart "$@" ;;` alongside the existing `delete`/`snapshot`/`wait` cases. In the usage/help text, add the line: `  vm restart <name|id> [--disk-size GIB] [--vcpu N] [--mem MIB]` with description `Reboot VM in place (optionally resize disk/CPU/memory)`. |

#### Endpoint contract (`POST /vms/:id/restart`)

```
app.post("/vms/:id/restart", async (c) => {
  const vm = findVm(c.req.param("id"));
  if (!vm) return c.json({ error: "VM not found" }, 404);

  let body: any = {};
  const raw = await c.req.text();
  if (raw.trim().length > 0) {
    try { body = JSON.parse(raw); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  }

  const opts: RestartVmOptions = {};

  if (body.disk_size_gib !== undefined) {
    if (!Number.isInteger(body.disk_size_gib) || body.disk_size_gib < 1 || body.disk_size_gib > config.maxDiskSizeGib) {
      return c.json({ error: `disk_size_gib must be an integer between 1 and ${config.maxDiskSizeGib}` }, 400);
    }
    const currentGib = Math.floor(statSync(vm.rootfsPath).size / (1024 ** 3));
    if (body.disk_size_gib < currentGib) {
      return c.json({ error: `disk_size_gib cannot be smaller than current size (${currentGib}GiB)` }, 400);
    }
    opts.diskSizeGib = body.disk_size_gib;
  }

  if (body.vcpu_count !== undefined) {
    if (!Number.isInteger(body.vcpu_count) || body.vcpu_count < 1 || body.vcpu_count > 32) {
      return c.json({ error: "vcpu_count must be an integer between 1 and 32" }, 400);
    }
    opts.vcpuCount = body.vcpu_count;
  }

  if (body.mem_size_mib !== undefined) {
    if (!Number.isInteger(body.mem_size_mib) || body.mem_size_mib < 128 || body.mem_size_mib > 65536) {
      return c.json({ error: "mem_size_mib must be an integer between 128 and 65536" }, 400);
    }
    // Request field is `mem_size_mib`; internal option is `memSizeMib`.
    opts.memSizeMib = body.mem_size_mib;
  }

  try {
    return await withVmCreationLock(async () => {
      const updated = await restartVm(vm, opts);
      return c.json(vmToResponse(updated), 200);
    });
  } catch (e: unknown) {
    console.error("VM restart failed:", e);
    const err = e as { status?: number; message?: string };
    return c.json({ error: err.message || "Unknown error" }, err.status || 500);
  }
});
```

#### CLI contract (`cmd_vm_restart` in `scripts/sb`)

```
cmd_vm_restart() {
  need_config
  local id="${1:-}"
  local disk="" vcpu="" mem=""
  shift || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -d|--disk-size) disk="$2"; shift 2 ;;
      --vcpu)         vcpu="$2"; shift 2 ;;
      -m|--mem)       mem="$2";  shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
  [[ -n "$id" ]] || die "Usage: sb vm restart <name|id> [--disk-size GIB] [--vcpu N] [--mem MIB]"

  local json_body
  json_body=$(jq -n \
    --argjson d "${disk:-null}" \
    --argjson v "${vcpu:-null}" \
    --argjson m "${mem:-null}" \
    '{}
      + (if $d != null then {disk_size_gib: $d} else {} end)
      + (if $v != null then {vcpu_count: $v} else {} end)
      + (if $m != null then {mem_size_mib: $m} else {} end)')

  local response
  if response=$(api POST "/vms/$id/restart" -d "$json_body"); then
    echo "$response" | output_single
  else
    echo "$response"
    return 1
  fi
}
```

### Verification

- Tests #1, #5, #6, #7, #8 pass (green).
- `./do check` passes (full pipeline: lint, deploy, bun tests, reconciliation).

---

## Phase 4: Apply Restart Overrides (disk / vCPU / memory)

### Goal

Wire `RestartVmOptions` into `restartVm` so `disk_size_gib` grows the rootfs (offline, while Firecracker is stopped) and `vcpu_count`/`mem_size_mib` change the relaunched VM's sizing.

### Acceptance Test (Red)

Unskip and implement:

| Test | Criterion | Expected Behavior |
|------|-----------|-------------------|
| `restart with disk_size_gib grows guest disk` | #2 | Create VM (default template ⇒ ~10 GiB rootfs); `waitForSsh`; read `oldBytes = Number(sshExec(port, "df -B1 --output=size / | tail -1").trim())` (`df` is GNU coreutils in `debian-base`, so `--output` is supported). `api.post(".../restart", { disk_size_gib: 14 })` → `200` (14 is above the 10 GiB base, guaranteeing a grow, while keeping the host free-space requirement modest — `checkAvailableSpace(14)` needs ≥16 GiB free). `waitForSsh`; read `newBytes` the same way. Assert `newBytes > oldBytes` and `newBytes >= 12 * 1024 ** 3`. |
| `restart with vcpu_count changes nproc` | #3 | Create VM (default 2 vCPU); `api.post(".../restart", { vcpu_count: 1 })` → `200`; `waitForSsh`; assert `sshExec(port, "nproc").trim() === "1"`. |
| `restart with mem_size_mib changes MemTotal` | #4 | Create VM (default 2048 MiB); `api.post(".../restart", { mem_size_mib: 1024 })` → `200`; `waitForSsh`; read `kb = Number(sshExec(port, "awk '/MemTotal/ {print $2}' /proc/meminfo").trim())`; assert `kb > 800000 && kb < 1200000`. |

Verify #2, #3, #4 **fail** before implementing (Phase 3's `restartVm` ignores overrides).

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/services/vm.ts` | Modify | In `restartVm`, after the process-stop step and before the TAP check: if `opts.diskSizeGib !== undefined`, call `await checkAvailableSpace(opts.diskSizeGib)` then `await resizeRootfs(vm.rootfsPath, opts.diskSizeGib)` (the space pre-flight mirrors `createVm`; `checkAvailableSpace` throws `{ status: 507, ... }` which the endpoint's catch maps to a 507 response). Remove the Phase 3 `// Phase 3: do not resize ...` comment and replace the Phase 3 sizing lines (`const vcpuCount = vm.vcpuCount;` / `const memSizeMib = vm.memSizeMib;`) with `const vcpuCount = opts.vcpuCount ?? vm.vcpuCount;` and `const memSizeMib = opts.memSizeMib ?? vm.memSizeMib;`. (The rest of `restartVm` is unchanged; it already persists `vm.vcpuCount`/`vm.memSizeMib` from these values and calls `saveState()`.) `resizeRootfs` and `checkAvailableSpace` are already imported in `vm.ts`. |

Safety note: `resizeRootfs` only ever grows (`truncate -s ${gib}G` then `resize2fs`). Shrink is impossible because the endpoint already rejects `disk_size_gib < currentGib` with `400`; `restartVm` is only reached with a grow-or-equal size. Resizing is safe because Firecracker is guaranteed stopped by the preceding step (the process-exit wait loop).

### Verification

- Tests #2, #3, #4 pass (green). Tests #1, #5–#8 still pass.
- `./do check` passes.

---

## Phase 5: Disk-Preserving Recovery (relaunch instead of delete)

### Goal

Change `recoverVms()` so a dead-PID VM with an existing rootfs is relaunched (Firecracker restarted, IP/port re-registered, proxies restarted) instead of deleted. Add a `do` reconciliation sub-test proving it.

### Acceptance Test (Red)

Add to `do` `test_reconciliation` a new sub-test `VM with dead process is relaunched on restart` (criterion #9):

| Step | Expected Behavior |
|------|-------------------|
| Create a VM via the API; capture `vm_id` and `ssh_port`. | VM created. |
| Capture the old Firecracker PID on the host: `old_pid=$(gcloud ... --command="pgrep -f firecracker-${vm_id}.sock")`. | `old_pid` non-empty. |
| Kill it hard on the host: `sudo kill -9 $old_pid` (simulates a crash). | Process gone; rootfs untouched. |
| `sudo systemctl restart scaleboxd`; wait for `/health` (reuse the existing 30×2s poll loop). | Daemon healthy. |
| `GET /vms` includes `vm_id` (`jq -e ".vms[] | select(.id==\"$vm_id\")"`). | VM still present (not deleted). |
| Capture the new PID: `new_pid=$(gcloud ... --command="pgrep -f firecracker-${vm_id}.sock")`. | Non-empty **and** `new_pid != old_pid` (a genuinely new process was launched, not the old one). |
| `ls /var/lib/scalebox/vms/${vm_id}.ext4` on the host. | Exists (rootfs preserved). |
| Check the journal for the relaunch log: `journalctl -u scaleboxd --no-pager -n 100 \| grep -q "process not running but rootfs exists — relaunching"`. | Match present (use the exact substring emitted by `recoverVms`). |
| Delete the VM via the API to clean up. | 204. |

Verify this sub-test **fails** against the current (Phase 4) code: the killed VM's rootfs would be deleted and the VM would be absent after restart. (This sub-test is added and its production code landed in the same phase, since a `do` shell sub-test cannot sit "skipped" without failing `./do check`.)

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/services/vm.ts` | Modify | Add a private `async function relaunchVm(saved: PersistedVM): Promise<void>` (see body below). In `recoverVms()`, replace the `else { ... cleanupDeadVm(saved) }` branch with: if `existsSync(saved.rootfsPath)` → `console.log(\`[recovery] VM ${saved.id} (${saved.name}) process not running but rootfs exists — relaunching\`)` then `try { await relaunchVm(saved); } catch (err) { console.error(\`[recovery] Failed to relaunch ${saved.id}:\`, err); }`; else → `console.log(\`[recovery] VM ${saved.id} (${saved.name}) rootfs missing — cleaning up\`)` then `await cleanupDeadVm(saved)`. `existsSync` is already imported in `vm.ts`. |
| `do` | Modify | Insert the `VM with dead process is relaunched on restart` sub-test into `test_reconciliation()`, before the existing "Orphan cleanup" sub-test. Use the same `gcloud compute ssh "$VM_NAME" --zone=... --project=... --command=...` pattern already used in that function for host commands, and the same `$api`/`curl`/`jq` pattern for API calls. `do_check` already invokes `test_reconciliation "$token"` and `"$BUN_BIN" test`, so no wiring changes are needed. |

`relaunchVm` body:

```
async function relaunchVm(saved: PersistedVM): Promise<void> {
  allocateSpecificPort(saved.sshPort);
  allocateSpecificIp(saved.ip);

  if (!existsSync(`/sys/class/net/${saved.tapDevice}`)) {
    await createTapDevice(saved.tapDevice);
  }

  const vcpuCount = saved.vcpuCount ?? config.defaultVcpuCount;
  const memSizeMib = saved.memSizeMib ?? config.defaultMemSizeMib;

  const pid = await startFirecracker({
    socketPath: saved.socketPath,
    kernelPath: config.kernelPath,
    rootfsPath: saved.rootfsPath,
    bootArgs: buildKernelArgs(saved.ip),
    tapDevice: saved.tapDevice,
    macAddress: vmIdToMac(saved.id),
    vcpuCount,
    memSizeMib,
  });

  await startProxy(saved.id, saved.sshPort, saved.ip, 22);
  await startUdpProxy(saved.id, saved.sshPort, saved.ip, saved.sshPort);

  vms.set(saved.id, {
    id: saved.id,
    name: saved.name,
    template: saved.templateName,
    ip: saved.ip,
    port: saved.sshPort,
    pid,
    socketPath: saved.socketPath,
    rootfsPath: saved.rootfsPath,
    tapDevice: saved.tapDevice,
    createdAt: new Date(saved.createdAt),
    vcpuCount,
    memSizeMib,
  });
}
```

Interaction notes (must hold, verify in review):
- `reconcileOrphans()` runs after `recoverVms()`; because relaunched PIDs are now in the `vms` map, reconcile will not kill them.
- The existing "Orphan cleanup" sub-test deletes `state.json` before restart, so `recoverVms()` returns early ("No state file found") and does not relaunch; `reconcileOrphans()` still cleans the orphaned process/TAP/rootfs. That sub-test remains valid and unchanged.
- On a real host reboot the TAP device and `/tmp` socket are gone; the `existsSync("/sys/class/net/...")` check recreates the TAP, and `startFirecracker` removes any stale socket before creating a new one.

### Verification

- New sub-test `VM with dead process is relaunched on restart` passes.
- Existing `test_reconciliation` sub-tests ("VMs survive scaleboxd restart", "Orphan cleanup on startup") still pass (criterion #10).
- `./do check` passes.

---

## Phase 6: DDD — Glossary & VM Lifecycle Context

### Goal

Document the new domain concepts: VM restart (power-cycle) and disk-preserving recovery relaunch.

### Changes

| File | Action | Details |
|------|--------|---------|
| `product/DDD/glossary.md` | Modify | Add **Restart** — "An in-place power-cycle of an existing VM: Firecracker is stopped and started again, reusing the VM's rootfs, IP, SSH port, TAP device, and MAC. May optionally resize the disk or change vCPU/memory. Distinct from Create (new rootfs/resources) and Snapshot." Add **Relaunch (Recovery)** — "During recovery (before [Reconciliation]), restarting Firecracker for a persisted VM whose process is dead but whose rootfs image still exists, instead of deleting it. Introduced so VMs survive process crashes and host reboots. Contrast with an Orphaned Resource, which has no `state.json` record and is cleaned up by Reconciliation." Update the existing **Orphaned Resource** entry to note that a *tracked* (in `state.json`) dead VM is now relaunched, not orphaned. |
| `product/DDD/contexts/vm-lifecycle.md` | Modify | (a) Update the `interface VM` snippet to include `vcpuCount: number;` and `memSizeMib: number;`. (b) Fix the `VMResponse` snippet to match `src/types.ts` (it currently omits `degraded` and `console_log_path`/`console_log_size` and lists a stale `mem` default) — bring it in line with the actual interface. (c) Update the Lifecycle diagram/section to add a self-transition `Running --restart--> Running` and describe the recovery paths (dead PID + rootfs present → relaunch → Running; dead PID + rootfs missing → removed). (d) Add a "Restart" entry to the **Domain Services** list (parallel to `createVm`/`deleteVm`/`snapshotVm`) describing `restartVm` orchestration (stop → optional space-check+resize → ensure TAP → start → persist) and that proxies/Caddy are untouched because IP/name are unchanged. (e) Update the **Repository / recovery** bullet from "reconnects or cleans up dead VMs" to "reconnects (live process), **relaunches** (dead process, rootfs present), or cleans up (rootfs missing)". |
| `product/DDD/context-map.md` | Modify | In the VM Lifecycle → Access and VM Lifecycle → Hypervisor relationship/integration bullet lists, add that the **recovery relaunch** path also starts Firecracker and re-registers TCP/UDP proxies (previously only creation/deletion were listed). No new contexts or relationship *types* are added. |

### Verification

- Review documentation for accuracy against the implemented behavior.

---

## Phase 7: ADR — VM Restart & Disk-Preserving Recovery

### Goal

Record the architectural decision, including the change away from delete-on-dead recovery, and update the outdated "VMs are lost on restart" note in `CLAUDE.md`.

### Changes

| File | Action | Details |
|------|--------|---------|
| `product/ADR/019-vm-restart-and-disk-preserving-recovery.md` | Create | ADR with sections: **Context** (in-place recovery/resize was impossible; `recoverVms()` deleted rootfs on dead PID — a data-loss footgun on crash/host-reboot; cite ADR-014 orphan reconciliation and plan 018's "Future Enhancements: Auto-restart VMs that died unexpectedly" as the sanctioned lineage). **Decision** (add `POST /vms/:id/restart` with optional `disk_size_gib`/`vcpu_count`/`mem_size_mib`; persist `vcpuCount`/`memSizeMib` in `state.json`; change recovery to relaunch dead-PID VMs when the rootfs exists, deleting only when the rootfs is missing). **Supersedes** (ADR-005 "In-Memory VM State" — its remaining ephemerality premise that VMs are lost on restart no longer holds; ADR-014 is complemented, not contradicted — reconciliation still handles record-less orphans). **Consequences** (positive: VMs survive crashes and host reboots; disk resize is a supported in-place operation; rootfs deletion only via explicit `DELETE` or genuinely-missing rootfs. Negative/risks: daemon startup now starts Firecracker for every dead VM, increasing startup time and memory pressure on over-committed hosts; `VMResponse.status` is still hard-coded `"running"` for any VM in the map — note that `VMResponse` already carries a `degraded` health signal (via `isDegraded`), so operators are not fully blind to liveness, but true running/stopped status is left to a future enhancement; per-VM metrics are preserved across restart by design). |
| `CLAUDE.md` | Modify | In the "In-Memory State" bullet under "Key Architectural Patterns", replace "On restart, all VMs are lost." with a note that VM metadata is persisted in `state.json` and that on daemon/host restart VMs are reconnected (live process) or relaunched (dead process with intact rootfs); a VM's rootfs is only removed by explicit deletion or when the rootfs file is missing. |
| `README.md` | Modify (conditional) | Audit `README.md` for a documented list of VM API endpoints or `sb vm` subcommands. If such a list exists, add `POST /vms/:id/restart` and `sb vm restart <name|id> [--disk-size GIB] [--vcpu N] [--mem MIB]` to it. If no such list exists, make no change (record "no change needed" in the implementation notes). |

### Verification

- Review ADR for completeness (context, decision, rationale, consequences) and that it does not contradict remaining active ADRs.

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `test/helpers.ts` | Modify | Add `api.post` and `sbVmRestart` helpers |
| `test/integration.test.ts` | Modify | Acceptance tests for criteria #1–#8 (scaffolded skipped, then implemented) |
| `src/types.ts` | Modify | Add `vcpuCount`/`memSizeMib` to `VM` |
| `src/services/vm.ts` | Modify | Persist vCPU/mem; add `restartVm`/`RestartVmOptions`; add `relaunchVm`; disk-preserving recovery |
| `src/index.ts` | Modify | `POST /vms/:id/restart` route + validation |
| `scripts/sb` | Modify | `sb vm restart` subcommand + help |
| `do` | Modify | New `test_reconciliation` sub-test for recovery relaunch |
| `product/DDD/glossary.md` | Modify | Define Restart and Relaunch (Recovery); update Orphaned Resource |
| `product/DDD/contexts/vm-lifecycle.md` | Modify | Document restart transition, recovery relaunch, persisted sizing, Domain Services + Repository bullets, VMResponse snippet |
| `product/DDD/context-map.md` | Modify | Note recovery-relaunch in VM Lifecycle → Access/Hypervisor bullets |
| `product/ADR/019-vm-restart-and-disk-preserving-recovery.md` | Create | Record the decision (supersedes ADR-005) |
| `CLAUDE.md` | Modify | Update "In-Memory State" note |
| `README.md` | Modify (conditional) | Add restart endpoint/CLI if an API/CLI list exists |

---

## End-to-End Verification

After all phases:

1. All acceptance tests pass (none skipped): criteria #1–#8 in `test/integration.test.ts`, criterion #9 in `do` `test_reconciliation`.
2. Existing `test_reconciliation` sub-tests still pass (criterion #10 regression guard).
3. `./do check` passes end-to-end (lint → build → deploy → bun tests → reconciliation).
4. Manual spot check on the test host: `sb vm create`, `sb vm restart <id> --disk-size 5 --vcpu 1 --mem 1024`, then SSH in and confirm `nproc` = 1, `MemTotal` ≈ 1 GiB, `df -h /` ≈ 5 GiB, and a changed `boot_id`.
5. Manual crash-recovery check: `sudo kill -9` a VM's Firecracker, `sudo systemctl restart scaleboxd`, confirm the VM reappears running with its rootfs intact.

---

## Update Considerations

- **Config changes**: None. `vcpu`/`mem`/`disk` bounds reuse existing `config.defaultVcpuCount`, `config.defaultMemSizeMib`, `config.defaultDiskSizeGib`, and `config.maxDiskSizeGib`. The `vcpu_count` (1–32) and `mem_size_mib` (128–65536) bounds are hardcoded literals in the endpoint; no new config keys.
- **Storage changes**: No new directories. `state.json` entries gain `vcpuCount`/`memSizeMib` (additive). Old entries without these fields load fine and default to config values on recovery.
- **Dependency changes**: None (uses existing `firecracker`, `truncate`, `e2fsck`, `resize2fs`, `ip`, `jq`, `curl`).
- **Migration needed**: No. `state.json` is forward-compatible in both directions (new fields optional on read; a downgrade would simply ignore them).
- **Backwards compatibility**: The new endpoint is additive. The recovery behavior change means a dead-PID VM with an intact rootfs is now relaunched rather than deleted on daemon start — operators who relied on "restart scaleboxd to clear crashed VMs" must instead use `DELETE /vms/:id`. `VMResponse` is unchanged in shape; `status` continues to report `"running"` for VMs present in the map.
