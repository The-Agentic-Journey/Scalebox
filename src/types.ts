export interface VM {
	id: string;
	name?: string;
	template: string;
	ip: string;
	port: number;
	pid: number;
	vcpuCount: number;
	memSizeMib: number;
	socketPath: string;
	rootfsPath: string;
	tapDevice: string;
	createdAt: Date;
}

export interface VMResponse {
	id: string;
	name: string;
	template: string;
	ip: string;
	ssh_port: number;
	ssh: string;
	url: string | null;
	status: "running" | "stopped";
	created_at: string;
	console_log_path: string;
	console_log_size: number;
	degraded: boolean;
}

export interface CreateVMRequest {
	template: string;
	name?: string;
	ssh_public_key: string;
	vcpu_count?: number;
	mem_size_mib?: number;
	disk_size_gib?: number; // defaults to template size
	env?: Record<string, string>;
	files?: Array<{ path: string; content: string }>;
	init_script?: string;
}

export interface SnapshotRequest {
	template_name: string;
}

export interface SnapshotResponse {
	template: string;
	source_vm: string;
	size_bytes: number;
	created_at: string;
}
