export const config = {
	apiPort: Number(process.env.API_PORT) || 8080,
	apiToken: process.env.API_TOKEN || "dev-token",
	dataDir: process.env.DATA_DIR || "/var/lib/scalebox",
	kernelPath: process.env.KERNEL_PATH || "/var/lib/scalebox/kernel/vmlinux",
	portMin: Number(process.env.PORT_MIN) || 22001,
	portMax: Number(process.env.PORT_MAX) || 32000,
	defaultVcpuCount: Number(process.env.DEFAULT_VCPU_COUNT) || 2,
	defaultMemSizeMib: Number(process.env.DEFAULT_MEM_SIZE_MIB) || 512,
	defaultDiskSizeGib: Number(process.env.DEFAULT_DISK_SIZE_GIB) || 2,
	maxDiskSizeGib: Number(process.env.MAX_DISK_SIZE_GIB) || 100,
	protectedTemplates: ["debian-base"],
	// Domain for VM HTTPS access (e.g., "vms.example.com")
	// When set, VMs are accessible at https://{vm-name}.{vmDomain}
	vmDomain: process.env.VM_DOMAIN || "",
};
