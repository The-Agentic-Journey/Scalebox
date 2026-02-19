import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { config } from "../config";
import type { CreateVMRequest, SnapshotResponse, VM, VMResponse } from "../types";
import {
	buildKernelArgs,
	pauseVm,
	resumeVm,
	startFirecracker,
	stopFirecracker,
} from "./firecracker";
import { generateUniqueName } from "./nameGenerator";
import {
	allocateIp,
	allocatePort,
	allocateSpecificIp,
	allocateSpecificPort,
	createTapDevice,
	deleteTapDevice,
	releaseIp,
	releasePort,
	vmIdToMac,
} from "./network";
import { startProxy, stopProxy } from "./proxy";
import {
	checkAvailableSpace,
	clearAuthorizedKeys,
	copyRootfs,
	copyRootfsToTemplate,
	deleteRootfs,
	injectSshKey,
	resizeRootfs,
} from "./storage";
import { startUdpProxy, stopUdpProxy } from "./udpProxy";

// In-memory VM state
export const vms = new Map<string, VM>();

// State persistence
const STATE_FILE = `${config.dataDir}/vms/state.json`;

interface PersistedVM {
	id: string;
	name: string;
	templateName: string;
	ip: string;
	tapDevice: string;
	sshPort: number;
	pid: number;
	socketPath: string;
	rootfsPath: string;
	createdAt: string;
}

export function saveState(): void {
	const state = Array.from(vms.values()).map((vm) => ({
		id: vm.id,
		name: vm.name || "",
		templateName: vm.template,
		ip: vm.ip,
		tapDevice: vm.tapDevice,
		sshPort: vm.port,
		pid: vm.pid,
		socketPath: vm.socketPath,
		rootfsPath: vm.rootfsPath,
		createdAt: vm.createdAt.toISOString(),
	}));
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0); // Signal 0 = check existence
		return true;
	} catch {
		return false;
	}
}

async function cleanupDeadVm(saved: PersistedVM): Promise<void> {
	console.log(`[${saved.id}] Cleaning up dead VM resources...`);

	// Clean up TAP device
	try {
		await deleteTapDevice(saved.tapDevice);
	} catch {}

	// Clean up rootfs
	try {
		await deleteRootfs(saved.rootfsPath);
	} catch {}
}

export async function recoverVms(): Promise<void> {
	if (!existsSync(STATE_FILE)) {
		console.log("[recovery] No state file found, starting fresh");
		return;
	}

	console.log("[recovery] Loading VM state from disk...");
	const state: PersistedVM[] = JSON.parse(readFileSync(STATE_FILE, "utf-8"));

	for (const saved of state) {
		const isRunning = processExists(saved.pid);

		if (isRunning) {
			console.log(`[recovery] Reconnecting to running VM ${saved.id} (${saved.name})`);

			// Re-register resource allocations
			allocateSpecificPort(saved.sshPort);
			allocateSpecificIp(saved.ip);

			// Restart TCP proxy for this VM
			try {
				await startProxy(saved.id, saved.sshPort, saved.ip, 22);
				console.log(`[recovery] TCP proxy started for ${saved.id}`);
			} catch (err) {
				console.error(`[recovery] Failed to start TCP proxy for ${saved.id}:`, err);
			}

			// Restart UDP proxy for mosh
			try {
				await startUdpProxy(saved.id, saved.sshPort, saved.ip, saved.sshPort);
				console.log(`[recovery] UDP proxy started for ${saved.id}`);
			} catch (err) {
				console.error(`[recovery] Failed to start UDP proxy for ${saved.id}:`, err);
			}

			// Reconstruct VM object and add to map
			vms.set(saved.id, {
				id: saved.id,
				name: saved.name,
				template: saved.templateName,
				ip: saved.ip,
				port: saved.sshPort,
				pid: saved.pid,
				socketPath: saved.socketPath,
				rootfsPath: saved.rootfsPath,
				tapDevice: saved.tapDevice,
				createdAt: new Date(saved.createdAt),
			});
		} else {
			console.log(`[recovery] VM ${saved.id} (${saved.name}) process died, cleaning up`);
			await cleanupDeadVm(saved);
		}
	}

	// Save state after recovery to remove dead VMs
	saveState();
	console.log(`[recovery] Recovered ${vms.size} VMs`);
}

export function findVm(idOrName: string): VM | undefined {
	// First try direct ID lookup (fast path)
	const byId = vms.get(idOrName);
	if (byId) return byId;

	// Fall back to name search (guard against undefined name)
	for (const vm of vms.values()) {
		if (vm.name && vm.name === idOrName) return vm;
	}
	return undefined;
}

// Mutex for VM creation
let creationLock: Promise<void> = Promise.resolve();

export async function withVmCreationLock<T>(fn: () => Promise<T>): Promise<T> {
	const previousLock = creationLock;
	let releaseLock: () => void = () => {};
	creationLock = new Promise((resolve) => {
		releaseLock = resolve;
	});

	try {
		await previousLock;
		return await fn();
	} finally {
		releaseLock();
	}
}

function generateVmId(): string {
	return `vm-${randomBytes(6).toString("hex")}`;
}

