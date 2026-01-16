import { afterEach, describe, expect, test } from "bun:test";
import { API_BASE_URL, TEST_PUBLIC_KEY, api, sshExec, waitForSsh } from "./helpers";

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
		const res = await fetch(`${API_BASE_URL}/health`);
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
	test("create VM returns valid response", async () => {
		const { status, data } = await api.post("/vms", {
			template: "debian-base",
			name: "test-vm",
			ssh_public_key: TEST_PUBLIC_KEY,
		});
		if (data?.id) createdVmIds.push(data.id);

		expect(status).toBe(201);
		expect(data.id).toMatch(/^vm-[a-f0-9]{12}$/);
		expect(data.template).toBe("debian-base");
		expect(data.ip).toMatch(/^172\.16\.\d+\.\d+$/);
		expect(data.ssh_port).toBeGreaterThan(22000);
	});

	test("created VM appears in list", async () => {
		const { data: created } = await api.post("/vms", {
			template: "debian-base",
			ssh_public_key: TEST_PUBLIC_KEY,
		});
		createdVmIds.push(created.id);

		const { status, data } = await api.get("/vms");
		expect(status).toBe(200);
		expect(data.vms.some((v: { id: string }) => v.id === created.id)).toBe(true);
	});

	test("get VM by id returns details", async () => {
		const { data: created } = await api.post("/vms", {
			template: "debian-base",
			ssh_public_key: TEST_PUBLIC_KEY,
		});
		createdVmIds.push(created.id);

		const { status, data } = await api.get(`/vms/${created.id}`);
		expect(status).toBe(200);
		expect(data.id).toBe(created.id);
	});

	test("delete VM returns 204", async () => {
		const { data: created } = await api.post("/vms", {
			template: "debian-base",
			ssh_public_key: TEST_PUBLIC_KEY,
		});

		const { status } = await api.delete(`/vms/${created.id}`);
		expect(status).toBe(204);
	});

	test("deleted VM not in list", async () => {
		const { data: created } = await api.post("/vms", {
			template: "debian-base",
			ssh_public_key: TEST_PUBLIC_KEY,
		});
		await api.delete(`/vms/${created.id}`);

		const { data } = await api.get("/vms");
		expect(data.vms.some((v: { id: string }) => v.id === created.id)).toBe(false);
	});

	// === Phase 5: SSH Access ===
	test(
		"VM becomes reachable via SSH",
		async () => {
			const { data } = await api.post("/vms", {
				template: "debian-base",
				ssh_public_key: TEST_PUBLIC_KEY,
			});
			createdVmIds.push(data.id);

			await waitForSsh(data.ip, 30000);
		},
		{ timeout: 60000 },
	);

	test(
		"can execute command via SSH",
		async () => {
			const { data } = await api.post("/vms", {
				template: "debian-base",
				ssh_public_key: TEST_PUBLIC_KEY,
			});
			createdVmIds.push(data.id);

			await waitForSsh(data.ip, 30000);
			const output = await sshExec(data.ip, "echo hello");
			expect(output.trim()).toBe("hello");
		},
		{ timeout: 60000 },
	);

	// === Phase 6: Snapshots ===
	test.skip("snapshot VM creates template", async () => {});
	test.skip("snapshot appears in template list", async () => {});
	test.skip("can create VM from snapshot", async () => {});
	test.skip("snapshot preserves filesystem state", async () => {});

	// === Phase 7: Cleanup ===
	test.skip("can delete snapshot template", async () => {});
});
