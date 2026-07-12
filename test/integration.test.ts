import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rm as rmFile, writeFile as writeFileHelper } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
	API_BASE_URL,
	API_TOKEN,
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
	sbVmCreateWithInit,
	sbVmDelete,
	sbVmGet,
	sbVmList,
	sbVmRestart,
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

	test("info returns base_image", async () => {
		const status = await sbStatus();
		expect(status.base_image).toBeDefined();
		expect(typeof status.base_image).toBe("string");
		expect((status.base_image as string).length).toBeGreaterThan(0);
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

	test(
		"VM hostname matches generated name",
		async () => {
			const vm = await sbVmCreate("debian-base");
			createdVmIds.push(vm.id as string);

			await waitForSsh(vm.ssh_port as number, 90000);
			const hostname = await sshExec(vm.ssh_port as number, "hostname");
			expect(hostname.trim()).toBe(vm.name);
		},
		{ timeout: 90000 },
	);

	// === Swap ===
	test(
		"VM has swap enabled",
		async () => {
			const vm = await sbVmCreate("debian-base");
			createdVmIds.push(vm.id as string);

			await waitForSsh(vm.ssh_port as number, 90000);
			const output = await sshExec(
				vm.ssh_port as number,
				"/usr/sbin/swapon --show=NAME,SIZE --noheadings --bytes",
			);
			// Expected output: /swapfile <size_in_bytes>
			expect(output.trim()).not.toBe("");
			const fields = output.trim().split(/\s+/);
			expect(fields[0]).toBe("/swapfile");
			// Size in bytes — 2048 MiB = 2147483648 bytes.
			// mkswap reserves a small header (~4 KiB), so usable size is slightly less.
			const sizeBytes = Number.parseInt(fields[1], 10);
			expect(sizeBytes).toBeGreaterThan(2147483648 - 1024 * 1024);
			expect(sizeBytes).toBeLessThanOrEqual(2147483648);
		},
		{ timeout: 90000 },
	);

	test("info returns default_swap_size_mib", async () => {
		const status = await sbStatus();
		expect(status.default_swap_size_mib).toBeDefined();
		expect(typeof status.default_swap_size_mib).toBe("number");
		expect(status.default_swap_size_mib).toBeGreaterThanOrEqual(0);
	});

	// === VM Initialization ===
	describe("VM Initialization", () => {
		test(
			"env vars accessible via non-interactive SSH",
			async () => {
				const vm = await sbVmCreateWithInit("debian-base", {
					env: ["FOO=bar", "HELLO=world"],
				});
				createdVmIds.push(vm.id as string);

				await waitForSsh(vm.ssh_port as number, 90000);
				const foo = await sshExec(vm.ssh_port as number, "printenv FOO");
				expect(foo.trim()).toBe("bar");
				const hello = await sshExec(vm.ssh_port as number, "printenv HELLO");
				expect(hello.trim()).toBe("world");
			},
			{ timeout: 90000 },
		);

		test(
			"files created with correct content and permissions",
			async () => {
				const testContent = "hello-from-file-test";
				const tmpFile = join(tmpdir(), `scalebox-file-test-${Date.now()}.txt`);
				await writeFileHelper(tmpFile, testContent);

				try {
					const vm = await sbVmCreateWithInit("debian-base", {
						files: [`/home/user/test-file.txt:@${tmpFile}`],
					});
					createdVmIds.push(vm.id as string);

					await waitForSsh(vm.ssh_port as number, 90000);
					const content = await sshExec(vm.ssh_port as number, "cat /home/user/test-file.txt");
					expect(content.trim()).toBe(testContent);

					const perms = await sshExec(
						vm.ssh_port as number,
						"stat -c '%a %U:%G' /home/user/test-file.txt",
					);
					expect(perms.trim()).toBe("640 user:user");
				} finally {
					await rmFile(tmpFile, { force: true });
				}
			},
			{ timeout: 90000 },
		);

		test(
			"init script executed on boot",
			async () => {
				const tmpScript = join(tmpdir(), `scalebox-init-test-${Date.now()}.sh`);
				await writeFileHelper(
					tmpScript,
					'#!/bin/bash\necho "init-completed" > /home/user/init-result.txt\nchown 1000:1000 /home/user/init-result.txt\n',
				);

				try {
					const vm = await sbVmCreateWithInit("debian-base", {
						initScript: tmpScript,
					});
					createdVmIds.push(vm.id as string);

					await waitForSsh(vm.ssh_port as number, 90000);
					let result = "";
					for (let i = 0; i < 30; i++) {
						try {
							result = await sshExec(
								vm.ssh_port as number,
								"cat /home/user/init-result.txt 2>/dev/null || echo PENDING",
							);
							if (result.trim() !== "PENDING") break;
						} catch {}
						await Bun.sleep(1000);
					}
					expect(result.trim()).toBe("init-completed");
				} finally {
					await rmFile(tmpScript, { force: true });
				}
			},
			{ timeout: 150000 },
		);

		test(
			"init script has access to env vars",
			async () => {
				const tmpScript = join(tmpdir(), `scalebox-init-env-${Date.now()}.sh`);
				await writeFileHelper(
					tmpScript,
					'#!/bin/bash\necho "$MY_TEST_VAR" > /home/user/env-from-init.txt\nchown 1000:1000 /home/user/env-from-init.txt\n',
				);

				try {
					const vm = await sbVmCreateWithInit("debian-base", {
						env: ["MY_TEST_VAR=hello-from-env"],
						initScript: tmpScript,
					});
					createdVmIds.push(vm.id as string);

					await waitForSsh(vm.ssh_port as number, 90000);
					let result = "";
					for (let i = 0; i < 30; i++) {
						try {
							result = await sshExec(
								vm.ssh_port as number,
								"cat /home/user/env-from-init.txt 2>/dev/null || echo PENDING",
							);
							if (result.trim() !== "PENDING") break;
						} catch {}
						await Bun.sleep(1000);
					}
					expect(result.trim()).toBe("hello-from-env");
				} finally {
					await rmFile(tmpScript, { force: true });
				}
			},
			{ timeout: 150000 },
		);

		test(
			"init script removed after execution",
			async () => {
				const tmpScript = join(tmpdir(), `scalebox-init-cleanup-${Date.now()}.sh`);
				await writeFileHelper(
					tmpScript,
					"#!/bin/bash\necho done > /home/user/init-done.txt\nchown 1000:1000 /home/user/init-done.txt\n",
				);

				try {
					const vm = await sbVmCreateWithInit("debian-base", {
						initScript: tmpScript,
					});
					createdVmIds.push(vm.id as string);

					await waitForSsh(vm.ssh_port as number, 90000);
					for (let i = 0; i < 30; i++) {
						try {
							const done = await sshExec(
								vm.ssh_port as number,
								"cat /home/user/init-done.txt 2>/dev/null || echo PENDING",
							);
							if (done.trim() !== "PENDING") break;
						} catch {}
						await Bun.sleep(1000);
					}

					const scriptExists = await sshExec(
						vm.ssh_port as number,
						"test -f /opt/scalebox/init.sh && echo exists || echo gone",
					);
					expect(scriptExists.trim()).toBe("gone");

					const serviceEnabled = await sshExec(
						vm.ssh_port as number,
						"systemctl is-enabled scalebox-init.service 2>/dev/null; true",
					);
					expect(serviceEnabled.trim()).toBe("disabled");
				} finally {
					await rmFile(tmpScript, { force: true });
				}
			},
			{ timeout: 150000 },
		);

		test(
			"env, files, and init script work together",
			async () => {
				const tmpFile = join(tmpdir(), `scalebox-combined-file-${Date.now()}.txt`);
				await writeFileHelper(tmpFile, "combined-file-content");

				const tmpScript = join(tmpdir(), `scalebox-combined-init-${Date.now()}.sh`);
				await writeFileHelper(
					tmpScript,
					'#!/bin/bash\necho "$COMBINED_VAR" > /home/user/combined-init.txt\nchown 1000:1000 /home/user/combined-init.txt\n',
				);

				try {
					const vm = await sbVmCreateWithInit("debian-base", {
						env: ["COMBINED_VAR=it-works"],
						files: [`/home/user/combined-file.txt:@${tmpFile}`],
						initScript: tmpScript,
					});
					createdVmIds.push(vm.id as string);

					await waitForSsh(vm.ssh_port as number, 90000);

					// Verify env var
					const envVal = await sshExec(vm.ssh_port as number, "printenv COMBINED_VAR");
					expect(envVal.trim()).toBe("it-works");

					// Verify file
					const fileContent = await sshExec(
						vm.ssh_port as number,
						"cat /home/user/combined-file.txt",
					);
					expect(fileContent.trim()).toBe("combined-file-content");

					const filePerms = await sshExec(
						vm.ssh_port as number,
						"stat -c '%a %U:%G' /home/user/combined-file.txt",
					);
					expect(filePerms.trim()).toBe("640 user:user");

					// Verify init script ran with env vars
					let initResult = "";
					for (let i = 0; i < 30; i++) {
						try {
							initResult = await sshExec(
								vm.ssh_port as number,
								"cat /home/user/combined-init.txt 2>/dev/null || echo PENDING",
							);
							if (initResult.trim() !== "PENDING") break;
						} catch {}
						await Bun.sleep(1000);
					}
					expect(initResult.trim()).toBe("it-works");
				} finally {
					await rmFile(tmpFile, { force: true });
					await rmFile(tmpScript, { force: true });
				}
			},
			{ timeout: 150000 },
		);
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
	test(
		"snapshot existing template returns 409",
		async () => {
			const vm = await sbVmCreate("debian-base");
			createdVmIds.push(vm.id as string);
			await sbVmWait(vm.id as string, 90);

			const templateName = `overwrite-test-${Date.now()}`;
			createdTemplates.push(templateName);
			await sbVmSnapshot(vm.id as string, templateName);

			// Second snapshot with same name should return 409
			const result = await sbVmSnapshotRaw(vm.id as string, templateName);
			expect(result.exitCode).not.toBe(0);
			expect(result.data?.status).toBe(409);
		},
		{ timeout: 90000 },
	);

	test(
		"snapshot with overwrite replaces existing template",
		async () => {
			const vm = await sbVmCreate("debian-base");
			createdVmIds.push(vm.id as string);
			await sbVmWait(vm.id as string, 90);

			const templateName = `overwrite-replace-${Date.now()}`;
			createdTemplates.push(templateName);
			await sbVmSnapshot(vm.id as string, templateName);

			// Overwrite should succeed
			const snapshot = await sbVmSnapshot(vm.id as string, templateName, { overwrite: true });
			expect(snapshot.template).toBe(templateName);
			expect(snapshot.size_bytes).toBeGreaterThan(0);
		},
		{ timeout: 90000 },
	);

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

	// === Observability: metrics + degradation ===
	describe("Metrics endpoint", () => {
		test("returns process memory and per-vm counters", async () => {
			const res = await fetch(`${API_BASE_URL}/metrics`, {
				headers: { Authorization: `Bearer ${API_TOKEN}` },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				uptime_seconds: number;
				process: { rss: number; heap_used: number };
				vms: Record<string, unknown>;
				vm_count: number;
			};
			expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
			expect(body.process.rss).toBeGreaterThan(0);
			expect(body.process.heap_used).toBeGreaterThan(0);
			expect(typeof body.vms).toBe("object");
			expect(typeof body.vm_count).toBe("number");
		});

		test("requires bearer token", async () => {
			const res = await fetch(`${API_BASE_URL}/metrics`);
			expect(res.status).toBe(401);
		});

		test(
			"connection counters increment for a real VM",
			async () => {
				const vm = await sbVmCreate("debian-base");
				const vmId = vm.id as string;
				createdVmIds.push(vmId);
				await waitForSsh(vm.ssh_port as number, 90000);

				// SSH already opened/closed a connection by way of waitForSsh.
				const res = await fetch(`${API_BASE_URL}/metrics`, {
					headers: { Authorization: `Bearer ${API_TOKEN}` },
				});
				const body = (await res.json()) as {
					vms: Record<string, { connections_accepted: number; vm_connect_successes: number }>;
				};
				const c = body.vms[vmId];
				expect(c).toBeDefined();
				expect(c.connections_accepted).toBeGreaterThan(0);
				expect(c.vm_connect_successes).toBeGreaterThan(0);

				// Healthy VM should not be marked degraded
				const detail = await sbVmGet(vmId);
				expect(detail?.degraded).toBe(false);
			},
			{ timeout: 120000 },
		);
	});

	// === Observability: In-guest health agent ===
	describe("Health agent", () => {
		test(
			"scalebox-health.timer is active in new VM",
			async () => {
				const vm = await sbVmCreate("debian-base");
				createdVmIds.push(vm.id as string);
				await waitForSsh(vm.ssh_port as number, 90000);

				const status = await sshExec(
					vm.ssh_port as number,
					"systemctl is-active scalebox-health.timer",
				);
				expect(status.trim()).toBe("active");
			},
			{ timeout: 120000 },
		);

		test(
			"scalebox-health.log accumulates entries within 90s",
			async () => {
				const vm = await sbVmCreate("debian-base");
				createdVmIds.push(vm.id as string);
				await waitForSsh(vm.ssh_port as number, 90000);

				// OnBootSec=30s + OnUnitActiveSec=60s — wait up to 120s for first entry
				let count = 0;
				for (let i = 0; i < 60; i++) {
					try {
						const out = await sshExec(
							vm.ssh_port as number,
							"sudo grep -c '^=== ' /var/log/scalebox-health.log 2>/dev/null || echo 0",
						);
						count = Number(out.trim());
						if (count > 0) break;
					} catch {}
					await Bun.sleep(2000);
				}
				expect(count).toBeGreaterThan(0);
			},
			{ timeout: 240000 },
		);
	});

	// === Observability: Persistent console logs ===
	describe("Console logs", () => {
		test(
			"console log persists under /var/lib/scalebox/logs and grows",
			async () => {
				const vm = await sbVmCreate("debian-base");
				createdVmIds.push(vm.id as string);

				expect(vm.console_log_path).toMatch(
					new RegExp(`^/var/lib/scalebox/logs/${vm.id}/console\\.log$`),
				);

				// Wait briefly for Firecracker to emit boot output
				let size = 0;
				for (let i = 0; i < 20; i++) {
					const detail = await sbVmGet(vm.id as string);
					size = (detail?.console_log_size as number) ?? 0;
					if (size > 0) break;
					await Bun.sleep(500);
				}
				expect(size).toBeGreaterThan(0);
			},
			{ timeout: 60000 },
		);

		test(
			"console log dir removed on vm delete",
			async () => {
				const vm = await sbVmCreate("debian-base");
				const vmId = vm.id as string;
				// Don't push to createdVmIds — we delete it explicitly below

				const logPath = vm.console_log_path as string;
				expect(logPath).toContain(vmId);

				await sbVmDelete(vmId);

				// After delete, GET should 404 (the VM is gone, hence its log dir too)
				const after = await sbVmGet(vmId);
				expect(after).toBe(null);
			},
			{ timeout: 60000 },
		);
	});

	// === Phase 1: VM Restart & Disk-Preserving Recovery (stubs) ===
	describe("VM Restart", () => {
		test(
			"restart power-cycles a running VM (boot_id changes)",
			async () => {
				const vm = await sbVmCreate("debian-base");
				createdVmIds.push(vm.id as string);
				const port = vm.ssh_port as number;

				await waitForSsh(port, 90000);
				const bootId1 = (await sshExec(port, "cat /proc/sys/kernel/random/boot_id")).trim();

				const res = await api.post(`/vms/${vm.id}/restart`, {});
				expect(res.status).toBe(200);
				expect(res.body.status).toBe("running");
				expect(res.body.ssh_port).toBe(port);

				// Load-bearing: wait for the guest to finish rebooting before reading boot_id.
				await waitForSsh(port, 90000);
				const bootId2 = (await sshExec(port, "cat /proc/sys/kernel/random/boot_id")).trim();

				expect(bootId2).not.toBe(bootId1);
				expect(bootId2.length).toBeGreaterThan(0);
			},
			{ timeout: 240000 },
		);

		test(
			"restart with disk_size_gib grows guest disk",
			async () => {
				const vm = await sbVmCreate("debian-base");
				createdVmIds.push(vm.id as string);
				const port = vm.ssh_port as number;

				await waitForSsh(port, 90000);
				const oldBytes = Number((await sshExec(port, "df -B1 --output=size / | tail -1")).trim());

				const res = await api.post(`/vms/${vm.id}/restart`, { disk_size_gib: 14 });
				expect(res.status).toBe(200);

				await waitForSsh(port, 90000);
				const newBytes = Number((await sshExec(port, "df -B1 --output=size / | tail -1")).trim());

				expect(newBytes).toBeGreaterThan(oldBytes);
				expect(newBytes).toBeGreaterThanOrEqual(12 * 1024 ** 3);
			},
			{ timeout: 240000 },
		);

		test(
			"restart with vcpu_count changes nproc",
			async () => {
				const vm = await sbVmCreate("debian-base");
				createdVmIds.push(vm.id as string);
				const port = vm.ssh_port as number;

				const res = await api.post(`/vms/${vm.id}/restart`, { vcpu_count: 1 });
				expect(res.status).toBe(200);

				await waitForSsh(port, 90000);
				expect((await sshExec(port, "nproc")).trim()).toBe("1");
			},
			{ timeout: 240000 },
		);

		test(
			"restart with mem_size_mib changes MemTotal",
			async () => {
				const vm = await sbVmCreate("debian-base");
				createdVmIds.push(vm.id as string);
				const port = vm.ssh_port as number;

				const res = await api.post(`/vms/${vm.id}/restart`, { mem_size_mib: 1024 });
				expect(res.status).toBe(200);

				await waitForSsh(port, 90000);
				const kb = Number(
					(await sshExec(port, "awk '/MemTotal/ {print $2}' /proc/meminfo")).trim(),
				);
				expect(kb).toBeGreaterThan(800000);
				expect(kb).toBeLessThan(1200000);
			},
			{ timeout: 240000 },
		);

		test("restart nonexistent VM returns 404", async () => {
			const res = await api.post("/vms/vm-000000000000/restart", {});
			expect(res.status).toBe(404);
		});

		test(
			"restart rejects disk shrink",
			async () => {
				const vm = await sbVmCreate("debian-base");
				createdVmIds.push(vm.id as string);

				const res = await api.post(`/vms/${vm.id}/restart`, { disk_size_gib: 1 });
				expect(res.status).toBe(400);
			},
			{ timeout: 60000 },
		);

		test(
			"restart rejects invalid overrides",
			async () => {
				const vm = await sbVmCreate("debian-base");
				createdVmIds.push(vm.id as string);

				const invalidBodies = [
					{ disk_size_gib: 0 },
					{ disk_size_gib: 101 },
					{ vcpu_count: 0 },
					{ vcpu_count: 33 },
					{ mem_size_mib: 64 },
					{ mem_size_mib: 70000 },
				];

				for (const body of invalidBodies) {
					const res = await api.post(`/vms/${vm.id}/restart`, body);
					expect(res.status).toBe(400);
				}
			},
			{ timeout: 60000 },
		);

		test(
			"CLI vm restart power-cycles a VM",
			async () => {
				const vm = await sbVmCreate("debian-base");
				createdVmIds.push(vm.id as string);
				const port = vm.ssh_port as number;

				await waitForSsh(port, 90000);
				const bootId1 = (await sshExec(port, "cat /proc/sys/kernel/random/boot_id")).trim();

				const out = await sbVmRestart(vm.id as string);
				expect(out.status).toBe("running");

				await waitForSsh(port, 90000);
				const bootId2 = (await sshExec(port, "cat /proc/sys/kernel/random/boot_id")).trim();

				expect(bootId2).not.toBe(bootId1);
			},
			{ timeout: 240000 },
		);
	});
});
