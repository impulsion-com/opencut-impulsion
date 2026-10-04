import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	clampMotionDuration,
	getMotionBlock,
	MOTION_BLOCKS,
	MotionPropsError,
	normalizeMotionProps,
	type MotionBlock,
	type MotionProps,
} from "@opencut/motion-blocks/catalog";
import { z } from "zod";
import { BridgeError } from "./errors";
import type { Logger } from "./log";
import { projectFolderName } from "./media-index";

// Motion blocks, sidecar half: a per-project index of what each rendered media is (block, props, duration),
// and a renderer that runs Remotion one block at a time. The index is what makes a block editable afterwards:
// the timeline only holds a video element, the settings that produced it live here.
// Stored in <dataDir>/projects/<projectId>/motion-index.json, renders in <motionDir>/<projectId>/.

export interface MotionEntry {
	block: string;
	props: MotionProps;
	/** Seconds. */
	duration: number;
	fps: number;
	width: number;
	height: number;
	/** Disk path of the render. */
	file: string;
	renderedAt: string;
}

const EntrySchema = z.object({
	block: z.string(),
	props: z.record(z.string(), z.unknown()),
	duration: z.number(),
	fps: z.number(),
	width: z.number(),
	height: z.number(),
	file: z.string(),
	renderedAt: z.string(),
});
const IndexSchema = z.object({
	version: z.literal(1),
	projectId: z.string(),
	entries: z.record(z.string(), EntrySchema),
});

export interface MotionRenderRequest {
	projectId: string;
	block: MotionBlock;
	props: MotionProps;
	duration: number;
	fps: number;
	width: number;
	height: number;
	onProgress?: (progress: number) => void;
	signal?: AbortSignal;
}

export interface MotionRenderer {
	(request: MotionRenderRequest & { outputPath: string }): Promise<{
		duration: number;
	}>;
}

export interface MotionService {
	readonly blocks: readonly MotionBlock[];
	/** Validates a block id and its props. Throws BridgeError INVALID_PARAMS. */
	resolve(input: { block: string; props: unknown; duration?: number }): {
		block: MotionBlock;
		props: MotionProps;
		duration: number;
	};
	render(
		request: MotionRenderRequest,
	): Promise<{ file: string; duration: number }>;
	/** Prepares the renderer in the background so the first block does not wait for the bundle. */
	prewarm(): void;
	read(projectId: string): Promise<Record<string, MotionEntry>>;
	record(projectId: string, mediaId: string, entry: MotionEntry): Promise<void>;
}

/** The real renderer, loaded on first use: Remotion and its browser are heavy and most sessions never need them. */
const remotionRenderer: MotionRenderer = async (request) => {
	const { renderMotionBlock } = await import("@opencut/motion-blocks/render");
	const result = await renderMotionBlock({
		block: request.block.id,
		props: request.props,
		duration: request.duration,
		fps: request.fps,
		width: request.width,
		height: request.height,
		outputPath: request.outputPath,
		onProgress: request.onProgress,
		signal: request.signal,
	});
	return { duration: result.duration };
};

export function createMotionService({
	dataDir,
	motionDir,
	logger,
	renderer = remotionRenderer,
	prewarm = () =>
		import("@opencut/motion-blocks/render").then((mod) =>
			mod.prewarmMotionBundle(),
		),
	now = () => new Date(),
}: {
	dataDir: string;
	motionDir: string;
	logger: Logger;
	renderer?: MotionRenderer;
	prewarm?: () => Promise<boolean>;
	now?: () => Date;
}): MotionService {
	// One render at a time: each one already uses every core.
	let renderQueue: Promise<unknown> = Promise.resolve();
	const writeQueues = new Map<string, Promise<unknown>>();

	function indexFile(projectId: string): string {
		return path.join(
			dataDir,
			"projects",
			projectFolderName(projectId),
			"motion-index.json",
		);
	}

	async function load(projectId: string): Promise<z.infer<typeof IndexSchema>> {
		const empty = { version: 1 as const, projectId, entries: {} };
		try {
			const parsed = IndexSchema.safeParse(
				JSON.parse(await readFile(indexFile(projectId), "utf8")),
			);
			if (parsed.success) return parsed.data;
			logger.warn("motion index ignored (invalid)", { projectId });
		} catch {
			// No index yet.
		}
		return empty;
	}

	return {
		blocks: MOTION_BLOCKS,

		resolve({ block: blockId, props, duration }) {
			const block = getMotionBlock(blockId);
			if (!block)
				throw new BridgeError({
					code: "INVALID_PARAMS",
					message: `Unknown motion block "${blockId}". Known: ${MOTION_BLOCKS.map((b) => b.id).join(", ")}.`,
				});
			try {
				return {
					block,
					props: normalizeMotionProps(block, props),
					duration: clampMotionDuration(block, duration ?? block.defaultDuration),
				};
			} catch (error) {
				if (error instanceof MotionPropsError)
					throw new BridgeError({
						code: "INVALID_PARAMS",
						message: `props.${error.message}`,
					});
				throw error;
			}
		},

		render(request) {
			const run = async () => {
				const folder = path.join(motionDir, projectFolderName(request.projectId));
				await mkdir(folder, { recursive: true });
				const file = path.join(
					folder,
					`bloc-${request.block.id}-${randomUUID().slice(0, 8)}.webm`,
				);
				const startedAt = Date.now();
				const { duration } = await renderer({ ...request, outputPath: file });
				logger.info("motion block rendered", {
					block: request.block.id,
					duration,
					ms: Date.now() - startedAt,
				});
				return { file, duration };
			};
			const next = renderQueue.catch(() => {}).then(run);
			renderQueue = next;
			return next;
		},

		prewarm() {
			const startedAt = Date.now();
			prewarm().then(
				(ok) =>
					logger.info(ok ? "motion renderer ready" : "motion renderer not ready", {
						ms: Date.now() - startedAt,
					}),
				() => {},
			);
		},

		async read(projectId) {
			await writeQueues.get(projectId);
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			return (await load(projectId)).entries as Record<string, MotionEntry>;
		},

		record(projectId, mediaId, entry) {
			const previous = writeQueues.get(projectId) ?? Promise.resolve();
			const next = previous
				.catch(() => {})
				.then(async () => {
					const current = await load(projectId);
					current.entries[mediaId] = { ...entry, renderedAt: now().toISOString() };
					const file = indexFile(projectId);
					await mkdir(path.dirname(file), { recursive: true });
					const temp = `${file}.${process.pid}.tmp`;
					await writeFile(temp, `${JSON.stringify(current, null, "\t")}\n`, "utf8");
					await rename(temp, file);
				});
			writeQueues.set(projectId, next);
			return next.finally(() => {
				if (writeQueues.get(projectId) === next) writeQueues.delete(projectId);
			});
		},
	};
}
