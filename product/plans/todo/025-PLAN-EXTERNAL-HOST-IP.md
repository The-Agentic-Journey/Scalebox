# External Host IP in API Response Plan

## Overview

The VM API response currently returns the internal bridge IP (`172.16.x.x`) in the `ip` field, which is useless to API consumers — they cannot reach VMs at that address. The `ssh` field uses `VM_HOST` env var (defaulting to `localhost`), and the `/info` endpoint uses a separate `HOST_IP` env var with auto-detection — two env vars for the same purpose.

This plan makes `HOST_IP` a required config value set during installation, and uses it for the `ip` and `ssh` fields in VM API responses. The bootstrap installer prompts for the host IP interactively (with auto-detection as a suggested default). The server refuses to start if `HOST_IP` is missing. The `scalebox-update` script adds `HOST_IP` to existing configs via auto-detection during upgrade.

**Interaction with Plan 026:** Plan 026 (DNS Wildcard Cert) is also pending and references `config.hostIp || (await getHostIp())`. After this plan, `config.hostIp` is guaranteed non-empty at startup, so Plan 026 can simplify to just `config.hostIp`.

## Acceptance Criteria

| # | Criterion | Acceptance Test |
|---|-----------|-----------------|
| 1 | VM response `ip` field contains the host IP, not an internal 172.16.x.x bridge address | `test/integration.test.ts`: `VM response contains host IP instead of bridge IP` |
| 2 | VM response `ssh` field uses the host IP, not `localhost` | `test/integration.test.ts`: `VM response contains host IP instead of bridge IP` |

---

## Phase 1: Acceptance Test Scaffold

### Goal

Create the acceptance test as a skipped stub. After this phase, `./do check` passes with the skipped test.

### Changes

| File | Action | Details |
|------|--------|---------|
| `test/integration.test.ts` | Modify | Add a skipped acceptance test after the existing "create VM returns valid response" test |

Add the following test immediately after the `"create VM returns valid response"` test (after the closing `});` on line 110):

```typescript
test.skip("VM response contains host IP instead of bridge IP", async () => {
	const vm = await sbVmCreate("debian-base");
	if (vm?.id) createdVmIds.push(vm.id as string);

	// ip should be the host IP, not internal bridge IP (172.16.x.x)
	expect(vm.ip).not.toMatch(/^172\.16\./);
	expect(vm.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

	// ssh field should use the same host IP
	expect(vm.ssh).toContain(vm.ip as string);
	expect(vm.ssh).not.toContain("localhost");
});
```

### Verification

- The new test exists and is skipped
- Run `./do check` — passes (skipped test does not fail)

---

## Phase 2: Install and Update Infrastructure

### Goal

Make `HOST_IP` a required config value. Add it to the bootstrap installer (interactive prompt), the install script (config file generation), and the update script (migration for existing installs). Update `./do` to pass the external IP during automated bootstrap.

### Changes

| File | Action | Details |
|------|--------|---------|
| `scripts/bootstrap.sh` | Modify | Add interactive prompt for HOST_IP in `configure()` function; export it for install.sh |
| `scripts/install.sh` | Modify | Accept HOST_IP env var; write it to `/etc/scaleboxd/config` |
| `scripts/scalebox-update` | Modify | Add `migrate_host_ip()` function for existing installations |
| `do` | Modify | Pass `HOST_IP=$VM_IP` in bootstrap expect script; add expect clause for new prompt |

#### `scripts/bootstrap.sh`

1. In the `configure()` function, add the following block **after** the VM_DOMAIN prompt block (after line 102 `fi`):

```bash

  # HOST_IP - external IP for API responses
  if [[ -z "${HOST_IP:-}" ]]; then
    local detected_ip
    detected_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    echo ""
    echo "Scalebox includes the server's IP address in API responses"
    echo "so clients know where to connect via SSH."
    echo "On cloud VMs (GCE, AWS), use the public IP, not the VPC-internal IP."
    echo ""
    HOST_IP=$(prompt "Enter host IP" "${detected_ip:-}")
  fi
```

