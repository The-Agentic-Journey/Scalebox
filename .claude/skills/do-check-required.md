# Do Check Required Skill

## Purpose

This skill enforces that `./do check` MUST pass before any commits are made. There are NO exceptions.

## Rules

### 1. `./do check` is MANDATORY

Before creating ANY commit, you MUST run `./do check` and it MUST pass completely. This is non-negotiable.

### 2. Infrastructure Failures are a FULL STOP

If `./do check` fails due to infrastructure issues (GCP, firewall rules, SSH, DNS, VM creation, etc.), this is a **FULL STOP**. You CANNOT:

- Proceed with commits
- Skip `./do check` and use `./do lint` or `./do build` as a substitute
- Assume the code is correct because lint/build passed
- Work around the infrastructure issue

Instead, you MUST:

1. Stop all implementation work immediately
2. Inform the user that `./do check` failed due to infrastructure
3. Explain specifically what infrastructure issue occurred
4. Ask the user to fix the infrastructure issue or provide guidance
5. Wait for the user to confirm the infrastructure is fixed before continuing

### 3. Code Failures Must Be Fixed

If `./do check` fails due to code issues (lint errors, build errors, test failures), you MUST:

1. Launch sub-agents to fix all errors
2. Run `./do check` again
3. Repeat until `./do check` passes completely
4. Only then create commits

### 4. No Partial Verification

The following are NOT acceptable substitutes for `./do check`:

- `./do lint` alone
- `./do build` alone
- `./do test` alone
- Any combination that doesn't include the full `./do check` pipeline

### 5. Example Infrastructure Failures (FULL STOP required)

- "Firewall rule not found"
- "GCLOUD_PROJECT is not set"
- "SSH not ready"
- "DNS propagation timeout"
- "VM has no external IP"
- "Failed to create VM"
- Any GCP/gcloud authentication or permission errors

When you see ANY of these, STOP and ask the user for help.

## Rationale

The `./do check` command runs the full CI pipeline including deployment to a real VM and integration tests. Local lint and build checks are insufficient because:

1. Integration tests catch real-world issues that unit tests miss
2. The deployment process validates the full installation flow
3. Tests run against actual Firecracker VMs, not mocks

Skipping `./do check` means shipping untested code, which breaks production.
