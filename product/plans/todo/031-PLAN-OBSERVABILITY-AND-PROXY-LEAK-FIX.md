# Observability & Proxy Leak Fix Plan

## Overview

A VM (`highly-fancy-otter`, 19-day uptime, running Postgres + Claude Code workload) soft-hung on 2026-05-19. The guest journal stopped abruptly at 11:18:04 with no OOM, panic, hung-task, or soft-lockup trace. Recovery was only possible because we could reflink-copy the rootfs from the host — the VM itself was unreachable at every layer (mosh, SSH, Firecracker API socket). A previous VM (`vm-38816be0651b`, May 12) failed with the same pattern. Investigation also uncovered a second, independent issue: `scaleboxd` itself OOM-died on May 14 with 63 GB anon-RSS — a slow memory leak. The current `scaleboxd` instance is already at 74 GB VSZ, 5 days into its life, while exposed to continuous public SSH brute-force traffic through its TCP proxies.

This plan delivers two things together:

1. **Observability** that would have answered "what happened?" on first inspection for both incidents — persistent console logs, an injected in-guest health agent, scaleboxd metrics, proxy degradation signals, and crash-pattern scanning of console output.
2. **A targeted fix** for the most plausible leak source in `scaleboxd`: the TCP proxy in `src/services/proxy.ts`, where every brute-force connection allocates per-connection state (`pendingData[]`, captured closures) and the failure path has no explicit teardown.

The plan is sequenced so each phase produces independent value and so the proxy fix (Phase 7) can be **data-driven** from metrics added in Phase 3.

**Explicit non-goals:**

- **No auto-snapshot on VM degradation** — degradation is surfaced for the operator to act on, not acted on automatically. Per user direction.
- **No changes baked into `debian-base`** — the in-guest health agent is *injected at VM creation* so it works on user-supplied templates built from external Docker images that we don't control. Per user direction.

## Acceptance Criteria

| # | Criterion | Acceptance Test |
|---|-----------|-----------------|
| 1 | Firecracker console log is written to persistent storage and survives host reboot | `test/integration.test.ts`: `console log persists under /var/lib/scalebox/logs` |
| 2 | Console logs are size-capped and rotated | Manual: write 100 MB to a log, confirm rotation kicks in |
| 3 | Console log directory is removed when VM is deleted | `test/integration.test.ts`: `console log dir removed on vm delete` |
| 4 | `scaleboxd` exposes `/metrics` with process memory, proxy stats, VM counts | `test/integration.test.ts`: `metrics endpoint returns counters` |
| 5 | `scaleboxd` logs a memory + connection summary to the journal every 5 minutes | Manual: `journalctl -u scaleboxd | grep '\[metrics\]'` |
| 6 | Every VM created has `/usr/local/bin/scalebox-health` + a systemd timer running every 60 s, regardless of template | `test/integration.test.ts`: `health agent installed and running in new VM` |
| 7 | Health agent writes snapshots to `/var/log/scalebox-health.log` with rotation | `test/integration.test.ts`: `health log present after 90s` |
| 8 | When proxy fails to reach VM for N consecutive attempts, scaleboxd logs ERROR and marks VM `degraded=true` in API response | `test/integration.test.ts`: `proxy failures mark vm as degraded` |
| 9 | `sb vm list` shows `AGE` and `STATUS` columns | Manual: `sb vm list` |
| 10 | Console-log scanner detects `Out of memory`/`Kernel panic`/`hung task`/`soft lockup` and emits ERROR to scaleboxd journal | `test/integration.test.ts`: `console scanner detects oom marker` |
| 11 | TCP proxy clears per-connection state on `close`/`error` and caps `pendingData` size | `test/integration.test.ts`: `proxy memory stable under churn` |
| 12 | Sustained brute-force load (100 conn/s, 5 min) against an unreachable VM does not grow scaleboxd RSS by more than 50 MB | Load test script (new) |
| 13 | All existing tests pass unchanged | `./do check` |

---

## Phase 1: Persistent Console Logs

### Goal

