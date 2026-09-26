import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { TOOL_DEFAULTS, type ToolResult } from "@opencut/claude-tools";
import type { MediaAsset } from "@/media/types";
import { BridgeError, imageResult, toolImageFromDataUrl } from "@/claude/types";
import {
	requireReadyProject,
	round3,
	throwIfAborted,
	type HandlerArgs,
} from "@/claude/state/handler-kit";
import {
	cellLabel,
	computeGridLayout,
	sampleMediaTimes,
} from "./contact-sheet-layout";
import {
	createSheetCanvas,
	drawCellLabel,
	drawIntoCell,
	encodeJpeg,
} from "./sheet-canvas";

// peek_media (map 4.4, 9.2): a media asset's own frames, decoded straight from its file with a mediabunny
// CanvasSink. It never touches the compositor, the video cache, the timeline or the playhead.

/** Keeps the last requested time strictly inside the file (the very end has no frame). */
const END_MARGIN_SECONDS = 0.001;

function findAsset({
	assets,
	mediaId,
}: {
	assets: readonly MediaAsset[];
	mediaId: string;
}): MediaAsset {
	const asset = assets.find((candidate) => candidate.id === mediaId);
	if (!asset) {
		throw new BridgeError({
			code: "NOT_FOUND",
			message: `Media "${mediaId}" is not in this project. Use list_media for the current ids.`,
			details: { mediaId },
		});
	}
	return asset;
}

async function peekImage({
	asset,
}: {
	asset: MediaAsset;
}): Promise<ToolResult> {
	const bitmap = await createImageBitmap(asset.file);
	try {
		const layout = computeGridLayout({
			count: 1,
			frameWidth: bitmap.width,
			frameHeight: bitmap.height,
			maxEdge: TOOL_DEFAULTS.captureMaxEdge,
			gap: 0,
		});
		const { canvas, context } = createSheetCanvas({ layout });
		drawIntoCell({
			context,
			layout,
			index: 0,
			source: bitmap,
			sourceWidth: bitmap.width,
			sourceHeight: bitmap.height,
		});
		return imageResult({
			images: toolImageFromDataUrl({
				dataUrl: encodeJpeg({ canvas }),
				caption: `image "${asset.name}" ${bitmap.width}x${bitmap.height}`,
			}),
			json: {
				mediaId: asset.id,
				type: "image",
				times: [],
				columns: 1,
				rows: 1,
				width: bitmap.width,
				height: bitmap.height,
			},
		});
	} finally {
		bitmap.close();
	}
}

async function peekVideo({
	asset,
	times: requestedTimes,
	columns,
	signal,
}: {
	asset: MediaAsset;
	times?: readonly number[];
	columns?: number;
	signal?: AbortSignal;
}): Promise<ToolResult> {
	const input = new Input({
		source: new BlobSource(asset.file),
		formats: ALL_FORMATS,
	});
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track) {
			throw new BridgeError({
				code: "INTERNAL",
				message: `"${asset.name}" has no video track the browser can read.`,
			});
		}
		if (!(await track.canDecode())) {
			throw new BridgeError({
				code: "INTERNAL",
				message: `This browser cannot decode "${asset.name}" (codec ${track.codec ?? "unknown"}). Convert it to H.264 MP4 to preview it.`,
			});
		}
		const duration =
			typeof asset.duration === "number" && asset.duration > 0
				? asset.duration
				: await input.computeDuration();
		const firstTimestamp = await track.getFirstTimestamp();
		const lastTime = Math.max(firstTimestamp, duration - END_MARGIN_SECONDS);
		const times = (
			requestedTimes
				? [...requestedTimes]
				: sampleMediaTimes({ duration, count: TOOL_DEFAULTS.contactSheetCount })
		)
			.map((time) => Math.min(lastTime, Math.max(firstTimestamp, time)))
			.sort((a, b) => a - b);

		const layout = computeGridLayout({
			count: times.length,
			columns,
			frameWidth: track.displayWidth,
			frameHeight: track.displayHeight,
		});
		const { canvas, context } = createSheetCanvas({ layout });
		const sink = new CanvasSink(track, {
			width: layout.cellWidth,
			height: layout.cellHeight,
			fit: "contain",
		});

		let index = 0;
		// Sorted timestamps: mediabunny decodes each packet at most once.
		for await (const wrapped of sink.canvasesAtTimestamps(times)) {
			throwIfAborted(signal);
			if (wrapped) {
				drawIntoCell({
					context,
					layout,
					index,
					source: wrapped.canvas,
					sourceWidth: wrapped.canvas.width,
					sourceHeight: wrapped.canvas.height,
				});
			}
			drawCellLabel({
				context,
				layout,
				index,
				text: cellLabel({ index, seconds: times[index] ?? 0 }),
			});
			index += 1;
		}

		return imageResult({
			images: toolImageFromDataUrl({
				dataUrl: encodeJpeg({ canvas }),
				caption: `source frames of "${asset.name}": ${times.length} frames, ${layout.columns}x${layout.rows} grid, labels are SOURCE times`,
			}),
			json: {
				mediaId: asset.id,
				type: "video",
				times: times.map(round3),
				columns: layout.columns,
				rows: layout.rows,
				cellWidth: layout.cellWidth,
				cellHeight: layout.cellHeight,
				duration: round3(duration),
				width: track.displayWidth,
				height: track.displayHeight,
			},
		});
	} finally {
		input.dispose();
	}
}

export async function peekMedia({
	input,
	ctx,
}: HandlerArgs<"peek_media">): Promise<ToolResult> {
	const { editor } = ctx;
	requireReadyProject(editor);
	const asset = findAsset({
		assets: editor.media.getAssets(),
		mediaId: input.mediaId,
	});
	if (asset.type === "audio") {
		throw new BridgeError({
			code: "INVALID_PARAMS",
			message: `"${asset.name}" is an audio file: peek_media only shows video and image media.`,
			details: { mediaId: asset.id, type: asset.type },
		});
	}
	if (asset.type === "image") return peekImage({ asset });
	return peekVideo({
		asset,
		times: input.times,
		columns: input.columns,
		signal: ctx.signal,
	});
}
