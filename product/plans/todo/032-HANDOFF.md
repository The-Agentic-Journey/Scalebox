# 032 — VM Restart & Disk-Preserving Recovery: Session Handoff

**Status:** All 7 phases implemented and committed on `feat/032-vm-restart-and-recovery` (pushed to
`origin`/GitHub). Restart acceptance tests #1–#8 pass against a real host. **Criterion #9 (recovery
relaunch) is implemented and statically verified but has NOT been exercised end-to-end** — blocked by
a pre-existing test-infra failure (details below). No PR/MR was opened.

This note lets another engineer pick up where this session left off. Pair it with the plan:
`product/plans/todo/032-PLAN-VM-RESTART-AND-RECOVERY.md`.

---

## What was done

Seven focused commits, one per plan phase:

| Phase | Commit | Summary |
|-------|--------|---------|
| 1 | `e3ea08b` | Test scaffolds: `api.post`, `sbVmRestart` helpers, 8 skipped restart stubs |
| 2 | `3b800c4` | Persist `vcpuCount`/`memSizeMib` in `VM`/`PersistedVM`/`state.json` (defaults on recovery) |
| 3 | `9fd87fa` | `restartVm` power-cycle, `POST /vms/:id/restart` (full validation), `sb vm restart`; tests #1,5,6,7,8 |
| 4 | `42c460d` | Apply overrides: offline rootfs grow + vcpu/mem; tests #2,3,4 |
| 5 | `587719a` | Disk-preserving recovery: `relaunchVm`, `recoverVms` relaunch-not-delete, `do` reconciliation sub-test (#9) |
| 6 | `91d23e7` | DDD docs: glossary, vm-lifecycle, context-map |
| 7 | `c2c0673` | ADR-019, CLAUDE.md "In-Memory State" update, README endpoint/CLI |

Each phase passed the local check (`./do lint` = biome clean, `./do build` = binary compiles) before commit.

## Verification status

`./do check` was run **twice** end-to-end against a real Firecracker host (each run provisions a fresh
GCE nested-virt VM, deploys scaleboxd, runs `bun test` then `test_reconciliation`).

- **Restart tests #1–#8: PASS** on the host (power-cycle/boot_id, disk grow, `nproc`, `MemTotal`, 404,
  shrink-reject, invalid-override matrix, CLI restart). They are among the 65 passing tests; bun's
  default reporter only prints failures, so they don't appear by name in the log.
- **6 tests FAIL — pre-existing, NOT from this branch.** Both runs failed identically:
  ```
  Firecracker API > VM becomes reachable via SSH        (Timeout waiting for SSH on port 22001 after 90s)
  Firecracker API > snapshot VM creates template
  Firecracker API > snapshot appears in template list
  Firecracker API > snapshot existing template returns 409
  Firecracker API > snapshot with overwrite replaces existing template
  Firecracker API > can delete snapshot template
  ```
  **Proof it's pre-existing:** the same failures (including `VM becomes reachable via SSH`) appear in the
  Phase-1 baseline runs, when only *skipped* tests existed and no runtime code had changed.
  **Root-cause hypothesis:** the *first* Firecracker VM on a cold GCE nested-virt host takes >90s to reach
  SSH; that first test (`VM becomes reachable via SSH`, port 22001) times out and the snapshot chain that
  depends on a reachable VM cascades. Our restart tests run later against a warmed host and pass — which is
  exactly why VM creation + SSH clearly work, yet the first-VM test deterministically times out. This is a
  test-infra issue on `main`, deterministic (not flaky — a retry produced byte-identical failures).

## The open gap: criterion #9 (recovery relaunch)

`do_check` runs `bun test` **before** `test_reconciliation`, so the pre-existing `bun test` failures abort
the run before the `VM with dead process is relaunched on restart` sub-test executes. Phase 5's recovery
change (delete → relaunch on dead PID with intact rootfs — the data-loss-footgun fix, and the riskiest part
of this work) is therefore **implemented per spec and statically verified, but not validated end-to-end**:

- `relaunchVm()` (`src/services/vm.ts`) mirrors the live-reconnect branch of `recoverVms()` field-for-field,
  sourcing values from the `PersistedVM` and using a freshly-started `pid`.
- The relaunch log substring is **byte-identical** between the emitter (`src/services/vm.ts`) and the `do`
  grep target: `process not running but rootfs exists — relaunching` (note the em-dash `—`).

## How to finish this off

1. **Unblock verification** — fix the pre-existing snapshot/SSH-timeout failure so `./do check` can go green
   and reach `test_reconciliation`. Likely fixes: add a warm-up VM before the timed `Firecracker API` tests,
   or raise the first-VM SSH wait for cold GCE hosts. This is a separate concern from plan 032; ideally its
   own change on `main`. Alternatively, validate #9 in isolation by deploying this branch
   (`./do test-deploy`) and running just the crash → `systemctl restart scaleboxd` → relaunch scenario.
2. **Open the PR** (nothing was pushed to a PR yet):
   `https://github.com/The-Agentic-Journey/Scalebox/pull/new/feat/032-vm-restart-and-recovery`
   A ready-to-paste PR title/body was drafted in the session; reproduce from this handoff if needed.
3. **When green**, move `032-PLAN-*.md` (and delete this handoff) to `product/plans/done/` per CLAUDE.md.

## Environment notes for whoever picks this up

- **Local orchestration mode.** The work was driven from the local plan file (not a GitLab work-item URL),
  so no GitLab claim/label/MR/notes were performed. `GITLAB_TOKEN` is present in the env but irrelevant —
  **the remote is GitHub** (`git@github.com:The-Agentic-Journey/Scalebox.git`). PR creation needs a
  `GH_TOKEN` or `gh` (neither was available in the sandbox; the SSH key authorizes push but not the API).
- **Test host:** `./do check` provisions a fresh GCE VM (`n2-standard-2`, `us-central1-a`) and deploys to it,
  with DNS under `testing.holderbaum.cloud`. There is also a persistent host `sb.holderbaum.cloud` used
  during exploration. Both `./do check` runs tore down their GCE VMs/DNS on exit — no leftover cloud
  resources were left by this session.
- **Reproduce verification:** `./do check` from the worktree; ~14 min/run. Reference logs from this session
  (may be cleaned up): `/tmp/do-check-final.log`, `/tmp/do-check-final2.log`.
- `./do check` runs `lint → build → deploy → bun test → test_reconciliation`; it needs an authenticated
  `gcloud` with `GCLOUD_PROJECT` set.
