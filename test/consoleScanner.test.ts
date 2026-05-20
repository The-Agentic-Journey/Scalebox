import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PANIC_PATTERN,
	_tickForTest,
	unwatchConsole,
	watchConsole,
} from "../src/services/consoleScanner";

describe("consoleScanner pattern", () => {
	test.each([
		"Out of memory: Killed process 1234 (postgres)",
		"Kernel panic - not syncing: Fatal exception",
		"INFO: task journald:142 blocked for more than 120 seconds (hung task)",
		"watchdog: BUG: soft lockup - CPU#0 stuck for 22s!",
		"BUG: unable to handle kernel paging request",
		"general protection fault: 0000 [#1] SMP",
	])("matches catastrophe line: %s", (line) => {
		expect(line).toMatch(PANIC_PATTERN);
	});

	test.each(["systemd[1]: Started something normal", "regular kernel ring buffer noise"])(
		"does NOT match benign line: %s",
		(line) => {
			expect(line).not.toMatch(PANIC_PATTERN);
		},
	);
});

describe("consoleScanner watch lifecycle", () => {
	let tmp: string;
	const vmId = "vm-scanner-test";

	afterEach(async () => {
		unwatchConsole(vmId);
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	test("logs ERROR when matching line appears", async () => {
		tmp = await mkdtemp(join(tmpdir(), "scanner-"));
		const logPath = join(tmp, "console.log");
		await writeFile(logPath, "boot ok\nmore boot stuff\n");

		const spy = mock(() => {});
		const original = console.error;
		console.error = spy as unknown as typeof console.error;

		try {
			await _tickForTest(vmId, logPath);
			expect(spy).not.toHaveBeenCalled();

			await writeFile(
				logPath,
				"boot ok\nmore boot stuff\nOut of memory: Killed process 99 (foo)\n",
			);
			await _tickForTest(vmId, logPath);

			expect(spy).toHaveBeenCalledTimes(1);
			const call = (spy.mock.calls[0] as unknown[])[0] as string;
			expect(call).toContain(`[console] vm=${vmId}`);
			expect(call).toContain("Out of memory");
		} finally {
			console.error = original;
		}
	});

	test("watchConsole + unwatchConsole are idempotent", () => {
		watchConsole(vmId, "/tmp/does-not-exist");
		watchConsole(vmId, "/tmp/does-not-exist"); // second call is no-op
		unwatchConsole(vmId);
		unwatchConsole(vmId); // second call is no-op
	});
});
