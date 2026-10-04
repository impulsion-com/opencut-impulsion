import {
	BRIDGE_FILES_PATH,
	isBridgeUrl,
	TOOL_DEFAULTS,
	TRACK_KEYWORDS,
	type InternalMethodParams,
	type ToolResult,
} from "@opencut/claude-tools";
import {
	AddMediaAssetCommand,
	RemoveMediaAssetCommand,
} from "@/commands/media";
import {
	AddTrackCommand,
	InsertElementCommand,
	UpdateElementsCommand,
} from "@/commands/timeline";
import type { Command } from "@/commands";
import type { EditorCore } from "@/core";
import {
	processMediaAssets,
	type ProcessedMediaAsset,
} from "@/media/processing";
import type { MediaType } from "@/media/types";
import { buildElementFromMedia } from "@/timeline/element-utils";
import {
	mediaTimeFromSeconds,
	ZERO_MEDIA_TIME,
	type MediaTime,
} from "@/wasm";
import type { SceneTracks, TimelineElement } from "@/timeline";
import { flushSave, runAiEdit } from "@/claude/edit/ai-edit";
import {
	BridgeError,
	jsonResult,
	type TabHandlerContext,
} from "@/claude/types";
import {
	getOrderedTracks,
	getProjectFps,
	secondsToTicks,
} from "@/claude/units";
import {
	assertNotExporting,
	requireReadyProject,
	round3,
	throwIfAborted,
	waitForUserIdle,
	type HandlerArgs,
} from "@/claude/state/handler-kit";
import { tracksDuration } from "@/claude/state/serialize";
import {
	planImportPlacement,
	validateImportTarget,
	type ImportPlacementPlan,
	type ImportTrackTarget,
} from "./placement-plan";

// internal.import_files, the tab half of import_media (map 4.2): fetch each file from the sidecar's /files
// route, probe it like a drop in the Assets panel (processMediaAssets), then add every asset and the optional
// placements as ONE undo step. Nothing is written to the project before that final step.

type ImportFile =
	InternalMethodParams<"internal.import_files">["files"][number];
type ImportPlace = InternalMethodParams<"internal.import_files">["place"];

/** A drag or scrub at the very end should not throw away a long copy: wait this long for it to end. */
const USER_IDLE_WAIT_MS = 5_000;
/** Share of the job progress spent copying bytes; probing and adding take the rest. */
const COPY_SHARE = 0.85;
const PROBE_SHARE = 0.1;

interface ImportedFile {
	file: ImportFile;
	asset: ProcessedMediaAsset;
}

interface SkippedFile {
	path: string;
	reason: string;
}

function mediaTypeOfMime(mimeType: string): MediaType | null {
	const prefix = mimeType.split("/")[0];
	return prefix === "video" || prefix === "image" || prefix === "audio"
		? prefix
		: null;
}

function toTarget(track: NonNullable<ImportPlace>["track"]): ImportTrackTarget {
	if (track === undefined) return "auto";
	return (
		TRACK_KEYWORDS.find((keyword) => keyword === track) ?? { trackId: track }
	);
}

const byteFormatter = new Intl.NumberFormat("fr-FR", {
	maximumFractionDigits: 1,
});

/** "350 Mo", "1,2 Go" (French: the progress message is shown in the chat panel). */
export function formatBytesFr(bytes: number): string {
	if (bytes >= 1e9) return `${byteFormatter.format(bytes / 1e9)} Go`;
	if (bytes >= 1e6)
		return `${byteFormatter.format(Math.round(bytes / 1e6))} Mo`;
	return `${byteFormatter.format(Math.max(0, Math.round(bytes / 1e3)))} Ko`;
}

