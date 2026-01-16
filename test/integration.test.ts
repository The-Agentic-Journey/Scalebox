import { afterEach, describe, expect, test } from "bun:test";

const API_URL = `http://${process.env.VM_HOST || "34.40.56.57"}:8080`;
const API_TOKEN = process.env.API_TOKEN || "dev-5a30aabffc0d8308ec749c49d94164705fc2d4b57c50b800";

// Simple API client
const api = {
	async get(path: string) {
		const res = await fetch(`${API_URL}${path}`, {
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		return { status: res.status, data: res.ok ? await res.json() : null };
	},
	async post(path: string, body: unknown) {
		const res = await fetch(`${API_URL}${path}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return { status: res.status, data: res.ok ? await res.json() : null };
	},
	async delete(path: string) {
		const res = await fetch(`${API_URL}${path}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		return { status: res.status };
	},
	async getRaw(path: string, token?: string) {
		const res = await fetch(`${API_URL}${path}`, {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		});
		return { status: res.status };
	},
};

describe("Firecracker API", () => {
	// === Test Helpers & Cleanup ===
	const createdVmIds: string[] = [];
	const createdTemplates: string[] = [];

	afterEach(async () => {
		// Clean up VMs first, then templates
		for (const vmId of createdVmIds) {
			try {
				await api.delete(`/vms/${vmId}`);
			} catch {}
		}
		createdVmIds.length = 0;
		for (const template of createdTemplates) {
			try {
				await api.delete(`/templates/${template}`);
			} catch {}
		}
		createdTemplates.length = 0;
	});

	// === Phase 2: Health & Auth ===
	test.skip("health check returns ok", async () => {});
	test.skip("auth rejects missing token", async () => {});
	test.skip("auth rejects invalid token", async () => {});

	// === Phase 3: Templates ===
	test.skip("lists templates", async () => {});
	test.skip("debian-base template exists", async () => {});
	test.skip("delete protected template returns 403", async () => {});
	test.skip("delete nonexistent template returns 404", async () => {});

	// === Phase 4: VM Lifecycle ===
	test.skip("create VM returns valid response", async () => {});
	test.skip("created VM appears in list", async () => {});
	test.skip("get VM by id returns details", async () => {});
	test.skip("delete VM returns 204", async () => {});
	test.skip("deleted VM not in list", async () => {});

	// === Phase 5: SSH Access ===
	test.skip("VM becomes reachable via SSH", async () => {});
	test.skip("can execute command via SSH", async () => {});

	// === Phase 6: Snapshots ===
	test.skip("snapshot VM creates template", async () => {});
	test.skip("snapshot appears in template list", async () => {});
	test.skip("can create VM from snapshot", async () => {});
	test.skip("snapshot preserves filesystem state", async () => {});

	// === Phase 7: Cleanup ===
	test.skip("can delete snapshot template", async () => {});
});
