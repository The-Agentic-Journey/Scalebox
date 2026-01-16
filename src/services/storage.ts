import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { $ } from "bun";
import { config } from "../config";

export async function copyRootfs(templateName: string, vmId: string): Promise<string> {
	const templatePath = `${config.dataDir}/templates/${templateName}.ext4`;
	const vmPath = `${config.dataDir}/vms/${vmId}.ext4`;

	if (!existsSync(templatePath)) {
		throw { status: 404, message: "Template not found" };
	}

	// Create vms directory if it doesn't exist
	await mkdir(`${config.dataDir}/vms`, { recursive: true });

	// Use reflink copy for COW efficiency
	await $`cp --reflink=auto ${templatePath} ${vmPath}`.quiet();

	return vmPath;
}

export async function injectSshKey(rootfsPath: string, sshPublicKey: string): Promise<void> {
	// Mount the rootfs temporarily
	const mountPoint = `/tmp/mount-${Date.now()}`;
	await mkdir(mountPoint, { recursive: true });

	try {
		await $`mount -o loop ${rootfsPath} ${mountPoint}`.quiet();
		const authorizedKeysPath = `${mountPoint}/root/.ssh/authorized_keys`;
		await writeFile(authorizedKeysPath, `${sshPublicKey}\n`, { mode: 0o600 });
	} finally {
		try {
			await $`umount ${mountPoint}`.quiet();
		} catch {
			// Ignore unmount errors
		}
		try {
			await $`rmdir ${mountPoint}`.quiet();
		} catch {
			// Ignore rmdir errors
		}
	}
}

export async function deleteRootfs(rootfsPath: string): Promise<void> {
	try {
		await $`rm -f ${rootfsPath}`.quiet();
	} catch {
		// Ignore errors
	}
}
