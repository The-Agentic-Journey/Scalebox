import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { config } from "./config";
import { updateCaddyConfig } from "./services/caddy";
import { deleteAcmeTxtRecord, setAcmeTxtRecord, startDnsServer } from "./services/dns";
import { reconcileOrphans } from "./services/reconcile";
import { getCpuUsage, getMemoryStats, getStorageStats } from "./services/system";
import { deleteTemplate, listTemplates } from "./services/template";
import { cleanupOrphanedUdpRules } from "./services/udpProxy";
import {
	createVm,
	deleteVm,
	findVm,
	recoverVms,
	saveState,
	snapshotVm,
	vmToResponse,
	vms,
	withVmCreationLock,
} from "./services/vm";

const app = new Hono();

// Health check (no auth required)
app.get("/health", (c) => c.json({ status: "ok" }));

// System info endpoint (no auth required for basic status)
app.get("/info", async (c) => {
	const templates = await listTemplates();
	const vmList = Array.from(vms.values());

	// Get system stats
	const storageStats = await getStorageStats();
	const memoryStats = await getMemoryStats();
	const cpuUsage = await getCpuUsage();

	const hostIp = config.hostIp;

	return c.json({
		host_ip: hostIp,
		base_domain: config.baseDomain,
		default_swap_size_mib: config.defaultSwapSizeMib,
		base_image: config.baseImage,
		templates_count: templates.length,
		vms_count: vmList.length,
		storage: {
			total_gb: storageStats.totalGb,
			used_gb: storageStats.usedGb,
			free_gb: storageStats.freeGb,
		},
		memory: {
			total_gb: memoryStats.totalGb,
			free_gb: memoryStats.freeGb,
		},
		cpu_percent: cpuUsage,
	});
});

// ACME proxy endpoints for Caddy DNS-01 challenge (basic auth, not bearer)
app.post("/dns/present", async (c) => {
	// Validate basic auth
	const authHeader = c.req.header("Authorization");
	if (!config.acmeProxyPassword || !authHeader) {
		return c.body(null, 401);
	}
	const expected = `Basic ${btoa(`caddy:${config.acmeProxyPassword}`)}`;
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
	const expected = `Basic ${btoa(`caddy:${config.acmeProxyPassword}`)}`;
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

// Protected routes require bearer token
app.use("/*", bearerAuth({ token: config.apiToken }));

// Template routes
app.get("/templates", async (c) => {
	const templates = await listTemplates();
	return c.json({ templates });
});

app.delete("/templates/:name", async (c) => {
	try {
		await deleteTemplate(c.req.param("name"));
		return c.body(null, 204);
	} catch (e: unknown) {
		console.error("Template deletion failed:", e);
		const err = e as { status?: number; message?: string };
		return c.json({ error: err.message || "Unknown error" }, err.status || 500);
	}
});

// VM routes
app.get("/vms", (c) => {
	return c.json({ vms: Array.from(vms.values()).map(vmToResponse) });
});

app.get("/vms/:id", (c) => {
	const vm = findVm(c.req.param("id"));
	if (!vm) return c.json({ error: "VM not found" }, 404);
	return c.json(vmToResponse(vm));
});

app.post("/vms", async (c) => {
	try {
		return await withVmCreationLock(async () => {
			const body = await c.req.json();

			if (body.disk_size_gib !== undefined) {
				if (body.disk_size_gib < 1 || body.disk_size_gib > config.maxDiskSizeGib) {
					return c.json(
						{ error: `disk_size_gib must be between 1 and ${config.maxDiskSizeGib}` },
						400,
					);
				}
			}

			const vm = await createVm(body);
			await updateCaddyConfig();
			return c.json(vmToResponse(vm), 201);
		});
	} catch (e: unknown) {
		// Log full error details for debugging
		console.error("VM creation failed:", e);
		const err = e as { status?: number; message?: string };
		return c.json({ error: err.message || "Unknown error" }, err.status || 500);
	}
});

app.delete("/vms/:id", async (c) => {
	const vm = findVm(c.req.param("id"));
	if (!vm) return c.json({ error: "VM not found" }, 404);
	await deleteVm(vm);
	await updateCaddyConfig();
	return c.body(null, 204);
});

app.post("/vms/:id/snapshot", async (c) => {
	const vm = findVm(c.req.param("id"));
	if (!vm) return c.json({ error: "VM not found" }, 404);

	try {
		const body = await c.req.json();
		const templateName = body.template_name;
		const overwrite = body.overwrite === true;

		if (!templateName) {
			return c.json({ error: "template_name is required" }, 400);
		}

		const result = await snapshotVm(vm, templateName, overwrite);
		return c.json(result, 201);
	} catch (e: unknown) {
		console.error("Snapshot creation failed:", e);
		const err = e as { status?: number; message?: string };
		return c.json({ error: err.message || "Unknown error" }, err.status || 500);
	}
});

const host = "0.0.0.0";

// Validate required config
if (!config.hostIp) {
	console.error("FATAL: HOST_IP not set in /etc/scaleboxd/config.");
	console.error("Set it to this server's external IP address and restart scaleboxd.");
	process.exit(1);
}

// Clean up orphaned UDP proxy rules from previous runs
await cleanupOrphanedUdpRules();

// Recover VMs from previous run
await recoverVms();
await reconcileOrphans();

// Start DNS server for domain resolution and ACME challenges
await startDnsServer();

// Initialize Caddy config on startup to ensure vms.caddy matches current VM state
updateCaddyConfig().then(() => {
	console.log(`Scaleboxd started on http://${host}:${config.apiPort}`);
});

// Add SIGTERM handler for graceful shutdown
process.on("SIGTERM", () => {
	console.log("Received SIGTERM, saving state...");
	saveState();
	process.exit(0);
});

export default { port: config.apiPort, hostname: host, fetch: app.fetch };
