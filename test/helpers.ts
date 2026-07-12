import { chmodSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

// Configuration
export const VM_HOST = process.env.VM_HOST || "localhost";
export const VM_IP = process.env.VM_IP || "";
export const API_PORT = process.env.API_PORT || "8080";
export const USE_HTTPS = process.env.USE_HTTPS === "true";
export const API_BASE_URL = USE_HTTPS ? `https://api.${VM_HOST}` : `http://${VM_HOST}:${API_PORT}`;
export const API_TOKEN = process.env.API_TOKEN || "dev-token";

// SSH
export const TEST_PRIVATE_KEY_PATH = join(FIXTURES_DIR, "test_key");
// Fix permissions for SSH key - git stores as 644 but SSH requires 600
chmodSync(TEST_PRIVATE_KEY_PATH, 0o600);
export const TEST_PUBLIC_KEY = readFileSync(join(FIXTURES_DIR, "test_key.pub"), "utf-8").trim();

// Custom fetch wrapper that bypasses DNS when VM_IP is set
async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
	if (VM_IP && USE_HTTPS) {
		// Connect to VM_IP directly, bypassing DNS
		const url = `https://${VM_IP}:443${path}`;
		const apiHost = `api.${VM_HOST}`;
		return fetch(url, {
			...options,
			headers: {
				...Object.fromEntries(Object.entries(options.headers || {})),
				Host: apiHost,
			},
			tls: { rejectUnauthorized: false },
		} as RequestInit);
	}
	return fetch(`${API_BASE_URL}${path}`, options);
}

