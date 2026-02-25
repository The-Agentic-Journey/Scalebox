# DNS Server & Wildcard Certificate Plan

## Overview

Replace per-VM HTTP-01 certificate issuance with a single wildcard certificate obtained via DNS-01 challenge. This eliminates Let's Encrypt rate limiting (50 certs/week/domain) by issuing one `*.vm.{BASE_DOMAIN}` wildcard cert instead of one cert per VM.

The implementation adds an in-process DNS server (using `dns2` npm package) to the Scalebox server and switches Caddy from on-demand TLS (HTTP-01) to DNS-01 challenge via the `caddy-dns/acmeproxy` module. A new single `BASE_DOMAIN` config replaces the separate `API_DOMAIN` and `VM_DOMAIN` settings.

**Domain structure (new):**
- Config: `BASE_DOMAIN` (e.g., `scalebox.example.com`)
- API: `api.{BASE_DOMAIN}` (e.g., `api.scalebox.example.com`)
- VMs: `{name}.vm.{BASE_DOMAIN}` (e.g., `happy-blue-fox.vm.scalebox.example.com`)
- User DNS setup: one NS record delegating `BASE_DOMAIN` to the host

## Prerequisites

**Plan 025 (External Host IP) must be implemented first.** This plan depends on Plan 025's guarantee that `config.hostIp` is always non-empty at startup. All file modifications in this plan incorporate Plan 025's changes (HOST_IP config, startup validation, vmToResponse using config.hostIp).

## Implementation Note — Phase Atomicity

**Phases 2–5 and the `./do`/test-infrastructure changes from Phase 8 form a single atomic implementation unit.** They are numbered separately for readability, but must all be implemented and deployed together before `./do check` can pass. The reason: Phase 2 changes `config.ts` (removing `apiDomain`/`vmDomain`), Phase 3 adds the DNS server, Phase 4 adds ACME proxy endpoints, Phase 5 rewrites `caddy.ts` to use `baseDomain`, and Phase 8 updates `./do` DNS records/expect script and `test/helpers.ts` to match the new domain structure. None of these work in isolation.

The red-green ATDD cycle operates across this combined unit:
1. Unskip all acceptance tests for criteria #1–#4 at the start
2. Verify they all fail (red)
3. Implement all changes in Phases 2–6
4. Verify `./do check` passes (green)

## Acceptance Criteria

| # | Criterion | Acceptance Test |
|---|-----------|-----------------|
| 1 | `/info` returns `base_domain` field (not `api_domain`/`vm_domain`) | `test/integration.test.ts`: `info returns base_domain` |
| 2 | Created VM response URL uses `https://{name}.vm.{BASE_DOMAIN}` format | `test/integration.test.ts`: `VM URL uses vm.BASE_DOMAIN format` |
| 3 | DNS server resolves `*.vm.{BASE_DOMAIN}` A records to host IP | `test/integration.test.ts`: `DNS resolves VM subdomain to host IP` |
| 4 | DNS server resolves `api.{BASE_DOMAIN}` A record to host IP | `test/integration.test.ts`: `DNS resolves API subdomain to host IP` |
| 5 | ACME proxy present/cleanup endpoints store and remove TXT records | `test/integration.test.ts`: `ACME proxy endpoints manage TXT records` |
| 6 | API is accessible via HTTPS at `api.{BASE_DOMAIN}` | `test/integration.test.ts`: `API accessible via HTTPS` (existing health check, adapted) |
| 7 | `./do check` passes end-to-end | CI verification |

---

## Phase 1: Acceptance Test Scaffolds

### Goal

Create all acceptance tests as skipped/pending stubs. After this phase, `./do check` passes with skipped tests.

### Changes

| File | Action | Details |
|------|--------|---------|
| `test/integration.test.ts` | Modify | Add skipped tests for criteria #1–#5 inside the existing `describe("Firecracker API")` block |

### Test Stubs

Add the following inside the existing `describe("Firecracker API")` block, after the "Phase 7: Cleanup" section (after the last existing test):

```typescript
	// === DNS & Wildcard Cert ===
	test.skip("info returns base_domain", async () => {});
	test.skip("VM URL uses vm.BASE_DOMAIN format", async () => {});
	test.skip("DNS resolves VM subdomain to host IP", async () => {});
	test.skip("DNS resolves API subdomain to host IP", async () => {});
	test.skip("ACME proxy endpoints manage TXT records", async () => {});
```

**Important:** These tests go INSIDE the existing `describe("Firecracker API")` block (not a new describe) so they share the existing `createdVmIds`, `afterEach` cleanup, and `beforeAll`/`afterAll` hooks.

### Verification

- All new tests are skipped
- Run `./do check` — passes (skipped tests don't fail)

---

## Phase 2: Config — Replace API_DOMAIN + VM_DOMAIN with BASE_DOMAIN

### Goal

Introduce the `BASE_DOMAIN` config key and remove `API_DOMAIN` and `VM_DOMAIN`. Derive `apiDomain` and `vmDomain` from `baseDomain`.

### Acceptance Test (Red)

Unskip and implement:

| Test | Criterion | Expected Behavior |
|------|-----------|-------------------|
| `info returns base_domain` | #1 | `GET /info` returns JSON with `base_domain` field, no `api_domain` or `vm_domain` fields |
| `VM URL uses vm.BASE_DOMAIN format` | #2 | Created VM response has `url` matching `https://{name}.vm.{BASE_DOMAIN}` |

**Test implementation for `info returns base_domain`:**
```typescript
test("info returns base_domain", async () => {
	const status = await sbStatus();
	expect(status.base_domain).toBeDefined();
	expect(status.base_domain).not.toBe("");
	expect((status as Record<string, unknown>).api_domain).toBeUndefined();
	expect((status as Record<string, unknown>).vm_domain).toBeUndefined();
});
```

**Test implementation for `VM URL uses vm.BASE_DOMAIN format`:**
```typescript
test("VM URL uses vm.BASE_DOMAIN format", async () => {
	const vm = await sbVmCreate("debian-base");
	if (vm?.id) createdVmIds.push(vm.id as string);
	const status = await sbStatus();
	const baseDomain = status.base_domain as string;
	expect(vm.url).toMatch(new RegExp(`^https://.+\\.vm\\.${baseDomain.replace(/\./g, "\\.")}$`));
});
```

Verify the tests **fail** before implementing production code.

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/config.ts` | Modify | Replace `apiDomain` and `vmDomain` with `baseDomain: process.env.BASE_DOMAIN \|\| ""`. Add derived getters: `get apiDomain() { return this.baseDomain ? "api." + this.baseDomain : "" }` and `get vmDomain() { return this.baseDomain ? "vm." + this.baseDomain : "" }` — but since `config` is a plain object, instead add two computed values: `apiSubdomain: "api"` and `vmSubdomain: "vm"` as constants, and compute full domains inline where needed |
| `src/index.ts` | Modify | (1) Change `/info` response: replace `api_domain: config.apiDomain` and `vm_domain: config.vmDomain` with `base_domain: config.baseDomain`. (2) Remove the `/caddy/check` endpoint (lines 57–74) |
| `src/services/vm.ts` | Modify | Line 329: change `const url = config.vmDomain ? \`https://${vm.name}.${config.vmDomain}\` : null;` to `const url = config.baseDomain ? \`https://${vm.name}.vm.${config.baseDomain}\` : null;` |
| `src/services/caddy.ts` | Modify | Replace `config.vmDomain` references with `config.baseDomain` and use `vm.${config.baseDomain}` for the wildcard domain. Details in Phase 5. For now, update the domain references: line 53 `if (!config.baseDomain)`, line 62 `${vm.name}.vm.${config.baseDomain}`, line 70 `*.vm.${config.baseDomain}` |
| `test/helpers.ts` | Modify | Change `API_BASE_URL` to include `api.` prefix for HTTPS: `export const API_BASE_URL = USE_HTTPS ? \`https://api.${VM_HOST}\` : \`http://${VM_HOST}:${API_PORT}\`;` — this reflects the new domain structure where the API lives at `api.{BASE_DOMAIN}`. `VM_HOST` remains the raw FQDN (the BASE_DOMAIN), used directly for SSH and `dig` commands |
| `scripts/sb` | Modify | Line 308: change `echo "API:  $(echo "$response" \| jq -r '.api_domain // "N/A"')"` to `echo "Domain: $(echo "$response" \| jq -r '.base_domain // "N/A"')"`. No adjacent VM domain line exists in the current `cmd_status()` function — no other changes needed. |

