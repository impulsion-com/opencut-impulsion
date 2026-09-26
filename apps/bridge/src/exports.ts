import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, mkdir, stat, statfs, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { errorMessage } from "./errors";
import { answerPreflight, applyCors, sendJson } from "./http-utils";
import type { JobTable } from "./jobs";
import type { Logger } from "./log";

// POST /exports/<jobId>: the editor tab uploads a finished render here. Only jobs the sidecar created with
// start_export are accepted, once each. The body streams to a hidden temp file in the exports folder, then is
// hard-linked to its final name (a " (2)" suffix when the name is taken), so a partial file is never visible.

const METHODS = "POST, OPTIONS";
/** Keep this much free space on the exports volume beyond the upload itself. */
const FREE_SPACE_MARGIN_BYTES = 200 * 1024 * 1024;

export interface ExportUploads {
	handle(options: {
		req: IncomingMessage;
		res: ServerResponse;
		jobId: string;
	}): Promise<void>;
	/** Stops a running upload for the job and deletes its partial file (cancel_job). */
	abort(jobId: string): boolean;
}

export class SizeLimitError extends Error {}

/** Counts bytes and fails once the limit is passed. */
function byteCounter(limit: number): Transform & { bytes: number } {
	const counter = new Transform({
		transform(
			chunk: Buffer,
			_encoding: BufferEncoding,
			callback: TransformCallback,
		) {
			counter.bytes += chunk.length;
			if (counter.bytes > limit) {
				callback(new SizeLimitError(`upload larger than ${limit} bytes`));
				return;
			}
			callback(null, chunk);
		},
	}) as Transform & { bytes: number };
	counter.bytes = 0;
	return counter;
}

/** "name.mp4" -> "name.mp4", "name (2).mp4", "name (3).mp4"... */
export function candidateName(fileName: string, attempt: number): string {
	if (attempt <= 1) return fileName;
	const extension = path.extname(fileName);
	const base = fileName.slice(0, fileName.length - extension.length);
	return `${base} (${attempt})${extension}`;
}

/** First "name (n).ext" in `dir` that does not exist yet (a guess: the upload links with exclusive create). */
export async function nextFreePath(
	dir: string,
	fileName: string,
): Promise<string> {
	for (let attempt = 1; attempt < 10_000; attempt += 1) {
		const candidate = path.join(dir, candidateName(fileName, attempt));
		try {
			await stat(candidate);
		} catch {
			return candidate;
		}
	}
	return path.join(dir, `${Date.now()}-${fileName}`);
}

