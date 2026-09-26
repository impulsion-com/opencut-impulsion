import { TOOL_DEFAULTS, type ToolResult } from "@opencut/claude-tools";
import type { EditorCore } from "@/core";
import { BridgeError, imageResult, toolImageFromDataUrl } from "@/claude/types";
import { secondsToTicks, ticksToSeconds } from "@/claude/units";
import {
	assertNotExporting,
	requireReadyProject,
	type HandlerArgs,
} from "@/claude/state/handler-kit";
import {
	cellLabel,
	computeGridLayout,
	sampleEvenTimes,
} from "./contact-sheet-layout";
import {
	createSheetCanvas,
	drawCellLabel,
	drawIntoCell,
	encodeJpeg,
} from "./sheet-canvas";

// capture_frame and capture_contact_sheet (map 4.4, 9.2): the composed output of the active scene, rendered with
// a fresh CanvasRenderer under the render lock (RendererManager.renderFrames), exactly as an export would.

const CAPTURE_JPEG_QUALITY = 0.85;

const EXPORT_BLOCKS_CAPTURE =
	"An export is rendering: the compositor is busy until it ends, so frames cannot be captured now.";

function prepareCapture(editor: EditorCore) {
	const ready = requireReadyProject(editor);
	assertNotExporting({ editor, message: EXPORT_BLOCKS_CAPTURE });
	// The contract says captures pause playback (the preview would otherwise fight for the compositor).
	editor.playback.pause();
	return ready;
}

export async function captureFrame({
	input,
	ctx,
}: HandlerArgs<"capture_frame">): Promise<ToolResult> {
	const { editor } = ctx;
	const { project } = prepareCapture(editor);
	const time =
		input.time === undefined
			? editor.playback.getCurrentTime()
			: secondsToTicks({ seconds: input.time, fps: project.settings.fps });
	const isEmpty = editor.timeline.getTotalDuration() <= 0;

	const frame = await editor.renderer.captureFrame({
		time,
		maxEdge: input.maxEdge ?? TOOL_DEFAULTS.captureMaxEdge,
		mime: "image/jpeg",
		quality: CAPTURE_JPEG_QUALITY,
		signal: ctx.signal,
	});
	const seconds = ticksToSeconds({ ticks: frame.time });
	const { width: canvasWidth, height: canvasHeight } = frame.canvasSize;
	return imageResult({
		images: {
			data: frame.base64,
			mimeType: frame.mimeType,
			caption: `frame @${seconds.toFixed(3)}s ${canvasWidth}x${canvasHeight}${isEmpty ? " (empty timeline: background only)" : ""}`,
		},
		json: {
			time: seconds,
			width: frame.width,
			height: frame.height,
			canvas: { width: canvasWidth, height: canvasHeight },
			/** Canvas px per image px: multiply image coordinates by it to get canvas coordinates. */
			scale: Math.round((canvasWidth / frame.width) * 1000) / 1000,
			...(isEmpty ? { emptyTimeline: true } : {}),
		},
	});
}

export async function captureContactSheet({
	input,
	ctx,
}: HandlerArgs<"capture_contact_sheet">): Promise<ToolResult> {
	const { editor } = ctx;
	const { project } = prepareCapture(editor);
	const durationTicks = editor.timeline.getTotalDuration();
	if (durationTicks <= 0) {
		throw new BridgeError({
			code: "INVALID_PARAMS",
			message:
				"The active scene's timeline is empty: there is nothing to put on a contact sheet yet.",
		});
	}
	const timelineEnd = ticksToSeconds({ ticks: durationTicks });

	let requested: number[];
	if (input.times) {
		requested = [...input.times];
	} else {
		const start = input.start ?? 0;
		const end = Math.min(input.end ?? timelineEnd, timelineEnd);
		if (start >= timelineEnd) {
			throw new BridgeError({
				code: "INVALID_PARAMS",
				message: `start (${start}s) is at or past the end of the timeline (${timelineEnd}s).`,
				details: { start, timelineEnd },
			});
		}
		if (end <= start) {
			throw new BridgeError({
				code: "INVALID_PARAMS",
				message: `end (${end}s) must be greater than start (${start}s).`,
				details: { start, end },
			});
		}
		requested = sampleEvenTimes({
			start,
			end,
			count: input.count ?? TOOL_DEFAULTS.contactSheetCount,
		});
	}
	// Sorted: the video cache decodes forward instead of seeking back for every cell.
	const ticks = requested
		.map((seconds) => secondsToTicks({ seconds, fps: project.settings.fps }))
		.sort((a, b) => a - b);

	const { width: canvasWidth, height: canvasHeight } =
		project.settings.canvasSize;
	const layout = computeGridLayout({
		count: ticks.length,
		columns: input.columns,
		frameWidth: canvasWidth,
		frameHeight: canvasHeight,
	});
	const { canvas, context } = createSheetCanvas({ layout });

	const rendered = await editor.renderer.renderFrames({
		times: ticks,
		signal: ctx.signal,
		onFrame: ({ index, time, source, canvasSize }) => {
			drawIntoCell({
				context,
				layout,
				index,
				source,
				sourceWidth: canvasSize.width,
				sourceHeight: canvasSize.height,
			});
			drawCellLabel({
				context,
				layout,
				index,
				text: cellLabel({ index, seconds: ticksToSeconds({ ticks: time }) }),
			});
		},
	});

	const times = rendered.times.map((time) => ticksToSeconds({ ticks: time }));
	const first = times[0] ?? 0;
	const last = times[times.length - 1] ?? first;
	return imageResult({
		images: toolImageFromDataUrl({
			dataUrl: encodeJpeg({ canvas }),
			caption: `contact sheet: ${times.length} frames ${first.toFixed(3)}s to ${last.toFixed(3)}s, ${layout.columns}x${layout.rows} grid, labels "cell · m:ss.cc"`,
		}),
		json: {
			times,
			columns: layout.columns,
			rows: layout.rows,
			cellWidth: layout.cellWidth,
			cellHeight: layout.cellHeight,
			canvas: {
				width: rendered.canvasSize.width,
				height: rendered.canvasSize.height,
			},
		},
	});
}
