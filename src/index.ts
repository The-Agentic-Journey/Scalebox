import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { config } from "./config";
import { deleteTemplate, listTemplates } from "./services/template";
import {
	createVm,
	deleteVm,
	snapshotVm,
	vmToResponse,
	vms,
	withVmCreationLock,
} from "./services/vm";

const app = new Hono();

// Health check (no auth required)
app.get("/health", (c) => c.json({ status: "ok" }));

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
	const vm = vms.get(c.req.param("id"));
	if (!vm) return c.json({ error: "VM not found" }, 404);
	return c.json(vmToResponse(vm));
});

app.post("/vms", async (c) => {
	try {
		return await withVmCreationLock(async () => {
			const body = await c.req.json();
			const vm = await createVm(body);
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
	const vm = vms.get(c.req.param("id"));
	if (!vm) return c.json({ error: "VM not found" }, 404);
	await deleteVm(vm);
	return c.body(null, 204);
});

app.post("/vms/:id/snapshot", async (c) => {
	const vm = vms.get(c.req.param("id"));
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
console.log(`Scaleboxd started on http://${host}:${config.apiPort}`);
export default { port: config.apiPort, hostname: host, fetch: app.fetch };
