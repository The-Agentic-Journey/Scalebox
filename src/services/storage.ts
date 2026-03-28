import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { $ } from "bun";
import { config } from "../config";

export interface InitializeRootfsOptions {
	sshPublicKey: string;
	hostname?: string;
}

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

export async function initializeRootfs(
	rootfsPath: string,
	options: InitializeRootfsOptions,
): Promise<void> {
	const mountPoint = `/tmp/mount-${Date.now()}`;
	await mkdir(mountPoint, { recursive: true });

	try {
		await $`sudo mount -o loop ${rootfsPath} ${mountPoint}`;

		// 1. SSH key injection
		const sshDir = `${mountPoint}/home/user/.ssh`;
		await $`sudo mkdir -p ${sshDir}`;
		await $`sudo chmod 700 ${sshDir}`;

		const tempKeyFile = `/tmp/authorized_keys_${Date.now()}`;
		await writeFile(tempKeyFile, `${options.sshPublicKey}\n`, { mode: 0o600 });
		await $`sudo cp ${tempKeyFile} ${sshDir}/authorized_keys`;
		await $`sudo chmod 600 ${sshDir}/authorized_keys`;
		await $`rm -f ${tempKeyFile}`;

		// 2. Set ownership of .ssh directory (covers authorized_keys)
		await $`sudo chown -R 1000:1000 ${sshDir}`;

		// 3. Hostname
		if (options.hostname) {
			const tempHostname = `/tmp/hostname_${Date.now()}`;
			await writeFile(tempHostname, `${options.hostname}\n`);
			await $`sudo cp ${tempHostname} ${mountPoint}/etc/hostname`;
			await $`rm -f ${tempHostname}`;

			const tempHosts = `/tmp/hosts_${Date.now()}`;
			await writeFile(
				tempHosts,
				`127.0.0.1\tlocalhost\n::1\t\tlocalhost\n127.0.1.1\t${options.hostname}\n`,
			);
			await $`sudo cp ${tempHosts} ${mountPoint}/etc/hosts`;
			await $`rm -f ${tempHosts}`;
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
