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
