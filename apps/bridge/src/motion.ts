import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	MOTION_BLOCKS,
	MotionPropsError,
	normalizeMotionProps,
	resolveMotionTiming,
	type MotionBlock,
	type MotionProps,
} from "@opencut/motion-blocks/catalog";
import type { MotionSource } from "@opencut/motion-blocks/render";
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

/** File a local pack declares its blocks in, at the root of the pack folder. */
export const PACK_FILE = "opencut-pack.json";

// A field of a pack block, checked loosely here; normalizeMotionProps does the real validation of values.
const PackFieldSchema: z.ZodType<unknown> = z.lazy(() =>
	z.looseObject({
		key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/),
		label: z.string().min(1).max(120),
		type: z.enum(["text", "textarea", "number", "select", "list"]),
		default: z.union([
			z.string(),
			z.number(),
			z.array(z.record(z.string(), z.union([z.string(), z.number()]))),
		]),
		item: z.array(PackFieldSchema).optional(),
	}),
);

const PackSchema = z.looseObject({
	name: z.string().min(1).max(80),
	/** Remotion entry, relative to the pack folder (the file that calls registerRoot). */
	entry: z.string().min(1),
	publicDir: z.string().min(1).optional(),
	blocks: z
		.array(
			z.looseObject({
				id: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/),
				label: z.string().min(1).max(120),
				description: z.string().max(400).default(""),
				composition: z.string().min(1),
				defaultDuration: z.number().positive(),
				minDuration: z.number().positive(),
				fullScreen: z.boolean().default(true),
				opaque: z.boolean().optional(),
				durationFields: z.array(z.string()).optional(),
				size: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
				fps: z.number().positive().optional(),
				fields: z.array(PackFieldSchema),
			}),
		)
		.min(1),
});

interface LoadedBlock {
	block: MotionBlock;
	source?: MotionSource;
}

/** Reads the packs' block lists. A broken pack is skipped with a warning: it must not take the editor down. */
function loadPackBlocks(packs: readonly string[], logger: Logger): LoadedBlock[] {
	const loaded: LoadedBlock[] = [];
	const taken = new Set(MOTION_BLOCKS.map((block) => block.id));
	for (const dir of packs) {
		const file = path.join(dir, PACK_FILE);
		if (!existsSync(file)) {
			logger.warn("motion pack ignored (no opencut-pack.json)", { dir });
			continue;
		}
		let parsed: z.infer<typeof PackSchema>;
		try {
			parsed = PackSchema.parse(JSON.parse(readFileSync(file, "utf8")));
		} catch (error) {
			logger.warn("motion pack ignored (invalid opencut-pack.json)", {
				dir,
				error: error instanceof Error ? error.message.slice(0, 300) : String(error),
			});
			continue;
		}
		for (const { composition, ...definition } of parsed.blocks) {
			if (taken.has(definition.id)) {
				logger.warn("motion pack block ignored (id already used)", { dir, id: definition.id });
				continue;
			}
			taken.add(definition.id);
			loaded.push({
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
				block: { ...definition, pack: parsed.name } as unknown as MotionBlock,
				source: {
					entry: path.resolve(dir, parsed.entry),
					publicDir: path.resolve(dir, parsed.publicDir ?? "public"),
					composition,
					watchDir: path.dirname(path.resolve(dir, parsed.entry)),
				},
			});
		}
	}
	return loaded;
}

export interface MotionRenderRequest {
	projectId: string;
	block: MotionBlock;
	props: MotionProps;
	duration: number;
	fps: number;
	width: number;
	height: number;
	/** Set for a block that comes from a local pack. */
	source?: MotionSource;
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
		source?: MotionSource;
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
		definition: request.block,
		...(request.source ? { source: request.source } : {}),
		onProgress: request.onProgress,
		signal: request.signal,
	});
	return { duration: result.duration };
};

export function createMotionService({
	dataDir,
	motionDir,
	packs = [],
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
	/** Folders of local block packs (each holds an opencut-pack.json). */
	packs?: readonly string[];
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

	// Packs are read again on every call: their author edits them while the sidecar runs.
	const allBlocks = (): LoadedBlock[] => [
		...MOTION_BLOCKS.map((block) => ({ block })),
		...loadPackBlocks(packs, logger),
	];

	return {
		get blocks() {
			return allBlocks().map((entry) => entry.block);
		},

		resolve({ block: blockId, props, duration }) {
			const all = allBlocks();
			const found = all.find((entry) => entry.block.id === blockId);
			if (!found)
				throw new BridgeError({
					code: "INVALID_PARAMS",
					message: `Unknown motion block "${blockId}". Known: ${all.map((entry) => entry.block.id).join(", ")}.`,
				});
			const { block, source } = found;
			try {
				return {
					block,
					...resolveMotionTiming({
						block,
						props: normalizeMotionProps(block, props),
						duration,
					}),
					...(source ? { source } : {}),
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
					`bloc-${request.block.id}-${randomUUID().slice(0, 8)}.${request.block.opaque ? "mp4" : "webm"}`,
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
