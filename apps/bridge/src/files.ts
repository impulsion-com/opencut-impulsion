import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { BRIDGE_FILES_PATH, BRIDGE_ORIGIN } from "@opencut/claude-tools";
import { resolveAllowedPath } from "./allowlist";
import { answerPreflight, applyCors, sendJson } from "./http-utils";
import type { Logger } from "./log";
import { contentTypeOf } from "./media-types";

// Opaque file tokens for the tab's imports: registerFile(path) validates the path against the allow-list and
// mints GET http://127.0.0.1:3457/files/<id>, valid for a day. Disk paths never travel in URLs, and every request
// re-checks the real path (a file swapped for a symlink after registration is refused).

const METHODS = "GET, HEAD, OPTIONS";
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_ENTRIES = 5000;

export interface RegisteredFile {
	id: string;
	url: string;
	/** Real path on disk. */
	path: string;
	name: string;
	size: number;
	mtimeMs: number;
	mimeType: string;
	expiresAt: number;
}

export interface FileRegistry {
	/** Validates and registers a disk file; throws FileAccessError when the path is not allowed. */
	registerFile(inputPath: string): Promise<RegisteredFile>;
	get(id: string): RegisteredFile | null;
	/** Handles GET/HEAD/OPTIONS for /files/<id>. */
	handle(options: {
		req: IncomingMessage;
		res: ServerResponse;
		id: string;
	}): Promise<void>;
	size(): number;
}

export class FileAccessError extends Error {
	readonly code: "INVALID" | "MISSING";
	constructor({
		message,
		code,
	}: {
		message: string;
		code: "INVALID" | "MISSING";
	}) {
		super(message);
		this.name = "FileAccessError";
		this.code = code;
	}
}

export type ByteRange = { start: number; end: number };

/**
 * Parses a single-range "bytes=" header. Returns null for no (or an ignorable multi-) range, "unsatisfiable" for a
 * range outside the file, else the inclusive byte range.
 */
export function parseRange({
	header,
	size,
}: {
	header: string | undefined;
	size: number;
}): ByteRange | null | "unsatisfiable" {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;
	const [, startText = "", endText = ""] = match;
	if (startText === "" && endText === "") return null;
	if (startText === "") {
		const suffix = Number(endText);
		if (suffix === 0 || size === 0) return "unsatisfiable";
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(startText);
	const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
	if (start >= size || end < start) return "unsatisfiable";
	return { start, end };
}

export function createFileRegistry({
	getRoots,
	ttlMs,
	now = () => Date.now(),
	logger,
	baseUrl = BRIDGE_ORIGIN,
}: {
	getRoots: () => readonly string[];
	ttlMs: number;
	now?: () => number;
	logger: Logger;
	/** Origin used in minted URLs (tests on a random port pass theirs). */
	baseUrl?: string;
}): FileRegistry {
	const entries = new Map<string, RegisteredFile>();

	function prune(): void {
		const at = now();
		for (const [id, entry] of entries) {
			if (entry.expiresAt <= at) entries.delete(id);
		}
		while (entries.size >= MAX_ENTRIES) {
			const oldest = entries.keys().next().value;
			if (oldest === undefined) break;
			entries.delete(oldest);
		}
	}

	function get(id: string): RegisteredFile | null {
		const entry = entries.get(id);
		if (!entry) return null;
		if (entry.expiresAt <= now()) {
			entries.delete(id);
			return null;
		}
		return entry;
	}

	async function registerFile(inputPath: string): Promise<RegisteredFile> {
		const resolved = await resolveAllowedPath({
			input: inputPath,
			roots: getRoots(),
			kind: "file",
		});
		if (!resolved.ok)
			throw new FileAccessError({
				message: resolved.reason,
				code: resolved.code,
			});
		prune();
		const id = randomBytes(18).toString("base64url");
		const entry: RegisteredFile = {
			id,
			url: `${baseUrl}${BRIDGE_FILES_PATH}/${id}`,
			path: resolved.value.real,
			name: path.basename(resolved.value.real),
			size: resolved.value.stats.size,
			mtimeMs: resolved.value.stats.mtimeMs,
			mimeType: contentTypeOf(resolved.value.real),
			expiresAt: now() + ttlMs,
		};
		entries.set(id, entry);
		return entry;
	}

	async function handle({
		req,
		res,
		id,
	}: {
		req: IncomingMessage;
		res: ServerResponse;
		id: string;
	}): Promise<void> {
		if (req.method === "OPTIONS") {
			answerPreflight({ req, res, methods: METHODS });
			return;
		}
		if (!applyCors({ req, res, methods: METHODS })) return;
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.setHeader("Allow", METHODS);
			sendJson({ res, status: 405, body: { error: "method not allowed" } });
			return;
		}
		const entry = ID_PATTERN.test(id) ? get(id) : null;
		if (!entry) {
			sendJson({
				res,
				status: 404,
				body: { error: "unknown or expired file id" },
			});
			return;
		}
		// Re-check at serve time: the file may have been moved, deleted or swapped for a symlink.
		const resolved = await resolveAllowedPath({
			input: entry.path,
			roots: getRoots(),
			kind: "file",
		});
		if (!resolved.ok || resolved.value.real !== entry.path) {
			const missing = !resolved.ok && resolved.code === "MISSING";
			logger.warn("refused file", {
				id,
				reason: resolved.ok ? "path changed" : resolved.reason,
			});
			sendJson({
				res,
				status: missing ? 404 : 403,
				body: {
					error: missing ? "file no longer exists" : "file no longer allowed",
				},
			});
			return;
		}
		const size = resolved.value.stats.size;
		const range = parseRange({ header: req.headers.range, size });
		res.setHeader("Accept-Ranges", "bytes");
		res.setHeader("Content-Type", entry.mimeType);
		res.setHeader("Last-Modified", resolved.value.stats.mtime.toUTCString());
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Content-Security-Policy", "sandbox");
		res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
		if (range === "unsatisfiable") {
			res.setHeader("Content-Range", `bytes */${size}`);
			sendJson({ res, status: 416, body: { error: "range not satisfiable" } });
			return;
		}
		const start = range?.start ?? 0;
		const end = range?.end ?? size - 1;
		const length = size === 0 ? 0 : end - start + 1;
		res.statusCode = range ? 206 : 200;
		res.setHeader("Content-Length", length);
		if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
		if (req.method === "HEAD" || length === 0) {
			res.end();
			return;
		}
		await new Promise<void>((resolve) => {
			const stream = createReadStream(entry.path, { start, end });
			const finish = () => resolve();
			stream.on("error", (error) => {
				logger.warn("file stream failed", { id, error });
				res.destroy(error);
				finish();
			});
			res.on("close", () => {
				stream.destroy();
				finish();
			});
			res.on("finish", finish);
			stream.pipe(res);
		});
		logger.debug("served file", {
			id,
			bytes: length,
			range: range ? `${start}-${end}` : undefined,
		});
	}

	return { registerFile, get, handle, size: () => entries.size };
}
