import { afterEach, describe, expect, test } from "bun:test";
import {
	DEGRADED_THRESHOLD,
	isDegraded,
	recordConnectionAccepted,
	recordConnectionClosed,
	recordPendingBytes,
	recordVmConnectFailure,
	recordVmConnectSuccess,
	removeVm,
	snapshot,
	summaryLine,
} from "../src/services/metrics";

describe("metrics", () => {
	const TEST_ID = "vm-metrics-test";

	afterEach(() => {
		removeVm(TEST_ID);
	});

	test("connection counters open/close balance", () => {
		recordConnectionAccepted(TEST_ID);
		recordConnectionAccepted(TEST_ID);
		recordConnectionClosed(TEST_ID);
		const s = snapshot();
		const c = s.vms[TEST_ID];
		expect(c.connections_accepted).toBe(2);
		expect(c.connections_currently_open).toBe(1);
	});

	test("pendingBytes saturates at zero on over-subtract", () => {
		recordPendingBytes(TEST_ID, 100);
		recordPendingBytes(TEST_ID, -500);
		const c = snapshot().vms[TEST_ID];
		expect(c.pending_bytes_queued).toBe(0);
	});

	test("threshold crossing returns true exactly once", () => {
		let crossed = false;
		for (let i = 1; i <= DEGRADED_THRESHOLD; i++) {
			const r = recordVmConnectFailure(TEST_ID);
			if (i === DEGRADED_THRESHOLD) crossed = r;
			else expect(r).toBe(false);
		}
		expect(crossed).toBe(true);
		expect(isDegraded(TEST_ID)).toBe(true);
		// 11th failure also returns false (already crossed)
		expect(recordVmConnectFailure(TEST_ID)).toBe(false);
		expect(isDegraded(TEST_ID)).toBe(true);
	});

	test("success resets consecutive failures and clears degraded", () => {
		for (let i = 0; i < DEGRADED_THRESHOLD; i++) recordVmConnectFailure(TEST_ID);
		expect(isDegraded(TEST_ID)).toBe(true);
		recordVmConnectSuccess(TEST_ID);
		expect(isDegraded(TEST_ID)).toBe(false);
		const c = snapshot().vms[TEST_ID];
		expect(c.consecutive_failures).toBe(0);
		expect(c.last_connect_success_at).toBeGreaterThan(0);
	});

	test("snapshot is JSON-serialisable and has expected shape", () => {
		recordConnectionAccepted(TEST_ID);
		const s = snapshot();
		expect(s.uptime_seconds).toBeGreaterThanOrEqual(0);
		expect(s.process.rss).toBeGreaterThan(0);
		expect(JSON.parse(JSON.stringify(s))).toEqual(s);
	});

	test("summaryLine includes the rss/heap/conns tokens", () => {
		recordConnectionAccepted(TEST_ID);
		const line = summaryLine();
		expect(line).toContain("[metrics]");
		expect(line).toContain("rss=");
		expect(line).toContain("heap=");
		expect(line).toContain("conns_open=");
	});
});