export async function createVm(req: CreateVMRequest): Promise<VM> {
	// Validate template name
	if (!/^[a-zA-Z0-9_-]+$/.test(req.template)) {
		throw { status: 400, message: "Invalid template name" };
	}

	// Pre-flight space check
	const diskSizeGib = req.disk_size_gib || config.defaultDiskSizeGib;
	await checkAvailableSpace(diskSizeGib);

	const name = req.name || generateUniqueName();
	const vmId = generateVmId();
	const ip = allocateIp();
	const port = allocatePort(config.portMin, config.portMax);
	// Linux interface names max 15 chars: "tap-" (4) + 10 hex chars = 14 chars
	const tapDevice = `tap-${vmId.slice(3, 13)}`;
	const socketPath = `/tmp/firecracker-${vmId}.sock`;

	let rootfsPath: string;

	try {
		// Copy rootfs from template
		console.log(`[${vmId}] Copying rootfs from template ${req.template}...`);
		rootfsPath = await copyRootfs(req.template, vmId);

		// Resize if custom size requested
		// Only resize if larger than base template
		if (diskSizeGib > 2) {
			console.log(`[${vmId}] Resizing rootfs to ${diskSizeGib}GB...`);
			await resizeRootfs(rootfsPath, diskSizeGib);
		}

		// Inject SSH key
		console.log(`[${vmId}] Injecting SSH key...`);
		await injectSshKey(rootfsPath, req.ssh_public_key);

		// Create TAP device
		console.log(`[${vmId}] Creating TAP device ${tapDevice}...`);
		await createTapDevice(tapDevice);

		// Start Firecracker
		console.log(`[${vmId}] Starting Firecracker...`);
		const pid = await startFirecracker({
			socketPath,
			kernelPath: config.kernelPath,
			rootfsPath,
			bootArgs: buildKernelArgs(ip),
			tapDevice,
			macAddress: vmIdToMac(vmId),
			vcpuCount: req.vcpu_count || config.defaultVcpuCount,
			memSizeMib: req.mem_size_mib || config.defaultMemSizeMib,
		});

		// Start TCP proxy for SSH
		console.log(`[${vmId}] Starting proxy on port ${port}...`);
		try {
			await startProxy(vmId, port, ip, 22);
			console.log(`[${vmId}] Proxy started successfully`);
		} catch (proxyError) {
			console.error(`[${vmId}] PROXY FAILED TO START:`, proxyError);
			throw proxyError;
		}

		// Start UDP proxy for mosh (use same host port, forward to same port on VM)
		await startUdpProxy(vmId, port, ip, port);

		// Create VM record
		const vm: VM = {
			id: vmId,
			name,
			template: req.template,
			ip,
			port,
			pid,
			socketPath,
			rootfsPath,
			tapDevice,
			createdAt: new Date(),
		};

		vms.set(vmId, vm);
		saveState();
		console.log(`[${vmId}] VM created successfully`);
		return vm;
	} catch (e) {
		// Log the error for debugging
		console.error(`[${vmId}] VM creation failed:`, e);

		// Cleanup on failure
		releaseIp(ip);
		releasePort(port);

		// Clean up TCP proxy if it was started
		try {
			stopProxy(vmId);
		} catch {}

		// Clean up UDP proxy if it was started
		try {
			await stopUdpProxy(vmId);
		} catch {}

		try {
			await deleteTapDevice(tapDevice);
		} catch {}
		if (rootfsPath) {
			try {
				await deleteRootfs(rootfsPath);
			} catch {}
		}
		throw e;
	}
}

export async function deleteVm(vm: VM): Promise<void> {
	// Stop UDP proxy for mosh
	await stopUdpProxy(vm.id);

	// Stop proxy
	stopProxy(vm.id);

	// Stop Firecracker
	await stopFirecracker(vm.pid);

	// Delete TAP device
	await deleteTapDevice(vm.tapDevice);

	// Delete rootfs
	await deleteRootfs(vm.rootfsPath);

	// Release resources
	releaseIp(vm.ip);
	releasePort(vm.port);

	// Remove from state
	vms.delete(vm.id);
	saveState();
}

export function vmToResponse(vm: VM): VMResponse {
	const url = config.vmDomain ? `https://${vm.name}.${config.vmDomain}` : null;
	return {
		id: vm.id,
		name: vm.name,
		template: vm.template,
		ip: config.hostIp,
		ssh_port: vm.port,
		ssh: `ssh -p ${vm.port} user@${config.hostIp}`,
		url,
		status: "running",
		created_at: vm.createdAt.toISOString(),
	};
}

export async function snapshotVm(vm: VM, templateName: string): Promise<SnapshotResponse> {
	// Validate template name (alphanumeric, dash, underscore only)
	if (!/^[a-zA-Z0-9_-]+$/.test(templateName)) {
		throw {
			status: 400,
			message: "Invalid template name. Use alphanumeric, dash, or underscore only.",
		};
	}

	// Check if template already exists
	const templatePath = `${config.dataDir}/templates/${templateName}.ext4`;
	if (existsSync(templatePath)) {
		throw { status: 409, message: "Template already exists" };
	}

	console.log(`[${vm.id}] Creating snapshot as template "${templateName}"...`);

	try {
		// Pause the VM
		console.log(`[${vm.id}] Pausing VM...`);
		await pauseVm(vm.socketPath);

		// Copy the rootfs to templates directory using reflink
		console.log(`[${vm.id}] Copying rootfs to template...`);
		await copyRootfsToTemplate(vm.rootfsPath, templateName);

		// Resume the VM
		console.log(`[${vm.id}] Resuming VM...`);
		await resumeVm(vm.socketPath);

		// Clear authorized_keys from the new template (so it's clean)
		console.log(`[${vm.id}] Clearing SSH authorized_keys from template...`);
		await clearAuthorizedKeys(templatePath);

		// Get template stats
		const stats = await stat(templatePath);

		console.log(`[${vm.id}] Snapshot created successfully as "${templateName}"`);

		return {
			template: templateName,
			source_vm: vm.id,
			size_bytes: stats.size,
			created_at: new Date().toISOString(),
		};
	} catch (e) {
		// Try to resume VM if paused but snapshot failed
		try {
			await resumeVm(vm.socketPath);
		} catch {
			// Ignore resume errors
		}
		throw e;
	}
}