### Specific changes to `src/config.ts`:

Replace the entire file content with:
```typescript
export const config = {
	apiPort: Number(process.env.API_PORT) || 8080,
	apiToken: process.env.API_TOKEN || "dev-token",
	dataDir: process.env.DATA_DIR || "/var/lib/scalebox",
	kernelPath: process.env.KERNEL_PATH || "/var/lib/scalebox/kernel/vmlinux",
	portMin: Number(process.env.PORT_MIN) || 22001,
	portMax: Number(process.env.PORT_MAX) || 32000,
	defaultVcpuCount: Number(process.env.DEFAULT_VCPU_COUNT) || 2,
	defaultMemSizeMib: Number(process.env.DEFAULT_MEM_SIZE_MIB) || 2048,
	defaultDiskSizeGib: Number(process.env.DEFAULT_DISK_SIZE_GIB) || 2,
	maxDiskSizeGib: Number(process.env.MAX_DISK_SIZE_GIB) || 100,
	protectedTemplates: ["debian-base"],
	// Base domain for all HTTPS access (e.g., "scalebox.example.com")
	// API at api.{baseDomain}, VMs at {name}.vm.{baseDomain}
	baseDomain: process.env.BASE_DOMAIN || "",
	acmeStaging: process.env.ACME_STAGING === "true",
	// Host IP for external access (required — set during installation)
	hostIp: process.env.HOST_IP || "",
	// Internal password for Caddy ACME proxy communication
	acmeProxyPassword: process.env.ACME_PROXY_PASSWORD || "",
};
```

### Verification

