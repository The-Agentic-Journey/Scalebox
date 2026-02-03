import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
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
	createTapDevice,
	deleteTapDevice,
	releaseIp,
	releasePort,
	vmIdToMac,
} from "./network";
import { startProxy, stopProxy } from "./proxy";
import {
	clearAuthorizedKeys,
	copyRootfs,
	copyRootfsToTemplate,
	deleteRootfs,
	injectSshKey,
} from "./storage";

// In-memory VM state
export const vms = new Map<string, VM>();

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
		console.log(`[${vmId}] VM created successfully`);
		return vm;
	} catch (e) {
		// Log the error for debugging
		console.error(`[${vmId}] VM creation failed:`, e);

		// Cleanup on failure
		releaseIp(ip);
		releasePort(port);
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
}

export function vmToResponse(vm: VM): VMResponse {
	const host = process.env.VM_HOST || "localhost";
	const url = config.vmDomain ? `https://${vm.name}.${config.vmDomain}` : null;
	return {
		id: vm.id,
		name: vm.name,
		template: vm.template,
		ip: vm.ip,
		ssh_port: vm.port,
		ssh: `ssh -p ${vm.port} root@${host}`,
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
