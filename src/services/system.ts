import { readFile } from "node:fs/promises";
import { $ } from "bun";
import { config } from "../config";

export interface StorageStats {
	totalGb: number;
	usedGb: number;
	freeGb: number;
}

export interface MemoryStats {
	totalGb: number;
	freeGb: number;
}

/**
 * Get btrfs storage stats for the data directory.
 * Falls back to regular df if btrfs command fails.
 */
export async function getStorageStats(): Promise<StorageStats> {
	try {
		// Try btrfs filesystem df first for more accurate stats on btrfs
		const result = await $`btrfs filesystem df -b ${config.dataDir}`.text();

		// Parse btrfs output - look for Data line
		// Format: "Data, single: total=123456789, used=12345678"
		const dataLine = result.split("\n").find((line) => line.startsWith("Data"));
		if (dataLine) {
			const totalMatch = dataLine.match(/total=(\d+)/);
			const usedMatch = dataLine.match(/used=(\d+)/);
			if (totalMatch && usedMatch) {
				const totalBytes = Number.parseInt(totalMatch[1]);
				const usedBytes = Number.parseInt(usedMatch[1]);
				return {
					totalGb: Math.round((totalBytes / 1024 / 1024 / 1024) * 10) / 10,
					usedGb: Math.round((usedBytes / 1024 / 1024 / 1024) * 10) / 10,
					freeGb: Math.round(((totalBytes - usedBytes) / 1024 / 1024 / 1024) * 10) / 10,
				};
			}
		}
	} catch {
		// Fall through to df fallback
	}

	// Fallback to standard df
	const dfResult = await $`df -B1 ${config.dataDir} --output=size,used,avail | tail -1`.text();
	const parts = dfResult.trim().split(/\s+/);
	const totalBytes = Number.parseInt(parts[0]);
	const usedBytes = Number.parseInt(parts[1]);
	const availBytes = Number.parseInt(parts[2]);

	return {
		totalGb: Math.round((totalBytes / 1024 / 1024 / 1024) * 10) / 10,
		usedGb: Math.round((usedBytes / 1024 / 1024 / 1024) * 10) / 10,
		freeGb: Math.round((availBytes / 1024 / 1024 / 1024) * 10) / 10,
	};
}

/**
 * Get memory stats from /proc/meminfo.
 */
export async function getMemoryStats(): Promise<MemoryStats> {
	const meminfo = await readFile("/proc/meminfo", "utf-8");
	const lines = meminfo.split("\n");

	let totalKb = 0;
	let freeKb = 0;
	let buffersKb = 0;
	let cachedKb = 0;

	for (const line of lines) {
		if (line.startsWith("MemTotal:")) {
			totalKb = Number.parseInt(line.split(/\s+/)[1]);
		} else if (line.startsWith("MemFree:")) {
			freeKb = Number.parseInt(line.split(/\s+/)[1]);
		} else if (line.startsWith("Buffers:")) {
			buffersKb = Number.parseInt(line.split(/\s+/)[1]);
		} else if (line.startsWith("Cached:")) {
			cachedKb = Number.parseInt(line.split(/\s+/)[1]);
		}
	}

	// Available memory is free + buffers + cached (reclaimable)
	const availableKb = freeKb + buffersKb + cachedKb;

	return {
		totalGb: Math.round((totalKb / 1024 / 1024) * 10) / 10,
		freeGb: Math.round((availableKb / 1024 / 1024) * 10) / 10,
	};
}

/**
 * Get CPU usage percentage from /proc/stat.
 * This measures CPU usage over a short sampling period.
 */
export async function getCpuUsage(): Promise<number> {
	// Read CPU stats twice with a short delay to calculate usage
	const readCpuStats = async () => {
		const stat = await readFile("/proc/stat", "utf-8");
		const cpuLine = stat.split("\n").find((line) => line.startsWith("cpu "));
		if (!cpuLine) return null;

		// cpu user nice system idle iowait irq softirq steal guest guest_nice
		const parts = cpuLine.split(/\s+/).slice(1).map(Number);
		const idle = parts[3] + (parts[4] || 0); // idle + iowait
		const total = parts.reduce((a, b) => a + b, 0);
		return { idle, total };
	};

	const first = await readCpuStats();
	if (!first) return 0;

	// Wait 100ms between samples
	await new Promise((resolve) => setTimeout(resolve, 100));

	const second = await readCpuStats();
	if (!second) return 0;

	const idleDelta = second.idle - first.idle;
	const totalDelta = second.total - first.total;

	if (totalDelta === 0) return 0;

	const usage = ((totalDelta - idleDelta) / totalDelta) * 100;
	return Math.round(usage * 10) / 10;
}

/**
 * Get the host IP address.
 * Uses environment variable if set, otherwise auto-detects from default route.
 */
export async function getHostIp(): Promise<string> {
	// Check environment variable first
	if (process.env.HOST_IP) {
		return process.env.HOST_IP;
	}

	try {
		// Auto-detect from default route
		const result = await $`ip route get 1.1.1.1 | head -1`.text();
		const match = result.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
		if (match) {
			return match[1];
		}
	} catch {
		// Fall through
	}

	return "unknown";
}
