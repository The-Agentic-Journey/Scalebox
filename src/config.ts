export const config = {
	// Server
	apiPort: Number.parseInt(process.env.API_PORT || "8080"),
	apiToken: process.env.API_TOKEN || "dev-5a30aabffc0d8308ec749c49d94164705fc2d4b57c50b800",

	// Storage
	dataDir: process.env.DATA_DIR || "/var/lib/firecracker",
	kernelPath: process.env.KERNEL_PATH || "/var/lib/firecracker/kernel/vmlinux",

	// Networking
	// Note: Port range (22001-32000 = ~10k ports) is the effective VM limit,
	// not the IP range (172.16.0.0/16 = ~65k IPs)
	portMin: Number.parseInt(process.env.PORT_MIN || "22001"),
	portMax: Number.parseInt(process.env.PORT_MAX || "32000"),

	// VM defaults
	defaultVcpuCount: Number.parseInt(process.env.DEFAULT_VCPU_COUNT || "2"),
	defaultMemSizeMib: Number.parseInt(process.env.DEFAULT_MEM_SIZE_MIB || "512"),

	// Protected templates - cannot be deleted via API
	protectedTemplates: ["debian-base"],
};
