import { mkdir } from "node:fs/promises";
import {
	BRIDGE_EXPORTS_PATH,
	BRIDGE_ORIGIN,
	parseToolInput,
	TOOL_DEFAULTS,
	TOOLS,
	toMcpToolConfig,
	type HybridToolName,
	type SidecarToolName,
	type TabToolName,
	type ToolDefinition,
	type ToolInput,
	type ToolName,
	type ToolResult,
} from "@opencut/claude-tools";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BridgeConfig } from "./config";
import { listDiskMedia } from "./disk-media";
import { BridgeError, errorMessage, toBridgeError } from "./errors";
import { nextFreePath, type ExportUploads } from "./exports";
import { FileAccessError, type FileRegistry } from "./files";
import type { EditorHub } from "./hub";
import { isFinished, type JobTable, type ToolOrigin } from "./jobs";
import type { Logger } from "./log";
import type { MediaIndex, MediaIndexEntry } from "./media-index";
import type { MotionService } from "./motion";
import { mediaTypeOf } from "./media-types";
import { toCallToolResult, toErrorCallToolResult } from "./mcp-result";
import type { Prober } from "./probe";

// The ONE tool registry, used twice: on the Streamable HTTP MCP server (Claude Code) and on the chat panel's
// in-process SDK MCP server. Every contract tool gets exactly one handler:
// - runsIn "tab": forwarded unchanged to the editor tab with hub.call (list_media also gains disk paths);
// - runsIn "hybrid" / "sidecar": implemented here (disk, jobs), calling the tab through internal methods.

export interface ToolCallContext {
	signal?: AbortSignal;
	origin: ToolOrigin;
	/**
	 * Tells the client how far a long call got (0..1). Set when the client asked for progress (MCP progressToken):
	 * Claude Code aborts an HTTP tool call after 5 min without a response or a progress notification.
	 */
	reportProgress?: (update: { progress: number; message?: string }) => void;
}

type Handler<N extends ToolName> = (
	input: ToolInput<N>,
	ctx: ToolCallContext,
) => Promise<ToolResult>;
type UntypedHandler = (
	input: unknown,
	ctx: ToolCallContext,
) => Promise<ToolResult>;

export interface RegistryEntry {
	tool: ToolDefinition;
	/** "tab": forwarded to the editor tab; "sidecar": implemented in this process. */
	handledBy: "tab" | "sidecar";
	handler: UntypedHandler;
}

export interface ToolRegistry {
	readonly entries: readonly RegistryEntry[];
	get(name: string): RegistryEntry | undefined;
	/** Validates the params with the contract schema, then runs the handler. Throws BridgeError. */
	run(name: string, params: unknown, ctx: ToolCallContext): Promise<ToolResult>;
}

export interface ToolRegistryDeps {
	hub: EditorHub;
	jobs: JobTable;
	files: FileRegistry;
	uploads: Pick<ExportUploads, "abort">;
	mediaIndex: MediaIndex;
	motion: MotionService;
	prober: Prober | null;
	config: Pick<BridgeConfig, "allowedRoots" | "exportsDir">;
	logger: Logger;
	now?: () => Date;
}

const IMPORT_TIMEOUT_MS = 30 * 60_000;
/** Longest silence between two progress notifications of a waiting call (one huge file can copy for minutes). */
export const PROGRESS_HEARTBEAT_MS = 30_000;
/** Job updates can arrive per chunk: relay at most one per this interval (the heartbeat covers the rest). */
const PROGRESS_MIN_INTERVAL_MS = 1_000;
const MEDIA_ID_LOOKUP_TIMEOUT_MS = 5_000;
const CANCEL_TIMEOUT_MS = 15_000;

/** Tab result of internal.import_files (lenient: extra fields pass through). */
const ImportResultSchema = z.looseObject({
	imported: z.array(z.looseObject({ path: z.string(), mediaId: z.string() })),
	skipped: z
		.array(z.looseObject({ path: z.string(), reason: z.string() }))
		.optional(),
});