2. In the `run_installer()` function, add `HOST_IP` to the exports. Change:

```bash
  # Export config for install.sh
  export API_DOMAIN="${API_DOMAIN:-}"
  export VM_DOMAIN="${VM_DOMAIN:-}"
  export INSTALL_DIR
```

To:

```bash
  # Export config for install.sh
  export API_DOMAIN="${API_DOMAIN:-}"
  export VM_DOMAIN="${VM_DOMAIN:-}"
  export HOST_IP="${HOST_IP:-}"
  export INSTALL_DIR
```

#### `scripts/install.sh`

1. Add `HOST_IP` to the env var defaults at the top (after line 19 `ACME_STAGING="${ACME_STAGING:-false}"`):

```bash
HOST_IP="${HOST_IP:-}"
```

2. Add `HOST_IP` to the config file generation in the `install_service()` function. Change the config heredoc (lines 442-450):

```bash
    cat > /etc/scaleboxd/config <<EOF
API_PORT=$API_PORT
API_TOKEN=$API_TOKEN
DATA_DIR=$DATA_DIR
KERNEL_PATH=$DATA_DIR/kernel/vmlinux
API_DOMAIN=$API_DOMAIN
VM_DOMAIN=$VM_DOMAIN
ACME_STAGING=$ACME_STAGING
EOF
```

To:

```bash
    cat > /etc/scaleboxd/config <<EOF
API_PORT=$API_PORT
API_TOKEN=$API_TOKEN
DATA_DIR=$DATA_DIR
KERNEL_PATH=$DATA_DIR/kernel/vmlinux
API_DOMAIN=$API_DOMAIN
VM_DOMAIN=$VM_DOMAIN
ACME_STAGING=$ACME_STAGING
HOST_IP=$HOST_IP
EOF
```

#### `scripts/scalebox-update`

Add a `migrate_host_ip()` function after the existing `migrate_caddy_config()` function (after line 298):

```bash
migrate_host_ip() {
  local config_file="/etc/scaleboxd/config"

  # Skip if already has HOST_IP
  if grep -q "^HOST_IP=" "$config_file" 2>/dev/null; then
    return 0
  fi

  log "Adding HOST_IP to config (required by new version)..."
  local host_ip
  host_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  if [[ -n "$host_ip" ]]; then
    echo "HOST_IP=$host_ip" >> "$config_file"
    log "HOST_IP set to $host_ip (auto-detected). Edit /etc/scaleboxd/config if this is not the external IP."
  else
    echo "HOST_IP=" >> "$config_file"
    log "WARNING: Could not auto-detect HOST_IP. Set HOST_IP in /etc/scaleboxd/config before restarting."
  fi
}
```

Call `migrate_host_ip` in the `main()` function, in the update sequence between `migrate_caddy_config` and `start_service`. Change:

```bash
  migrate_caddy_config
  start_service
```

To:

```bash
  migrate_caddy_config
  migrate_host_ip
  start_service
```

#### `do`

In the `provision_vm_bootstrap()` function, make two changes:

1. Pass `HOST_IP` in the spawn command. Change line 158:

```bash
spawn sudo bash -c "SCALEBOX_RELEASE_URL='$tarball_url' ACME_STAGING=true bash /tmp/bootstrap.sh"
```

To:

```bash
spawn sudo bash -c "SCALEBOX_RELEASE_URL='$tarball_url' ACME_STAGING=true HOST_IP='$VM_IP' bash /tmp/bootstrap.sh"
```

2. Add an expect clause for the new host IP prompt. Add the following block inside the `expect { ... }` block (after the "Enter VM domain" clause, before the `timeout` clause):

```expect
    "Enter host IP" {
        send "$VM_IP\r"
        exp_continue
    }
```

