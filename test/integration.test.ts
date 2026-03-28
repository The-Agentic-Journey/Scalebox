import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
	API_BASE_URL,
	TEST_PUBLIC_KEY,
	VM_HOST,
	VM_IP,
	api,
	cleanupCli,
	initCli,
	sbCmd,
	sbConnectRaw,
	sbStatus,
	sbTemplateDelete,
	sbTemplateList,
	sbVmCreate,
	sbVmDelete,
	sbVmGet,
	sbVmList,
	sbVmSnapshot,
	sbVmSnapshotRaw,
	sbVmWait,
	sshExec,
	waitForSsh,
} from "./helpers";

describe("Firecracker API", () => {
	// === Test Helpers & Cleanup ===
	const createdVmIds: string[] = [];
	const createdTemplates: string[] = [];

	beforeAll(async () => {
		await initCli();
	});

	afterAll(async () => {
		await cleanupCli();
	});

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
		const status = await sbStatus();
		expect(status.status).toBe(200);
	});
	test("auth rejects missing token", async () => {
		const { status } = await api.getRaw("/templates");
		expect(status).toBe(401);
	});

	test("auth rejects invalid token", async () => {
		const { status } = await api.getRaw("/templates", "wrong-token");
		expect(status).toBe(401);
	});

	test.skip("info returns base_image", async () => {
		// GET /info, check base_image field exists
	});

	// === CLI Connect Command ===
	// These tests exercise the connect command code path, including empty array handling
	// that was problematic on bash 3.2 (macOS) with set -u
	test("connect to nonexistent VM returns 404", async () => {
		const result = await sbConnectRaw("nonexistent-vm-name");
		expect(result.exitCode).not.toBe(0);
		expect(result.data?.status).toBe(404);
	});

	// === Phase 3: Templates ===
	test("lists templates", async () => {
		const templates = await sbTemplateList();
		expect(Array.isArray(templates)).toBe(true);
	});

	test("debian-base template exists", async () => {
		const templates = await sbTemplateList();
		const names = templates.map((t) => t.name);
		expect(names).toContain("debian-base");
	});

	test("delete protected template returns 403", async () => {
		const result = await sbCmd("template", "delete", "debian-base");
		expect(result.exitCode).not.toBe(0);
		expect(result.data?.status).toBe(403);
	});

	test("delete nonexistent template returns 404", async () => {
		const result = await sbCmd("template", "delete", "does-not-exist");
		expect(result.exitCode).not.toBe(0);
		expect(result.data?.status).toBe(404);
	});

	// === Phase 4: VM Lifecycle ===
	test("create VM returns valid response", async () => {
		const vm = await sbVmCreate("debian-base");
		if (vm?.id) createdVmIds.push(vm.id as string);

		expect(vm.id).toMatch(/^vm-[a-f0-9]{12}$/);
		expect(vm.name).toBeDefined();
		expect(vm.template).toBe("debian-base");
		expect(vm.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
		expect(vm.ssh_port).toBeGreaterThan(22000);
	});

	test("VM response contains host IP instead of bridge IP", async () => {
		const vm = await sbVmCreate("debian-base");
		if (vm?.id) createdVmIds.push(vm.id as string);

		// ip should be the host IP, not internal bridge IP (172.16.x.x)
		expect(vm.ip).not.toMatch(/^172\.16\./);
		expect(vm.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

		// ssh field should use the same host IP
		expect(vm.ssh).toContain(vm.ip as string);
		expect(vm.ssh).not.toContain("localhost");
	});

	test("created VM appears in list", async () => {
		const created = await sbVmCreate("debian-base");
		createdVmIds.push(created.id as string);

		const vms = await sbVmList();
		expect(vms.some((v) => v.id === created.id)).toBe(true);
	});

	test("get VM by id returns details", async () => {
		const created = await sbVmCreate("debian-base");
		createdVmIds.push(created.id as string);

		const vm = await sbVmGet(created.id as string);
		expect(vm?.id).toBe(created.id);
	});

	test("get VM by name returns details", async () => {
		const created = await sbVmCreate("debian-base");
		createdVmIds.push(created.id as string);

		// Lookup by name instead of ID
		const vm = await sbVmGet(created.name as string);
		expect(vm?.id).toBe(created.id);
		expect(vm?.name).toBe(created.name);
	});

	test("delete VM by name works", async () => {
		const created = await sbVmCreate("debian-base");
		// Don't add to createdVmIds since we'll delete by name

		// Delete by name instead of ID
		await sbVmDelete(created.name as string);

		// Verify it's gone
		const vms = await sbVmList();
		expect(vms.some((v) => v.id === created.id)).toBe(false);
	});

	test("delete VM returns 204", async () => {
		const created = await sbVmCreate("debian-base");

		await sbVmDelete(created.id as string);
		// If no error thrown, deletion succeeded
	});

	test("deleted VM not in list", async () => {
		const created = await sbVmCreate("debian-base");
		await sbVmDelete(created.id as string);

		const vms = await sbVmList();
		expect(vms.some((v) => v.id === created.id)).toBe(false);
	});

	// === Phase 5: SSH Access ===
	test(
		"VM becomes reachable via SSH",
		async () => {
			const vm = await sbVmCreate("debian-base");
			createdVmIds.push(vm.id as string);

			await sbVmWait(vm.id as string, 90);
		},
		{ timeout: 90000 },
	);

	test(
		"can execute command via SSH",
		async () => {
			const vm = await sbVmCreate("debian-base");
			createdVmIds.push(vm.id as string);

			await waitForSsh(vm.ssh_port as number, 90000);
			const output = await sshExec(vm.ssh_port as number, "echo hello");
			expect(output.trim()).toBe("hello");
		},
		{ timeout: 90000 },
	);

	// === Kernel Version ===
	test(
		"VM boots with kernel 5.10",
		async () => {
			const vm = await sbVmCreate("debian-base");
			createdVmIds.push(vm.id as string);

			await waitForSsh(vm.ssh_port as number, 90000);
			const output = await sshExec(vm.ssh_port as number, "uname -r");
			expect(output.trim()).toMatch(/^5\.10\./);
		},
		{ timeout: 90000 },
	);

	test.skip("VM hostname matches generated name", async () => {
		// Create VM, SSH in, run hostname, compare to vm.name
	});

	// === Phase 6: Snapshots ===
	test(
		"snapshot VM creates template",
		async () => {
			const vm = await sbVmCreate("debian-base");
			createdVmIds.push(vm.id as string);

			await sbVmWait(vm.id as string, 90);

			const templateName = `snapshot-test-${Date.now()}`;
			createdTemplates.push(templateName);

			const snapshot = await sbVmSnapshot(vm.id as string, templateName);

			expect(snapshot.template).toBe(templateName);
			expect(snapshot.source_vm).toBe(vm.id);
			expect(snapshot.size_bytes).toBeGreaterThan(0);
			expect(snapshot.created_at).toBeTruthy();
		},
		{ timeout: 90000 },
	);

	test(
		"snapshot appears in template list",
		async () => {
			const vm = await sbVmCreate("debian-base");
			createdVmIds.push(vm.id as string);

			await sbVmWait(vm.id as string, 90);

			const templateName = `snapshot-list-${Date.now()}`;
			createdTemplates.push(templateName);

			await sbVmSnapshot(vm.id as string, templateName);

			const templates = await sbTemplateList();
			const names = templates.map((t) => t.name);
			expect(names).toContain(templateName);
		},
		{ timeout: 90000 },
	);

	test(
		"can create VM from snapshot",
		async () => {
			const vm1 = await sbVmCreate("debian-base");
			createdVmIds.push(vm1.id as string);

			await waitForSsh(vm1.ssh_port as number, 90000);

			const templateName = `snapshot-create-${Date.now()}`;
			createdTemplates.push(templateName);

			await sbVmSnapshot(vm1.id as string, templateName);

			const vm2 = await sbVmCreate(templateName);
			createdVmIds.push(vm2.id as string);

			expect(vm2.template).toBe(templateName);

			await waitForSsh(vm2.ssh_port as number, 90000);
			const output = await sshExec(vm2.ssh_port as number, "echo hello");
			expect(output.trim()).toBe("hello");
		},
		{ timeout: 150000 },
	);

	test(
		"snapshot preserves filesystem state",
		async () => {
			const vm1 = await sbVmCreate("debian-base");
			createdVmIds.push(vm1.id as string);

			await waitForSsh(vm1.ssh_port as number, 90000);

			const testContent = `test-content-${Date.now()}`;
			await sshExec(vm1.ssh_port as number, `echo "${testContent}" > /home/user/testfile.txt`);

			const verifyContent = await sshExec(vm1.ssh_port as number, "cat /home/user/testfile.txt");
			expect(verifyContent.trim()).toBe(testContent);

			await sshExec(vm1.ssh_port as number, "sync");

			const templateName = `snapshot-state-${Date.now()}`;
			createdTemplates.push(templateName);

			await sbVmSnapshot(vm1.id as string, templateName);

			const vm2 = await sbVmCreate(templateName);
			createdVmIds.push(vm2.id as string);

			await waitForSsh(vm2.ssh_port as number, 90000);
			const content = await sshExec(vm2.ssh_port as number, "cat /home/user/testfile.txt");
			expect(content.trim()).toBe(testContent);
		},
		{ timeout: 150000 },
	);

	// === Snapshot Overwrite ===
	test.skip("snapshot existing template returns 409", async () => {
		// Create VM, snapshot, attempt duplicate snapshot → 409
	});

	test.skip("snapshot with overwrite replaces existing template", async () => {
		// Create VM, snapshot, overwrite snapshot → 201
	});

	// === Phase 7: Cleanup ===
	test(
		"can delete snapshot template",
		async () => {
			const vm = await sbVmCreate("debian-base");
			createdVmIds.push(vm.id as string);

			await sbVmWait(vm.id as string, 90);

			const templateName = `snapshot-delete-${Date.now()}`;
			createdTemplates.push(templateName);

			await sbVmSnapshot(vm.id as string, templateName);

			const templatesBeforeDelete = await sbTemplateList();
			const namesBeforeDelete = templatesBeforeDelete.map((t) => t.name);
			expect(namesBeforeDelete).toContain(templateName);

			await sbTemplateDelete(templateName);

			const templateIndex = createdTemplates.indexOf(templateName);
			if (templateIndex > -1) {
				createdTemplates.splice(templateIndex, 1);
			}

			const vm2 = await sbVmGet(templateName);
			expect(vm2).toBe(null);

			const templatesAfterDelete = await sbTemplateList();
			const namesAfterDelete = templatesAfterDelete.map((t) => t.name);
			expect(namesAfterDelete).not.toContain(templateName);
		},
		{ timeout: 90000 },
	);

	// === DNS & Wildcard Cert ===
	test("info returns base_domain", async () => {
		const status = await sbStatus();
		expect(status.base_domain).toBeDefined();
		expect(status.base_domain).not.toBe("");
		expect((status as Record<string, unknown>).api_domain).toBeUndefined();
		expect((status as Record<string, unknown>).vm_domain).toBeUndefined();
	});

	test("VM URL uses vm.BASE_DOMAIN format", async () => {
		const vm = await sbVmCreate("debian-base");
		if (vm?.id) createdVmIds.push(vm.id as string);
		const status = await sbStatus();
		const baseDomain = status.base_domain as string;
		expect(vm.url).toMatch(new RegExp(`^https://.+\\.vm\\.${baseDomain.replace(/\./g, "\\.")}$`));
	});
	test(
		"DNS resolves VM subdomain to host IP",
		async () => {
			const status = await sbStatus();
			const baseDomain = status.base_domain as string;
			const hostIp = status.host_ip as string;
			const digTarget = VM_IP || VM_HOST;
			const result = await $`dig @${digTarget} test-vm.vm.${baseDomain} A +short`.text();
			expect(result.trim()).toBe(hostIp);
		},
		{ timeout: 10000 },
	);

	test(
		"DNS resolves API subdomain to host IP",
		async () => {
			const status = await sbStatus();
			const baseDomain = status.base_domain as string;
			const hostIp = status.host_ip as string;
			const digTarget = VM_IP || VM_HOST;
			const result = await $`dig @${digTarget} api.${baseDomain} A +short`.text();
			expect(result.trim()).toBe(hostIp);
		},
		{ timeout: 10000 },
	);
	test.skip("ACME proxy endpoints manage TXT records", async () => {
		// Verified end-to-end: if HTTPS works (criterion #6), the ACME proxy worked.
		// Direct testing would require the ACME proxy password from the server config.
	});
});
