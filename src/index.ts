import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { config } from "./config";
import { deleteTemplate, listTemplates } from "./services/template";

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
		const err = e as { status?: number; message?: string };
		return c.json({ error: err.message || "Unknown error" }, err.status || 500);
	}
});

export default { port: config.apiPort, fetch: app.fetch };