Note: When `./do check-update` bootstraps with an old release that doesn't have this prompt, the expect clause simply never matches — it does not cause an error. The old install.sh ignores the `HOST_IP` env var. The new `scalebox-update` then adds `HOST_IP` via `migrate_host_ip()`.

### Verification

- `scripts/bootstrap.sh` prompts for HOST_IP during interactive setup
- `scripts/install.sh` writes HOST_IP to `/etc/scaleboxd/config`
- `scripts/scalebox-update` adds HOST_IP to existing configs missing it

---

## Phase 3: Server-Side Implementation

### Goal

Use `config.hostIp` for the `ip` and `ssh` fields in VM API responses. Fail at startup if `HOST_IP` is not configured. Remove `VM_HOST` from server-side code and remove the runtime auto-detection from the API code path.

### Acceptance Test (Red)

Unskip the acceptance test by removing `.skip` from `test.skip("VM response contains host IP instead of bridge IP", ...)`.

| Test | Criterion | Expected Behavior |
|------|-----------|-------------------|
| `VM response contains host IP instead of bridge IP` | #1, #2 | `ip` is not `172.16.x.x`, matches IP pattern, `ssh` contains the IP, `ssh` does not contain `localhost` |

Verify the test **fails** (red) before implementing production code. It will fail because `ip` still returns `172.16.x.x`.

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/index.ts` | Modify | Add startup validation for HOST_IP; simplify `/info` endpoint |
| `src/services/vm.ts` | Modify | Update `vmToResponse()` to use `config.hostIp` |
| `src/config.ts` | Modify | Update stale comment on `hostIp` property |
| `test/integration.test.ts` | Modify | Update existing test that checks internal IP pattern |

#### `src/index.ts`

1. Remove `getHostIp` from the import (no longer needed). Change:

```typescript
import { getCpuUsage, getHostIp, getMemoryStats, getStorageStats } from "./services/system";
```

To:

```typescript
import { getCpuUsage, getMemoryStats, getStorageStats } from "./services/system";
```

2. Add a startup validation **before** the `await cleanupOrphanedUdpRules();` line (before line 165). Insert:

```typescript
// Validate required config
if (!config.hostIp) {
	console.error("FATAL: HOST_IP not set in /etc/scaleboxd/config.");
	console.error("Set it to this server's external IP address and restart scaleboxd.");
	process.exit(1);
}
```

3. In the `/info` endpoint, replace:

```typescript
	// Get host IP (from config or auto-detect)
	const hostIp = config.hostIp || (await getHostIp());
```

With:

```typescript
	const hostIp = config.hostIp;
```

#### `src/services/vm.ts`

Replace the `vmToResponse()` function body. Change:

```typescript
export function vmToResponse(vm: VM): VMResponse {
	const host = process.env.VM_HOST || "localhost";
	const url = config.vmDomain ? `https://${vm.name}.${config.vmDomain}` : null;
	return {
		id: vm.id,
		name: vm.name,
		template: vm.template,
		ip: vm.ip,
		ssh_port: vm.port,
		ssh: `ssh -p ${vm.port} user@${host}`,
		url,
		status: "running",
		created_at: vm.createdAt.toISOString(),
	};
}
```

To:

```typescript
export function vmToResponse(vm: VM): VMResponse {
	const url = config.vmDomain ? `https://${vm.name}.${config.vmDomain}` : null;
	return {
		id: vm.id,
		name: vm.name,
		template: vm.template,
		ip: config.hostIp,
		ssh_port: vm.port,
		ssh: `ssh -p ${vm.port} user@${config.hostIp}`,
		url,
		status: "running",
		created_at: vm.createdAt.toISOString(),
	};
}
```

#### `src/config.ts`

Update the stale comment on the `hostIp` property (line 20). Change:

```typescript
	// Host IP for external access (auto-detected if not set)
	hostIp: process.env.HOST_IP || "",
