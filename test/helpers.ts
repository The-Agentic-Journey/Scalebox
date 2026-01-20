import { readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

// Configuration
export const VM_HOST = process.env.VM_HOST || "localhost";
export const API_PORT = process.env.API_PORT || "8080";
export const USE_HTTPS = process.env.USE_HTTPS === "true";
export const API_BASE_URL = USE_HTTPS ? `https://${VM_HOST}` : `http://${VM_HOST}:${API_PORT}`;
const API_TOKEN = process.env.API_TOKEN || "dev-token";

// SSH
export const TEST_PRIVATE_KEY_PATH = join(FIXTURES_DIR, "test_key");
export const TEST_PUBLIC_KEY = readFileSync(join(FIXTURES_DIR, "test_key.pub"), "utf-8").trim();

// API client
export const api = {
	async get(path: string) {
		const res = await fetch(`${API_BASE_URL}${path}`, {
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		return { status: res.status, data: res.ok ? await res.json() : null };
	},
	async post(path: string, body: unknown) {
		const res = await fetch(`${API_BASE_URL}${path}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return { status: res.status, data: res.ok ? await res.json() : null };
	},
	async delete(path: string) {
		const res = await fetch(`${API_BASE_URL}${path}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		return { status: res.status };
	},
	async getRaw(path: string, token?: string) {
		const res = await fetch(`${API_BASE_URL}${path}`, {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		});
		return { status: res.status };
	},
};

// SSH via proxy port (connects to VM_HOST on the proxy port, not internal IP)
export async function waitForSsh(sshPort: number, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			await $`ssh -p ${sshPort} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=2 -i ${TEST_PRIVATE_KEY_PATH} root@${VM_HOST} exit`.quiet();
			return;
		} catch {
			await Bun.sleep(1000);
		}
	}
	throw new Error(`SSH not ready on port ${sshPort} within ${timeoutMs}ms`);
}

export async function sshExec(sshPort: number, command: string): Promise<string> {
	return await $`ssh -p ${sshPort} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${TEST_PRIVATE_KEY_PATH} root@${VM_HOST} ${command}`.text();
}
