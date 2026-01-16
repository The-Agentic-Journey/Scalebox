import { existsSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { config } from "../config";

export interface Template {
	name: string;
	size_bytes: number;
	created_at: string;
}

export async function listTemplates(): Promise<Template[]> {
	const dir = `${config.dataDir}/templates`;

	// If directory doesn't exist, return empty array
	if (!existsSync(dir)) {
		return [];
	}

	const files = await readdir(dir);
	const templates = await Promise.all(
		files
			.filter((f) => f.endsWith(".ext4"))
			.map(async (f) => {
				const path = `${dir}/${f}`;
				const stats = await stat(path);
				return {
					name: f.replace(".ext4", ""),
					size_bytes: stats.size,
					created_at: stats.mtime.toISOString(),
				};
			}),
	);
	return templates;
}

export async function deleteTemplate(name: string): Promise<void> {
	// Validate name (path traversal prevention)
	if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
		throw { status: 400, message: "Invalid template name" };
	}

	// Check if protected
	if (config.protectedTemplates.includes(name)) {
		throw { status: 403, message: "Cannot delete protected template" };
	}

	// Check if exists
	const templatePath = `${config.dataDir}/templates/${name}.ext4`;
	if (!existsSync(templatePath)) {
		throw { status: 404, message: "Template not found" };
	}

	await unlink(templatePath);
}