async function linkUnique(
	temp: string,
	dir: string,
	fileName: string,
): Promise<string> {
	for (let attempt = 1; attempt < 10_000; attempt += 1) {
		const candidate = path.join(dir, candidateName(fileName, attempt));
		try {
			await link(temp, candidate);
			return candidate;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	throw new Error("no free file name");
}

export function createExportUploads({
	jobs,
	getExportsDir,
	maxBytes,
	logger,
	probeDuration,
}: {
	jobs: JobTable;
	getExportsDir: () => string;
	maxBytes: number;
	logger: Logger;
	/** Duration in seconds of the written file (best effort). */
	probeDuration?: (filePath: string) => Promise<number | undefined>;
}): ExportUploads {
	const active = new Map<string, { req: IncomingMessage; temp: string }>();

	async function handle({
		req,
		res,
		jobId,
	}: {
		req: IncomingMessage;
		res: ServerResponse;
		jobId: string;
	}): Promise<void> {
		if (req.method === "OPTIONS") {
			answerPreflight({ req, res, methods: METHODS });
			return;
		}
		if (!applyCors({ req, res, methods: METHODS })) return;
		if (req.method !== "POST") {
			res.setHeader("Allow", METHODS);
			sendJson({ res, status: 405, body: { error: "method not allowed" } });
			return;
		}
		const job = jobs.get(jobId);
		if (!job || job.kind !== "export" || !job.export) {
			sendJson({ res, status: 404, body: { error: "unknown export job" } });
			return;
		}
		if (
			job.status === "done" ||
			job.status === "failed" ||
			job.status === "cancelled"
		) {
			sendJson({
				res,
				status: 409,
				body: { error: `export job already ${job.status}` },
			});
			return;
		}
		if (job.export.upload !== "none" || active.has(jobId)) {
			sendJson({
				res,
				status: 409,
				body: { error: "an upload for this job is already running or done" },
			});
			return;
		}
		const lengthHeader = req.headers["content-length"];
		const declared =
			lengthHeader === undefined ? undefined : Number(lengthHeader);
		if (
			declared !== undefined &&
			(!Number.isFinite(declared) || declared < 0)
		) {
			sendJson({ res, status: 400, body: { error: "invalid Content-Length" } });
			return;
		}
		if (declared !== undefined && declared > maxBytes) {
			sendJson({
				res,
				status: 413,
				body: { error: `export larger than the ${maxBytes} byte limit` },
			});
			return;
		}
		if (declared === 0) {
			sendJson({ res, status: 400, body: { error: "empty upload" } });
			return;
		}

		const dir = getExportsDir();
		try {
			await mkdir(dir, { recursive: true });
			const space = await statfs(dir);
			const free = Number(space.bavail) * Number(space.bsize);
			if (declared !== undefined && free < declared + FREE_SPACE_MARGIN_BYTES) {
				sendJson({
					res,
					status: 507,
					body: { error: "not enough free disk space for this export" },
				});
				return;
			}
		} catch (error) {
			logger.error("exports folder unavailable", { dir, error });
			sendJson({
				res,
				status: 500,
				body: { error: "exports folder unavailable" },
			});
			return;
		}

		const temp = path.join(
			dir,
			`.opencut-upload-${randomBytes(8).toString("hex")}.part`,
		);
		active.set(jobId, { req, temp });
		jobs.update(jobId, {
			status: "running",
			phase: "uploading",
			message: "Enregistrement du fichier sur le disque",
			export: { upload: "receiving" },
		});
		logger.info("export upload started", { jobId, bytes: declared });
		const counter = byteCounter(maxBytes);
		try {
			await pipeline(req, counter, createWriteStream(temp, { flags: "wx" }));
			if (declared !== undefined && counter.bytes !== declared) {
				throw new Error(
					`upload truncated (${counter.bytes} of ${declared} bytes)`,
				);
			}
			if (counter.bytes === 0) throw new Error("empty upload");
			const current = jobs.get(jobId);
			if (
				!current ||
				current.status === "cancelled" ||
				current.status === "failed"
			) {
				throw new Error(`export job ${current?.status ?? "missing"}`);
			}
			const finalPath = await linkUnique(temp, dir, job.export.fileName);
			await unlink(temp).catch(() => {});
			const durationSeconds = await probeDuration?.(finalPath).catch(
				() => undefined,
			);
			jobs.update(jobId, { export: { upload: "done", outputPath: finalPath } });
			jobs.finish(jobId, {
				status: "done",
				result: {
					path: finalPath,
					sizeBytes: counter.bytes,
					...(durationSeconds === undefined ? {} : { durationSeconds }),
				},
				message: `Export enregistré : ${finalPath}`,
			});
			logger.info("export written", {
				jobId,
				path: finalPath,
				bytes: counter.bytes,
			});
			sendJson({
				res,
				status: 201,
				body: { path: finalPath, sizeBytes: counter.bytes },
			});
		} catch (error) {
			await unlink(temp).catch(() => {});
			const tooLarge = error instanceof SizeLimitError;
			// Let the tab retry the upload (or report failure) unless the job was cancelled meanwhile.
			jobs.update(jobId, { export: { upload: "none" } });
			logger.warn("export upload failed", {
				jobId,
				error: errorMessage(error),
			});
			if (!res.headersSent && !res.destroyed) {
				sendJson({
					res,
					status: tooLarge ? 413 : 400,
					body: { error: errorMessage(error) },
				});
			}
		} finally {
			active.delete(jobId);
		}
	}

	return {
		handle,
		abort(jobId) {
			const upload = active.get(jobId);
			if (!upload) return false;
			upload.req.destroy(new Error("export cancelled"));
			return true;
		},
	};
}
