export interface VM {
	id: string;
	name?: string;
	template: string;
	ip: string;
	port: number;
	pid: number;
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
}

export interface CreateVMRequest {
	template: string;
	name?: string;
	ssh_public_key: string;
	vcpu_count?: number;
	mem_size_mib?: number;
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
