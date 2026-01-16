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

	// Extract vmId from socket path (e.g., /tmp/firecracker-abc123.sock -> abc123)
	const vmId = cfg.socketPath.replace("/tmp/firecracker-", "").replace(".sock", "");
	const logPath = `/tmp/fc-${vmId}-console.log`;

	// Start Firecracker process with console output captured to log file
	const proc = Bun.spawn(["firecracker", "--api-sock", cfg.socketPath], {
		stdout: "pipe",
		stderr: "pipe",
	});

	// Pipe stdout and stderr to log file for debugging VM console output
	const logFile = Bun.file(logPath);
	const logWriter = logFile.writer();

	// Async function to stream output to log file
	const pipeToLog = async (stream: ReadableStream<Uint8Array> | null) => {
		if (!stream) return;
		const reader = stream.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) {
					logWriter.write(value);
					logWriter.flush();
				}
			}
		} catch {
			// Stream closed or process exited
		}
	};

	// Start piping in background (don't await)
	pipeToLog(proc.stdout);
	pipeToLog(proc.stderr);

	console.log(`VM console output being captured to: ${logPath}`);

	// Wait for socket to be available
	await waitForSocket(cfg.socketPath);

	// Configure boot source
	await configureVm(cfg);

	// Start the VM
	const startResult = await startVm(cfg.socketPath);
	if (startResult) {
		// Check if it's an error response
		if (startResult.includes("fault_message")) {
			console.error("VM start failed:", startResult);
			throw new Error(`VM start failed: ${startResult}`);
		}
	}

	// Give the VM a moment to start and check if it's still running
	await Bun.sleep(500);

	// Check if process is still alive
	try {
		process.kill(proc.pid, 0); // Signal 0 tests if process exists
	} catch {
		throw new Error("Firecracker process died after start");
	}

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

async function startVm(socketPath: string): Promise<string> {
	const result =
		await $`curl -s --unix-socket ${socketPath} -X PUT http://localhost/actions -H 'Content-Type: application/json' -d '{"action_type": "InstanceStart"}'`.text();
	return result;
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

export async function pauseVm(socketPath: string): Promise<void> {
	const result =
		await $`curl -s --unix-socket ${socketPath} -X PATCH http://localhost/vm -H 'Content-Type: application/json' -d '{"state": "Paused"}'`.text();
	if (result?.includes("fault_message")) {
		throw new Error(`Failed to pause VM: ${result}`);
	}
}

export async function resumeVm(socketPath: string): Promise<void> {
	const result =
		await $`curl -s --unix-socket ${socketPath} -X PATCH http://localhost/vm -H 'Content-Type: application/json' -d '{"state": "Resumed"}'`.text();
	if (result?.includes("fault_message")) {
		throw new Error(`Failed to resume VM: ${result}`);
	}
}