Move Firecracker per-VM console output from `/tmp/fc-<vmid>-console.log` (tmpfs, lost on host reboot) to `/var/lib/scalebox/logs/<vmid>/console.log` (persistent). Add size-based rotation. Clean up the directory on VM delete.

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/services/firecracker.ts` | Modify | Replace `/tmp/fc-${vmId}-console.log` with `${config.dataDir}/logs/${vmId}/console.log`. Create dir before opening writer. Add inline rotation: when file > 50 MB, rename to `.1`, start fresh; keep only `.1`. |
| `src/services/vm.ts` | Modify | In `deleteVm`, after `stopFirecracker`, remove `${config.dataDir}/logs/${vmId}/`. |
| `src/services/vm.ts` | Modify | In `recoverVms` → `cleanupDeadVm`, also remove the log dir. |
| `test/integration.test.ts` | Add | Acceptance tests #1 and #3. |

### Verification

- Create a VM, confirm `/var/lib/scalebox/logs/<vmid>/console.log` exists with content.
- Delete it, confirm the directory is gone.
- `./do check` passes.

### Update Considerations

- **Storage:** new directory created on demand. No install.sh change needed.
- **Old VMs (predating this change):** recovered VMs without the new log path simply won't have logs until recreated. Non-breaking.

---

## Phase 2: Inject In-Guest Health Agent at VM Creation

### Goal

Every VM (regardless of template) gets a small bash health-snapshot agent + a systemd timer that runs it every 60 s. Output goes to `/var/log/scalebox-health.log` with rotation. The agent lives in the rootfs, so it survives a guest soft-hang — readable later via the same rescue-mount path we used today.

Injection happens in `initializeRootfs` (host-side, rootfs mounted) so external templates work without modification.

### What the agent captures (every 60 s)

```
=== TIMESTAMP ===
uptime: $(uptime)
mem: $(free -m | awk '/Mem:/')
swap: $(free -m | awk '/Swap:/')
mounts: $(wc -l < /proc/self/mountinfo) entries
slab_top: $(awk 'NR>2 {print $1, $3*$4}' /proc/slabinfo | sort -k2 -rn | head -5)
load: $(cat /proc/loadavg)
top_rss: $(ps -eo rss,pid,comm --sort=-rss --no-headers | head -5)
docker_containers: $(ls /sys/fs/cgroup/system.slice/ 2>/dev/null | grep -c '^docker-' || echo 0)
last_dmesg: $(dmesg | tail -3 2>/dev/null | tr '\n' '|')
---
```

Rotation: append-only file, when > 20 MB rename to `.1` and start fresh.

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/services/agent.ts` | Create | Export `injectHealthAgent(rootfsPath: string)`. Mounts rootfs, writes 3 files (script, .service, .timer), creates the wants-symlink, unmounts. Idempotent. |
| `src/services/storage.ts` | Modify | In `initializeRootfs`, call `injectHealthAgent` after SSH/hostname setup. Detect absence of `/usr/bin/systemctl` and skip with a warning log (not error) — only systemd guests supported in v1. |
| `src/services/agent.ts` | Embed | The 3 file contents as TypeScript string constants. Keep small and POSIX-compatible. |
| `test/integration.test.ts` | Add | Acceptance tests #6 and #7. |

### Files written into rootfs

- `/usr/local/bin/scalebox-health` (mode 0755) — the snapshot script
- `/etc/systemd/system/scalebox-health.service` — oneshot, runs the script
- `/etc/systemd/system/scalebox-health.timer` — `OnBootSec=30s` + `OnUnitActiveSec=60s`
- `/etc/systemd/system/timers.target.wants/scalebox-health.timer` → `../scalebox-health.timer` (enable without `systemctl enable`)

### Verification

- Create VM, SSH in, confirm `systemctl status scalebox-health.timer` is active.
- Wait 2 minutes, `cat /var/log/scalebox-health.log` shows at least 2 snapshots.
- Create VM from a non-`debian-base` template (e.g., the rescue template) — agent still installed.
- `./do check` passes.

### Update Considerations

- **Config:** none.
- **Storage:** none (writes to rootfs which is per-VM).
- **Dependencies:** none new on the host. The agent uses only POSIX coreutils + systemd, which are present on any Debian-derived template.
- **Non-systemd templates:** silently skipped with a warning. Documented as v1 limitation.

---

## Phase 3: scaleboxd Memory & Connection Metrics

### Goal

Expose `process.memoryUsage()` and per-proxy counters via a `/metrics` endpoint (bearer-auth, like other protected routes). Additionally, log a one-line summary to the journal every 5 minutes. Provides the data to drive Phase 7's leak fix.

### Counters tracked

Per proxy (keyed by `vmId`):

