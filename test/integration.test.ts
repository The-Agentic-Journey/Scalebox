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

			await waitForSsh(data.ssh_port, 180000);
		},
		{ timeout: 180000 },
	);

	test(
		"can execute command via SSH",
		async () => {
			const { data } = await api.post("/vms", {
				template: "debian-base",
				ssh_public_key: TEST_PUBLIC_KEY,
			});
			createdVmIds.push(data.id);

			await waitForSsh(data.ssh_port, 180000);
			const output = await sshExec(data.ssh_port, "echo hello");
			expect(output.trim()).toBe("hello");
		},
		{ timeout: 180000 },
	);

	// === Phase 6: Snapshots ===
	test(
		"snapshot VM creates template",
		async () => {
			// Create a VM
			const { data: vm } = await api.post("/vms", {
				template: "debian-base",
				ssh_public_key: TEST_PUBLIC_KEY,
			});
			createdVmIds.push(vm.id);

			// Wait for VM to be ready
			await waitForSsh(vm.ssh_port, 180000);

			// Create a snapshot
			const templateName = `snapshot-test-${Date.now()}`;
			createdTemplates.push(templateName);

			const { status, data } = await api.post(`/vms/${vm.id}/snapshot`, {
				template_name: templateName,
			});

			expect(status).toBe(201);
			expect(data.template).toBe(templateName);
			expect(data.source_vm).toBe(vm.id);
			expect(data.size_bytes).toBeGreaterThan(0);
			expect(data.created_at).toBeTruthy();
		},
		{ timeout: 180000 },
	);

	test(
		"snapshot appears in template list",
		async () => {
			// Create a VM
			const { data: vm } = await api.post("/vms", {
				template: "debian-base",
				ssh_public_key: TEST_PUBLIC_KEY,
			});
			createdVmIds.push(vm.id);

			// Wait for VM to be ready
			await waitForSsh(vm.ssh_port, 180000);

			// Create a snapshot
			const templateName = `snapshot-list-${Date.now()}`;
			createdTemplates.push(templateName);

			await api.post(`/vms/${vm.id}/snapshot`, {
				template_name: templateName,
			});

			// Check that snapshot appears in template list
			const { data } = await api.get("/templates");
			const names = data.templates.map((t: { name: string }) => t.name);
			expect(names).toContain(templateName);
		},
		{ timeout: 180000 },
	);

	test(
		"can create VM from snapshot",
		async () => {
			// Create a VM
			const { data: vm1 } = await api.post("/vms", {
				template: "debian-base",
				ssh_public_key: TEST_PUBLIC_KEY,
			});
			createdVmIds.push(vm1.id);

			// Wait for VM to be ready
			await waitForSsh(vm1.ssh_port, 180000);

			// Create a snapshot
			const templateName = `snapshot-create-${Date.now()}`;
			createdTemplates.push(templateName);

			await api.post(`/vms/${vm1.id}/snapshot`, {
				template_name: templateName,
			});

			// Create a new VM from the snapshot
			const { status, data: vm2 } = await api.post("/vms", {
				template: templateName,
				ssh_public_key: TEST_PUBLIC_KEY,
			});
			createdVmIds.push(vm2.id);

			expect(status).toBe(201);
			expect(vm2.template).toBe(templateName);

			// Verify new VM is reachable
			await waitForSsh(vm2.ssh_port, 180000);
			const output = await sshExec(vm2.ssh_port, "echo hello");
			expect(output.trim()).toBe("hello");
		},
		{ timeout: 300000 },
	);

	test(
		"snapshot preserves filesystem state",
		async () => {
			// Create a VM and write a file
			const { data: vm1 } = await api.post("/vms", {
				template: "debian-base",
				ssh_public_key: TEST_PUBLIC_KEY,
			});
			createdVmIds.push(vm1.id);

			// Wait for VM to be ready
			await waitForSsh(vm1.ssh_port, 180000);

			// Write a unique file to the VM
			const testContent = `test-content-${Date.now()}`;
			await sshExec(vm1.ssh_port, `echo "${testContent}" > /root/testfile.txt`);

			// Verify the file was written
			const verifyContent = await sshExec(vm1.ssh_port, "cat /root/testfile.txt");
			expect(verifyContent.trim()).toBe(testContent);

			// Sync filesystem to ensure data is written to disk before snapshot
			await sshExec(vm1.ssh_port, "sync");

			// Create a snapshot
			const templateName = `snapshot-state-${Date.now()}`;
			createdTemplates.push(templateName);

			await api.post(`/vms/${vm1.id}/snapshot`, {
				template_name: templateName,
			});

			// Create a new VM from the snapshot
			const { data: vm2 } = await api.post("/vms", {
				template: templateName,
				ssh_public_key: TEST_PUBLIC_KEY,
			});
			createdVmIds.push(vm2.id);

			// Verify new VM has the file with the content
			await waitForSsh(vm2.ssh_port, 180000);
			const content = await sshExec(vm2.ssh_port, "cat /root/testfile.txt");
			expect(content.trim()).toBe(testContent);
		},
		{ timeout: 300000 },
	);

	// === Phase 7: Cleanup ===
	test(
		"can delete snapshot template",
		async () => {
			// Create a VM from debian-base template
			const { data: vm } = await api.post("/vms", {
				template: "debian-base",
				ssh_public_key: TEST_PUBLIC_KEY,
			});
			createdVmIds.push(vm.id);

			// Wait for VM to be ready via SSH
			await waitForSsh(vm.ssh_port, 180000);

			// Take a snapshot with a unique name
			const templateName = `snapshot-delete-${Date.now()}`;
			createdTemplates.push(templateName);

			const { status: snapshotStatus } = await api.post(`/vms/${vm.id}/snapshot`, {
				template_name: templateName,
			});
			expect(snapshotStatus).toBe(201);

			// Verify the snapshot/template was created by checking the templates list
			const { data: templatesBeforeDelete } = await api.get("/templates");
			const namesBeforeDelete = templatesBeforeDelete.templates.map(
				(t: { name: string }) => t.name,
			);
			expect(namesBeforeDelete).toContain(templateName);

			// Delete the snapshot template
			const { status: deleteStatus } = await api.delete(`/templates/${templateName}`);
			expect(deleteStatus).toBe(204);

			// Remove from createdTemplates since we've already deleted it
			const templateIndex = createdTemplates.indexOf(templateName);
			if (templateIndex > -1) {
				createdTemplates.splice(templateIndex, 1);
			}

			// Verify the template returns 404 when deleted
			const { status: getDeletedStatus } = await api.get(`/templates/${templateName}`);
			expect(getDeletedStatus).toBe(404);

			// Also verify it's no longer in the templates list
			const { data: templatesAfterDelete } = await api.get("/templates");
			const namesAfterDelete = templatesAfterDelete.templates.map((t: { name: string }) => t.name);
			expect(namesAfterDelete).not.toContain(templateName);
		},
		{ timeout: 180000 },
	);
});
