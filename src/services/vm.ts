import { randomBytes } from "node:crypto";
import { config } from "../config";
import type { CreateVMRequest, VM, VMResponse } from "../types";
import { buildKernelArgs, startFirecracker, stopFirecracker } from "./firecracker";
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
import { copyRootfs, deleteRootfs, injectSshKey } from "./storage";

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

	const vmId = generateVmId();
	const ip = allocateIp();
	const port = allocatePort(config.portMin, config.portMax);
	const tapDevice = `tap-${vmId.substring(0, 12)}`;
	const socketPath = `/tmp/firecracker-${vmId}.sock`;

	let rootfsPath: string;

	try {
		// Copy rootfs from template
		rootfsPath = await copyRootfs(req.template, vmId);

		// Inject SSH key
		await injectSshKey(rootfsPath, req.ssh_public_key);

		// Create TAP device
		await createTapDevice(tapDevice);

		// Start Firecracker
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
		await startProxy(vmId, port, ip, 22);

		// Create VM record
		const vm: VM = {
			id: vmId,
			name: req.name,
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
		return vm;
	} catch (e) {
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
	return {
		id: vm.id,
		name: vm.name || null,
		template: vm.template,
		ip: vm.ip,
		ssh_port: vm.port,
		ssh: `ssh -p ${vm.port} root@${host}`,
		status: "running",
		created_at: vm.createdAt.toISOString(),
	};
}
