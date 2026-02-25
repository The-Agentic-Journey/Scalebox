import { exec as execCallback } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { config } from "../config";
import { vms } from "./vm";

const exec = promisify(execCallback);

const CADDYFILE = "/etc/caddy/Caddyfile";
const CADDYFILE_TMP = "/etc/caddy/Caddyfile.tmp";
const VMSFILE = "/etc/caddy/vms.caddy";
const VMSFILE_TMP = "/etc/caddy/vms.caddy.tmp";

export async function updateCaddyConfig(): Promise<void> {
	if (!config.baseDomain) {
		return;
	}

	const caddyfileContent = buildCaddyfileContent();
	const vmsContent = buildVmsCaddyContent();

	// Read current content for potential rollback
	let previousCaddyfile: string | null = null;
	let previousVmsFile: string | null = null;
	try {
		previousCaddyfile = await readFile(CADDYFILE, "utf-8");
		previousVmsFile = await readFile(VMSFILE, "utf-8");
	} catch {
		// Files don't exist yet
	}

	// Atomic write both files
	try {
		await writeFile(CADDYFILE_TMP, caddyfileContent);
		await rename(CADDYFILE_TMP, CADDYFILE);
		await writeFile(VMSFILE_TMP, vmsContent);
		await rename(VMSFILE_TMP, VMSFILE);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			console.log(
				"Skipping Caddy config update: /etc/caddy/ directory does not exist (Caddy may not be installed yet)",
			);
			return;
		}
		throw error;
	}

	// Reload Caddy (fall back to restart if Caddy isn't running yet)
	try {
		await exec("systemctl reload caddy");
	} catch {
		try {
			await exec("systemctl restart caddy");
		} catch (restartError) {
			// Rollback on failure
			if (previousCaddyfile !== null) {
				await writeFile(CADDYFILE, previousCaddyfile);
			}
			if (previousVmsFile !== null) {
				await writeFile(VMSFILE, previousVmsFile);
			}
			console.error("Caddy restart failed, rolled back config:", restartError);
		}
	}
}

function buildCaddyfileContent(): string {
	const apiDomain = `api.${config.baseDomain}`;
	const vmWildcard = `*.vm.${config.baseDomain}`;
	const acmeEndpoint = `http://localhost:${config.apiPort}/dns`;

	let globalBlock: string;
	if (config.acmeStaging) {
		globalBlock = `{
	acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
}`;
	} else {
		globalBlock = "{}";
	}

	return `# Managed by scaleboxd - do not edit manually
${globalBlock}

${apiDomain} {
	tls {
		dns acmeproxy {
			endpoint ${acmeEndpoint}
			username caddy
			password ${config.acmeProxyPassword}
		}
		resolvers 127.0.0.1
	}
	reverse_proxy localhost:${config.apiPort}
}

${vmWildcard} {
	tls {
		dns acmeproxy {
			endpoint ${acmeEndpoint}
			username caddy
			password ${config.acmeProxyPassword}
		}
		resolvers 127.0.0.1
	}

	import /etc/caddy/vms.caddy

	handle {
		respond "VM not found" 404
	}
}
`;
}

function buildVmsCaddyContent(): string {
	if (!config.baseDomain) {
		return `# Managed by scaleboxd - do not edit manually
# VM routes are added here when BASE_DOMAIN is configured
`;
	}

	const vmRoutes = Array.from(vms.values())
		.map((vm) => {
			return `@${vm.name} host ${vm.name}.vm.${config.baseDomain}
handle @${vm.name} {
	reverse_proxy ${vm.ip}:8080
}`;
		})
		.join("\n\n");

	return `# Managed by scaleboxd - do not edit manually
${vmRoutes}
`;
}
