import { afterEach, describe, expect, test } from "bun:test";
import { api } from "./helpers";

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
	test("health check returns ok", async () => {
		const res = await fetch(`http://${process.env.VM_HOST || "34.40.56.57"}:8080/health`);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.status).toBe("ok");
	});
	test("auth rejects missing token", async () => {
		const { status } = await api.getRaw("/templates");
		expect(status).toBe(401);
	});

	test("auth rejects invalid token", async () => {
		const { status } = await api.getRaw("/templates", "wrong-token");
		expect(status).toBe(401);
	});

	// === Phase 3: Templates ===
	test("lists templates", async () => {
		const { status, data } = await api.get("/templates");
		expect(status).toBe(200);
		expect(Array.isArray(data.templates)).toBe(true);
	});

	test("debian-base template exists", async () => {
		const { data } = await api.get("/templates");
		const names = data.templates.map((t: { name: string }) => t.name);
		expect(names).toContain("debian-base");
	});

	test("delete protected template returns 403", async () => {
		const { status } = await api.delete("/templates/debian-base");
		expect(status).toBe(403);
	});

	test("delete nonexistent template returns 404", async () => {
		const { status } = await api.delete("/templates/does-not-exist");
		expect(status).toBe(404);
	});

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
