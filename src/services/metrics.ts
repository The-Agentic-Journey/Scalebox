// In-memory per-VM and global counters for scaleboxd. Exposed via GET /metrics
// and summarised every 5 min to the journal so we can spot leaks and degraded
// VMs without external instrumentation.

interface VmCounters {
	connectionsAccepted: number;
	connectionsCurrentlyOpen: number;
	vmConnectSuccesses: number;
	vmConnectFailures: number;
	pendingBytesQueued: number;
	consecutiveFailures: number;
	lastConnectSuccessAt: number | null;
	lastConnectFailureAt: number | null;
}

const counters = new Map<string, VmCounters>();
const startedAt = Date.now();

export const DEGRADED_THRESHOLD = 10;

function ensure(vmId: string): VmCounters {
	let c = counters.get(vmId);
	if (!c) {
		c = {
			connectionsAccepted: 0,
			connectionsCurrentlyOpen: 0,
			vmConnectSuccesses: 0,
			vmConnectFailures: 0,
			pendingBytesQueued: 0,
			consecutiveFailures: 0,
			lastConnectSuccessAt: null,
			lastConnectFailureAt: null,
		};
		counters.set(vmId, c);
	}
	return c;
}

export function recordConnectionAccepted(vmId: string): void {
	const c = ensure(vmId);
	c.connectionsAccepted += 1;
	c.connectionsCurrentlyOpen += 1;
}

export function recordConnectionClosed(vmId: string): void {
	const c = ensure(vmId);
	c.connectionsCurrentlyOpen = Math.max(0, c.connectionsCurrentlyOpen - 1);
}

export function recordVmConnectSuccess(vmId: string): void {
	const c = ensure(vmId);
	c.vmConnectSuccesses += 1;
	c.consecutiveFailures = 0;
	c.lastConnectSuccessAt = Date.now();
}

// Returns true on the exact crossing of the degraded threshold so the caller
// can emit a one-shot ERROR rather than spamming on every failure.
export function recordVmConnectFailure(vmId: string): boolean {
	const c = ensure(vmId);
	c.vmConnectFailures += 1;
	c.consecutiveFailures += 1;
	c.lastConnectFailureAt = Date.now();
	return c.consecutiveFailures === DEGRADED_THRESHOLD;
}

export function recordPendingBytes(vmId: string, delta: number): void {
	const c = ensure(vmId);
	c.pendingBytesQueued = Math.max(0, c.pendingBytesQueued + delta);
}

export function removeVm(vmId: string): void {
	counters.delete(vmId);
}

export function isDegraded(vmId: string, threshold: number = DEGRADED_THRESHOLD): boolean {
	const c = counters.get(vmId);
	if (!c) return false;
	return c.consecutiveFailures >= threshold;
}

export function snapshot() {
	const mem = process.memoryUsage();
	return {
		uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
		process: {
			rss: mem.rss,
			heap_total: mem.heapTotal,
			heap_used: mem.heapUsed,
			external: mem.external,
			array_buffers: mem.arrayBuffers,
		},
		vms: Object.fromEntries(
			Array.from(counters.entries()).map(([vmId, c]) => [
				vmId,
				{
					connections_accepted: c.connectionsAccepted,
					connections_currently_open: c.connectionsCurrentlyOpen,
					vm_connect_successes: c.vmConnectSuccesses,
					vm_connect_failures: c.vmConnectFailures,
					consecutive_failures: c.consecutiveFailures,
					pending_bytes_queued: c.pendingBytesQueued,
					last_connect_success_at: c.lastConnectSuccessAt,
					last_connect_failure_at: c.lastConnectFailureAt,
					degraded: isDegraded(vmId),
				},
			]),
		),
	};
}

export function summaryLine(): string {
	const mem = process.memoryUsage();
	let totalAccepted = 0;
	let totalOpen = 0;
	let totalFailures = 0;
	for (const c of counters.values()) {
		totalAccepted += c.connectionsAccepted;
		totalOpen += c.connectionsCurrentlyOpen;
		totalFailures += c.vmConnectFailures;
	}
	const rssMb = (mem.rss / (1024 * 1024)).toFixed(0);
	const heapMb = (mem.heapUsed / (1024 * 1024)).toFixed(0);
	return `[metrics] rss=${rssMb}MB heap=${heapMb}MB vms=${counters.size} conns_open=${totalOpen} conns_accepted=${totalAccepted} connect_failures=${totalFailures}`;
}
