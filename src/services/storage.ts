import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { $ } from "bun";
import { config } from "../config";

export interface InitializeRootfsOptions {
	sshPublicKey: string;
	hostname?: string;
	env?: Record<string, string>;
	files?: Array<{ path: string; content: string }>;
	initScript?: string;
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

		// 3. Environment variables
		if (options.env && Object.keys(options.env).length > 0) {
			const envContent = `${Object.entries(options.env)
				.map(([k, v]) => `${k}=${v}`)
				.join("\n")}\n`;
			const tempEnvFile = `/tmp/ssh_environment_${Date.now()}`;
			await writeFile(tempEnvFile, envContent, { mode: 0o640 });
			await $`sudo cp ${tempEnvFile} ${sshDir}/environment`;
			await $`sudo chmod 640 ${sshDir}/environment`;
			await $`sudo chown 1000:1000 ${sshDir}/environment`;
			await $`rm -f ${tempEnvFile}`;

			// Enable PermitUserEnvironment in sshd_config
			const sshdConfig = `${mountPoint}/etc/ssh/sshd_config`;
			await $`sudo sed -i 's/^#\\? *PermitUserEnvironment.*/PermitUserEnvironment yes/' ${sshdConfig}`;
			// Append if sed didn't match anything
			const check = await $`sudo grep -c '^PermitUserEnvironment yes' ${sshdConfig}`
				.nothrow()
				.text();
			if (check.trim() === "0") {
				await $`echo 'PermitUserEnvironment yes' | sudo tee -a ${sshdConfig}`.quiet();
			}
		}

		// 4. Hostname
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
		// 5. Files
		if (options.files && options.files.length > 0) {
			for (const file of options.files) {
				const decoded = Buffer.from(file.content, "base64");
				const targetPath = `${mountPoint}${file.path}`;
				const parentDir = targetPath.substring(0, targetPath.lastIndexOf("/"));

				await $`sudo mkdir -p ${parentDir}`;

				const tempFile = `/tmp/scalebox_file_${Date.now()}_${Math.random().toString(36).slice(2)}`;
				await writeFile(tempFile, decoded, { mode: 0o640 });
				await $`sudo cp ${tempFile} ${targetPath}`;
				await $`sudo chmod 640 ${targetPath}`;
				await $`sudo chown 1000:1000 ${targetPath}`;
				await $`rm -f ${tempFile}`;

				// Ensure parent directories are also owned by user
				// (only for dirs under /home/user)
				if (file.path.startsWith("/home/user/")) {
					await $`sudo chown 1000:1000 ${parentDir}`;
				}
			}
		}
		// 6. Init script
		if (options.initScript) {
			const scriptContent = Buffer.from(options.initScript, "base64").toString();

			// Write the init script
			await $`sudo mkdir -p ${mountPoint}/opt/scalebox`;
			const tempScript = `/tmp/scalebox_init_${Date.now()}`;
			await writeFile(tempScript, scriptContent, { mode: 0o755 });
			await $`sudo cp ${tempScript} ${mountPoint}/opt/scalebox/init.sh`;
			await $`sudo chmod 755 ${mountPoint}/opt/scalebox/init.sh`;
			await $`rm -f ${tempScript}`;

			// Write the systemd service unit
			const serviceContent = `[Unit]
Description=Scalebox Init Script
After=network-online.target
Wants=network-online.target
ConditionPathExists=/opt/scalebox/init.sh

[Service]
Type=oneshot
ExecStart=/bin/bash -c '/opt/scalebox/init.sh; _rc=$$?; rm -f /opt/scalebox/init.sh; systemctl disable scalebox-init.service; exit $$_rc'
EnvironmentFile=-/home/user/.ssh/environment
StandardOutput=journal
StandardError=journal
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
`;
			const tempService = `/tmp/scalebox_init_service_${Date.now()}`;
			await writeFile(tempService, serviceContent);
			await $`sudo cp ${tempService} ${mountPoint}/etc/systemd/system/scalebox-init.service`;
			await $`rm -f ${tempService}`;

			// Enable the service via symlink (cannot use systemctl on mounted fs)
			await $`sudo mkdir -p ${mountPoint}/etc/systemd/system/multi-user.target.wants`;
			await $`sudo ln -sf /etc/systemd/system/scalebox-init.service ${mountPoint}/etc/systemd/system/multi-user.target.wants/scalebox-init.service`;
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
