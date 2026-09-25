import { z } from "zod";

// Shared schema primitives. Every time at the tool boundary is in SECONDS (float, 3 decimals is plenty);
// the tab converts once to MediaTime ticks and snaps to the project frame grid.

/** Upper bound for any timeline time, a sanity guard against ms-for-seconds mistakes. */
export const MAX_TIMELINE_SECONDS = 86_400;

export const TimeSecondsSchema = z.number().min(0).max(MAX_TIMELINE_SECONDS);
export const DurationSecondsSchema = z
	.number()
	.positive()
	.max(MAX_TIMELINE_SECONDS);

/** Opaque id produced by the editor (element, track, media, project, bookmark...). */
export const EntityIdSchema = z.string().min(1).max(200);

export const HEX_COLOR_PATTERN =
	/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
export const HexColorSchema = z.string().regex(HEX_COLOR_PATTERN);

/** CSS gradients the renderer draws for colour backgrounds (drawCssBackground in apps/web/src/gradients). */
export const CSS_GRADIENT_PATTERN = /^(?:repeating-)?(?:linear|radial|conic)-gradient\(.+\)$/;

/** Values stored in element params (see the elementParamRegistry in apps/web). */
export const ParamValueSchema = z.union([z.number(), z.string(), z.boolean()]);
export const ParamRecordSchema = z.record(
	z.string().min(1).max(200),
	ParamValueSchema,
);
export type ParamValue = z.infer<typeof ParamValueSchema>;
export type ParamRecord = z.infer<typeof ParamRecordSchema>;

// ---------------------------------------------------------------------------
// Canvas and project presets
// ---------------------------------------------------------------------------

/**
 * "16:9", "9:16", "1:1" and "4:3" mirror DEFAULT_CANVAS_PRESETS (apps/web/src/canvas/sizes.ts).
 * "4:5" (feed posts) is not an editor preset: for it, and for any {width, height}, the tab must store
 * canvasSizeMode "custom" plus lastCustomCanvasSize, like the Settings panel does, or the panel shows
 * the wrong selection.
 */
export const CANVAS_PRESETS = {
	"16:9": { width: 1920, height: 1080 },
	"9:16": { width: 1080, height: 1920 },
	"1:1": { width: 1080, height: 1080 },
	"4:3": { width: 1440, height: 1080 },
	"4:5": { width: 1080, height: 1350 },
} as const;
/** Presets that exist in the editor's Settings panel (canvasSizeMode "preset"). */
export const EDITOR_CANVAS_PRESET_NAMES = ["16:9", "9:16", "1:1", "4:3"] as const;
export type CanvasPreset = keyof typeof CANVAS_PRESETS;
export const CANVAS_PRESET_NAMES = Object.keys(CANVAS_PRESETS) as [
	CanvasPreset,
	...CanvasPreset[],
];
export const CanvasPresetSchema = z.enum(CANVAS_PRESET_NAMES);

export const CanvasSizeSchema = z.strictObject({
	width: z.number().int().min(16).max(8192).describe("Canvas width in pixels."),
	height: z
		.number()
		.int()
		.min(16)
		.max(8192)
		.describe("Canvas height in pixels."),
});

export const FpsSchema = z
	.number()
	.positive()
	.max(240)
	.describe("Frames per second, e.g. 24, 25, 30, 29.97, 60.");

export const EXPORT_FORMATS = ["mp4", "webm"] as const;
export const EXPORT_QUALITIES = ["low", "medium", "high", "very_high"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export type ExportQuality = (typeof EXPORT_QUALITIES)[number];

/**
 * Defaults applied by handlers when an optional input is omitted. Schemas never use .default()
 * (it would make the fields "required" in output-mode JSON Schema), so both ends read these.
 */
export const TOOL_DEFAULTS = {
	editorStateDetail: "summary",
	captureMaxEdge: 1280,
	captureMaxEdgeLimit: 2576,
	contactSheetCount: 9,
	historySteps: 1,
	exportFormat: "mp4",
	exportQuality: "high",
	exportIncludeAudio: true,
	speedMaintainPitch: true,
	keyframeInterpolation: "linear",
	splitKeep: "both",
	blurIntensity: 15,
	imageDurationSeconds: 5,
	elementDurationSeconds: 5,
	bookmarkColor: "#009dff",
	listDiskMediaRecursive: false,
	jobStatusWaitSeconds: 0,
} as const;