- `connectionsAccepted` (cumulative)
- `connectionsCurrentlyOpen` (gauge)
- `vmConnectFailures` (cumulative)
- `pendingBytesQueued` (gauge)
- `lastConnectSuccessAt` / `lastConnectFailureAt` (timestamps)

Globally:

- `process.memoryUsage()` (rss, heapTotal, heapUsed, external, arrayBuffers)
- `vmCount`, `udpRuleCount`, `dnsRecordCount`
- `uptimeSeconds`

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/services/metrics.ts` | Create | Module exporting `recordConnectionAccepted(vmId)`, `recordConnectionClosed(vmId)`, `recordVmConnectFailure(vmId)`, `recordPendingBytes(vmId, delta)`, `snapshot()`. In-memory `Map<vmId, counters>`. |
| `src/services/proxy.ts` | Modify | Call metrics functions at the right places (open/close/error/connect-fail/pendingData push). |
| `src/index.ts` | Add | `GET /metrics` returns `metrics.snapshot()` as JSON. Bearer-auth (inside the protected block). |
| `src/index.ts` | Add | `setInterval(logMetricsSummary, 5*60*1000)` — single-line journal entry: `[metrics] rss=X heap=Y vms=Z conns=O/T fails=F`. Cleared on SIGTERM. |
| `test/integration.test.ts` | Add | Acceptance test #4. |

### Verification

- `curl -H 'Authorization: Bearer …' http://host:8080/metrics | jq` returns object with all keys.
- `journalctl -u scaleboxd | grep '\[metrics\]'` shows entries every 5 min.
- `./do check` passes.

### Update Considerations

- **Config:** none.
- **API:** additive only — new endpoint, no existing endpoints changed.

---

## Phase 4: Proxy Degradation Signal

### Goal

When `vmConnectFailures` for a single VM crosses a threshold (e.g., 10 consecutive failures, with success resetting the counter), `scaleboxd` logs ERROR (not just message) and the VM's API response gains `degraded: true`. This is the "you would have noticed in minutes instead of 38 minutes" fix.

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/services/metrics.ts` | Modify | Track `consecutiveFailures` per VM. Expose `isDegraded(vmId, threshold = 10)`. |
| `src/services/proxy.ts` | Modify | On `vmConnectFailures` crossing threshold for the first time, `console.error('[proxy] VM <id> DEGRADED: <N> consecutive connect failures')`. Reset on successful connect. |
| `src/types.ts` | Modify | Add `degraded?: boolean` to `VMResponse`. |
| `src/services/vm.ts` | Modify | `vmToResponse` reads `isDegraded(vm.id)` and includes it. |
| `test/integration.test.ts` | Add | Acceptance test #8 (kill firecracker for a VM, make 11 connection attempts, expect `degraded:true`). |

### Verification

- Manually kill a VM's Firecracker process, hammer its port, confirm `sb vm get <name>` shows `degraded:true` and the journal has the ERROR line.
- `./do check` passes.

### Update Considerations

- **API:** additive — new optional `degraded` field. Old `sb` clients ignore it.

---

## Phase 5: `sb vm list` Shows AGE & STATUS

### Goal

Two new columns in `sb vm list`: `AGE` (computed from `created_at`) and `STATUS` (`running` or `degraded`). Makes long-running and unhealthy VMs immediately visible.

### Changes

| File | Action | Details |
|------|--------|---------|
| `scripts/sb` | Modify | In `cmd_vm_list`, change the `jq` filter to include `created_at` and `degraded`. Compute `AGE` in jq (now - parsed timestamp → human "3d4h"). Header: `NAME ID TEMPLATE IP PORT AGE STATUS`. |
| `scripts/sb` | Modify | Update `cmd_help` examples. |

### Verification

- `sb vm list` shows new columns.
- Existing scripts using `sb --json vm list` are unaffected (JSON adds new fields, doesn't remove old).

### Update Considerations

- **Backwards compat:** JSON output is additive. Plain-text output gets new columns — anything parsing `sb vm list` plain-text breaks, but plain-text is intended for humans.

---

## Phase 6: Console-Log Crash/Panic Scanner

### Goal

A background tail on each VM's console log. When patterns matching kernel catastrophes appear, log as ERROR to scaleboxd's journal. Lets us learn about a guest dying within seconds, not by inspecting later.

### Patterns matched

- `Out of memory:` (host or guest kernel)
- `Kernel panic`
- `hung task`
- `soft lockup`
- `BUG:` (kernel BUG())
- `general protection fault`

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/services/consoleScanner.ts` | Create | `watchConsole(vmId, path)` — opens a tail-like reader on the console log, runs each new line through a precompiled regex, emits `console.error('[console] vm=<id> matched=<pattern>: <line>')` on hit. Stops cleanly on `unwatchConsole(vmId)`. |
| `src/services/firecracker.ts` | Modify | After opening the log writer, call `watchConsole(vmId, logPath)`. |
| `src/services/vm.ts` | Modify | In `deleteVm`, call `unwatchConsole(vmId)` before removing the log dir. |
| `test/integration.test.ts` | Add | Acceptance test #10 — write a fake `Out of memory: Killed process` line into a VM's console log via the test harness, assert journal contains the ERROR. |

