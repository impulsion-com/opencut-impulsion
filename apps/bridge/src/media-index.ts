import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "./log";

// Per-project index of the media imported through import_media: mediaId -> disk path, size and mtime.
// Stored in <dataDir>/projects/<projectId>/media-index.json. The editor keeps its media in OPFS, which has no
// paths; this index is how list_media and list_disk_media can say where an asset came from.

export interface MediaIndexEntry {
	path: string;
	size: number;
	mtimeMs: number;
	importedAt: string;
}

const IndexFileSchema = z.object({
	version: z.literal(1),
	projectId: z.string(),
	entries: z.record(
		z.string(),
		z.object({
			path: z.string(),
			size: z.number(),
			mtimeMs: z.number(),
			importedAt: z.string(),
		}),
	),
});
type IndexFile = z.infer<typeof IndexFileSchema>;

export interface MediaIndex {
	read(projectId: string): Promise<Record<string, MediaIndexEntry>>;
	record(
		projectId: string,
		entries: Record<string, MediaIndexEntry>,
	): Promise<void>;
	fileFor(projectId: string): string;
}

/** Folder name for a project id: kept readable when it is filesystem-safe, hashed otherwise. */
export function projectFolderName(projectId: string): string {
	if (/^[A-Za-z0-9_-]{1,100}$/.test(projectId)) return projectId;
	return `id-${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}`;
}

export function createMediaIndex({
	dataDir,
	logger,
}: {
	dataDir: string;
	logger: Logger;
}): MediaIndex {
	// Writes are serialised per project so two imports finishing together do not lose entries.
	const queues = new Map<string, Promise<unknown>>();

	function fileFor(projectId: string): string {
		return path.join(
			dataDir,
			"projects",
			projectFolderName(projectId),
			"media-index.json",
		);
	}

	async function load(projectId: string): Promise<IndexFile> {
		const empty: IndexFile = { version: 1, projectId, entries: {} };
		let text: string;
		try {
			text = await readFile(fileFor(projectId), "utf8");
		} catch {
			return empty;
		}
		try {
			const parsed = IndexFileSchema.safeParse(JSON.parse(text));
			if (parsed.success) return parsed.data;
			logger.warn("media index ignored (invalid)", { projectId });
		} catch {
			logger.warn("media index ignored (invalid JSON)", { projectId });
		}
		return empty;
	}

	return {
		fileFor,
		async read(projectId) {
			await queues.get(projectId);
			return (await load(projectId)).entries;
		},
		record(projectId, entries) {
			const previous = queues.get(projectId) ?? Promise.resolve();
			const next = previous
				.catch(() => {})
				.then(async () => {
					const current = await load(projectId);
					Object.assign(current.entries, entries);
					const file = fileFor(projectId);
					await mkdir(path.dirname(file), { recursive: true });
					const temp = `${file}.${process.pid}.tmp`;
					await writeFile(
						temp,
						`${JSON.stringify(current, null, "\t")}\n`,
						"utf8",
					);
					await rename(temp, file);
					logger.info("media index updated", {
						projectId,
						added: Object.keys(entries).length,
					});
				});
			queues.set(projectId, next);
			return next.finally(() => {
				if (queues.get(projectId) === next) queues.delete(projectId);
			});
		},
	};
}
