import { readdir } from "node:fs/promises";
import { $ } from "bun";
import { config } from "../config";
import { stopFirecracker } from "./firecracker";
import { deleteTapDevice } from "./network";
import { deleteRootfs } from "./storage";
import { vms } from "./vm";

function log(msg: string): void {
	console.log(`[reconcile] ${msg}`);
}

export async function reconcileOrphans(): Promise<void> {
	log("Scanning for orphaned resources...");

	const knownVmIds = new Set(vms.keys());
	const knownPids = new Set(Array.from(vms.values()).map((vm) => vm.pid));
	const knownTapDevices = new Set(Array.from(vms.values()).map((vm) => vm.tapDevice));

	let cleanedProcesses = 0;
	let cleanedTapDevices = 0;
	let cleanedRootfsFiles = 0;

	// 1. Discover and kill orphaned Firecracker processes
	// Uses pgrep -a to get PID + full command line, then matches Scalebox socket pattern
	try {
		const output = await $`pgrep -a firecracker`.text();
		for (const line of output.trim().split("\n")) {
			if (!line.trim()) continue;

			const pidMatch = line.match(/^(\d+)/);
			if (!pidMatch) continue;
			const pid = Number.parseInt(pidMatch[1]);

			// Only consider Scalebox-managed processes (socket path anchored to /tmp/)
			const socketMatch = line.match(/\/tmp\/firecracker-(vm-[0-9a-f]{12})\.sock/);
			if (!socketMatch) continue;

			if (!knownPids.has(pid)) {
				const vmId = socketMatch[1];
				log(`Found orphaned Firecracker process PID ${pid} (${vmId}) — killing`);
				await stopFirecracker(pid);
				cleanedProcesses++;
			}
		}
	} catch {
		// pgrep returns exit code 1 when no processes match — this is normal
	}

	// 2. Discover and delete orphaned TAP devices
	// Lists network interfaces via /sys/class/net/ and filters for tap-* pattern
	try {
		const output = await $`ls /sys/class/net/`.text();
		const tapDevices = output.split(/\s+/).filter((name) => name.startsWith("tap-"));

		for (const tap of tapDevices) {
			if (!knownTapDevices.has(tap)) {
				log(`Found orphaned TAP device ${tap} — deleting`);
				await deleteTapDevice(tap);
				cleanedTapDevices++;
			}
		}
	} catch {
		// /sys/class/net/ read failure — skip TAP cleanup
	}

	// 3. Discover and delete orphaned rootfs files
	// Lists *.ext4 files in the vms directory and checks against known VM IDs
	try {
		const vmsDir = `${config.dataDir}/vms`;
		const files = await readdir(vmsDir);

		for (const file of files) {
			// Only consider files matching the exact Scalebox VM rootfs pattern
			if (!/^vm-[0-9a-f]{12}\.ext4$/.test(file)) continue;

			// Extract VM ID from filename: "vm-a1b2c3d4e5f6.ext4" -> "vm-a1b2c3d4e5f6"
			const vmId = file.replace(".ext4", "");

			if (!knownVmIds.has(vmId)) {
				const fullPath = `${vmsDir}/${file}`;
				log(`Found orphaned rootfs ${fullPath} — deleting`);
				await deleteRootfs(fullPath);
				cleanedRootfsFiles++;
			}
		}
	} catch {
		// vms directory may not exist on fresh install — skip rootfs cleanup
	}

	const total = cleanedProcesses + cleanedTapDevices + cleanedRootfsFiles;
	if (total === 0) {
		log("No orphaned resources found");
	} else {
		log(
			`Cleaned up: ${cleanedProcesses} process(es), ${cleanedTapDevices} TAP device(s), ${cleanedRootfsFiles} rootfs file(s)`,
		);
	}
}
