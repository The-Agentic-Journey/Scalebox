import { open, stat } from "node:fs/promises";

// Patterns the kernel emits right before / during a fatal condition. Matching
// any of these in a VM's console log surfaces an ERROR in scaleboxd's journal,
// so we learn about a guest dying within seconds instead of next time we look.
export const PANIC_PATTERN =
	/Out of memory:|Kernel panic|hung task|soft lockup|BUG:|general protection fault/i;

const POLL_INTERVAL_MS = 5000;
const MAX_LINE_PREVIEW = 200;

interface Watcher {
	interval: ReturnType<typeof setInterval>;
	offset: number;
}

const watchers = new Map<string, Watcher>();

async function tick(vmId: string, path: string): Promise<void> {
	const w = watchers.get(vmId);
	if (!w) return;
	let size: number;
	try {
		size = (await stat(path)).size;
	} catch {
		return; // file missing — ignore until it appears
	}
	// File shrank → rotated (rotation happens at 50 MB in firecracker.ts)
	if (size < w.offset) w.offset = 0;
	if (size === w.offset) return;

	let fh: Awaited<ReturnType<typeof open>> | null = null;
	try {
		fh = await open(path, "r");
		const len = size - w.offset;
		const buf = Buffer.alloc(len);
		await fh.read(buf, 0, len, w.offset);
		w.offset = size;
		const text = buf.toString("utf8");
		for (const line of text.split("\n")) {
			if (!line) continue;
			const match = line.match(PANIC_PATTERN);
			if (match) {
				console.error(
					`[console] vm=${vmId} matched="${match[0]}": ${line.slice(0, MAX_LINE_PREVIEW)}`,
				);
			}
		}
	} catch {
		// ignore transient read errors
	} finally {
		if (fh) await fh.close().catch(() => {});
	}
}

export function watchConsole(vmId: string, path: string): void {
	if (watchers.has(vmId)) return;
	const interval = setInterval(() => {
		void tick(vmId, path);
	}, POLL_INTERVAL_MS);
	watchers.set(vmId, { interval, offset: 0 });
}

export function unwatchConsole(vmId: string): void {
	const w = watchers.get(vmId);
	if (!w) return;
	clearInterval(w.interval);
	watchers.delete(vmId);
}

// Test-only: synchronously process whatever's currently in the file. Lets
// us unit-test the pattern matching without waiting for the poll interval.
export async function _tickForTest(vmId: string, path: string): Promise<void> {
	if (!watchers.has(vmId)) {
		watchers.set(vmId, { interval: setInterval(() => {}, 1 << 30), offset: 0 });
	}
	await tick(vmId, path);
}
