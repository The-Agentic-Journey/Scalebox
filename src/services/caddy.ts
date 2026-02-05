import { exec as execCallback } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { config } from "../config";
import { vms } from "./vm";

const exec = promisify(execCallback);

const VMSFILE = "/etc/caddy/vms.caddy";
const VMSFILE_TMP = "/etc/caddy/vms.caddy.tmp";

export async function updateCaddyConfig(): Promise<void> {
	// Build content
	const content = buildVmsCaddyContent();

	// Read current content for potential rollback
	let previousContent: string | null = null;
	try {
		previousContent = await readFile(VMSFILE, "utf-8");
	} catch {
		// File doesn't exist yet, no rollback needed
	}

	// Atomic write: write to .tmp then rename
	await writeFile(VMSFILE_TMP, content);
	await rename(VMSFILE_TMP, VMSFILE);

	// Reload Caddy
	try {
		await exec("systemctl reload caddy");
	} catch (error) {
		// Rollback on failure
		if (previousContent !== null) {
			await writeFile(VMSFILE, previousContent);
		}
		console.error("Caddy reload failed, rolled back vms.caddy:", error);
		// Don't throw - VM operation should still succeed
	}
}

function buildVmsCaddyContent(): string {
	if (!config.vmDomain) {
		return `# Managed by scaleboxd - do not edit manually
# VM routes are added here when VM_DOMAIN is configured
`;
	}

	// Build VM-specific routes
	const vmRoutes = Array.from(vms.values())
		.map((vm) => {
			return `	@${vm.name} host ${vm.name}.${config.vmDomain}
	handle @${vm.name} {
		reverse_proxy ${vm.ip}:8080
	}`;
		})
		.join("\n\n");

	return `# Managed by scaleboxd - do not edit manually
*.${config.vmDomain} {
	tls {
		on_demand
	}

${vmRoutes}

	handle {
		respond "VM not found" 404
	}
}
`;
}
