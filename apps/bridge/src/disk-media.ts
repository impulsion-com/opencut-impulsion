import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import { BridgeError } from "./errors";
import {
	hasHiddenSegment,
	isInside,
	resolveAllowedPath,
	resolveRoots,
} from "./allowlist";
import {
	DEFAULT_MEDIA_EXTENSIONS,
	extensionOf,
	mediaTypeOf,
	type MediaKind,
} from "./media-types";
import type { ProbeInfo, Prober } from "./probe";

// list_disk_media: browse the allow-listed folders for importable media. Read-only, dotfiles skipped, symlinks
// followed only when their target stays inside an allowed root. Media files get ffprobe metadata (cached).

export interface DiskEntry {
	path: string;
	name: string;
	kind: "folder" | MediaKind;
	size?: number;
	modifiedAt: string;
	duration?: number;
	width?: number;
	height?: number;
	fps?: number;
	hasAudio?: boolean;
	mediaId?: string;
}

export interface DiskListing {
	roots: string[];
	folder: string | null;
	entries: DiskEntry[];
	/** Set when the listing hit the entry cap. */
	truncated?: true;
}

const MAX_ENTRIES = 2000;
const MAX_DEPTH = 12;
/** ffprobe runs on at most this many files per call (the rest is listed without metadata). */
const MAX_PROBED = 300;

function normaliseExtensions(
	extensions: readonly string[] | undefined,
): Set<string> {
	const list =
		extensions && extensions.length > 0 ? extensions : DEFAULT_MEDIA_EXTENSIONS;
	return new Set(
		list
			.map((extension) => extension.trim().replace(/^\./, "").toLowerCase())
			.filter(Boolean),
	);
}

function byKindThenName(a: DiskEntry, b: DiskEntry): number {
	if ((a.kind === "folder") !== (b.kind === "folder"))
		return a.kind === "folder" ? -1 : 1;
	return a.path.localeCompare(b.path, "fr", {
		numeric: true,
		sensitivity: "base",
	});
}

function probeFields(
	info: ProbeInfo | null,
	kind: MediaKind,
): Partial<DiskEntry> {
	if (!info) return {};
	const fields: Partial<DiskEntry> = {};
	if (info.duration !== undefined && kind !== "image")
		fields.duration = info.duration;
	if (info.width !== undefined && kind !== "audio") fields.width = info.width;
	if (info.height !== undefined && kind !== "audio")
		fields.height = info.height;
	if (info.fps !== undefined && kind === "video") fields.fps = info.fps;
	if (kind === "video" && info.hasAudio !== undefined)
		fields.hasAudio = info.hasAudio;
	return fields;
}

export async function listDiskMedia({
	folder,
	recursive = false,
	extensions,
	roots,
	prober,
	mediaIds,
}: {
	folder?: string;
	recursive?: boolean;
	extensions?: readonly string[];
	roots: readonly string[];
	prober: Prober | null;
	/** Real path -> mediaId of the media already imported in the open project. */
	mediaIds?: ReadonlyMap<string, string>;
}): Promise<DiskListing> {
	const existingRoots = await resolveRoots(roots);
	const rootList = existingRoots.map((root) => root.configured);

	if (folder === undefined) {
		const entries: DiskEntry[] = [];
		for (const root of existingRoots) {
			const stats = await stat(root.real);
			entries.push({
				path: root.configured,
				name: root.configured,
				kind: "folder",
				modifiedAt: stats.mtime.toISOString(),
			});
		}
		return { roots: rootList, folder: null, entries };
	}

	const resolved = await resolveAllowedPath({
		input: folder,
		roots,
		kind: "folder",
	});
	if (!resolved.ok) {
		throw new BridgeError({
			code: resolved.code === "MISSING" ? "NOT_FOUND" : "INVALID_PARAMS",
			message: `${folder}: ${resolved.reason}. Allowed folders: ${rootList.join(", ") || "(none exists)"}.`,
		});
	}

	const wanted = normaliseExtensions(extensions);
	const realRoots = existingRoots.map((root) => root.real);
	const entries: DiskEntry[] = [];
	const visited = new Set<string>();
	let truncated = false;
	const probeQueue: Array<{ entry: DiskEntry; kind: MediaKind; stats: Stats }> =
		[];

	async function walk(dir: string, depth: number): Promise<void> {
		if (truncated || visited.has(dir)) return;
		visited.add(dir);
		let names: string[];
		try {
			names = (await readdir(dir)).sort();
		} catch {
			return;
		}
		const subfolders: string[] = [];
		for (const name of names) {
			if (entries.length >= MAX_ENTRIES) {
				truncated = true;
				return;
			}
			if (name.startsWith(".")) continue;
			const candidate = path.join(dir, name);
			let real: string;
			let stats: Stats;
			try {
				real = await realpath(candidate);
				stats = await stat(real);
			} catch {
				continue;
			}
			// A symlink may point anywhere: keep it only if its target is inside an allowed root, not hidden.
			const root = realRoots.find((candidateRoot) =>
				isInside({ child: real, parent: candidateRoot }),
			);
			if (!root || hasHiddenSegment({ real, root })) continue;
			if (stats.isDirectory()) {
				if (recursive) subfolders.push(real);
				else
					entries.push({
						path: real,
						name,
						kind: "folder",
						modifiedAt: stats.mtime.toISOString(),
					});
				continue;
			}
			if (!stats.isFile() || !wanted.has(extensionOf(name))) continue;
			const type = mediaTypeOf(name);
			if (!type) continue;
			const entry: DiskEntry = {
				path: real,
				name,
				kind: type.kind,
				size: stats.size,
				modifiedAt: stats.mtime.toISOString(),
			};
			const mediaId = mediaIds?.get(real);
			if (mediaId) entry.mediaId = mediaId;
			entries.push(entry);
			if (probeQueue.length < MAX_PROBED)
				probeQueue.push({ entry, kind: type.kind, stats });
		}
		if (depth >= MAX_DEPTH) return;
		for (const sub of subfolders) await walk(sub, depth + 1);
	}

	await walk(resolved.value.real, 0);

	if (prober) {
		await Promise.all(
			probeQueue.map(async ({ entry, kind, stats }) => {
				const info = await prober.probe({
					path: entry.path,
					size: stats.size,
					mtimeMs: stats.mtimeMs,
				});
				Object.assign(entry, probeFields(info, kind));
			}),
		);
	}

	entries.sort(byKindThenName);
	return {
		roots: rootList,
		folder: resolved.value.real,
		entries,
		...(truncated ? { truncated: true as const } : {}),
	};
}