### Verification

- Manually `echo "Out of memory: Killed process 123 (foo)" >> /var/lib/scalebox/logs/<vmid>/console.log` (as test) — see ERROR in `journalctl -u scaleboxd`.
- `./do check` passes.

### Update Considerations

- **Resources:** one async reader per VM. Cheap. Stops on VM delete.

---

## Phase 7: Fix the TCP Proxy Leak

### Goal

After Phase 3 metrics confirm proxy traffic correlates with RSS growth, apply targeted fixes to `proxy.ts`. (If Phase 3 reveals the leak is elsewhere, this phase is re-scoped to that area.)

### Changes (assuming proxy.ts is confirmed culprit)

| File | Action | Details |
|------|--------|---------|
| `src/services/proxy.ts` | Modify | Cap `pendingData` total bytes at e.g. 64 KB; drop oldest / close client on overflow. |
| `src/services/proxy.ts` | Modify | In `close` and `error` handlers, explicitly null out `clientSocket.data.pendingData = []` and `clientSocket.data.vmSocket = undefined`. |
| `src/services/proxy.ts` | Modify | On `Bun.connect().catch`, ensure `clientSocket.data.pendingData = []` before `clientSocket.end()`. |
| `src/services/proxy.ts` | Modify | Add per-VM "circuit breaker": once `degraded`, refuse new connections at `open()` for N seconds (cheaper than connecting and timing out). |
| `test/integration.test.ts` | Add | Acceptance tests #11 and #12 (load test). |
| `test/loadProxy.ts` | Create | Standalone load generator: opens 100 conn/s to a dead VM for 5 min, samples RSS before/after via `/metrics`, asserts < 50 MB growth. |

### Verification

- Acceptance test #12 passes (RSS delta < 50 MB under load).
- Real-world: watch `journalctl -u scaleboxd | grep '\[metrics\]'` for a week. Confirm RSS flat under typical brute-force load.

### Update Considerations

- **Behavior change:** clients sending > 64 KB before VM accepts are dropped. Realistic SSH/HTTPS clients send < 4 KB before handshake. Documented in commit.

---

## Files Summary

| File | Action | Phase |
|------|--------|-------|
| `src/services/firecracker.ts` | Modify | 1, 6 |
| `src/services/vm.ts` | Modify | 1, 4, 6 |
| `src/services/storage.ts` | Modify | 2 |
| `src/services/agent.ts` | Create | 2 |
| `src/services/metrics.ts` | Create | 3, 4 |
| `src/services/proxy.ts` | Modify | 3, 4, 7 |
| `src/services/consoleScanner.ts` | Create | 6 |
| `src/index.ts` | Modify | 3 |
| `src/types.ts` | Modify | 4 |
| `scripts/sb` | Modify | 5 |
| `test/integration.test.ts` | Modify | 1–6, 11 |
| `test/loadProxy.ts` | Create | 7 |

## Verification (overall)

- All 13 acceptance criteria met.
- `./do check` passes.
- A new VM has the health agent running within 90 s of `sb go`.
- After 1 week running, scaleboxd RSS is stable (< 200 MB) under typical traffic.
- An induced guest hang produces ERROR lines in `journalctl -u scaleboxd` from the console scanner within seconds.

## Update Considerations

- **Config changes:** none required. All defaults safe.
- **Storage changes:** new directory `/var/lib/scalebox/logs/` created on demand by `firecracker.ts`. No `install.sh` change.
- **Dependency changes:** none.
- **Migration needed:** no. Old VMs without `degraded` field, without persistent logs, without health agent will continue working unchanged. Only newly-created VMs get the new behavior.
- **`./do check-update`:** existing checks still apply. No new checks required, but adding a "metrics endpoint reachable" check after deploy is recommended (not required).
