import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Stats } from "node:fs";

// The disk allow-list shared by list_disk_media, import_media and /files. A path is allowed when its REAL path
// (symlinks resolved) sits inside the real path of an allowed root and no segment below that root starts with a
// dot. Checking real paths is what stops symlink escapes (e.g. /Volumes/Macintosh HD -> /).

export interface AllowedPath {
	/** Absolute, normalised path as the caller wrote it (after "~/" expansion). */
	absolute: string;
	/** Real path on disk, the one every check and every served byte uses. */
	real: string;
	/** Real path of the allowed root that contains it. */
	root: string;
	stats: Stats;
}

export type AllowedPathResult =
	| { ok: true; value: AllowedPath }
	| { ok: false; reason: string; code: "INVALID" | "MISSING" };

export function expandUserPath(
	input: string,
	home: string = homedir(),
): string {
	const trimmed = input.trim();
	if (trimmed === "~") return home;
	if (trimmed.startsWith("~/")) return path.join(home, trimmed.slice(2));
	return trimmed;
}

/** Real paths of the roots that exist right now (volumes come and go). */
export async function resolveRoots(
	roots: readonly string[],
): Promise<Array<{ configured: string; real: string }>> {
	const resolved: Array<{ configured: string; real: string }> = [];
	for (const configured of roots) {
		try {
			const real = await realpath(configured);
			if ((await stat(real)).isDirectory()) resolved.push({ configured, real });
		} catch {
			// Missing root (unplugged drive, folder not created yet): skipped.
		}
	}
	return resolved;
}

export function isInside({
	child,
	parent,
}: {
	child: string;
	parent: string;
}): boolean {
	if (child === parent) return true;
	const prefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
	return child.startsWith(prefix);
}

export function hasHiddenSegment({
	real,
	root,
}: {
	real: string;
	root: string;
}): boolean {
	const relative = path.relative(root, real);
	if (relative === "") return false;
	return relative.split(path.sep).some((segment) => segment.startsWith("."));
}

/**
 * Validates a user-supplied path against the allow-list. `kind` restricts the result to a file or a folder.
 * Reasons are short English sentences (they reach the model through tool results).
 */
export async function resolveAllowedPath({
	input,
	roots,
	kind,
	home,
}: {
	input: string;
	roots: readonly string[];
	kind?: "file" | "folder";
	home?: string;
}): Promise<AllowedPathResult> {
	if (input.includes("\0"))
		return { ok: false, code: "INVALID", reason: "invalid path" };
	const expanded = expandUserPath(input, home);
	if (!path.isAbsolute(expanded)) {
		return {
			ok: false,
			code: "INVALID",
			reason: 'not an absolute path (use "/..." or "~/...")',
		};
	}
	const absolute = path.resolve(expanded);
	let real: string;
	try {
		real = await realpath(absolute);
	} catch {
		return { ok: false, code: "MISSING", reason: "does not exist" };
	}
	const realRoots = await resolveRoots(roots);
	const root = realRoots.find((candidate) =>
		isInside({ child: real, parent: candidate.real }),
	);
	if (!root)
		return {
			ok: false,
			code: "INVALID",
			reason: "outside the allowed folders",
		};
	if (hasHiddenSegment({ real, root: root.real })) {
		return {
			ok: false,
			code: "INVALID",
			reason: "hidden files and folders are not allowed",
		};
	}
	let stats: Stats;
	try {
		stats = await stat(real);
	} catch {
		return { ok: false, code: "MISSING", reason: "does not exist" };
	}
	if (kind === "file" && !stats.isFile())
		return { ok: false, code: "INVALID", reason: "not a regular file" };
	if (kind === "folder" && !stats.isDirectory())
		return { ok: false, code: "INVALID", reason: "not a folder" };
	return { ok: true, value: { absolute, real, root: root.real, stats } };
}
