import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { config } from "./config";
import { updateCaddyConfig } from "./services/caddy";
import { reconcileOrphans } from "./services/reconcile";
import { getCpuUsage, getHostIp, getMemoryStats, getStorageStats } from "./services/system";
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

	// Get host IP (from config or auto-detect)
	const hostIp = config.hostIp || (await getHostIp());

	return c.json({
		host_ip: hostIp,
		api_domain: config.apiDomain,
		vm_domain: config.vmDomain,
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

// Caddy on-demand TLS validation (no auth required)
app.get("/caddy/check", (c) => {
	const domain = c.req.query("domain");
	if (!domain || !config.vmDomain) {
		return c.body(null, 404);
	}

	// Extract VM name from subdomain (e.g., "very-silly-penguin" from "very-silly-penguin.vms.example.com")
	const suffix = `.${config.vmDomain}`;
	if (!domain.endsWith(suffix)) {
		return c.body(null, 404);
	}

	const vmName = domain.slice(0, -suffix.length);
	const vmExists = Array.from(vms.values()).some((vm) => vm.name === vmName);

	return vmExists ? c.body(null, 200) : c.body(null, 404);
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

		if (!templateName) {
			return c.json({ error: "template_name is required" }, 400);
		}

		const result = await snapshotVm(vm, templateName);
		return c.json(result, 201);
	} catch (e: unknown) {
		console.error("Snapshot creation failed:", e);
		const err = e as { status?: number; message?: string };
		return c.json({ error: err.message || "Unknown error" }, err.status || 500);
	}
});

const host = "0.0.0.0";

// Clean up orphaned UDP proxy rules from previous runs
await cleanupOrphanedUdpRules();

// Recover VMs from previous run
await recoverVms();
await reconcileOrphans();

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