// HTTP API client (kept for auth tests and cleanup)
export const api = {
	async delete(path: string) {
		const res = await apiFetch(path, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		return { status: res.status };
	},
	async getRaw(path: string, token?: string) {
		const res = await apiFetch(path, {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		});
		return { status: res.status };
	},
	async post(path: string, body: unknown, token?: string) {
		const res = await apiFetch(path, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token ?? API_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		let json = null;
		try {
			json = await res.json();
		} catch {}
		return { status: res.status, body: json };
	},
};

// SSH via proxy port (connects to VM_HOST on the proxy port, not internal IP)
export async function waitForSsh(sshPort: number, timeoutMs: number): Promise<void> {
	const start = Date.now();
	let attempts = 0;
	let lastError = "";
	while (Date.now() - start < timeoutMs) {
		attempts++;
		const elapsed = Math.round((Date.now() - start) / 1000);
		try {
			await $`ssh -p ${sshPort} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5 -i ${TEST_PRIVATE_KEY_PATH} user@${VM_HOST} exit`.quiet();
			console.log(`SSH ready on port ${sshPort} after ${elapsed}s (${attempts} attempts)`);
			return;
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
			// Log progress every 30 seconds, or on last few attempts
			const timeRemaining = timeoutMs - (Date.now() - start);
			if (attempts % 15 === 0 || timeRemaining < 10000) {
				console.log(
					`SSH not ready on port ${sshPort} after ${elapsed}s (${attempts} attempts), error: ${lastError.slice(0, 200)}`,
				);
			}
			await Bun.sleep(2000);
		}
	}
	const elapsed = Math.round((Date.now() - start) / 1000);
	throw new Error(
		`SSH not ready on port ${sshPort} within ${elapsed}s (${attempts} attempts). Last error: ${lastError}`,
	);
}

export async function sshExec(sshPort: number, command: string): Promise<string> {
	return await $`ssh -p ${sshPort} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${TEST_PRIVATE_KEY_PATH} user@${VM_HOST} ${command}`.text();
}

// === NEW: CLI Test Helpers ===
// These are added alongside existing HTTP helpers for incremental test migration.

// CLI configuration
let cliConfigDir: string | null = null;

// Path to test public key file
export const TEST_PUBLIC_KEY_PATH = join(FIXTURES_DIR, "test_key.pub");

// Get path to sb binary
function getSbPath(): string {
	const localPath = join(import.meta.dir, "..", "builds", "sb");
	try {
		readFileSync(localPath);
		return localPath;
	} catch {
		return "sb";
	}
}

// Initialize CLI with isolated config directory
export async function initCli(): Promise<void> {
	cliConfigDir = await mkdtemp(join(tmpdir(), "scalebox-test-"));
	const host = `${API_BASE_URL}`;
	// When VM_IP is set, use direct IP connection to bypass DNS propagation delays.
	// The sb CLI uses curl, which can use --resolve to map hostnames to IPs.
	const apiHost = USE_HTTPS ? `api.${VM_HOST}` : VM_HOST;
	const resolveFlag = VM_IP && USE_HTTPS ? `--resolve ${apiHost}:443:${VM_IP}` : "";
	const env: Record<string, string> = {
		SCALEBOX_INSECURE: "1",
		SCALEBOX_CONFIG_DIR: cliConfigDir,
	};
	if (resolveFlag) {
		env.SCALEBOX_CURL_FLAGS = resolveFlag;
	}
	const result = await $`echo ${API_TOKEN} | ${getSbPath()} login --host ${host} --token-stdin`
		.env(env)
		.quiet();
	if (result.exitCode !== 0) {
		throw new Error(`sb login failed: ${result.stderr.toString()}`);
	}
}

// Cleanup CLI config
export async function cleanupCli(): Promise<void> {
	if (cliConfigDir) {
		await rm(cliConfigDir, { recursive: true, force: true });
		cliConfigDir = null;
	}
}

// Execute sb command and return parsed JSON
export async function sbCmd(
	...args: string[]
): Promise<{ exitCode: number; data: Record<string, unknown> | null; error: string | null }> {
	if (!cliConfigDir) {
		throw new Error("CLI not initialized. Call initCli() first.");
	}
	const configDir = cliConfigDir; // Local variable for type narrowing

	const apiHost = USE_HTTPS ? `api.${VM_HOST}` : VM_HOST;
	const resolveFlag = VM_IP && USE_HTTPS ? `--resolve ${apiHost}:443:${VM_IP}` : "";
	const env: Record<string, string> = {
		SCALEBOX_INSECURE: "1",
		SCALEBOX_CONFIG_DIR: configDir,
	};
	if (resolveFlag) {
		env.SCALEBOX_CURL_FLAGS = resolveFlag;
	}

	const result = await $`${getSbPath()} --json ${args}`.env(env).quiet().nothrow();

	const stdout = result.stdout.toString().trim();
	const stderr = result.stderr.toString().trim();

	let data: Record<string, unknown> | null = null;
	let error: string | null = null;

	if (stdout) {
		try {
			data = JSON.parse(stdout);
			if (data && typeof data === "object" && "error" in data) {
				error = data.error as string;
			}
		} catch {
			error = stdout;
		}
	}

	if (stderr && !error) {
		error = stderr;
	}

	return { exitCode: result.exitCode, data, error };
}

// Convenience functions for CLI operations
export async function sbVmCreate(template: string): Promise<Record<string, unknown>> {
	const result = await sbCmd("vm", "create", "-t", template, "-k", `@${TEST_PUBLIC_KEY_PATH}`);
	if (result.exitCode !== 0 || !result.data) {
		throw new Error(`Failed to create VM: ${result.error}`);
	}
	return result.data;
}

export async function sbVmCreateWithInit(
	template: string,
	options?: { env?: string[]; files?: string[]; initScript?: string },
): Promise<Record<string, unknown>> {
	const args = ["vm", "create", "-t", template, "-k", `@${TEST_PUBLIC_KEY_PATH}`];
	if (options?.env) {
		for (const e of options.env) {
			args.push("--env", e);
		}
	}
	if (options?.files) {
		for (const f of options.files) {
			args.push("--file", f);
		}
	}
	if (options?.initScript) {
		args.push("--init-script", options.initScript);
	}
	const result = await sbCmd(...args);
	if (result.exitCode !== 0 || !result.data) {
		throw new Error(`Failed to create VM with init options: ${result.error}`);
	}
	return result.data;
}

export async function sbVmDelete(nameOrId: string): Promise<void> {
	const result = await sbCmd("vm", "delete", nameOrId);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to delete VM: ${result.error}`);
	}
}

export async function sbVmGet(nameOrId: string): Promise<Record<string, unknown> | null> {
	const result = await sbCmd("vm", "get", nameOrId);
	if (result.exitCode !== 0) {
		return null;
	}
	return result.data;
}

export async function sbVmList(): Promise<Record<string, unknown>[]> {
	const result = await sbCmd("vm", "list");
	if (result.exitCode !== 0 || !result.data) {
		throw new Error(`Failed to list VMs: ${result.error}`);
	}
	return (result.data as { vms: Record<string, unknown>[] }).vms || [];
}

export async function sbVmWait(nameOrId: string, timeoutSec = 60): Promise<void> {
	const result = await sbCmd("vm", "wait", nameOrId, "--ssh", "--timeout", String(timeoutSec));
	if (result.exitCode !== 0) {
		throw new Error(`Failed waiting for SSH: ${result.error}`);
	}
}

export async function sbVmSnapshot(
	nameOrId: string,
	templateName: string,
	options?: { overwrite?: boolean },
): Promise<Record<string, unknown>> {
	const args = ["vm", "snapshot", nameOrId, "-n", templateName];
	if (options?.overwrite) args.push("--overwrite");
	const result = await sbCmd(...args);
	if (result.exitCode !== 0 || !result.data) {
		throw new Error(`Failed to snapshot VM: ${result.error}`);
	}
	return result.data;
}

export async function sbVmRestart(
	nameOrId: string,
	opts: { diskSizeGib?: number; vcpuCount?: number; memSizeMib?: number } = {},
): Promise<Record<string, unknown>> {
	const args = ["vm", "restart", nameOrId];
	if (opts.diskSizeGib !== undefined) args.push("--disk-size", String(opts.diskSizeGib));
	if (opts.vcpuCount !== undefined) args.push("--vcpu", String(opts.vcpuCount));
	if (opts.memSizeMib !== undefined) args.push("--mem", String(opts.memSizeMib));
	const result = await sbCmd(...args);
	if (result.exitCode !== 0 || !result.data) {
		throw new Error(`Failed to restart VM: ${result.error}`);
	}
	return result.data;
}

export async function sbVmSnapshotRaw(
	nameOrId: string,
	templateName: string,
	options?: { overwrite?: boolean },
): Promise<{ exitCode: number; data: Record<string, unknown> | null; error: string | null }> {
	const args = ["vm", "snapshot", nameOrId, "-n", templateName];
	if (options?.overwrite) args.push("--overwrite");
	return sbCmd(...args);
}

export async function sbTemplateList(): Promise<Record<string, unknown>[]> {
	const result = await sbCmd("template", "list");
	if (result.exitCode !== 0 || !result.data) {
		throw new Error(`Failed to list templates: ${result.error}`);
	}
	return (result.data as { templates: Record<string, unknown>[] }).templates || [];
}

export async function sbTemplateDelete(name: string): Promise<void> {
	const result = await sbCmd("template", "delete", name);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to delete template: ${result.error}`);
	}
}

export async function sbStatus(): Promise<Record<string, unknown>> {
	const result = await sbCmd("status");
	if (result.exitCode !== 0 || !result.data) {
		throw new Error(`Failed to get status: ${result.error}`);
	}
	return result.data;
}

// Connect command helper - returns result for error checking
// Note: This exercises the connect code path but will fail before exec
// because the VM lookup happens before the SSH/mosh connection
export async function sbConnectRaw(
	nameOrId: string,
	...args: string[]
): Promise<{ exitCode: number; data: Record<string, unknown> | null; error: string | null }> {
	return sbCmd("connect", nameOrId, "--ssh", ...args);
}