/** "Mon projet: v2.mp4" -> "Mon projet- v2" (no path separators, no control characters, no extension). */
export function sanitizeExportName(raw: string): string {
	const cleaned = raw
		.replace(/\.(mp4|webm|mov)$/i, "")
		.replace(/[/\\:*?"<>|\u0000-\u001f\u007f]+/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s-]+|[.\s]+$/g, "")
		.slice(0, 120)
		.trim();
	return cleaned || "export";
}

function timestampForFileName(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}h${pad(date.getMinutes())}m${pad(date.getSeconds())}`;
}

/** Relays a job's progress to the client while a call waits on it, with a heartbeat. Returns the stop function. */
function relayJobProgress({
	jobs,
	jobId,
	report,
	now = () => Date.now(),
}: {
	jobs: JobTable;
	jobId: string;
	report: ToolCallContext["reportProgress"];
	now?: () => number;
}): () => void {
	if (!report) return () => {};
	let lastSentAt = 0;
	const send = (force: boolean) => {
		const job = jobs.get(jobId);
		if (!job || isFinished(job)) return;
		if (!force && now() - lastSentAt < PROGRESS_MIN_INTERVAL_MS) return;
		lastSentAt = now();
		report({
			progress: job.progress,
			...(job.message ? { message: job.message } : {}),
		});
	};
	const unsubscribe = jobs.subscribe((job) => {
		if (job.id === jobId) send(false);
	});
	const timer = setInterval(() => send(true), PROGRESS_HEARTBEAT_MS);
	timer.unref?.();
	send(true);
	return () => {
		unsubscribe();
		clearInterval(timer);
	};
}

/** Awaits `work` but gives up (throws a cancellation) when the signal aborts; `work` keeps running. */
async function untilAborted<T>(
	work: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	if (!signal) return work;
	if (signal.aborted)
		throw new BridgeError({
			code: "TIMEOUT",
			message: "The call was cancelled by the client.",
		});
	return new Promise<T>((resolve, reject) => {
		const onAbort = () =>
			reject(
				new BridgeError({
					code: "TIMEOUT",
					message: "The call was cancelled by the client.",
				}),
			);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export function createToolRegistry(deps: ToolRegistryDeps): ToolRegistry {
	const {
		hub,
		jobs,
		files,
		uploads,
		mediaIndex,
		motion,
		prober,
		config,
		logger,
	} = deps;
	const now = deps.now ?? (() => new Date());
	/** Real path -> id of the running import job copying it. */
	const importsInFlight = new Map<string, string>();

	function requireProject(): string {
		if (!hub.isConnected()) {
			throw new BridgeError({
				code: "EDITOR_NOT_CONNECTED",
				message: "No editor tab is connected to the sidecar.",
			});
		}
		const projectId = hub.getActiveProjectId();
		if (!projectId)
			throw new BridgeError({
				code: "NO_PROJECT",
				message: "No project is open in the editor tab.",
			});
		return projectId;
	}

	function forward<N extends TabToolName>(name: N): Handler<N> {
		return (input, ctx) => hub.call(name, input, { signal: ctx.signal });
	}

	/** mediaId by real disk path, for the media of the open project that came from import_media. */
	async function importedMediaIds(
		signal?: AbortSignal,
	): Promise<Map<string, string>> {
		const byPath = new Map<string, string>();
		const projectId = hub.getActiveProjectId();
		if (!hub.isConnected() || !projectId) return byPath;
		try {
			const [index, listed] = await Promise.all([
				mediaIndex.read(projectId),
				hub.call(
					"list_media",
					{},
					{ timeoutMs: MEDIA_ID_LOOKUP_TIMEOUT_MS, waitForTabMs: 0, signal },
				),
			]);
			const ids = new Set<string>();
			if (Array.isArray(listed.json)) {
				for (const asset of listed.json) {
					const id: unknown =
						typeof asset === "object" && asset !== null
							? Reflect.get(asset, "id")
							: undefined;
					if (typeof id === "string") ids.add(id);
				}
			}
			for (const [mediaId, entry] of Object.entries(index)) {
				if (ids.has(mediaId)) byPath.set(entry.path, mediaId);
			}
		} catch (error) {
			logger.debug("media ids unavailable", { error: errorMessage(error) });
		}
		return byPath;
	}

	const listMedia: Handler<"list_media"> = async (input, ctx) => {
		const result = await hub.call("list_media", input, { signal: ctx.signal });
		const projectId = hub.getActiveProjectId();
		if (!projectId || !Array.isArray(result.json)) return result;
		let index: Record<string, MediaIndexEntry>;
		try {
			index = await mediaIndex.read(projectId);
		} catch {
			return result;
		}
		const json = result.json.map((asset: unknown) => {
			if (typeof asset !== "object" || asset === null) return asset;
			const id: unknown = Reflect.get(asset, "id");
			const entry = typeof id === "string" ? index[id] : undefined;
			return entry ? { ...asset, path: entry.path } : asset;
		});
		return { ...result, json };
	};

	/** import_media, plus the internal `replace` used by update_motion_block (swap the media of one element). */
	async function importFromDisk(
		input: ToolInput<"import_media"> & {
			replace?: { elementId: string; removeMediaId?: string };
		},
		ctx: ToolCallContext,
	): Promise<ToolResult> {
		const projectId = requireProject();
		const skipped: Array<{ path: string; reason: string }> = [];
		const byRealPath = new Map<
			string,
			{
				path: string;
				url: string;
				name: string;
				size: number;
				mimeType: string;
				lastModified: number;
				mtimeMs: number;
			}
		>();
		for (const requested of input.paths) {
			try {
				const file = await files.registerFile(requested);
				if (!mediaTypeOf(file.path)) {
					skipped.push({
						path: requested,
						reason: "unsupported file type (video, audio or image expected)",
					});
					continue;
				}
				if (byRealPath.has(file.path)) {
					skipped.push({ path: requested, reason: "listed twice" });
					continue;
				}
				const runningJobId = importsInFlight.get(file.path);
				if (runningJobId) {
					skipped.push({
						path: requested,
						reason: `already being imported by job ${runningJobId}: wait for it with job_status, then list_media`,
					});
					continue;
				}
				byRealPath.set(file.path, {
					path: file.path,
					url: file.url,
					name: file.name,
					size: file.size,
					mimeType: file.mimeType,
					lastModified: Math.round(file.mtimeMs),
					mtimeMs: file.mtimeMs,
				});
			} catch (error) {
				if (!(error instanceof FileAccessError)) throw error;
				skipped.push({ path: requested, reason: error.message });
			}
		}
		if (byRealPath.size === 0) return { json: { imported: [], skipped } };

		const job = jobs.create({
			kind: "import",
			origin: ctx.origin,
			projectId,
			status: "running",
		});
		const importFiles = [...byRealPath.values()].map(
			({ mtimeMs: _mtimeMs, ...file }) => file,
		);
		logger.info("import started", {
			jobId: job.id,
			files: importFiles.length,
			projectId,
		});

		// A retry while this import runs (a client that gave up) must not copy the same files a second time.
		for (const realPath of byRealPath.keys()) importsInFlight.set(realPath, job.id);

		// Not tied to ctx.signal: if the MCP client gives up, the tab keeps importing and the index is still
		// recorded when it answers.
		const work = hub
			.call(
				"internal.import_files",
				{
					jobId: job.id,
					files: importFiles,
					...(input.place ? { place: input.place } : {}),
					...(input.replace ? { replace: input.replace } : {}),
				},
				{ projectId, timeoutMs: IMPORT_TIMEOUT_MS },
			)
			.then(async (result) => {
				const parsed = ImportResultSchema.safeParse(result.json);
				if (parsed.success) {
					const importedAt = now().toISOString();
					const entries: Record<string, MediaIndexEntry> = {};
					for (const item of parsed.data.imported) {
						const source = byRealPath.get(item.path);
						if (source)
							entries[item.mediaId] = {
								path: source.path,
								size: source.size,
								mtimeMs: source.mtimeMs,
								importedAt,
							};
					}
					if (Object.keys(entries).length > 0) {
						await mediaIndex
							.record(projectId, entries)
							.catch((error: unknown) => {
								logger.error("could not write the media index", {
									projectId,
									error: errorMessage(error),
								});
							});
					}
				} else {
					logger.warn(
						"unexpected import result shape (media index not updated)",
						{ jobId: job.id },
					);
				}
				jobs.finish(job.id, { status: "done", result: result.json });
				return result;
			})
			.catch((error: unknown) => {
				const bridgeError = toBridgeError(error);
				jobs.finish(job.id, {
					status: "failed",
					error: `${bridgeError.code}: ${bridgeError.message}`,
				});
				throw bridgeError;
			})
			.finally(() => {
				for (const realPath of byRealPath.keys()) {
					if (importsInFlight.get(realPath) === job.id)
						importsInFlight.delete(realPath);
				}
			});
		work.catch(() => {});

		const stopProgress = relayJobProgress({
			jobs,
			jobId: job.id,
			report: ctx.reportProgress,
		});
		let result: ToolResult;
		try {
			result = await untilAborted(work, ctx.signal);
		} finally {
			stopProgress();
		}
		const parsed = ImportResultSchema.safeParse(result.json);
		if (!parsed.success) return result;
		const json = {
			...(result.json as Record<string, unknown>),
			skipped: [...skipped, ...(parsed.data.skipped ?? [])],
		};
		return { ...result, json };
	}

	/** Canvas and frame rate of the open project: a block is rendered to match them. */
	async function projectFormat(
		signal?: AbortSignal,
	): Promise<{ width: number; height: number; fps: number }> {
		const state = await hub.call("get_editor_state", {}, { signal });
		const parsed = z
			.looseObject({
				project: z.looseObject({
					canvas: z.looseObject({ width: z.number(), height: z.number() }),
					fps: z.number(),
				}),
			})
			.safeParse(state.json);
		if (!parsed.success)
			throw new BridgeError({
				code: "INTERNAL",
				message: "Could not read the project canvas and fps from the editor.",
			});
		return {
			width: parsed.data.project.canvas.width,
			height: parsed.data.project.canvas.height,
			fps: parsed.data.project.fps,
		};
	}

	/** A block designed at one size or frame rate keeps them; the others follow the project. */
	function blockFormat(
		block: { size?: { width: number; height: number }; fps?: number },
		project: { width: number; height: number; fps: number },
	): { width: number; height: number; fps: number } {
		return {
			width: block.size?.width ?? project.width,
			height: block.size?.height ?? project.height,
			fps: block.fps ?? project.fps,
		};
	}

	/** The motion entry behind a timeline element, or NOT_FOUND. */
	async function motionElement(
		projectId: string,
		elementId: string,
		signal?: AbortSignal,
	) {
		const element = await hub.call("get_element", { elementId }, { signal });
		const mediaId: unknown =
			typeof element.json === "object" && element.json !== null
				? Reflect.get(element.json, "mediaId")
				: undefined;
		const entry =
			typeof mediaId === "string"
				? (await motion.read(projectId))[mediaId]
				: undefined;
		if (typeof mediaId !== "string" || !entry)
			throw new BridgeError({
				code: "NOT_FOUND",
				message: `Element "${elementId}" is not a motion block (only elements made by add_motion_block can be updated).`,
			});
		return { mediaId, entry };
	}

	/** Renders, relaying the progress as the first 85 % of the call (the import is the rest). */
	function renderBlock(
		request: Parameters<MotionService["render"]>[0],
		ctx: ToolCallContext,
	) {
		return motion.render({
			...request,
			signal: ctx.signal,
			onProgress: (progress) =>
				ctx.reportProgress?.({
					progress: progress * 0.85,
					message: "Rendu du bloc motion",
				}),
		});
	}

	function firstImported(result: ToolResult): {
		mediaId: string;
		elementId?: string;
	} {
		const parsed = z
			.looseObject({
				imported: z.array(z.looseObject({ mediaId: z.string() })).min(1),
				elementIds: z.array(z.string()).optional(),
			})
			.safeParse(result.json);
		if (!parsed.success)
			throw new BridgeError({
				code: "INTERNAL",
				message: `The rendered block could not be added to the project: ${JSON.stringify(result.json).slice(0, 300)}`,
			});
		const imported = parsed.data.imported[0];
		if (!imported)
			throw new BridgeError({ code: "INTERNAL", message: "Empty import." });
		return { mediaId: imported.mediaId, elementId: parsed.data.elementIds?.[0] };
	}

	const sidecarHandlers: {
		[N in HybridToolName | SidecarToolName]: Handler<N>;
	} = {
		async list_disk_media(input, ctx) {
			const mediaIds =
				input.folder === undefined
					? undefined
					: await importedMediaIds(ctx.signal);
			const listing = await listDiskMedia({
				folder: input.folder,
				recursive: input.recursive ?? TOOL_DEFAULTS.listDiskMediaRecursive,
				extensions: input.extensions,
				roots: config.allowedRoots,
				prober,
				mediaIds,
			});
			return { json: listing };
		},

		import_media: (input, ctx) => importFromDisk(input, ctx),

		async list_motion_blocks(input, ctx) {
			if (input.elementId === undefined) return { json: { blocks: motion.blocks } };
			const projectId = requireProject();
			const { mediaId, entry } = await motionElement(
				projectId,
				input.elementId,
				ctx.signal,
			);
			return {
				json: {
					blocks: motion.blocks,
					element: {
						elementId: input.elementId,
						mediaId,
						block: entry.block,
						props: entry.props,
						duration: entry.duration,
					},
				},
			};
		},

		async add_motion_block(input, ctx) {
			const projectId = requireProject();
			const resolved = motion.resolve({
				block: input.block,
				props: input.props ?? {},
				duration: input.duration,
			});
			const format = blockFormat(resolved.block, await projectFormat(ctx.signal));
			if (
				resolved.block.fullScreen &&
				!resolved.block.size &&
				format.height > format.width
			)
				throw new BridgeError({
					code: "INVALID_PARAMS",
					message: `Block "${resolved.block.id}" is a full-screen 16:9 shot: it does not fit a vertical canvas yet. Use an overlay block instead.`,
				});
			const rendered = await renderBlock(
				{ projectId, ...resolved, ...format },
				ctx,
			);
			const result = await importFromDisk(
				{
					paths: [rendered.file],
					place: { start: input.start, track: input.track ?? "overlay" },
				},
				ctx,
			);
			const { mediaId, elementId } = firstImported(result);
			await motion.record(projectId, mediaId, {
				block: resolved.block.id,
				props: resolved.props,
				duration: rendered.duration,
				...format,
				file: rendered.file,
				renderedAt: "",
			});
			return {
				json: {
					...(elementId ? { elementId } : {}),
					mediaId,
					block: resolved.block.id,
					props: resolved.props,
					duration: rendered.duration,
					start: input.start,
					...(elementId
						? {}
						: {
								warnings: [
									"The block was rendered and added to the media library but could not be placed; place it with apply_edit_plan insert_media.",
								],
							}),
				},
			};
		},

		async update_motion_block(input, ctx) {
			const projectId = requireProject();
			const { mediaId: previousMediaId, entry } = await motionElement(
				projectId,
				input.elementId,
				ctx.signal,
			);
			// For a block with duration fields, new settings decide the length unless a duration is given too.
			const resolved = motion.resolve({
				block: entry.block,
				props: { ...entry.props, ...(input.props ?? {}) },
				duration:
					input.duration ?? (input.props ? undefined : entry.duration),
			});
			const format = blockFormat(resolved.block, await projectFormat(ctx.signal));
			const rendered = await renderBlock(
				{ projectId, ...resolved, ...format },
				ctx,
			);
			const result = await importFromDisk(
				{
					paths: [rendered.file],
					replace: {
						elementId: input.elementId,
						removeMediaId: previousMediaId,
					},
				},
				ctx,
			);
			const { mediaId } = firstImported(result);
			await motion.record(projectId, mediaId, {
				block: resolved.block.id,
				props: resolved.props,
				duration: rendered.duration,
				...format,
				file: rendered.file,
				renderedAt: "",
			});
			return {
				json: {
					elementId: input.elementId,
					mediaId,
					block: resolved.block.id,
					props: resolved.props,
					duration: rendered.duration,
				},
			};
		},

		async start_export(input, ctx) {
			const projectId = requireProject();
			const format = input.format ?? TOOL_DEFAULTS.exportFormat;
			const quality = input.quality ?? TOOL_DEFAULTS.exportQuality;
			const includeAudio =
				input.includeAudio ?? TOOL_DEFAULTS.exportIncludeAudio;
			const baseName = sanitizeExportName(
				input.fileName ??
					`${hub.getActiveProjectName() ?? "Export"} ${timestampForFileName(now())}`,
			);
			const fileName = `${baseName}.${format}`;
			await mkdir(config.exportsDir, { recursive: true });
			const outputPath = await nextFreePath(config.exportsDir, fileName);
			const job = jobs.create({
				kind: "export",
				origin: ctx.origin,
				projectId,
				export: { fileName, format, outputPath, upload: "none" },
			});
			const uploadUrl = `${BRIDGE_ORIGIN}${BRIDGE_EXPORTS_PATH}/${job.id}`;
			try {
				await hub.call(
					"internal.export_start",
					{ jobId: job.id, format, quality, includeAudio, fileName, uploadUrl },
					{
						projectId,
						signal: ctx.signal,
						onDispatch: ({ connectionId }) =>
							jobs.update(job.id, { export: { connectionId } }),
					},
				);
			} catch (error) {
				const bridgeError = toBridgeError(error);
				jobs.finish(job.id, {
					status: "failed",
					error: `${bridgeError.code}: ${bridgeError.message}`,
				});
				throw bridgeError;
			}
			const current = jobs.get(job.id);
			if (current && !isFinished(current) && current.status === "queued") {
				jobs.update(job.id, {
					status: "running",
					phase: "rendering",
					message: "Rendu de l'export en cours",
				});
			}
			logger.info("export started", {
				jobId: job.id,
				format,
				quality,
				outputPath,
			});
			return { json: { jobId: job.id, outputPath } };
		},

		async job_status(input, ctx) {
			const job = jobs.get(input.jobId);
			if (!job)
				throw new BridgeError({
					code: "NOT_FOUND",
					message: `Unknown job "${input.jobId}" (jobs are kept 24 h and lost when the sidecar restarts).`,
				});
			const waited = await jobs.waitFor(job.id, {
				timeoutMs:
					(input.waitSeconds ?? TOOL_DEFAULTS.jobStatusWaitSeconds) * 1000,
				signal: ctx.signal,
			});
			return { json: jobs.snapshot(waited ?? job) };
		},

		async cancel_job(input) {
			/** Asks the tab to stop rendering this export; true when it was rendering it. */
			const cancelInTab = async (jobId: string): Promise<boolean> => {
				if (!hub.isConnected()) return false;
				try {
					const result = await hub.call(
						"internal.export_cancel",
						{ jobId },
						{ timeoutMs: CANCEL_TIMEOUT_MS, waitForTabMs: 0 },
					);
					const json = result.json;
					return (
						typeof json === "object" &&
						json !== null &&
						Reflect.get(json, "cancelled") === true
					);
				} catch (error) {
					logger.warn("export cancel not confirmed by the tab", {
						jobId,
						error: errorMessage(error),
					});
					return false;
				}
			};

			const job = jobs.get(input.jobId);
			if (!job) {
				// The sidecar restarted since start_export: the tab may still be rendering that job.
				if (await cancelInTab(input.jobId))
					return { json: { jobId: input.jobId, status: "cancelled" } };
				throw new BridgeError({
					code: "NOT_FOUND",
					message: `Unknown job "${input.jobId}".`,
				});
			}
			if (job.kind !== "export") {
				if (isFinished(job))
					return { json: { jobId: job.id, status: job.status } };
				throw new BridgeError({
					code: "INVALID_PARAMS",
					message:
						"Only export jobs can be cancelled; an import finishes when import_media returns.",
				});
			}
			if (isFinished(job)) {
				// A job failed because its tab's socket dropped may still be rendering in that tab.
				if (job.status === "failed") await cancelInTab(job.id);
				return { json: { jobId: job.id, status: job.status } };
			}
			await cancelInTab(job.id);
			uploads.abort(job.id);
			jobs.finish(job.id, { status: "cancelled", message: "Export annulé" });
			return { json: { jobId: job.id, status: "cancelled" } };
		},
	};

	const tabOverrides: { [N in TabToolName]?: Handler<N> } = {
		list_media: listMedia,
	};

	const entries: RegistryEntry[] = TOOLS.map((tool): RegistryEntry => {
		if (tool.runsIn === "tab") {
			const name: TabToolName = tool.name;
			const handler = (tabOverrides[name] ?? forward(name)) as UntypedHandler;
			return { tool, handledBy: "tab", handler };
		}
		const name: HybridToolName | SidecarToolName = tool.name;
		return {
			tool,
			handledBy: "sidecar",
			handler: sidecarHandlers[name] as UntypedHandler,
		};
	});
	const byName = new Map(entries.map((entry) => [entry.tool.name, entry]));

	return {
		entries,
		get: (name) => byName.get(name),
		async run(name, params, ctx) {
			const entry = byName.get(name);
			if (!entry)
				throw new BridgeError({
					code: "INVALID_PARAMS",
					message: `Unknown tool "${name}".`,
				});
			const parsed = parseToolInput(entry.tool.name as ToolName, params);
			if (!parsed.ok) {
				throw new BridgeError({
					code: "INVALID_PARAMS",
					message: parsed.message,
					details: { issues: parsed.issues.slice(0, 20) },
				});
			}
			return entry.handler(parsed.data, ctx);
		},
	};
}

/**
 * MCP notifications/progress for one call: progress in percent of total 100. MCP wants a strictly increasing
 * value, so a heartbeat at an unchanged percent moves it by a negligible step.
 */
export function createProgressNotifier({
	progressToken,
	send,
}: {
	progressToken: string | number;
	send: (notification: {
		method: "notifications/progress";
		params: {
			progressToken: string | number;
			progress: number;
			total: number;
			message?: string;
		};
	}) => Promise<void>;
}): NonNullable<ToolCallContext["reportProgress"]> {
	let last = Number.NEGATIVE_INFINITY;
	return ({ progress, message }) => {
		const percent = Math.min(100, Math.max(0, progress * 100));
		const value = percent > last ? percent : last + 0.001;
		last = value;
		send({
			method: "notifications/progress",
			params: {
				progressToken,
				progress: value,
				total: 100,
				...(message ? { message } : {}),
			},
		}).catch(() => {
			// The client went away; the call itself reports that.
		});
	};
}

/**
 * Registers every contract tool on an McpServer with the contract's own config (the full strict input schema, so
 * misspelled keys fail with -32602 instead of being stripped). Used for the HTTP server and the chat's SDK server.
 */
export function registerToolsOnServer({
	server,
	registry,
	getOrigin,
	logger,
}: {
	server: McpServer;
	registry: ToolRegistry;
	getOrigin: (extra: { sessionId?: string }) => ToolOrigin;
	logger: Logger;
}): void {
	for (const entry of registry.entries) {
		const name = entry.tool.name;
		server.registerTool(
			name,
			toMcpToolConfig(entry.tool),
			async (args: unknown, extra) => {
				const startedAt = Date.now();
				const origin = getOrigin({ sessionId: extra.sessionId });
				const progressToken = extra._meta?.progressToken;
				try {
					const result = await registry.run(name, args, {
						signal: extra.signal,
						origin,
						...(progressToken !== undefined
							? {
									reportProgress: createProgressNotifier({
										progressToken,
										send: (notification) => extra.sendNotification(notification),
									}),
								}
							: {}),
					});
					logger.info("tool ok", {
						tool: name,
						via: origin.kind,
						ms: Date.now() - startedAt,
					});
					return toCallToolResult(result);
				} catch (error) {
					const bridgeError = toBridgeError(error);
					logger.info("tool error", {
						tool: name,
						via: origin.kind,
						code: bridgeError.code,
						ms: Date.now() - startedAt,
					});
					return toErrorCallToolResult(bridgeError);
				}
			},
		);
	}
}
