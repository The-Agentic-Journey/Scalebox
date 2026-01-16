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
		await $`sudo mount -o loop ${rootfsPath} ${mountPoint}`;

		// Ensure /root/.ssh directory exists and write the key
		const sshDir = `${mountPoint}/root/.ssh`;
		await $`sudo mkdir -p ${sshDir}`;
		await $`sudo chmod 700 ${sshDir}`;

		const authorizedKeysPath = `${sshDir}/authorized_keys`;
		// Write to temp file first, then move with sudo
		const tempKeyFile = `/tmp/authorized_keys_${Date.now()}`;
		await writeFile(tempKeyFile, `${sshPublicKey}\n`, { mode: 0o600 });
		await $`sudo cp ${tempKeyFile} ${authorizedKeysPath}`;
		await $`sudo chmod 600 ${authorizedKeysPath}`;
		await $`rm -f ${tempKeyFile}`;
	} finally {
		try {
			await $`sudo umount ${mountPoint}`;
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

export async function copyRootfsToTemplate(
	rootfsPath: string,
	templateName: string,
): Promise<string> {
	const templatePath = `${config.dataDir}/templates/${templateName}.ext4`;

	// Create templates directory if it doesn't exist
	await mkdir(`${config.dataDir}/templates`, { recursive: true });

	// Use reflink copy for COW efficiency
	await $`cp --reflink=auto ${rootfsPath} ${templatePath}`.quiet();

	return templatePath;
}

export async function clearAuthorizedKeys(rootfsPath: string): Promise<void> {
	// Mount the rootfs temporarily
	const mountPoint = `/tmp/mount-${Date.now()}`;
	await mkdir(mountPoint, { recursive: true });

	try {
		await $`sudo mount -o loop ${rootfsPath} ${mountPoint}`;

		// Clear authorized_keys file if it exists
		const authorizedKeysPath = `${mountPoint}/root/.ssh/authorized_keys`;
		try {
			await $`sudo truncate -s 0 ${authorizedKeysPath}`.quiet();
		} catch {
			// File might not exist, which is fine
		}
	} finally {
		try {
			await $`sudo umount ${mountPoint}`;
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
