import { $ } from "bun";

interface UdpRule {
	localPort: number;
	targetIp: string;
	targetPort: number;
	extIf: string; // Store interface to ensure consistent cleanup
}

// Track active rules for cleanup and state management
const activeRules = new Map<string, UdpRule>();

function log(msg: string): void {
	console.log(`[udp-proxy] ${msg}`);
}

// Get external interface (same robust logic as install.sh)
async function getExternalInterface(): Promise<string> {
	const result =
		await $`ip route | awk '/default/ {for(i=1;i<=NF;i++) if($i=="dev") print $(i+1); exit}'`.text();
	const iface = result.trim();
	if (!iface) {
		log("WARNING: Could not detect external interface, falling back to eth0");
		return "eth0";
	}
	return iface;
}

export async function startUdpProxy(
	vmId: string,
	localPort: number,
	targetIp: string,
	targetPort: number,
): Promise<void> {
	// Mosh requires the same port for client and server (--port flag sets both)
	if (localPort !== targetPort) {
		throw new Error(
			`UDP proxy port mismatch: localPort=${localPort} but targetPort=${targetPort}. Mosh requires identical ports.`,
		);
	}

	const extIf = await getExternalInterface();

	// Track the rule BEFORE adding iptables rules so cleanup works if verification fails
	// (iptables commands may succeed but verification may fail)
	activeRules.set(vmId, { localPort, targetIp, targetPort, extIf });

	try {
		// Add DNAT rule for incoming UDP (specify interface to avoid internal traffic)
		await $`sudo iptables -t nat -A PREROUTING -i ${extIf} -p udp --dport ${localPort} -j DNAT --to-destination ${targetIp}:${targetPort}`.quiet();

		// Add MASQUERADE for return traffic
		await $`sudo iptables -t nat -A POSTROUTING -p udp -d ${targetIp} --dport ${targetPort} -j MASQUERADE`.quiet();

		// Verify rules were actually created (iptables can fail silently with .quiet())
		const rules = await $`sudo iptables-save -t nat`.text().catch(() => "");
		const expectedDnat = `--to-destination ${targetIp}:${targetPort}`;
		const expectedMasq = `-d ${targetIp}`;
		if (!rules.includes(expectedDnat) || !rules.includes(expectedMasq)) {
			throw new Error(`Failed to create UDP proxy rules for ${targetIp}:${targetPort}`);
		}

		log(`UDP proxy started: ${extIf}:${localPort} -> ${targetIp}:${targetPort}`);
	} catch (err) {
		// Clean up tracking and any rules that may have been created
		activeRules.delete(vmId);
		await $`sudo iptables -t nat -D PREROUTING -i ${extIf} -p udp --dport ${localPort} -j DNAT --to-destination ${targetIp}:${targetPort}`
			.quiet()
			.nothrow();
		await $`sudo iptables -t nat -D POSTROUTING -p udp -d ${targetIp} --dport ${targetPort} -j MASQUERADE`
			.quiet()
			.nothrow();
		throw err;
	}
}

export async function stopUdpProxy(vmId: string): Promise<void> {
	const rule = activeRules.get(vmId);
	if (!rule) {
		log(`No UDP rule found for ${vmId}`);
		return;
	}

	// Use stored interface (avoids race condition if interface changes)
	const { localPort, targetIp, targetPort, extIf } = rule;

	// Remove DNAT rule
	await $`sudo iptables -t nat -D PREROUTING -i ${extIf} -p udp --dport ${localPort} -j DNAT --to-destination ${targetIp}:${targetPort}`
		.quiet()
		.nothrow();

	// Remove MASQUERADE rule
	await $`sudo iptables -t nat -D POSTROUTING -p udp -d ${targetIp} --dport ${targetPort} -j MASQUERADE`
		.quiet()
		.nothrow();

	activeRules.delete(vmId);
	log(`UDP proxy stopped: port ${localPort}`);
}

// Clean up ALL orphaned rules on startup
// Since VMs don't survive restart (in-memory state), all rules targeting our VM subnet are orphans
//
// Uses iptables-save format which is stable across versions, then deletes by subnet match.
// This is more robust than regex parsing of iptables -L output.
//
// NOTE: Cleanup is best-effort. If it fails (permissions, iptables busy, etc.):
// - Orphan rules are harmless (they forward to non-existent VMs, traffic is dropped)
// - New VMs get fresh rules that work correctly
// - Manual cleanup: sudo iptables -t nat -F (flushes all NAT rules - use with caution)
export async function cleanupOrphanedUdpRules(): Promise<void> {
	const extIf = await getExternalInterface();

	// Use iptables-save format for reliable parsing
	const rules = await $`sudo iptables-save -t nat`.text().catch((err) => {
		log(`WARNING: Failed to read iptables rules for cleanup: ${err.message || err}`);
		return "";
	});

	if (!rules) {
		log("Skipping orphan cleanup (no rules to process)");
		return;
	}

	for (const line of rules.split("\n")) {
		// Match PREROUTING DNAT rules targeting our VM subnet (172.16.x.x)
		// Format: -A PREROUTING -i eth0 -p udp -m udp --dport 22001 -j DNAT --to-destination 172.16.0.2:22001
		if (line.includes("-A PREROUTING") && line.includes("-p udp") && line.includes("172.16.")) {
			const portMatch = line.match(/--dport (\d+)/);
			const destMatch = line.match(/--to-destination (172\.16\.\d+\.\d+:\d+)/);
			if (portMatch && destMatch) {
				log(`Cleaning up orphaned PREROUTING rule for port ${portMatch[1]}`);
				await $`sudo iptables -t nat -D PREROUTING -i ${extIf} -p udp --dport ${portMatch[1]} -j DNAT --to-destination ${destMatch[1]}`
					.quiet()
					.nothrow();
			}
		}

		// Match POSTROUTING MASQUERADE rules targeting our VM subnet
		// Format: -A POSTROUTING -d 172.16.0.2/32 -p udp -m udp --dport 22001 -j MASQUERADE
		if (
			line.includes("-A POSTROUTING") &&
			line.includes("-p udp") &&
			line.includes("-d 172.16.") &&
			line.includes("MASQUERADE")
		) {
			const destMatch = line.match(/-d (172\.16\.\d+\.\d+)/);
			const portMatch = line.match(/--dport (\d+)/);
			if (destMatch && portMatch) {
				log(`Cleaning up orphaned POSTROUTING rule for ${destMatch[1]}:${portMatch[1]}`);
				await $`sudo iptables -t nat -D POSTROUTING -p udp -d ${destMatch[1]} --dport ${portMatch[1]} -j MASQUERADE`
					.quiet()
					.nothrow();
			}
		}
	}
}
