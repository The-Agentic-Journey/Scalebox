import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { config } from "./config";

const app = new Hono();

// Health check (no auth required)
app.get("/health", (c) => c.json({ status: "ok" }));

// Protected routes require bearer token
app.use("/*", bearerAuth({ token: config.apiToken }));

// Stub for templates (will be implemented later)
app.get("/templates", (c) => c.json({ templates: [] }));

export default { port: config.apiPort, fetch: app.fetch };
