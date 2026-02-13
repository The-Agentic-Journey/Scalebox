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
