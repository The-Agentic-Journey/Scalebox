import { exec as execCallback } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { config } from "../config";
import { vms } from "./vm";

const exec = promisify(execCallback);

export async function updateCaddyConfig(): Promise<void> {
	// Skip if baseDomain is not configured
	if (!config.baseDomain) {
		return;
	}

	// Build Caddyfile content
	const vmRoutes = Array.from(vms.values())
		.map((vm) => {
			return `	@${vm.name} host ${vm.name}.${config.baseDomain}
	handle @${vm.name} {
		reverse_proxy ${vm.ip}:8080
	}`;
		})
		.join("\n\n");

	const caddyfile = `{
	on_demand_tls {
		ask http://localhost:${config.apiPort}/caddy/check
	}
}

*.${config.baseDomain} {
	tls {
		on_demand
	}

${vmRoutes}

	handle {
		respond "VM not found" 404
	}
}
`;

	// Write Caddyfile
	await writeFile("/etc/caddy/Caddyfile", caddyfile);

	// Reload Caddy
	await exec("systemctl reload caddy");
}
