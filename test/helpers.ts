import { readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

// API configuration - VM_HOST can be localhost (via SSH tunnel) or remote VM IP
export const VM_HOST = process.env.VM_HOST || "34.89.142.221";
export const API_PORT = process.env.API_PORT || "8080";
export const API_BASE_URL = `http://${VM_HOST}:${API_PORT}`;
const API_TOKEN = process.env.API_TOKEN || "dev-5a30aabffc0d8308ec749c49d94164705fc2d4b57c50b800";

// SSH configuration - SSH_HOST must be the actual remote VM (not tunneled)
export const SSH_HOST = process.env.SSH_HOST || "34.89.142.221";

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

// SSH helpers
export const TEST_PRIVATE_KEY_PATH = join(FIXTURES_DIR, "test_key");
export const TEST_PUBLIC_KEY = readFileSync(join(FIXTURES_DIR, "test_key.pub"), "utf-8").trim();

export async function waitForSsh(vmIp: string, timeoutMs: number): Promise<void> {
	const jumpHost = `dev@${SSH_HOST}`;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			// Try SSH with ProxyJump - just check if we can connect
			await $`ssh -J ${jumpHost} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 -i ${TEST_PRIVATE_KEY_PATH} root@${vmIp} exit`.quiet();
			return;
		} catch {
			await Bun.sleep(1000);
		}
	}
	throw new Error(`SSH not ready on ${vmIp} within ${timeoutMs}ms`);
}

export async function sshExec(vmIp: string, command: string): Promise<string> {
	const jumpHost = `dev@${SSH_HOST}`;
	return await $`ssh -J ${jumpHost} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${TEST_PRIVATE_KEY_PATH} root@${vmIp} ${command}`.text();
}
