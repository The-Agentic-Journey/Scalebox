# ADR-019: VM Restart & Disk-Preserving Recovery

## Status

Accepted (2026-07-12)

## Context

Scalebox had no supported way to power-cycle a VM in place, nor to resize a VM's disk without destroying it. An operator facing a wedged guest, or a VM that had run out of disk space (the `quite-kind-newt` disk-full incident), had only one option: delete the VM and create a new one, losing all state written since the last snapshot.

Worse, VM recovery was a data-loss footgun. Plan 018 added state persistence to `state.json` so VMs could survive scaleboxd restarts, and ADR-014 (System-Level Orphan Reconciliation on Startup) changed `KillMode=process` so Firecracker children survive a daemon restart. But `recoverVms()` still treated any VM whose persisted Firecracker PID was no longer running as garbage: it called `cleanupDeadVm()` → `deleteRootfs()`, permanently destroying the disk. Combined with the SIGTERM handler that persists in-memory PIDs on shutdown, this meant that a crashed Firecracker process, a manual `kill`, or a **host reboot** (which kills every Firecracker process at once) would wipe every affected VM's disk on the next daemon start.

Both problems have a sanctioned lineage:

- **ADR-014 (System-Level Orphan Reconciliation on Startup)** established the recovery/reconciliation split: `recoverVms()` restores tracked VMs from `state.json`, then `reconcileOrphans()` cleans up resources with no `state.json` record. The delete-on-dead-PID behavior lived on the tracked-VM side of that split and was never the intended treatment for a VM Scalebox still had a record of.
- **Plan 018 (VM Persistence)** explicitly listed "Auto-restart VMs that died unexpectedly" under **Future Enhancements**, anticipating exactly this change.

## Decision

1. **Add `POST /vms/:id/restart`** — a synchronous, in-place power-cycle. It stops the existing Firecracker process (if any) and starts a fresh one, reusing the VM's rootfs, IP, SSH proxy port, TAP device, and MAC. The request body may optionally override:
   - `disk_size_gib` — grow the rootfs offline (while Firecracker is stopped); shrinking is rejected with `400`.
   - `vcpu_count` — CPU count of the relaunched VM.
   - `mem_size_mib` — memory of the relaunched VM.

   A matching `sb vm restart <name|id> [--disk-size GIB] [--vcpu N] [--mem MIB]` CLI command is provided.

2. **Persist `vcpuCount` and `memSizeMib` in `state.json`** (and in the in-memory `VM` record). Both restart and recovery need to relaunch Firecracker with the VM's original CPU/memory sizing, which the previous schema did not store. The fields are additive; old `state.json` entries without them default to `config.defaultVcpuCount` / `config.defaultMemSizeMib` on load.

3. **Change recovery to relaunch, not delete.** In `recoverVms()`, a VM whose persisted PID is dead is now handled by rootfs presence:
   - **Rootfs exists** → relaunch (restart Firecracker, recreate the TAP if missing, re-register the TCP/UDP proxies, re-add to the map).
   - **Rootfs missing** → clean up (the only path that deletes on recovery).

## Supersedes / Relationships

- **Supersedes ADR-005 (In-Memory VM State):** ADR-005's remaining premise — that VMs are ephemeral and lost on service restart, so there is "nothing to resume" — no longer holds. VM metadata is persisted in `state.json`; live VMs are reconnected and dead-but-intact VMs are relaunched on daemon or host restart. (ADR-014 already retired ADR-005's narrower claim that "all Firecracker processes die"; this ADR retires the broader ephemerality premise.)

- **Complements ADR-014 (System-Level Orphan Reconciliation on Startup):** ADR-014 is not contradicted. The recovery/reconciliation split is preserved. `reconcileOrphans()` still runs after `recoverVms()` and still cleans up record-less orphans (processes, TAP devices, and rootfs files with no `state.json` entry). This ADR only changes how a *tracked* dead-PID VM is treated: relaunch instead of delete. Because relaunched PIDs are back in the map before reconciliation runs, reconcile does not kill them.

## Consequences

### Positive

- VMs survive Firecracker crashes, manual kills, and host reboots: on the next daemon start, a dead-PID VM with an intact rootfs is relaunched rather than destroyed.
- Disk resize is a supported in-place operation via restart, instead of a delete-and-recreate that loses state.
- A VM's rootfs is now deleted in only two cases: an explicit `DELETE /vms/:id`, or recovery finding the rootfs file genuinely missing. There is no longer an accidental data-loss path.
- Per-VM metrics (keyed by `vm.id`) are preserved across a restart by design; proxy-health `degraded` state recovers naturally as new connections succeed.

### Negative / Risks

- Daemon startup now starts a Firecracker process for **every** dead-PID VM with an intact rootfs. On a host with many VMs, this increases startup time and memory pressure, and can be a problem on over-committed hosts (previously, a restart quietly reclaimed those resources by deleting the VMs).
- `VMResponse.status` is still hard-coded to `"running"` for any VM present in the map — it does not reflect true guest liveness. This is mitigated but not solved: `VMResponse` already carries a `degraded` health signal (via `isDegraded`), so operators are not fully blind to a wedged or unhealthy VM. A real running/stopped status field is left to a future enhancement.
- Operators who previously relied on "restart scaleboxd to clear crashed VMs" must now use `DELETE /vms/:id` to remove a VM.

### Neutral

- `state.json` is forward- and backward-compatible: the new `vcpuCount`/`memSizeMib` fields are optional on read; a downgrade simply ignores them.

## References

- Restart / recovery logic: `src/services/vm.ts` (`restartVm`, `relaunchVm`, `recoverVms`)
- Endpoint + validation: `src/index.ts` (`POST /vms/:id/restart`)
- CLI: `scripts/sb` (`cmd_vm_restart`)
- Plan: `product/plans/todo/032-PLAN-VM-RESTART-AND-RECOVERY.md`
- Related: ADR-005 (In-Memory VM State), ADR-014 (System-Level Orphan Reconciliation on Startup), Plan 018 (VM Persistence)
