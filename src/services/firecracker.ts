import { $ } from "bun";
import { config } from "../config";

interface FirecrackerConfig {
	socketPath: string;
	kernelPath: string;
	rootfsPath: string;
	bootArgs: string;
	tapDevice: string;
	macAddress: string;
	vcpuCount: number;
	memSizeMib: number;
}

export async function startFirecracker(cfg: FirecrackerConfig): Promise<number> {
	// Remove old socket if it exists
	try {
		await $`rm -f ${cfg.socketPath}`.quiet();
	} catch {
		// Ignore
	}

	// Start Firecracker process
	const proc = Bun.spawn(["firecracker", "--api-sock", cfg.socketPath], {
		stdout: "ignore",
		stderr: "ignore",
	});

	// Wait for socket to be available
	await waitForSocket(cfg.socketPath);

	// Configure boot source
	await configureVm(cfg);

	// Start the VM
	await startVm(cfg.socketPath);

	return proc.pid;
}

async function waitForSocket(socketPath: string, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			await $`test -S ${socketPath}`.quiet();
			return;
		} catch {
			await Bun.sleep(100);
		}
	}
	throw new Error("Firecracker socket not available");
}

async function configureVm(cfg: FirecrackerConfig): Promise<void> {
	const socket = cfg.socketPath;

	// Set boot source
	const bootResult =
		await $`curl -s --unix-socket ${socket} -X PUT http://localhost/boot-source -H 'Content-Type: application/json' -d ${JSON.stringify(
			{
				kernel_image_path: cfg.kernelPath,
				boot_args: cfg.bootArgs,
			},
		)}`.text();
	if (bootResult) {
		console.log("Boot source response:", bootResult);
	}

	// Set rootfs
	const rootfsResult =
		await $`curl -s --unix-socket ${socket} -X PUT http://localhost/drives/rootfs -H 'Content-Type: application/json' -d ${JSON.stringify(
			{
				drive_id: "rootfs",
				path_on_host: cfg.rootfsPath,
				is_root_device: true,
				is_read_only: false,
			},
		)}`.text();
	if (rootfsResult) {
		console.log("Rootfs response:", rootfsResult);
	}

	// Set network
	const networkResult =
		await $`curl -s --unix-socket ${socket} -X PUT http://localhost/network-interfaces/eth0 -H 'Content-Type: application/json' -d ${JSON.stringify(
			{
				iface_id: "eth0",
				guest_mac: cfg.macAddress,
				host_dev_name: cfg.tapDevice,
			},
		)}`.text();
	if (networkResult) {
		console.log("Network response:", networkResult);
	}

	// Set machine config
	const machineResult =
		await $`curl -s --unix-socket ${socket} -X PUT http://localhost/machine-config -H 'Content-Type: application/json' -d ${JSON.stringify(
			{
				vcpu_count: cfg.vcpuCount,
				mem_size_mib: cfg.memSizeMib,
			},
		)}`.text();
	if (machineResult) {
		console.log("Machine config response:", machineResult);
	}
}

async function startVm(socketPath: string): Promise<void> {
	await $`curl --unix-socket ${socketPath} -X PUT http://localhost/actions -H 'Content-Type: application/json' -d '{"action_type": "InstanceStart"}'`.quiet();
}

export async function stopFirecracker(pid: number): Promise<void> {
	try {
		process.kill(pid, "SIGTERM");
		// Wait a bit for graceful shutdown
		await Bun.sleep(500);
		// Force kill if still running
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already dead
		}
	} catch {
		// Process already dead
	}
}

export function buildKernelArgs(ip: string): string {
	return `console=ttyS0 reboot=k panic=1 pci=off ip=${ip}::172.16.0.1:255.255.0.0::eth0:off`;
}