- Both acceptance tests pass (green)
- Run `./do lint` — passes
- Run existing tests — all still pass (they don't check `api_domain`/`vm_domain` directly)

---

## Phase 3: DNS Server

### Goal

Add an in-process authoritative DNS server that handles queries for the `{BASE_DOMAIN}` zone.

### Acceptance Test (Red)

Unskip and implement:

| Test | Criterion | Expected Behavior |
|------|-----------|-------------------|
| `DNS resolves VM subdomain to host IP` | #3 | `dig @{VM_HOST} -p 53 anything.vm.{BASE_DOMAIN} A +short` returns the host IP |
| `DNS resolves API subdomain to host IP` | #4 | `dig @{VM_HOST} -p 53 api.{BASE_DOMAIN} A +short` returns the host IP |

**Test implementation (using Bun shell `$` to call `dig`):**
```typescript
test("DNS resolves VM subdomain to host IP", async () => {
	const status = await sbStatus();
	const baseDomain = status.base_domain as string;
	const hostIp = status.host_ip as string;
	const result = await $`dig @${VM_HOST} test-vm.vm.${baseDomain} A +short`.text();
	expect(result.trim()).toBe(hostIp);
}, { timeout: 10000 });

test("DNS resolves API subdomain to host IP", async () => {
	const status = await sbStatus();
	const baseDomain = status.base_domain as string;
	const hostIp = status.host_ip as string;
	const result = await $`dig @${VM_HOST} api.${baseDomain} A +short`.text();
	expect(result.trim()).toBe(hostIp);
}, { timeout: 10000 });
```

These tests require `dig` on the test runner machine (already available, it's part of `dnsutils` which is commonly installed). Add `import { $ } from "bun";` to the import block in `integration.test.ts`. Also add `VM_HOST` to the imports from `./helpers`.

Verify the tests **fail** before implementing production code.

### Changes

| File | Action | Details |
|------|--------|---------|
| `package.json` | Modify | Add `"dns2": "^2.1.0"` to `dependencies`. Add `"@types/dns2": "^2.0.10"` to `devDependencies` if it exists on npm; if not, create `src/types/dns2.d.ts` with a minimal type declaration (`declare module "dns2"`) |
| `src/services/dns.ts` | Create | In-process authoritative DNS server |
| `src/index.ts` | Modify | Import and start DNS server at startup |

### `src/services/dns.ts` specification:

```typescript
import dns2 from "dns2";
import { config } from "../config";

const { Packet } = dns2;

// In-memory store for ACME challenge TXT records
// Key: FQDN (e.g., "_acme-challenge.vm.scalebox.example.com.")
// Value: TXT record value
const acmeTxtRecords = new Map<string, string>();

export function setAcmeTxtRecord(fqdn: string, value: string): void {
	acmeTxtRecords.set(fqdn, value);
}

export function deleteAcmeTxtRecord(fqdn: string): void {
	acmeTxtRecords.delete(fqdn);
}

export async function startDnsServer(): Promise<void> {
	if (!config.baseDomain) return;

	// config.hostIp is guaranteed non-empty at startup (Plan 025)
	const hostIp = config.hostIp;
	const zone = config.baseDomain.toLowerCase();

	const server = dns2.createServer({
		udp: true,
		tcp: true,
		handle: (request, send) => {
			const response = Packet.createResponseFromRequest(request);
			response.header.aa = true; // Authoritative answer

			const [question] = request.questions;
			if (!question) {
				send(response);
				return;
			}

			const { name, type } = question;
			const nameLower = name.toLowerCase();

			// Only handle queries for our zone (exact match or proper subdomain with dot prefix)
			if (nameLower !== zone && !nameLower.endsWith(`.${zone}`)) {
				response.header.rcode = 3; // NXDOMAIN
				send(response);
				return;
			}

			switch (type) {
				case Packet.TYPE.A:
					// All subdomains resolve to host IP
					response.answers.push({
						name,
						type: Packet.TYPE.A,
						class: Packet.CLASS.IN,
						ttl: 300,
						data: hostIp,
					});
					break;

				case Packet.TYPE.TXT: {
					// Normalize FQDN: ensure trailing dot for lookup
					const fqdn = nameLower.endsWith(".") ? nameLower : nameLower + ".";
					const fqdnNoDot = nameLower.endsWith(".") ? nameLower.slice(0, -1) : nameLower;
					const value = acmeTxtRecords.get(fqdn) || acmeTxtRecords.get(fqdnNoDot);
					if (value) {
						response.answers.push({
							name,
							type: Packet.TYPE.TXT,
							class: Packet.CLASS.IN,
							ttl: 60,
							data: value,
						});
					}
					break;
				}

				case Packet.TYPE.SOA:
					response.answers.push({
						name: zone,
						type: Packet.TYPE.SOA,
						class: Packet.CLASS.IN,
						ttl: 3600,
						data: {
							mname: zone,
							rname: `admin.${zone}`,
							serial: Math.floor(Date.now() / 1000),
							refresh: 3600,
							retry: 600,
							expire: 604800,
							minimum: 60,
						},
					});
					break;

				case Packet.TYPE.NS:
					response.answers.push({
						name: zone,
						type: Packet.TYPE.NS,
						class: Packet.CLASS.IN,
						ttl: 3600,
						data: zone,
					});
					// Glue record in additional section
					response.additionals.push({
						name: zone,
						type: Packet.TYPE.A,
						class: Packet.CLASS.IN,
						ttl: 3600,
						data: hostIp,
					});
					break;

				default:
					// Empty response for unsupported types
					break;
			}

			send(response);
		},
	});

	server.on("requestError", (error: Error) => {
		console.error("DNS request error:", error);
	});

	await server.listen({
		udp: { port: 53, address: "0.0.0.0" },
		tcp: { port: 53, address: "0.0.0.0" },
	});

	console.log("DNS server listening on port 53 (UDP+TCP)");
}
```

### Changes to `src/index.ts` for DNS server startup:

Add import at top:
```typescript
import { startDnsServer } from "./services/dns";
```

Add after VM recovery (after line 168, before the `updateCaddyConfig` call):
```typescript
// Start DNS server for domain resolution and ACME challenges
await startDnsServer();
```

### Verification

- Both DNS acceptance tests pass (green)
- Run `./do lint` — passes
- DNS server starts without errors

---

## Phase 4: ACME Proxy Endpoints

### Goal

Add HTTP endpoints that Caddy's `acmeproxy` module calls to set/clear ACME challenge TXT records.

### Acceptance Test (Red)

Unskip and implement:

| Test | Criterion | Expected Behavior |
|------|-----------|-------------------|
| `ACME proxy endpoints manage TXT records` | #5 | POST `/dns/present` stores a TXT record; POST `/dns/cleanup` removes it; both require auth; TXT record is served by DNS |

**Test implementation:**
```typescript
test("ACME proxy endpoints manage TXT records", async () => {
	const status = await sbStatus();
	const baseDomain = status.base_domain as string;
	const fqdn = `_acme-challenge.vm.${baseDomain}.`;
	const value = "test-challenge-value-" + Date.now();

	// Get ACME proxy password from the remote server config
	// (tests run against a real deployment, so we read it from the server)
	const password = await $`gcloud compute ssh ${process.env.GCE_VM_NAME || ""} --zone=${process.env.GCLOUD_ZONE || "us-central1-a"} --project=${process.env.GCLOUD_PROJECT || ""} --command="sudo grep ACME_PROXY_PASSWORD /etc/scaleboxd/config | cut -d= -f2-" --quiet`.text();
	const authHeader = "Basic " + btoa("caddy:" + password.trim());

	// Present: store TXT record
	const presentRes = await fetch(`${API_BASE_URL}/dns/present`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: authHeader },
		body: JSON.stringify({ fqdn, value }),
	});
	expect(presentRes.status).toBe(200);
	const presentBody = await presentRes.json();
	expect(presentBody.fqdn).toBe(fqdn);
	expect(presentBody.value).toBe(value);

	// Verify DNS serves the TXT record
	const digResult = await $`dig @${VM_HOST} _acme-challenge.vm.${baseDomain} TXT +short`.text();
	expect(digResult.trim()).toContain(value);

	// Cleanup: remove TXT record
	const cleanupRes = await fetch(`${API_BASE_URL}/dns/cleanup`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: authHeader },
		body: JSON.stringify({ fqdn, value }),
	});
	expect(cleanupRes.status).toBe(200);

	// Verify DNS no longer serves the TXT record
	const digAfter = await $`dig @${VM_HOST} _acme-challenge.vm.${baseDomain} TXT +short`.text();
	expect(digAfter.trim()).not.toContain(value);
}, { timeout: 15000 });
```

**Note on test complexity:** This test requires the ACME proxy password from the server config. In CI (`./do check`), the test runner has `gcloud` access. For this to work, the `./do check` script needs to pass `GCE_VM_NAME` and `GCLOUD_PROJECT` as environment variables to the test runner. See Phase 8 for the `./do` script changes.

**Alternative simpler approach:** If passing GCE credentials is too complex, skip the auth test and test only the DNS TXT record lookup (testing the endpoint indirectly through Caddy's successful cert issuance in the end-to-end flow). In that case, mark this test as `test.skip` with a comment explaining it's verified end-to-end.

**Decision: Use the simpler approach.** Mark this specific test as `test.skip` with a comment, and verify ACME proxy functionality through the end-to-end HTTPS test (criterion #6 — if HTTPS works, the ACME proxy worked). This avoids leaking infrastructure credentials to the test runner.

Revised test:
```typescript
test.skip("ACME proxy endpoints manage TXT records", async () => {
	// Verified end-to-end: if HTTPS works (criterion #6), the ACME proxy worked.
	// Direct testing would require the ACME proxy password from the server config.
});
```

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/index.ts` | Modify | Add `/dns/present` and `/dns/cleanup` POST endpoints before the `bearerAuth` middleware |

### Endpoint specification:

Add after the existing imports and before the `bearerAuth` middleware (after removing `/caddy/check`, roughly where it was):

```typescript
import { setAcmeTxtRecord, deleteAcmeTxtRecord } from "./services/dns";

// ACME proxy endpoints for Caddy DNS-01 challenge (basic auth, not bearer)
app.post("/dns/present", async (c) => {
	// Validate basic auth
	const authHeader = c.req.header("Authorization");
	if (!config.acmeProxyPassword || !authHeader) {
		return c.body(null, 401);
	}
	const expected = "Basic " + btoa("caddy:" + config.acmeProxyPassword);
	if (authHeader !== expected) {
		return c.body(null, 401);
	}

	const body = await c.req.json<{ fqdn: string; value: string }>();
	if (!body.fqdn || !body.value) {
		return c.json({ error: "fqdn and value required" }, 400);
	}

	setAcmeTxtRecord(body.fqdn, body.value);
	console.log(`DNS: Set TXT record for ${body.fqdn}`);
	return c.json({ fqdn: body.fqdn, value: body.value });
});

app.post("/dns/cleanup", async (c) => {
	const authHeader = c.req.header("Authorization");
	if (!config.acmeProxyPassword || !authHeader) {
		return c.body(null, 401);
	}
	const expected = "Basic " + btoa("caddy:" + config.acmeProxyPassword);
	if (authHeader !== expected) {
		return c.body(null, 401);
	}

	const body = await c.req.json<{ fqdn: string; value: string }>();
	if (!body.fqdn || !body.value) {
		return c.json({ error: "fqdn and value required" }, 400);
	}

	deleteAcmeTxtRecord(body.fqdn);
	console.log(`DNS: Cleared TXT record for ${body.fqdn}`);
	return c.json({ fqdn: body.fqdn, value: body.value });
});
```

### Verification

- ACME proxy test is skipped (verified end-to-end)
- Run `./do lint` — passes
- Run existing tests — all pass

---

## Phase 5: Caddy Configuration — DNS-01 Wildcard Cert

### Goal

Switch Caddy from on-demand TLS (HTTP-01) to DNS-01 wildcard certificate via the `acmeproxy` module. Update both the static Caddyfile (generated by `install.sh`) and the dynamic `vms.caddy` (generated by `caddy.ts`).

### Acceptance Test

Criterion #6 (API accessible via HTTPS) is tested by existing tests — the health check and all API calls already run over HTTPS in CI. No new test code needed; the end-to-end flow validates it.

### Changes

| File | Action | Details |
|------|--------|---------|
| `src/services/caddy.ts` | Modify | Rewrite to generate new Caddyfile format with DNS-01 TLS |

### New `src/services/caddy.ts`:

The file is completely rewritten. The key changes:
1. `updateCaddyConfig()` now generates BOTH the main Caddyfile and vms.caddy
2. The main Caddyfile uses `dns acmeproxy` for TLS instead of `on_demand`
3. The wildcard site block `*.vm.{baseDomain}` contains DNS-01 TLS and imports vms.caddy
4. A separate `api.{baseDomain}` block handles the API reverse proxy

```typescript
import { exec as execCallback } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { config } from "../config";
import { vms } from "./vm";

const exec = promisify(execCallback);

const CADDYFILE = "/etc/caddy/Caddyfile";
const CADDYFILE_TMP = "/etc/caddy/Caddyfile.tmp";
const VMSFILE = "/etc/caddy/vms.caddy";
const VMSFILE_TMP = "/etc/caddy/vms.caddy.tmp";

export async function updateCaddyConfig(): Promise<void> {
	if (!config.baseDomain) {
		return;
	}

	const caddyfileContent = buildCaddyfileContent();
	const vmsContent = buildVmsCaddyContent();

	// Read current content for potential rollback
	let previousCaddyfile: string | null = null;
	let previousVmsFile: string | null = null;
	try {
		previousCaddyfile = await readFile(CADDYFILE, "utf-8");
		previousVmsFile = await readFile(VMSFILE, "utf-8");
	} catch {
		// Files don't exist yet
	}

	// Atomic write both files
	try {
		await writeFile(CADDYFILE_TMP, caddyfileContent);
		await rename(CADDYFILE_TMP, CADDYFILE);
		await writeFile(VMSFILE_TMP, vmsContent);
		await rename(VMSFILE_TMP, VMSFILE);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			console.log(
				"Skipping Caddy config update: /etc/caddy/ directory does not exist (Caddy may not be installed yet)",
			);
			return;
		}
		throw error;
	}

	// Reload Caddy
	try {
		await exec("systemctl reload caddy");
	} catch (error) {
		// Rollback on failure
		if (previousCaddyfile !== null) {
			await writeFile(CADDYFILE, previousCaddyfile);
		}
		if (previousVmsFile !== null) {
			await writeFile(VMSFILE, previousVmsFile);
		}
		console.error("Caddy reload failed, rolled back config:", error);
	}
}

function buildCaddyfileContent(): string {
	const apiDomain = `api.${config.baseDomain}`;
	const vmWildcard = `*.vm.${config.baseDomain}`;
	const acmeEndpoint = `http://localhost:${config.apiPort}/dns`;

	let globalBlock: string;
	if (config.acmeStaging) {
		globalBlock = `{
	acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
}`;
	} else {
		globalBlock = `{}`;
	}

	return `# Managed by scaleboxd - do not edit manually
${globalBlock}

${apiDomain} {
	tls {
		dns acmeproxy {
			endpoint ${acmeEndpoint}
			username caddy
			password ${config.acmeProxyPassword}
		}
	}
	reverse_proxy localhost:${config.apiPort}
}

${vmWildcard} {
	tls {
		dns acmeproxy {
			endpoint ${acmeEndpoint}
			username caddy
			password ${config.acmeProxyPassword}
		}
	}

	import /etc/caddy/vms.caddy

	handle {
		respond "VM not found" 404
	}
}
`;
}

function buildVmsCaddyContent(): string {
	if (!config.baseDomain) {
		return `# Managed by scaleboxd - do not edit manually
# VM routes are added here when BASE_DOMAIN is configured
`;
	}

	const vmRoutes = Array.from(vms.values())
		.map((vm) => {
			return `@${vm.name} host ${vm.name}.vm.${config.baseDomain}
handle @${vm.name} {
	reverse_proxy ${vm.ip}:8080
}`;
		})
		.join("\n\n");

	return `# Managed by scaleboxd - do not edit manually
${vmRoutes}
`;
}
```

Note: `vms.caddy` now contains only the inner matcher/handler blocks (no wrapping site block), since they're imported inside the `*.vm.{baseDomain}` block in the main Caddyfile.

### Verification

- Caddy config generates correctly with DNS-01 TLS
- Run `./do lint` — passes

---

## Phase 6: Install Script — Custom Caddy & New Config

### Goal

Update `install.sh` to download a custom Caddy binary with the `acmeproxy` module, generate the new `BASE_DOMAIN` config, and generate an ACME proxy password.

### Changes

| File | Action | Details |
|------|--------|---------|
| `scripts/install.sh` | Modify | See detailed changes below |

### Detailed changes to `scripts/install.sh`:

**1. Config variables (lines 17–19):**
Replace:
```bash
API_DOMAIN="${API_DOMAIN:-}"
VM_DOMAIN="${VM_DOMAIN:-}"
```
With:
```bash
BASE_DOMAIN="${BASE_DOMAIN:-}"
ACME_PROXY_PASSWORD="${ACME_PROXY_PASSWORD:-}"
```

Note: After Plan 025, line 19 also has `HOST_IP="${HOST_IP:-}"`. Keep that line — it sits after the new `ACME_PROXY_PASSWORD` line. The full block becomes: `BASE_DOMAIN`, `ACME_PROXY_PASSWORD`, `HOST_IP`.

**2. `install_caddy()` function (lines 260–315):**
Replace the entire function with:
```bash
install_caddy() {
  [[ -n "$BASE_DOMAIN" ]] || return 0

  log "Installing Caddy with acmeproxy module..."

  # Download custom Caddy binary with acmeproxy DNS module
  local caddy_url="https://caddyserver.com/api/download?os=linux&arch=$(dpkg --print-architecture)&p=github.com/caddy-dns/acmeproxy"
  curl -sSL "$caddy_url" -o /usr/bin/caddy
  chmod +x /usr/bin/caddy

  # Create caddy user/group if needed (normally done by apt package)
  if ! id caddy &>/dev/null; then
    groupadd --system caddy 2>/dev/null || true
    useradd --system --gid caddy --create-home --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy 2>/dev/null || true
  fi

  # Create config directory
  mkdir -p /etc/caddy

  # Install systemd unit for Caddy (if not already present)
  if [[ ! -f /etc/systemd/system/caddy.service ]]; then
    cat > /etc/systemd/system/caddy.service <<'CADDYSERVICEEOF'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=root
Group=root
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
CADDYSERVICEEOF
    systemctl daemon-reload
  fi

  # Write minimal placeholder Caddyfile (scaleboxd generates the real one on startup)
  cat > /etc/caddy/Caddyfile <<'CADDYEOF'
# Placeholder - scaleboxd generates the real config on startup
{
}
CADDYEOF

  # Create vms.caddy stub
  cat > /etc/caddy/vms.caddy <<'VMSCADDYEOF'
# Managed by scaleboxd - do not edit manually
VMSCADDYEOF

  systemctl enable caddy
  systemctl restart caddy
}
```

Note: Caddy runs as `root` (not the `caddy` user) because it needs to bind to port 443 and the custom service file is simpler. The placeholder Caddyfile is minimal — `scaleboxd` generates the full config on startup.

**3. `wait_for_https()` function (lines 317–369):**
Replace:
```bash
  [[ -n "$API_DOMAIN" ]] || return 0
```
With:
```bash
  [[ -n "$BASE_DOMAIN" ]] || return 0
```

Replace all references to `$API_DOMAIN` with `api.$BASE_DOMAIN`:
- Line 329: `curl $curl_opts "https://api.$BASE_DOMAIN/health"`
- Line 346: `host "api.$BASE_DOMAIN"`
- Line 349: `curl -v "https://api.$BASE_DOMAIN/health"`
- Line 366: `die "Failed to obtain TLS certificate for api.$BASE_DOMAIN"`

**4. `install_service()` config file (lines 442–450):**

After Plan 025, the heredoc contains `API_DOMAIN`, `VM_DOMAIN`, `ACME_STAGING`, and `HOST_IP` lines. Replace ALL FOUR domain/IP related lines with the new layout. The full heredoc body becomes:

```bash
    cat > /etc/scaleboxd/config <<EOF
API_PORT=$API_PORT
API_TOKEN=$API_TOKEN
DATA_DIR=$DATA_DIR
KERNEL_PATH=$DATA_DIR/kernel/vmlinux
BASE_DOMAIN=$BASE_DOMAIN
HOST_IP=$HOST_IP
ACME_PROXY_PASSWORD=$ACME_PROXY_PASSWORD
ACME_STAGING=$ACME_STAGING
EOF
```

**IMPORTANT:** Plan 025 adds `HOST_IP=$HOST_IP` after the `ACME_STAGING` line. Plan 026 must replace the ENTIRE heredoc body (not just the API_DOMAIN/VM_DOMAIN lines) to avoid a duplicate `HOST_IP` entry. The heredoc above is the complete, final content.

Add before the config file write (after the API_TOKEN generation block):
```bash
  # Generate ACME proxy password if not set
  if [[ -z "$ACME_PROXY_PASSWORD" && -f /etc/scaleboxd/config ]]; then
    ACME_PROXY_PASSWORD=$(grep -E "^ACME_PROXY_PASSWORD=" /etc/scaleboxd/config 2>/dev/null | cut -d= -f2- || true)
  fi
  [[ -z "$ACME_PROXY_PASSWORD" ]] && ACME_PROXY_PASSWORD="$(openssl rand -hex 32)"
```

**5. Function call order in `main()` (lines 515–520):**

**CRITICAL**: Move `install_caddy` before `start_service`. Since scaleboxd now generates the full Caddyfile on startup, `/etc/caddy/` must exist before scaleboxd starts. Change:
```bash
  install_binary
  install_scripts
  install_service
  install_caddy     # ← moved BEFORE start_service
  start_service
  wait_for_https
```

The old order was `install_service → start_service → install_caddy`. The new order is `install_service → install_caddy → start_service`, so that when scaleboxd starts, it can write the Caddyfile to `/etc/caddy/Caddyfile` and reload Caddy.

**6. Final output (lines 522–534):**
Replace the domain output block with:
```bash
  if [[ -n "$BASE_DOMAIN" ]]; then
    echo "  API: https://api.$BASE_DOMAIN"
    echo "  VM URLs: https://{vm-name}.vm.$BASE_DOMAIN"
  else
    echo "  API: http://$(hostname -I | awk '{print $1}'):$API_PORT"
  fi
```

### Verification

- `install.sh` uses `BASE_DOMAIN` throughout
- Custom Caddy binary is downloaded with acmeproxy module
- ACME proxy password is generated and persisted
- Placeholder Caddyfile is written (scaleboxd generates the real one)

---

## Phase 7: Bootstrap Script — Single Domain Prompt

### Goal

Replace the two separate domain prompts in `bootstrap.sh` with a single `BASE_DOMAIN` prompt.

### Changes

| File | Action | Details |
|------|--------|---------|
| `scripts/bootstrap.sh` | Modify | Replace API_DOMAIN + VM_DOMAIN prompts with single BASE_DOMAIN prompt |

### Detailed changes to `scripts/bootstrap.sh`:

**1. Header comment (lines 8–9):**
Replace:
```bash
#   curl -sSL ... | sudo API_DOMAIN=api.example.com VM_DOMAIN=vms.example.com bash
```
With:
```bash
#   curl -sSL ... | sudo BASE_DOMAIN=scalebox.example.com bash
```

**2. `configure()` function (lines 75–105):**
Replace the entire function body with:
```bash
configure() {
  echo ""
  echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║              Scalebox Interactive Setup                   ║${NC}"
  echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
  echo ""

  if [[ -z "${BASE_DOMAIN:-}" ]]; then
    echo "Scalebox needs a base domain for HTTPS access."
    echo "This domain should have an NS record pointing to this server."
    echo ""
    echo "The API will be at:  api.{base-domain}"
    echo "VMs will be at:      {vm-name}.vm.{base-domain}"
    echo ""
    echo "Example: scalebox.example.com"
    echo ""
    BASE_DOMAIN=$(prompt "Enter base domain (or press Enter to skip HTTPS)")
  fi

  # HOST_IP - external IP for API responses (from Plan 025)
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

  echo ""
}
```

**3. Exports (lines 147–148):**
Replace:
```bash
  export API_DOMAIN="${API_DOMAIN:-}"
  export VM_DOMAIN="${VM_DOMAIN:-}"
```
With:
```bash
  export BASE_DOMAIN="${BASE_DOMAIN:-}"
  export HOST_IP="${HOST_IP:-}"
  # Backward compatibility: old install.sh scripts use API_DOMAIN and VM_DOMAIN.
  # When check-update bootstraps with the old release tarball, the old install.sh
  # reads these vars. Derive them from BASE_DOMAIN for backward compat.
  export API_DOMAIN="${BASE_DOMAIN:+api.$BASE_DOMAIN}"
  export VM_DOMAIN="${BASE_DOMAIN:+vm.$BASE_DOMAIN}"
```

**4. Interactive check (line 168):**
Replace:
```bash
  if [[ -z "${API_DOMAIN:-}" && -z "${SCALEBOX_NONINTERACTIVE:-}" ]]; then
```
With:
```bash
  if [[ ( -z "${BASE_DOMAIN:-}" || -z "${HOST_IP:-}" ) && -z "${SCALEBOX_NONINTERACTIVE:-}" ]]; then
```

### Verification

- Bootstrap prompts for single BASE_DOMAIN
- Export passes BASE_DOMAIN to install.sh

---

## Phase 8: `./do` Script — DNS, Firewall, and Test Updates

### Goal

Update the `./do` script for the new DNS architecture: create NS delegation records for testing, open port 53 in firewall, and update the expect script for the single domain prompt.

### Changes

| File | Action | Details |
|------|--------|---------|
| `./do` | Modify | See detailed changes below |

### Detailed changes to `./do`:

**1. `create_dns_record()` (lines 214–236):**

The function currently creates a single A record. With the new architecture, the Scalebox host runs its own DNS server. We need to create an NS record delegating `{VM_FQDN}` to the Scalebox host, plus a glue A record so the NS can resolve.

Replace the entire function:
```bash
create_dns_record() {
  VM_FQDN="${VM_NAME}.${DNS_SUFFIX}"
  echo "==> Creating DNS records: ${VM_FQDN} -> ${VM_IP}"

  # Create A record for the host itself (needed as NS target)
  gcloud dns record-sets create "${VM_FQDN}." \
    --zone="$DNS_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --type=A \
    --ttl=60 \
    --rrdatas="$VM_IP"

  # Create NS record delegating the base domain to the host
  # This makes the Scalebox DNS server authoritative for *.{VM_FQDN}
  gcloud dns record-sets create "${VM_FQDN}." \
    --zone="$DNS_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --type=NS \
    --ttl=60 \
    --rrdatas="${VM_FQDN}." 2>/dev/null || true
  # NS creation may fail if A record-set already exists with same name;
  # gcloud DNS doesn't support mixed record types on the same name.
  # In that case, the A record is sufficient for testing (Caddy can still
  # obtain certs since the DNS server on the host handles challenges).

  echo "==> Waiting for DNS propagation..."
  local retries=30
  while [[ $retries -gt 0 ]]; do
    if host "$VM_FQDN" 2>/dev/null | grep -q "$VM_IP"; then
      echo "==> DNS propagated"
      return 0
    fi
    sleep 2
    ((retries--)) || true
  done
  die "DNS propagation timeout for $VM_FQDN"
}
```

**Important note on Google Cloud DNS limitation:** Google Cloud DNS does not allow both an A record and an NS record with the same name. Since we need the A record for the host itself (so the NS can resolve), and the NS record to delegate subdomains to our DNS server, we have a conflict.

**Workaround for Google Cloud DNS:** Create A + wildcard A records for general resolution, plus NS records that delegate only the `_acme-challenge` subdomains to the Scalebox DNS server. This solves the DNS-01 challenge validation problem:

- `_acme-challenge.api.{VM_FQDN}` NS → `{VM_FQDN}.` — delegates API cert challenge to Scalebox DNS
- `_acme-challenge.vm.{VM_FQDN}` NS → `{VM_FQDN}.` — delegates wildcard cert challenge to Scalebox DNS

These NS records don't conflict with the A/wildcard A records since they have different names. When Let's Encrypt queries `_acme-challenge.vm.{VM_FQDN}` TXT, the resolver follows the NS delegation to the Scalebox host, which serves the challenge TXT record from its in-memory store.

Revised `create_dns_record()`:
```bash
create_dns_record() {
  VM_FQDN="${VM_NAME}.${DNS_SUFFIX}"
  echo "==> Creating DNS records: ${VM_FQDN} -> ${VM_IP}"

  # Create A record for the host (used as BASE_DOMAIN by bootstrap)
  gcloud dns record-sets create "${VM_FQDN}." \
    --zone="$DNS_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --type=A \
    --ttl=60 \
    --rrdatas="$VM_IP"

  # Create wildcard A record for subdomains (api.X, *.vm.X, etc.)
  gcloud dns record-sets create "*.${VM_FQDN}." \
    --zone="$DNS_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --type=A \
    --ttl=60 \
    --rrdatas="$VM_IP"

  # Delegate ACME challenge subdomains to the Scalebox DNS server.
  # This enables DNS-01 challenge validation: Let's Encrypt queries
  # _acme-challenge.{X}.{VM_FQDN} → NS delegation → Scalebox DNS → TXT record.
  gcloud dns record-sets create "_acme-challenge.api.${VM_FQDN}." \
    --zone="$DNS_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --type=NS \
    --ttl=60 \
    --rrdatas="${VM_FQDN}."

  gcloud dns record-sets create "_acme-challenge.vm.${VM_FQDN}." \
    --zone="$DNS_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --type=NS \
    --ttl=60 \
    --rrdatas="${VM_FQDN}."

  echo "==> Waiting for DNS propagation..."
  local retries=30
  while [[ $retries -gt 0 ]]; do
    if host "$VM_FQDN" 2>/dev/null | grep -q "$VM_IP"; then
      echo "==> DNS propagated"
      return 0
    fi
    sleep 2
    ((retries--)) || true
  done
  die "DNS propagation timeout for $VM_FQDN"
}
```

**2. `delete_dns_record()` (lines 238–247):**

Update to delete all four records:
```bash
delete_dns_record() {
  if [[ -n "$VM_NAME" && -n "$DNS_SUFFIX" ]]; then
    echo "==> Deleting DNS records: ${VM_NAME}.${DNS_SUFFIX}"
    gcloud dns record-sets delete "${VM_NAME}.${DNS_SUFFIX}." \
      --zone="$DNS_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --type=A \
      --quiet 2>/dev/null || true
    gcloud dns record-sets delete "*.${VM_NAME}.${DNS_SUFFIX}." \
      --zone="$DNS_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --type=A \
      --quiet 2>/dev/null || true
    gcloud dns record-sets delete "_acme-challenge.api.${VM_NAME}.${DNS_SUFFIX}." \
      --zone="$DNS_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --type=NS \
      --quiet 2>/dev/null || true
    gcloud dns record-sets delete "_acme-challenge.vm.${VM_NAME}.${DNS_SUFFIX}." \
      --zone="$DNS_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --type=NS \
      --quiet 2>/dev/null || true
  fi
}
```

**3. `provision_vm_bootstrap()` expect script (lines 153–183):**

Replace the expect script content. The script handles both the new single-prompt format AND the old two-prompt format (needed for `check-update` which bootstraps with old releases):
```expect
#!/usr/bin/expect -f
set timeout 900
log_user 1

spawn sudo bash -c "SCALEBOX_RELEASE_URL='$tarball_url' ACME_STAGING=true HOST_IP='$VM_IP' bash /tmp/bootstrap.sh"

expect {
    "Enter base domain (or press Enter to skip HTTPS)" {
        send "$VM_FQDN\r"
        exp_continue
    }
    "Enter host IP" {
        send "$VM_IP\r"
        exp_continue
    }
    "Enter API domain (or press Enter to skip HTTPS)" {
        send "api.$VM_FQDN\r"
        exp_continue
    }
    "Enter VM domain (optional, press Enter to skip)" {
        send "vm.$VM_FQDN\r"
        exp_continue
    }
    timeout {
        puts "ERROR: Timeout waiting for prompt"
        exit 1
    }
    eof
}

# Capture exit code from spawned process
catch wait result
set exit_code [lindex \$result 3]
if {\$exit_code != 0} {
    puts "ERROR: Bootstrap exited with code \$exit_code"
}
exit \$exit_code
```

**Note on backward compatibility:** For `check-update`, the local bootstrap.sh (new) is used, which has the single BASE_DOMAIN prompt. However, if an old bootstrap.sh is somehow used, the expect script matches both formats. For `check-update`, the old API_DOMAIN prompt gets `api.{VM_FQDN}` and VM_DOMAIN gets `vm.{VM_FQDN}`, which after migration yields BASE_DOMAIN=`{VM_FQDN}` (correct).

**4. `check_firewall_rule()` (lines 358–419):**

Add port 53 (UDP+TCP) to the required ports check. Add after the SSH proxy check:
```bash
  # Check for DNS server (53)
  if [[ "$rule_config" != *"53"* ]]; then
    missing_ports+=("tcp:53,udp:53 (DNS server)")
  fi
```

Update the firewall creation hint:
```bash
    echo "  gcloud compute firewall-rules create scalebox-test-allow \\"
    echo "    --project=$GCLOUD_PROJECT \\"
    echo "    --allow=tcp:443,tcp:8080,tcp:22001-32000,tcp:53,udp:53 \\"
    echo "    --target-tags=scalebox-test \\"
    echo "    --description='Allow traffic to Scalebox test VMs'"
```

And update the update hint:
```bash
    echo "  gcloud compute firewall-rules update scalebox-test-allow \\"
    echo "    --project=$GCLOUD_PROJECT \\"
    echo "    --allow=tcp:443,tcp:8080,tcp:22001-32000,tcp:53,udp:53"
```

**5. Test execution (line 497):**

The test line currently passes `VM_HOST` and `USE_HTTPS`. `VM_HOST` remains the raw FQDN (`$VM_FQDN`), which equals the `BASE_DOMAIN`. No change needed here — the helpers.ts change (Phase 2) constructs `API_BASE_URL` as `https://api.${VM_HOST}` when `USE_HTTPS=true`, which correctly points to the API at `api.{BASE_DOMAIN}`. The `VM_HOST` value is also used directly for `dig @${VM_HOST}` queries and SSH connections, where the raw FQDN is correct.

**6. Debug curl commands (lines 496, 597):**

Update debug output to use the new API URL pattern:
- Line 496: `echo "==> Running tests against https://api.$VM_FQDN..."` (was `https://$VM_FQDN`)
- Line 597 (in `do_check_update`): `curl -v https://api.$VM_FQDN/health` (was `https://$VM_FQDN/health`)

### Verification

- `./do check` creates A + wildcard A records
- Firewall check requires port 53
- Expect script sends single BASE_DOMAIN prompt
- Cleanup deletes both DNS records

---

## Phase 9: scalebox-update Migration

### Goal

Update the `scalebox-update` script to handle migration from old `API_DOMAIN`/`VM_DOMAIN` config to new `BASE_DOMAIN`, and to replace the apt-installed Caddy with the custom binary.

### Changes

| File | Action | Details |
|------|--------|---------|
| `scripts/scalebox-update` | Modify | Update `migrate_caddy_config()` and add config migration |

### Detailed changes to `scripts/scalebox-update`:

**1. Add a new `migrate_config_to_base_domain()` function** (before `migrate_caddy_config()`):

```bash
migrate_config_to_base_domain() {
  local config_file="/etc/scaleboxd/config"
  [[ -f "$config_file" ]] || return 0

  # Skip if already migrated
  if grep -q "^BASE_DOMAIN=" "$config_file" 2>/dev/null; then
    return 0
  fi

  log "Migrating config to BASE_DOMAIN..."

  local api_domain=""
  local vm_domain=""
  api_domain=$(grep -E "^API_DOMAIN=" "$config_file" | cut -d= -f2- || true)
  vm_domain=$(grep -E "^VM_DOMAIN=" "$config_file" | cut -d= -f2- || true)

  # Derive BASE_DOMAIN from existing domains.
  # Old config had API_DOMAIN (e.g., "api.scalebox.example.com") and
  # VM_DOMAIN (e.g., "vms.scalebox.example.com").
  # Strip known prefixes to recover the base domain.
  local base_domain=""
  if [[ -n "$api_domain" ]]; then
    # Strip "api." prefix if present
    if [[ "$api_domain" == api.* ]]; then
      base_domain="${api_domain#api.}"
    else
      # API_DOMAIN was used directly without api. prefix (e.g., in test env)
      base_domain="$api_domain"
    fi
  elif [[ -n "$vm_domain" ]]; then
    # Strip "vms." or "vm." prefix if present
    if [[ "$vm_domain" == vms.* ]]; then
      base_domain="${vm_domain#vms.}"
    elif [[ "$vm_domain" == vm.* ]]; then
      base_domain="${vm_domain#vm.}"
    else
      base_domain="$vm_domain"
    fi
  fi

  # Generate ACME proxy password
  local acme_proxy_password
  acme_proxy_password="$(openssl rand -hex 32)"

  # Remove old keys and add new ones (preserves all other config like ACME_STAGING)
  sed -i '/^API_DOMAIN=/d' "$config_file"
  sed -i '/^VM_DOMAIN=/d' "$config_file"
  echo "BASE_DOMAIN=$base_domain" >> "$config_file"
  echo "ACME_PROXY_PASSWORD=$acme_proxy_password" >> "$config_file"

  log "Migrated to BASE_DOMAIN=$base_domain"
  if [[ -n "$base_domain" ]]; then
    log "  API URL: https://api.$base_domain"
    log "  VM URLs: https://{name}.vm.$base_domain"
    echo ""
    log "IMPORTANT: Update your DNS records!"
    log "  Replace A/wildcard A records with an NS record:"
    log "  $base_domain. NS <this-server-ip>"
  fi
}
```

**2. Add a `migrate_caddy_binary()` function:**

```bash
migrate_caddy_binary() {
  # Check if current Caddy has acmeproxy module
  if /usr/bin/caddy list-modules 2>/dev/null | grep -q "dns.providers.acmeproxy"; then
    return 0
  fi

  log "Upgrading Caddy to custom build with acmeproxy module..."

  local caddy_url="https://caddyserver.com/api/download?os=linux&arch=$(dpkg --print-architecture)&p=github.com/caddy-dns/acmeproxy"
  curl -sSL "$caddy_url" -o /usr/bin/caddy.new
  chmod +x /usr/bin/caddy.new
  mv /usr/bin/caddy.new /usr/bin/caddy

  # If Caddy was installed via apt, remove the apt package metadata
  # (keep the binary we just downloaded)
  if dpkg -l caddy &>/dev/null; then
    dpkg --remove --force-remove-reinstreq caddy 2>/dev/null || true
  fi

  log "Caddy upgraded successfully"
}
```

**3. Update `migrate_caddy_config()`:**

Replace the entire function — the old migration (split Caddyfile) is superseded by the new architecture where `scaleboxd` generates the full Caddyfile on startup:

```bash
migrate_caddy_config() {
  local caddyfile="/etc/caddy/Caddyfile"
  [[ -f "$caddyfile" ]] || return 0

  # Write minimal placeholder Caddyfile (scaleboxd generates the real one)
  cat > "$caddyfile" << 'EOF'
# Placeholder - scaleboxd generates the real config on startup
{
}
EOF

  cat > /etc/caddy/vms.caddy << 'EOF'
# Managed by scaleboxd - do not edit manually
EOF

  # Install Caddy systemd service for root (replacing apt's version)
  cat > /etc/systemd/system/caddy.service <<'CADDYSERVICEEOF'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=root
Group=root
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
CADDYSERVICEEOF

  systemctl daemon-reload
  systemctl enable caddy

  log "Caddy config migrated to scaleboxd-managed format"
}
```

**4. Call the new migration functions in `main()`:**

In the `main()` function, replace the existing migration sequence. After Plan 025, the sequence is `migrate_caddy_config`, `migrate_host_ip`, `start_service`. Replace with:
```bash
  migrate_config_to_base_domain
  migrate_host_ip
  migrate_caddy_binary
  migrate_caddy_config
  start_service
```

Order matters: `migrate_config_to_base_domain` runs first (converts API_DOMAIN/VM_DOMAIN → BASE_DOMAIN), then `migrate_host_ip` (from Plan 025, adds HOST_IP if missing), then `migrate_caddy_binary` (replaces Caddy binary), then `migrate_caddy_config` (writes placeholder Caddyfile), then `start_service` (scaleboxd generates real Caddyfile on startup).

### Verification

- `scalebox-update` migrates old config to `BASE_DOMAIN`
- Custom Caddy binary is installed if needed
- Caddyfile is replaced with placeholder

---

## Phase 10: DDD — Update Glossary and Access Context

### Goal

Update domain documentation to reflect the new DNS-based architecture.

### Changes

| File | Action | Details |
|------|--------|---------|
| `product/DDD/glossary.md` | Modify | Replace API Domain/VM Domain/On-Demand TLS entries with new terms |
| `product/DDD/contexts/access.md` | Modify | Update HTTPS Gateway sub-context for DNS-01 architecture |
| `product/DDD/context-map.md` | Modify | Add DNS Server to Access sub-contexts, add `src/services/dns.ts` to file mapping |

### Context map changes:

In the ASCII diagram (line 58), update the Access sub-contexts list:
```
│ Sub-contexts:   │
│ - TCP Proxy     │
│ - UDP Proxy     │
│ - HTTPS Gateway │
│ - DNS Server    │
```

In the File to Context Mapping table, add:
```
| `src/services/dns.ts` | [Access](contexts/access.md) (DNS Server) |
```

In the Deployment Topology server-side table, change Caddy row:
```
| Caddy | `/usr/bin/caddy` (custom binary) | HTTPS reverse proxy with acmeproxy module |
```

### Glossary changes:

**Remove** (all in the "Access Terms" section):
- "API Domain (API_DOMAIN)" entry (line 66)
- "VM Domain (VM_DOMAIN)" entry (line 69)
- "On-Demand TLS" entry (line 76)

**Add** the following entries to the "Access Terms" section, replacing the removed entries. Place "Base Domain" where "API Domain" was, and the others after it:

```markdown
### Base Domain (BASE_DOMAIN)
The configured base domain for all Scalebox HTTPS access (e.g., `scalebox.example.com`). When set:
- API is accessible at `https://api.{base-domain}`
- VMs are accessible at `https://{vm-name}.vm.{base-domain}`
Requires an NS record delegating `{base-domain}` to the Scalebox host.

### DNS Server
In-process authoritative DNS server (port 53) that handles the `{BASE_DOMAIN}` zone. Responds to A queries for all subdomains with the host IP, and serves TXT records for ACME DNS-01 challenges. Uses the `dns2` npm package.

**Note:** Place this entry in the "Infrastructure Terms" section (after "Firecracker" and "Kernel" entries, before "Socket Path").

### Wildcard Certificate
A single TLS certificate covering `*.vm.{BASE_DOMAIN}`, obtained via DNS-01 challenge. Replaces per-VM certificate issuance (on-demand TLS), eliminating Let's Encrypt rate limiting.

### DNS-01 Challenge
ACME certificate validation method where the CA verifies domain ownership by checking a TXT DNS record (`_acme-challenge.{domain}`). Used for wildcard certificates. Caddy communicates with the Scalebox DNS server via the `acmeproxy` module.

### ACME Proxy
Internal HTTP endpoints (`/dns/present` and `/dns/cleanup`) that Caddy calls to set and clear TXT records for DNS-01 challenges. Protected by Basic Auth with a generated password.
```

### Access context changes:

Update the HTTPS Gateway sub-context in `access.md`:

1. **Replace the TLS flow description**: Change from "Caddy uses on-demand TLS with HTTP-01 challenge, validated by `/caddy/check` endpoint" to "Caddy uses DNS-01 challenge via `caddy-dns/acmeproxy` module. A single wildcard certificate `*.vm.{BASE_DOMAIN}` covers all VMs. The `api.{BASE_DOMAIN}` cert is also obtained via DNS-01."

2. **Add DNS Server sub-context section**: Describe the in-process authoritative DNS server on port 53 that handles the `{BASE_DOMAIN}` zone. It resolves all subdomains to the host IP (A records) and serves ACME challenge TXT records from an in-memory store. Uses `dns2` npm package.

3. **Update the ACME flow**: Remove mention of `/caddy/check`. Document the new flow: Caddy → POST `/dns/present` → in-memory TXT record → DNS server serves TXT → Let's Encrypt validates → cert issued → Caddy → POST `/dns/cleanup`.

4. **Update domain structure**: Replace references to `API_DOMAIN`/`VM_DOMAIN` with `BASE_DOMAIN`, document `api.{BASE_DOMAIN}` and `{name}.vm.{BASE_DOMAIN}` structure.

5. **Update Caddy config management**: Note that `scaleboxd` generates the FULL Caddyfile (not just `vms.caddy`), and Caddy uses a custom binary with the `acmeproxy` module.

### Verification

- Documentation accurately describes the new architecture
- No references to removed concepts (on-demand TLS, API_DOMAIN, VM_DOMAIN)

---

## Phase 11: ADR — DNS-01 Wildcard Certificates

### Goal

Record the architectural decision to switch from HTTP-01 per-VM certificates to DNS-01 wildcard certificates with an in-process DNS server.

### Changes

| File | Action | Details |
|------|--------|---------|
| `product/ADR/016-dns-wildcard-certificates.md` | Create | ADR documenting this decision |
| `product/ADR/009-caddy-https-gateway.md` | Modify | Add "Partially superseded by ADR 016" to Status section |

### ADR 009 Update:

Change the Status section of `product/ADR/009-caddy-https-gateway.md` from `Accepted` to `Accepted. Partially superseded by [ADR 016](016-dns-wildcard-certificates.md) — TLS mechanism changed from HTTP-01 on-demand to DNS-01 wildcard, but Caddy is still used as the HTTPS reverse proxy.`

### ADR 016 Content:

```markdown
# ADR 016: DNS-01 Wildcard Certificates with In-Process DNS Server

## Status
Accepted

## Context
Caddy's on-demand TLS (HTTP-01 challenge) obtained a separate certificate for each VM subdomain. Let's Encrypt rate limits (50 certificates per week per registered domain) caused failures when creating many VMs. Additionally, users needed to configure two separate domains (API_DOMAIN and VM_DOMAIN) with separate DNS records.

## Decision
Replace per-VM HTTP-01 certificate issuance with a single wildcard certificate obtained via DNS-01 challenge. Add an in-process authoritative DNS server to handle domain resolution and ACME challenges.

Key choices:
- **In-process DNS server** using `dns2` (npm package): Runs inside the Scalebox Bun process, sharing memory for ACME challenge TXT records. No additional service to manage.
- **`caddy-dns/acmeproxy` module**: Caddy sends HTTP POST requests to internal endpoints to set/clear TXT records for DNS-01 challenges. Available on the Caddy download server.
- **Single `BASE_DOMAIN` config**: Replaces separate `API_DOMAIN` and `VM_DOMAIN`. API at `api.{BASE_DOMAIN}`, VMs at `{name}.vm.{BASE_DOMAIN}`.
- **NS record delegation**: Users create one NS record instead of wildcard A records.

## Consequences

### Positive
- Eliminates Let's Encrypt rate limiting (one wildcard cert covers all VMs)
- Simpler user DNS setup (one NS record vs. multiple A records)
- Simpler config (one domain instead of two)
- Full control over DNS resolution

### Negative
- Custom Caddy binary required (downloaded from Caddy API, not apt)
- DNS server adds complexity to the Scalebox process
- Port 53 must be available and accessible from the internet
- Breaking change: existing installations must migrate config
- NS delegation is slightly more complex than A records for some DNS providers

### Supersedes
- ADR 009: Caddy HTTPS Gateway (partially — Caddy is still used, but TLS mechanism changes)
```

### Verification

- ADR is complete with context, decision, and consequences

---

## Phase 12: `./do` Script — Update Firewall Rule

### Goal

Before running `./do check` for the first time after this change, the firewall rule must be updated to include port 53.

### Changes

| File | Action | Details |
|------|--------|---------|
| (Manual) | Action | Run: `gcloud compute firewall-rules update scalebox-test-allow --project=$GCLOUD_PROJECT --allow=tcp:443,tcp:8080,tcp:22001-32000,tcp:53,udp:53` |

This is a one-time manual step, not a code change. The `./do check` script will catch if the rule is missing port 53 (from Phase 8 changes).

### Verification

- `./do check` firewall check passes with port 53 included

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/config.ts` | Modify | Replace `apiDomain`/`vmDomain` with `baseDomain`, add `acmeProxyPassword` |
| `src/index.ts` | Modify | Update `/info`, remove `/caddy/check`, add ACME proxy endpoints, start DNS server |
| `src/services/dns.ts` | Create | In-process authoritative DNS server using `dns2` |
| `src/services/caddy.ts` | Modify | Generate full Caddyfile with DNS-01 TLS via `acmeproxy` |
| `src/services/vm.ts` | Modify | Update VM URL format to `vm.{baseDomain}` |
| `test/helpers.ts` | Modify | Update `API_BASE_URL` to use `api.` prefix for HTTPS |
| `src/types.ts` | No change | No structural changes needed |
| `package.json` | Modify | Add `dns2` dependency |
| `test/integration.test.ts` | Modify | Add DNS resolution tests |
| `scripts/install.sh` | Modify | Custom Caddy binary, `BASE_DOMAIN` config, ACME proxy password |
| `scripts/bootstrap.sh` | Modify | Single `BASE_DOMAIN` prompt |
| `scripts/scalebox-update` | Modify | Migration from old config, custom Caddy binary upgrade |
| `scripts/sb` | Modify | Update status display for `base_domain` |
| `./do` | Modify | Wildcard DNS records, port 53 firewall, expect script update |
| `product/DDD/glossary.md` | Modify | New terms: Base Domain, DNS Server, Wildcard Certificate, DNS-01 Challenge, ACME Proxy |
| `product/DDD/contexts/access.md` | Modify | Update HTTPS Gateway for DNS-01 architecture |
| `product/DDD/context-map.md` | Modify | Add DNS Server to Access sub-contexts, file mapping |
| `product/ADR/016-dns-wildcard-certificates.md` | Create | Decision record |
| `product/ADR/009-caddy-https-gateway.md` | Modify | Mark as partially superseded |

---

## End-to-End Verification

After all phases are complete:

1. All acceptance tests pass (DNS resolution tests green, one ACME proxy test skipped)
2. `./do check` passes — full CI pipeline
3. `./do check-update` passes — migration from old config works
4. Manual verification:
   a. Create a Scalebox server with `BASE_DOMAIN=scalebox.example.com`
   b. Verify `dig @host api.scalebox.example.com A` returns host IP
   c. Verify `dig @host test.vm.scalebox.example.com A` returns host IP
   d. Verify `https://api.scalebox.example.com/health` returns OK
   e. Create a VM, verify `https://{name}.vm.scalebox.example.com` is accessible
   f. Verify only one wildcard certificate exists (not per-VM certs)

---

## Update Considerations

How will this feature behave when updating from an older version?

- **Config changes**: `API_DOMAIN` and `VM_DOMAIN` replaced by `BASE_DOMAIN` + `ACME_PROXY_PASSWORD`. Migration script in `scalebox-update` handles conversion. Derives `BASE_DOMAIN` by stripping `api.` prefix from `API_DOMAIN` (e.g., `api.scalebox.example.com` → `scalebox.example.com`). If `API_DOMAIN` has no `api.` prefix, uses it directly. `ACME_STAGING` and all other config keys are preserved.
- **Storage changes**: None
- **Dependency changes**: `dns2` npm package added (compiled into binary, no runtime install needed). Custom Caddy binary replaces apt-installed Caddy (downloaded from Caddy API during update).
- **Migration needed**: Yes — `scalebox-update` migrates config file, replaces Caddy binary, and rewrites Caddyfile. The `scaleboxd` process generates the real Caddy config on startup.
- **Backwards compatibility**: Breaking change for API response (`/info` returns `base_domain` instead of `api_domain`/`vm_domain`). The `sb` CLI reads `api_domain` in the status command — updated in this plan. VM URLs change from `https://{name}.{VM_DOMAIN}` to `https://{name}.vm.{BASE_DOMAIN}`.
- **DNS setup change**: Users must switch from wildcard A record to NS record (or reconfigure with new subdomain structure). This requires manual user action during update.
- **Dead code**: After both Plan 025 and Plan 026, `getHostIp()` in `src/services/system.ts` is no longer called from anywhere. It can be removed in a future cleanup.