```

To:

```typescript
	// Host IP for external access (required — set during installation)
	hostIp: process.env.HOST_IP || "",
```

Note: The `getHostIp()` function in `src/services/system.ts` is no longer called from `index.ts` after this change. It remains exported as it may be useful for Plan 026 or future features. No changes to `system.ts` are needed.

#### `test/integration.test.ts`

Update the existing `"create VM returns valid response"` test. Change the IP assertion from:

```typescript
expect(vm.ip).toMatch(/^172\.16\.\d+\.\d+$/);
```

To:

```typescript
expect(vm.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
```

### Verification

- The acceptance test passes (green)
- The existing "create VM returns valid response" test passes
- Run `./do check` — all checks pass

---

## Phase 4: DDD — Update Glossary and VM Lifecycle Context

### Goal

Document the Host IP concept and update the VMResponse definition.

### Changes

| File | Action | Details |
|------|--------|---------|
| `product/DDD/glossary.md` | Modify | Add "Host IP" term; clarify existing "IP Address" term |
| `product/DDD/contexts/vm-lifecycle.md` | Modify | Update VMResponse `ip` field description; add `ip` to derived fields list |

#### `product/DDD/glossary.md`

1. Amend the existing "IP Address" entry (line 42). Change:

```markdown
### IP Address
Private IP assigned to each VM from the `172.16.0.0/16` range. Sequential allocation starting from `172.16.0.2`.
```

To:

```markdown
### IP Address (Internal)
Private IP assigned to each VM from the `172.16.0.0/16` range. Sequential allocation starting from `172.16.0.2`. Used internally for bridge networking, proxy forwarding, and Caddy routing. Not exposed to API consumers (see **Host IP**).
```

2. Add the following entry immediately after the updated "IP Address (Internal)" entry (before the "MAC Address" entry):

```markdown
### Host IP
The external IP address of the Scalebox host server. Required config value (`HOST_IP` in `/etc/scaleboxd/config`), set during installation. Returned in the `ip` field of VM API responses so clients know where to connect. The server refuses to start if `HOST_IP` is not set.
```

#### `product/DDD/contexts/vm-lifecycle.md`

1. In the "VMResponse (Read Model)" section, change:

```typescript
  ip: string;
```

To:

```typescript
  ip: string;           // Host IP (for client connections, not internal bridge IP)
```

2. In the "vmToResponse" description (the bullet list under "Transforms internal VM to external representation, computing derived fields"), add a new bullet:

```
- `ip`: Host IP from config (replaces internal bridge IP with the server's externally-reachable address)
```

### Verification

- Review documentation for accuracy and completeness

---

## Phase 5: ADR — Required Host IP Configuration

### Goal

Record the decision to make HOST_IP a required config value and consolidate the two env vars.

### Changes

| File | Action | Details |
|------|--------|---------|
| `product/ADR/015-host-ip-consolidation.md` | Create | ADR documenting the decision |

#### `product/ADR/015-host-ip-consolidation.md`

```markdown
# ADR 015: Required Host IP Configuration

## Status

Accepted

## Context

The system had two environment variables serving the same purpose — identifying the external IP of the Scalebox host:

- `VM_HOST`: Used in `vmToResponse()` for the SSH command field. Not set in the server config; defaults to `localhost`.
- `HOST_IP`: Used in the `/info` endpoint with auto-detection fallback via `ip route get 1.1.1.1`.

This caused two problems:
1. The `ip` field in VM API responses returned the internal bridge IP (`172.16.x.x`), which is unreachable by API consumers.
2. The `ssh` field defaulted to `localhost`, which is only correct when the client runs on the same machine as the server.

Runtime auto-detection via `ip route get 1.1.1.1` is unreliable on cloud VMs behind NAT (GCE, AWS), where it returns the VPC-internal IP rather than the public IP.

## Decision

Make `HOST_IP` a required configuration value set at install time:

1. The bootstrap installer prompts for the host IP during interactive setup, with `hostname -I` as a suggested default.
2. The value is written to `/etc/scaleboxd/config` as `HOST_IP=<value>`.
3. The server refuses to start if `HOST_IP` is not set, with a clear error message.
4. `vmToResponse()` uses `config.hostIp` directly for the `ip` and `ssh` fields.
5. The `/info` endpoint uses `config.hostIp` directly.
6. `VM_HOST` is removed from server-side code.
7. `scalebox-update` adds `HOST_IP` to existing configs (auto-detected) during upgrades.

## Consequences

- **API breaking change**: The `ip` field in VM responses changes from internal IP (`172.16.x.x`) to host IP. No known consumers relied on the internal IP.
- **Install-time configuration**: Operators explicitly set the IP during install, ensuring correctness even on NAT-ed cloud VMs.
- **Strict startup validation**: Missing `HOST_IP` prevents the server from starting, catching configuration errors early.
- **Backwards compatible on upgrade**: `scalebox-update` auto-detects and adds `HOST_IP` to existing configs. Operators on NAT-ed environments should verify the auto-detected value.
- **Test infrastructure unaffected**: Tests use `VM_HOST` in the test runner process (not the server), which remains unchanged. The `./do` script passes `HOST_IP=$VM_IP` (the GCE external IP) during automated bootstrap.
```

### Verification

- Review ADR for completeness (context, decision, rationale, consequences)

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `test/integration.test.ts` | Modify | Add acceptance test; update existing IP assertion |
| `scripts/bootstrap.sh` | Modify | Add interactive HOST_IP prompt |
| `scripts/install.sh` | Modify | Accept HOST_IP env var; write to config |
| `scripts/scalebox-update` | Modify | Add `migrate_host_ip()` for existing installs |
| `do` | Modify | Pass HOST_IP in bootstrap; handle new prompt |
| `src/index.ts` | Modify | Startup validation; simplify `/info` endpoint |
| `src/services/vm.ts` | Modify | Use `config.hostIp` in `vmToResponse()` |
| `src/config.ts` | Modify | Update stale comment on `hostIp` property |
| `product/DDD/glossary.md` | Modify | Add "Host IP" term; clarify "IP Address" term |
| `product/DDD/contexts/vm-lifecycle.md` | Modify | Update VMResponse `ip` description and derived fields |
| `product/ADR/015-host-ip-consolidation.md` | Create | Document decision |

---

## End-to-End Verification

After all phases are complete:

1. All acceptance tests pass (none skipped)
2. `./do check` passes — full verification pipeline (bootstrap sets HOST_IP, tests verify)
3. `./do check-update` passes — old install upgraded, HOST_IP migrated
4. Fresh bootstrap prompts for HOST_IP and writes to config
5. Server refuses to start if HOST_IP is missing from config
6. `sb vm list` displays the host IP in the IP column
7. The `/info` endpoint returns the same host IP

---

## Update Considerations

- **Config changes**: `HOST_IP` is now required in `/etc/scaleboxd/config`. Fresh installs get it via interactive prompt. Existing installs get it via `scalebox-update` auto-detection. Operators on NAT-ed cloud environments should verify the auto-detected value is the public IP.
- **Storage changes**: None
- **Dependency changes**: None
- **Migration needed**: Yes — `scalebox-update` adds `HOST_IP` to existing configs via `migrate_host_ip()`
- **Backwards compatibility**: The `ip` field value changes from internal to host IP. The `sb` CLI does not use the `ip` field for connections (it derives the host from `SCALEBOX_HOST`), so no client-side breakage expected.
- **Plan 026 interaction**: After this plan, `config.hostIp` is guaranteed non-empty at startup. Plan 026 can use `config.hostIp` directly instead of `config.hostIp || (await getHostIp())`.
