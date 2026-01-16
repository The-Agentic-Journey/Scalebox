import { Hono } from "hono";
import { config } from "./config";

const app = new Hono();

// Health check (no auth required)
app.get("/health", (c) => c.json({ status: "ok" }));

export default { port: config.apiPort, fetch: app.fetch };
