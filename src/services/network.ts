import { $ } from "bun";

// Track allocated IPs and ports
const allocatedIps = new Set<string>();
const allocatedPorts = new Set<number>();

// IP allocation: start from 172.16.0.2 (172.16.0.1 is the bridge)
let nextIpCounter = 2;

export function allocateIp(): string {
	// Simple sequential allocation
	const high = Math.floor(nextIpCounter / 256);
	const low = nextIpCounter % 256;
	const ip = `172.16.${high}.${low}`;
	allocatedIps.add(ip);
	nextIpCounter++;
	return ip;
}

export function releaseIp(ip: string): void {
	allocatedIps.delete(ip);
}

export function allocatePort(portMin: number, portMax: number): number {
	for (let port = portMin; port <= portMax; port++) {
		if (!allocatedPorts.has(port)) {
			allocatedPorts.add(port);
			return port;
		}
	}
	throw new Error("No available ports");
}

export function releasePort(port: number): void {
	allocatedPorts.delete(port);
}

export async function createTapDevice(tapName: string): Promise<void> {
	await $`ip tuntap add ${tapName} mode tap`.quiet();
	await $`ip link set ${tapName} master br0`.quiet();
	await $`ip link set ${tapName} up`.quiet();
}

export async function deleteTapDevice(tapName: string): Promise<void> {
	try {
		await $`ip link del ${tapName}`.quiet();
	} catch {
		// Ignore errors if device doesn't exist
	}
}

export function vmIdToMac(vmId: string): string {
	// Generate MAC from VM ID: AA:FC:XX:XX:XX:XX
	const hex = vmId.replace("vm-", "");
	const parts = hex.match(/.{2}/g) || [];
	return `AA:FC:${parts.join(":")}`.toUpperCase();
}