/** Streams the body so progress can be reported, into a Blob the browser may keep on disk. */
async function fetchFileBytes({
	file,
	signal,
	onBytes,
}: {
	file: ImportFile;
	signal?: AbortSignal;
	onBytes: (loaded: number) => void;
}): Promise<Blob> {
	const response = await fetch(file.url, { signal, cache: "no-store" });
	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, 200);
		throw new Error(
			`the sidecar answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
		);
	}
	if (!response.body) return response.blob();
	let loaded = 0;
	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			loaded += chunk.byteLength;
			onBytes(loaded);
			controller.enqueue(chunk);
		},
	});
	return new Response(response.body.pipeThrough(counter)).blob();
}

function reportProgress({
	ctx,
	jobId,
	progress,
	phase,
	message,
}: {
	ctx: TabHandlerContext;
	jobId: string | undefined;
	progress: number;
	phase: string;
	message: string;
}): void {
	if (!jobId) return;
	ctx.reportProgress({ jobId, progress, phase, message, kind: "import" });
}

function assetDuration(asset: ProcessedMediaAsset): MediaTime {
	if (asset.type !== "image" && typeof asset.duration === "number") {
		return mediaTimeFromSeconds({ seconds: asset.duration });
	}
	return mediaTimeFromSeconds({ seconds: TOOL_DEFAULTS.imageDurationSeconds });
}

function revokeUrls(imported: readonly ImportedFile[]): void {
	for (const { asset } of imported) {
		if (asset.url) URL.revokeObjectURL(asset.url);
	}
}

/** Downloads and probes every file; unreadable ones go to `skipped`, nothing touches the project yet. */
async function downloadAndProbe({
	files,
	ctx,
	jobId,
}: {
	files: readonly ImportFile[];
	ctx: TabHandlerContext;
	jobId: string | undefined;
}): Promise<{ imported: ImportedFile[]; skipped: SkippedFile[] }> {
	const imported: ImportedFile[] = [];
	const skipped: SkippedFile[] = [];
	const totalBytes = Math.max(
		1,
		files.reduce((sum, file) => sum + file.size, 0),
	);
	let doneBytes = 0;

	for (const [index, file] of files.entries()) {
		throwIfAborted(ctx.signal);
		const mediaType = mediaTypeOfMime(file.mimeType);
		if (!mediaType) {
			skipped.push({
				path: file.path,
				reason: `unsupported file type "${file.mimeType}"`,
			});
			doneBytes += file.size;
			continue;
		}
		if (!isBridgeUrl(file.url, BRIDGE_FILES_PATH)) {
			skipped.push({
				path: file.path,
				reason: "refused URL (not the sidecar's /files route)",
			});
			doneBytes += file.size;
			continue;
		}

		let blob: Blob;
		try {
			blob = await fetchFileBytes({
				file,
				signal: ctx.signal,
				onBytes: (loaded) =>
					reportProgress({
						ctx,
						jobId,
						progress:
							(COPY_SHARE * (doneBytes + Math.min(loaded, file.size))) /
							totalBytes,
						phase: "copying",
						message: `Copie de « ${file.name} » : ${formatBytesFr(loaded)} sur ${formatBytesFr(file.size)}`,
					}),
			});
		} catch (error) {
			throwIfAborted(ctx.signal);
			skipped.push({
				path: file.path,
				reason: `download failed: ${error instanceof Error ? error.message : String(error)}`,
			});
			doneBytes += file.size;
			continue;
		}
		doneBytes += file.size;

		reportProgress({
			ctx,
			jobId,
			progress: COPY_SHARE + (PROBE_SHARE * index) / files.length,
			phase: "probing",
			message: `Analyse de « ${file.name} »`,
		});
		const browserFile = new File([blob], file.name, {
			type: file.mimeType,
			lastModified: file.lastModified ?? Date.now(),
		});
		// One file at a time, so a file processMediaAssets refuses (it toasts why) maps to its path.
		const [asset] = await processMediaAssets({ files: [browserFile] });
		if (!asset) {
			skipped.push({
				path: file.path,
				reason:
					"the editor could not read this file (unsupported, or not enough browser storage)",
			});
			continue;
		}
		if (
			asset.type !== "image" &&
			!(typeof asset.duration === "number" && asset.duration > 0)
		) {
			if (asset.url) URL.revokeObjectURL(asset.url);
			skipped.push({
				path: file.path,
				reason:
					"the editor could not read the duration of this file (damaged or unsupported codec)",
			});
			continue;
		}
		imported.push({ file, asset });
	}
	return { imported, skipped };
}

function canvasNote(editor: EditorCore): string {
	const project = editor.project.getActiveOrNull();
	if (!project) return "";
	const { width, height } = project.settings.canvasSize;
	const fps = project.settings.fps.numerator / project.settings.fps.denominator;
	return ` It is now ${width}x${height} at ${round3(fps)} fps.`;
}

export async function importFiles({
	input,
	ctx,
}: HandlerArgs<"internal.import_files">): Promise<ToolResult> {
	const { editor } = ctx;
	const { project, scene } = requireReadyProject(editor);
	assertNotExporting({ editor });
	const projectId = project.metadata.id;
	const target = input.place ? toTarget(input.place.track) : null;

	if (target) {
		const problem = validateImportTarget({
			tracks: scene.tracks,
			target,
			mediaTypes: input.files.flatMap((file) => {
				const type = mediaTypeOfMime(file.mimeType);
				return type ? [type] : [];
			}),
		});
		if (problem)
			throw new BridgeError({ code: problem.code, message: problem.message });
	}

	const { imported, skipped } = await downloadAndProbe({
		files: input.files,
		ctx,
		jobId: input.jobId,
	});

	try {
		throwIfAborted(ctx.signal);
		if (imported.length === 0) {
			return jsonResult({
				imported: [],
				...(target ? { elementIds: [] } : {}),
				skipped,
			});
		}
		reportProgress({
			ctx,
			jobId: input.jobId,
			progress: COPY_SHARE + PROBE_SHARE,
			phase: "adding",
			message: "Ajout au projet",
		});
		await waitForUserIdle({
			editor,
			timeoutMs: USER_IDLE_WAIT_MS,
			signal: ctx.signal,
		});
		requireReadyProject(editor);
		// AddMediaAssetCommand writes into the storage of `projectId`: it must still be the open project.
		if (editor.project.getActiveOrNull()?.metadata.id !== projectId) {
			throw new BridgeError({
				code: "PROJECT_MISMATCH",
				message:
					"Another project was opened while the files were copied. Nothing was imported.",
				details: { expected: projectId },
			});
		}
	} catch (error) {
		revokeUrls(imported);
		throw error;
	}

	const fps = getProjectFps(editor);
	const warnings: string[] = [];
	const inserts: InsertElementCommand[] = [];
	let wasEmpty = false;
	let placed = false;
	const addCommands = imported.map(
		({ asset }) => new AddMediaAssetCommand({ projectId, asset }),
	);

	try {
		runAiEdit({
			editor,
			label: input.replace ? "Modifier un bloc motion" : "Importer des médias",
			build: (tracks) => {
				inserts.length = 0;
				const commands: Command[] = [...addCommands];
				if (input.replace) {
					const entry = imported[0];
					const add = addCommands[0];
					if (!entry || !add) return commands;
					return [
						...commands,
						...replaceCommands({
							tracks,
							projectId,
							replace: input.replace,
							mediaId: add.getAssetId(),
							duration: assetDuration(entry.asset),
						}),
					];
				}
				if (!target || !input.place) return commands;
				// InsertElementCommand's first-element rule counts elements, like this.
				wasEmpty = getOrderedTracks(tracks).every(
					(track) => track.elements.length === 0,
				);

				const newVideoTrack = new AddTrackCommand({ type: "video", index: 0 });
				const newAudioTrack = new AddTrackCommand({ type: "audio" });
				// Default: the end of the timeline, exactly (not snapped), so the files follow the last clip.
				const start =
					input.place.start === undefined
						? tracksDuration(tracks)
						: secondsToTicks({ seconds: input.place.start, fps });
				const planned = planImportPlacement({
					tracks,
					items: imported.map(({ asset }) => ({
						mediaType: asset.type,
						duration: assetDuration(asset),
					})),
					target,
					start,
					newTrackIds: {
						video: newVideoTrack.getTrackId(),
						audio: newAudioTrack.getTrackId(),
					},
				});
				if (!planned.ok) {
					// The copy is done: keep the media in the library rather than throwing it away.
					warnings.push(
						`Placement refused (${planned.reason}). The media were added to the library only; place them with apply_edit_plan insert_media.`,
					);
					return commands;
				}
				return [
					...commands,
					...placementCommands({
						plan: planned.plan,
						imported,
						addCommands,
						newVideoTrack,
						newAudioTrack,
						inserts,
						warnings,
					}),
				];
			},
			verify: () => {
				const failed = inserts.findIndex(
					(command) => command.getTrackId() === null,
				);
				return failed >= 0
					? `The editor refused to place file ${failed + 1} on the timeline.`
					: null;
			},
		});
		placed = inserts.length > 0;
	} catch (error) {
		revokeUrls(imported);
		throw error;
	}

	// Read before the save: a user edit made while it runs must still fail the next expectStateVersion.
	const stateVersion = ctx.getStateVersion();
	await flushSave(editor);
	reportProgress({
		ctx,
		jobId: input.jobId,
		progress: 1,
		phase: "done",
		message: "Import terminé",
	});
	if (
		placed &&
		wasEmpty &&
		imported.some(({ asset }) => asset.type !== "audio")
	) {
		warnings.push(
			`The timeline was empty: the first clip set the canvas size and fps (editor rule).${canvasNote(editor)} Apply project_settings if you want another format.`,
		);
	}

	return jsonResult({
		imported: imported.map(({ file, asset }, index) => ({
			path: file.path,
			mediaId: addCommands[index]?.getAssetId(),
			name: asset.name,
			type: asset.type,
			...(typeof asset.duration === "number"
				? { duration: round3(asset.duration) }
				: {}),
			...(asset.width ? { width: asset.width } : {}),
			...(asset.height ? { height: asset.height } : {}),
			...(asset.fps ? { fps: round3(asset.fps) } : {}),
			...(asset.type !== "image" && asset.hasAudio !== undefined
				? { hasAudio: asset.hasAudio }
				: {}),
		})),
		...(target
			? { elementIds: inserts.map((command) => command.getElementId()) }
			: {}),
		skipped,
		...(warnings.length > 0 ? { warnings } : {}),
		stateVersion,
	});
}

/**
 * update_motion_block: the element keeps its id, track, start, transforms and keyframes; only its media and its
 * length change. The replaced media leaves the library unless another element still uses it.
 */
function replaceCommands({
	tracks,
	projectId,
	replace,
	mediaId,
	duration,
}: {
	tracks: SceneTracks;
	projectId: string;
	replace: NonNullable<InternalMethodParams<"internal.import_files">["replace"]>;
	mediaId: string;
	duration: MediaTime;
}): Command[] {
	const ordered = getOrderedTracks(tracks);
	const track = ordered.find((candidate) =>
		candidate.elements.some((element) => element.id === replace.elementId),
	);
	const element = track?.elements.find(
		(candidate) => candidate.id === replace.elementId,
	);
	if (!track || !element || element.type !== "video") {
		throw new BridgeError({
			code: "NOT_FOUND",
			message: `No video element "${replace.elementId}" in the active scene (ids change after split, undo and redo).`,
		});
	}
	const end = element.startTime + duration;
	const blocker = track.elements.find(
		(other) =>
			other.id !== element.id &&
			other.startTime < end &&
			other.startTime + other.duration > element.startTime,
	);
	if (blocker) {
		throw new BridgeError({
			code: "INVALID_EDIT",
			message: `The new duration would overlap "${blocker.name}" on the same track. Move one of them first, or use a shorter duration.`,
		});
	}
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const patch = {
		mediaId,
		duration,
		sourceDuration: duration,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
	} as Partial<TimelineElement>;
	const commands: Command[] = [
		new UpdateElementsCommand({
			updates: [{ trackId: track.id, elementId: element.id, patch }],
		}),
	];
	const stillUsed =
		replace.removeMediaId !== undefined &&
		ordered.some((candidate) =>
			candidate.elements.some(
				(other) =>
					other.id !== element.id &&
					"mediaId" in other &&
					other.mediaId === replace.removeMediaId,
			),
		);
	if (replace.removeMediaId !== undefined && !stillUsed) {
		commands.push(
			new RemoveMediaAssetCommand({
				projectId,
				assetId: replace.removeMediaId,
			}),
		);
	}
	return commands;
}

function placementCommands({
	plan,
	imported,
	addCommands,
	newVideoTrack,
	newAudioTrack,
	inserts,
	warnings,
}: {
	plan: ImportPlacementPlan;
	imported: readonly ImportedFile[];
	addCommands: readonly AddMediaAssetCommand[];
	newVideoTrack: AddTrackCommand;
	newAudioTrack: AddTrackCommand;
	inserts: InsertElementCommand[];
	warnings: string[];
}): Command[] {
	warnings.push(...plan.warnings);
	// New tracks first, in the same batch as their inserts (the empty-track reactor would erase them alone).
	const commands: Command[] = plan.newTracks.map((track) =>
		track.kind === "video" ? newVideoTrack : newAudioTrack,
	);
	for (const step of plan.steps) {
		const entry = imported[step.index];
		const add = addCommands[step.index];
		if (!entry || !add) continue;
		const insert = new InsertElementCommand({
			element: buildElementFromMedia({
				mediaId: add.getAssetId(),
				mediaType: entry.asset.type,
				name: entry.asset.name,
				duration: assetDuration(entry.asset),
				startTime: step.startTime,
			}),
			placement: step.placement,
		});
		inserts.push(insert);
		commands.push(insert);
	}
	return commands;
}
