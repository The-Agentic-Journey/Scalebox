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

		// Ensure /home/user/.ssh directory exists and write the key
		const sshDir = `${mountPoint}/home/user/.ssh`;
		await $`sudo mkdir -p ${sshDir}`;
		await $`sudo chmod 700 ${sshDir}`;

		const authorizedKeysPath = `${sshDir}/authorized_keys`;
		// Write to temp file first, then move with sudo
		const tempKeyFile = `/tmp/authorized_keys_${Date.now()}`;
		await writeFile(tempKeyFile, `${sshPublicKey}\n`, { mode: 0o600 });
		await $`sudo cp ${tempKeyFile} ${authorizedKeysPath}`;
		await $`sudo chmod 600 ${authorizedKeysPath}`;
		await $`rm -f ${tempKeyFile}`;

		// Ensure proper ownership for the .ssh directory and its contents
		await $`sudo chown -R user:user ${sshDir}`;
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

		// Clear authorized_keys file if it exists (check both user and root locations)
		const userAuthorizedKeysPath = `${mountPoint}/home/user/.ssh/authorized_keys`;
		const rootAuthorizedKeysPath = `${mountPoint}/root/.ssh/authorized_keys`;
		try {
			await $`sudo truncate -s 0 ${userAuthorizedKeysPath}`.quiet();
		} catch {
			// File might not exist, which is fine
		}
		try {
			await $`sudo truncate -s 0 ${rootAuthorizedKeysPath}`.quiet();
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

export async function resizeRootfs(rootfsPath: string, sizeGib: number): Promise<void> {
	// Expand the sparse file
	await $`truncate -s ${sizeGib}G ${rootfsPath}`;

	// Check and resize the ext4 filesystem
	await $`e2fsck -f -y ${rootfsPath}`.quiet().nothrow();
	await $`resize2fs ${rootfsPath}`.quiet();
}

export async function getAvailableSpaceGib(): Promise<number> {
	const result = await $`df -BG ${config.dataDir} --output=avail | tail -1`.text();
	return Number.parseInt(result.replace("G", "").trim());
}

export async function checkAvailableSpace(requiredGib: number): Promise<void> {
	const available = await getAvailableSpaceGib();
	const buffer = 2; // Keep 2GB buffer

	if (available < requiredGib + buffer) {
		throw {
			status: 507, // Insufficient Storage
			message: `Insufficient storage: ${available}GB available, need ${requiredGib + buffer}GB`,
		};
	}
}
