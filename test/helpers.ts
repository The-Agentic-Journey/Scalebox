import { readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

// API configuration
const API_URL = `http://${process.env.VM_HOST || "34.40.56.57"}:8080`;
const API_TOKEN = process.env.API_TOKEN || "dev-5a30aabffc0d8308ec749c49d94164705fc2d4b57c50b800";

// API client
export const api = {
	async get(path: string) {
		const res = await fetch(`${API_URL}${path}`, {
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		return { status: res.status, data: res.ok ? await res.json() : null };
	},
	async post(path: string, body: unknown) {
		const res = await fetch(`${API_URL}${path}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return { status: res.status, data: res.ok ? await res.json() : null };
	},
	async delete(path: string) {
		const res = await fetch(`${API_URL}${path}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		return { status: res.status };
	},
	async getRaw(path: string, token?: string) {
		const res = await fetch(`${API_URL}${path}`, {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		});
		return { status: res.status };
	},
};

// SSH helpers
export const TEST_PRIVATE_KEY_PATH = join(FIXTURES_DIR, "test_key");
export const TEST_PUBLIC_KEY = readFileSync(join(FIXTURES_DIR, "test_key.pub"), "utf-8").trim();

export async function waitForSsh(port: number, timeoutMs: number): Promise<void> {
	const host = process.env.VM_HOST || "34.40.56.57";
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			await $`nc -z ${host} ${port}`.quiet();
			return;
		} catch {
			await Bun.sleep(500);
		}
	}
	throw new Error(`SSH not ready on port ${port} within ${timeoutMs}ms`);
}

export async function sshExec(port: number, command: string): Promise<string> {
	const host = process.env.VM_HOST || "34.40.56.57";
	return await $`ssh -p ${port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${TEST_PRIVATE_KEY_PATH} root@${host} ${command}`.text();
}
