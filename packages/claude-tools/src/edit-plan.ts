import { z } from "zod";
import {
	CanvasPresetSchema,
	CanvasSizeSchema,
	CSS_GRADIENT_PATTERN,
	DurationSecondsSchema,
	EntityIdSchema,
	FpsSchema,
	HEX_COLOR_PATTERN,
	HexColorSchema,
	ParamRecordSchema,
	TimeSecondsSchema,
} from "./common";

// The apply_edit_plan op union. Conventions (all written for the model):
// - every time is in SECONDS; timeline times are absolute, keyframe times are relative to the element start;
// - elements are referenced by elementId alone (the tab resolves the track);
// - an op that creates something accepts `as: "name"`, and later ops of the same plan may pass "@name"
//   wherever an element id, track id or effect id is expected.

// ---------------------------------------------------------------------------
// Enumerations shared with the editor (verified against apps/web)
// ---------------------------------------------------------------------------

export const TRACK_TYPES = ["video", "text", "audio", "graphic", "effect"] as const;
export type TrackType = (typeof TRACK_TYPES)[number];

export const TRACK_KEYWORDS = ["main", "overlay", "audio", "auto"] as const;
export type TrackKeyword = (typeof TRACK_KEYWORDS)[number];
/** Keywords valid for text, graphics and effect layers (never the main video track or an audio track). */
export const LAYER_TRACK_KEYWORDS = ["overlay", "auto"] as const;

export const GRAPHIC_SHAPES = ["rectangle", "ellipse", "polygon", "star"] as const;
export type GraphicShape = (typeof GRAPHIC_SHAPES)[number];

export const EFFECT_TYPES = ["blur"] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

export const MASK_TYPES = [
	"split",
	"cinematic-bars",
	"rectangle",
	"ellipse",
	"heart",
	"diamond",
	"star",
	"text",
	"freeform",
] as const;
export type MaskType = (typeof MASK_TYPES)[number];
/**
 * Masks the "mask" op can set. "freeform" is left out: its default has an empty path and only renders once the
 * path is drawn and closed, which scalar params cannot express.
 */
export const SETTABLE_MASK_TYPES = MASK_TYPES.filter(
	(type): type is Exclude<MaskType, "freeform"> => type !== "freeform",
) as [Exclude<MaskType, "freeform">, ...Exclude<MaskType, "freeform">[]];

/**
 * ANIMATION_PROPERTY_PATHS in apps/web/src/animation/types.ts (the paths the renderer really animates), plus the
 * virtual "transform.scale" (ANIMATION_PROPERTY_GROUPS): the tab expands it into scaleX AND scaleY with the same
 * time, value and interpolation, because the renderer scales the two axes independently.
 */
export const KEYFRAME_PROPERTIES = [
	"transform.positionX",
	"transform.positionY",
	"transform.scale",
	"transform.scaleX",
	"transform.scaleY",
	"transform.rotate",
	"opacity",
	"volume",
	"color",
	"background.color",
	"background.paddingX",
	"background.paddingY",
	"background.offsetX",
	"background.offsetY",
	"background.cornerRadius",
] as const;
export type KeyframeProperty = (typeof KEYFRAME_PROPERTIES)[number];
/** Keyframe properties whose value is a hex colour string; every other property takes a number. */
export const COLOR_KEYFRAME_PROPERTIES: readonly KeyframeProperty[] = [
	"color",
	"background.color",
];

/** Keyframes on a graphic's own params ("params.fill", "params.cornerRadius"...), the renderer's `params.<key>` channels. */
export const GRAPHIC_PARAM_PROPERTY_PATTERN = /^params\.[A-Za-z][A-Za-z0-9]*$/;
/** Keyframes on a clip effect param ("effect.intensity" plus effectId), the renderer's `effects.<id>.params.<key>` channels. */
export const EFFECT_PARAM_PROPERTY_PATTERN = /^effect\.[A-Za-z][A-Za-z0-9]*$/;

export const KEYFRAME_INTERPOLATIONS = ["linear", "hold", "bezier"] as const;
export type KeyframeInterpolation = (typeof KEYFRAME_INTERPOLATIONS)[number];

// ---------------------------------------------------------------------------
// Symbolic references
// ---------------------------------------------------------------------------

export const REF_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
export const REF_PATTERN = /^@[A-Za-z][A-Za-z0-9_-]{0,39}$/;

export function isPlanRef(value: string): boolean {
	return value.startsWith("@");
}

/** "@title" -> "title". Returns null when the value is not a well-formed reference. */
export function planRefName(value: string): string | null {
	return REF_PATTERN.test(value) ? value.slice(1) : null;
}

const AS_DESC =
	'Name what this op creates (letter first, then letters, digits, "_" or "-"; unique in the plan). Later ops of this plan may pass "@name" instead of its id.';

const RefNameSchema = z.string().regex(REF_NAME_PATTERN);

const elementRef = (what = "Target element") =>
	EntityIdSchema.describe(`${what}: element id, or "@name" from an earlier op of this plan.`);

const trackTarget = (description: string) =>
	z.union([z.enum(TRACK_KEYWORDS), EntityIdSchema]).describe(description);

const PLACE_TRACK_DESC =
	'Target track. "main": the permanent bottom video track (video/image only; its first clip is always forced to start at 0 s). "overlay": a NEW track of the right kind on top of every layer (for audio media: a new audio track). "audio": audio media only, the first audio track with room at that time, else a new one. "auto": the editor picks the first compatible track with room (for video/image it tries overlay tracks BEFORE main, so use "main" for primary footage). Or a track id from get_editor_state, or "@name" of a track made by new_track (or of an element: its track is used).';

const OPTIONAL_PLACE_TRACK_DESC =
	'Target track: "overlay" (a NEW track of the right kind on top of every layer), "auto" (default: the first compatible track with room, else a new one), a track id, or "@name" of a track made by new_track (or of an element: its track is used).';

/** A track id for text, graphics and effect layers: the "main" and "audio" keywords are refused, not taken as ids. */
const LayerTrackIdSchema = EntityIdSchema.refine((value) => value !== "main" && value !== "audio", {
	message: 'text, graphics and effect layers never go on "main" or "audio": use "overlay", "auto" or a track id.',
});

const layerTrackTarget = (description: string) =>
	z.union([z.enum(LAYER_TRACK_KEYWORDS), LayerTrackIdSchema]).describe(description);

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

export const InsertMediaOpSchema = z
	.strictObject({
		op: z.literal("insert_media"),
		mediaId: EntityIdSchema.describe(
			"Media asset id from list_media or import_media. Never invent one.",
		),
		start: TimeSecondsSchema.describe(
			"Timeline time of the clip's first frame, in seconds.",
		),
		track: trackTarget(PLACE_TRACK_DESC),
		trimStart: TimeSecondsSchema.optional().describe(
			"Seconds skipped at the start of the SOURCE media (source in-point). Default 0.",
		),
		duration: DurationSecondsSchema.optional().describe(
			"Length on the timeline in seconds. Default: the rest of the media after trimStart (video/audio), 5 s for images. For video/audio it cannot exceed media duration minus trimStart.",
		),
		as: RefNameSchema.optional().describe(AS_DESC),
	})
	.describe("Place a media asset (video, image or audio) on the timeline.");

export const TextStyleSchema = z
	.strictObject({
		fontFamily: z
			.string()
			.min(1)
			.max(100)
			.optional()
			.describe('Google Fonts family, e.g. "Figtree" (house default). Loaded automatically.'),
		fontSize: z
			.number()
			.min(1)
			.max(1000)
			.optional()
			.describe(
				"Editor size units, NOT pixels: rendered px = fontSize x canvasHeight / 90. Default 15; captions use about 5.",
			),
		color: HexColorSchema.optional().describe('Text colour, hex, e.g. "#ffffff".'),
		fontWeight: z
			.enum(["normal", "bold"])
			.optional()
			.describe("Only normal and bold exist. Default normal."),
		fontStyle: z.enum(["normal", "italic"]).optional().describe("Default normal."),
		textDecoration: z
			.enum(["none", "underline", "line-through"])
			.optional()
			.describe("Default none."),
		textAlign: z
			.enum(["left", "center", "right"])
			.optional()
			.describe("Default center."),
		letterSpacing: z
			.number()
			.min(-100)
			.max(1000)
			.optional()
			.describe("Extra spacing between letters in px. Default 0."),
		lineHeight: z
			.number()
			.min(0.1)
			.max(10)
			.optional()
			.describe("Line height multiplier. Default 1.2."),
		background: z
			.strictObject({
				enabled: z
					.boolean()
					.optional()
					.describe("Draw a box (pill) behind the text. Off by default; the house style keeps it off."),
				color: HexColorSchema.optional().describe("Box colour, hex. Default #000000."),
				cornerRadius: z.number().min(0).optional().describe("Box corner radius."),
				paddingX: z
					.number()
					.min(0)
					.optional()
					.describe(
						"Horizontal padding: canvas px at fontSize 15, multiplied by fontSize / 15 (the default 30 is 10 px on a size 5 caption). Default 30.",
					),
				paddingY: z
					.number()
					.min(0)
					.optional()
					.describe("Vertical padding, scaled by fontSize / 15 like paddingX. Default 42."),
				offsetX: z.number().optional().describe("Box offset in canvas px (not scaled). Default 0."),
				offsetY: z.number().optional().describe("Box offset in canvas px (not scaled). Default 0."),
			})
			.optional()
			.describe("Background box behind the text."),
	})
	.describe(
		"Text styling. Omitted fields use editor defaults (Arial, size 15, white, centred), so set fontFamily explicitly.",
	);

export const CanvasPositionSchema = z
	.strictObject({
		x: z.number().optional().describe("Canvas px from the canvas centre, positive to the right. Default 0."),
		y: z
			.number()
			.optional()
			.describe(
				"Canvas px from the canvas centre, positive DOWN (negative is above centre). Default 0. 12% from the top = -0.38 x canvas height.",
			),
	})
	.describe(
		"Position of the text's anchor relative to the canvas centre, in canvas pixels. The anchor is the text centre for centred text; with textAlign left, x is its LEFT edge; with textAlign right, x is its RIGHT edge. y is always the vertical centre.",
	);

export const AddTextOpSchema = z
	.strictObject({
		op: z.literal("add_text"),
		text: z
			.string()
			.min(1)
			.max(2000)
			.describe('Text content; use "\\n" for line breaks. Never use the em dash character.'),
		start: TimeSecondsSchema.describe("Timeline start in seconds."),
		duration: DurationSecondsSchema.describe("How long the text stays on screen, in seconds."),
		track: layerTrackTarget(OPTIONAL_PLACE_TRACK_DESC).optional(),
		style: TextStyleSchema.optional(),
		position: CanvasPositionSchema.optional(),
		maxWidth: z
			.number()
			.min(0.1)
			.max(1)
			.optional()
			.describe(
				'Wrap the text onto several lines so no line is wider than this fraction of the canvas width (the editor\'s captions use 0.8). Default: no wrapping (only your "\\n" breaks), so a long line can run off a 1080 px wide canvas.',
			),
		as: RefNameSchema.optional().describe(AS_DESC),
	})
	.describe("Add a text element (title, caption card, label).");

export const AddGraphicOpSchema = z
	.strictObject({
		op: z.literal("add_graphic"),
		shape: z.enum(GRAPHIC_SHAPES).describe("Vector shape to draw."),
		start: TimeSecondsSchema.describe("Timeline start in seconds."),
		duration: DurationSecondsSchema.describe("Duration in seconds."),
		track: layerTrackTarget(OPTIONAL_PLACE_TRACK_DESC).optional(),
		size: z
			.strictObject({
				width: z.number().positive().max(16384).describe("Width in canvas px."),
				height: z.number().positive().max(16384).describe("Height in canvas px."),
			})
			.optional()
			.describe(
				"Size of the shape's box in canvas px (e.g. a bar 1080 wide and 200 high). The tab converts it to transform.scaleX/Y; do not also pass those in params.",
			),
		params: ParamRecordSchema.optional().describe(
			"Shape and transform params. All shapes: fill (hex), stroke (hex), strokeWidth (0..64, in the shape's 512 px source units, so it grows with the shape), strokeAlign (inside|center|outside). rectangle: cornerRadius (0..50 %). polygon: sides, cornerRadius. star: points (3..12), depth (1..99 %). Transform: transform.positionX/Y (canvas px from centre, +y down), transform.rotate (degrees), opacity (0..1), and transform.scaleX/Y where 1 = a SQUARE whose side is the canvas's SHORT edge (1080x1080 on 9:16 or 16:9): for a W x H px box prefer size, or set scaleX = W / short edge and scaleY = H / short edge. See list_capabilities for exact ranges.",
		),
		as: RefNameSchema.optional().describe(AS_DESC),
	})
	.describe("Add a vector shape.");

export const AddEffectLayerOpSchema = z
	.strictObject({
		op: z.literal("add_effect_layer"),
		effect: z.enum(EFFECT_TYPES).describe('Effect type. Only "blur" exists.'),
		start: TimeSecondsSchema.describe("Timeline start in seconds."),
		duration: DurationSecondsSchema.describe("Duration in seconds."),
		intensity: z
			.number()
			.min(0)
			.max(100)
			.optional()
			.describe("Blur strength 0..100. Default 15."),
		track: layerTrackTarget(OPTIONAL_PLACE_TRACK_DESC).optional(),
		as: RefNameSchema.optional().describe(AS_DESC),
	})
	.describe(
		"Add an adjustment layer that applies the effect to EVERYTHING below it during its time span. To blur one clip only, use clip_effect.",
	);

export const SplitOpSchema = z
	.strictObject({
		op: z.literal("split"),
		elementIds: z
			.array(elementRef("Element"))
			.min(1)
			.max(200)
			.describe("Elements to cut at the same time (e.g. the video and its caption)."),
		at: TimeSecondsSchema.describe(
			"Absolute timeline time of the cut, in seconds. Must fall strictly inside each element.",
		),
		keep: z
			.enum(["both", "left", "right"])
			.optional()
			.describe('"both" (default) keeps both halves; "left" drops the part after the cut; "right" drops the part before it.'),
		as: RefNameSchema.optional().describe(
			`${AS_DESC} Here it names the new right-hand piece; only allowed when splitting exactly one element with keep "both" or "right". The left piece keeps the original id; the right piece always gets a NEW id.`,
		),
	})
	.describe("Cut elements in two at a timeline time.");

export const TrimOpSchema = z
	.strictObject({
		op: z.literal("trim"),
		elementId: elementRef(),
		start: TimeSecondsSchema.optional().describe(
			"New timeline IN point in seconds (moves the left edge; the content under the playhead stays in place).",
		),
		end: TimeSecondsSchema.optional().describe(
			"New timeline OUT point in seconds (moves the right edge).",
		),
	})
	.describe(
		"Change where an element starts and/or ends on the timeline, keeping its content anchored (like dragging its edges). Video/audio cannot extend past their source media. Keyframes keep their times relative to the element start: a new start does NOT shift them, and keyframes past the new end are DROPPED, so add keyframes after trimming. Trimming leaves a gap (ripple is off); to remove a range and close the gap on every track, use remove_range.",
	);

export const MoveOpSchema = z
	.strictObject({
		op: z.literal("move"),
		elementId: elementRef(),
		start: TimeSecondsSchema.optional().describe(
			"New timeline start in seconds. Omit to keep the current start.",
		),
		track: trackTarget(
			'Destination track. Omit to stay on the current track. "main", "overlay" (a NEW top track), "audio", a track id, or "@name" (a track from new_track, or an element whose track is used). Must be compatible with the element kind.',
		).optional(),
	})
	.describe("Move an element in time and/or to another track. Overlaps are refused.");

export const DeleteOpSchema = z
	.strictObject({
		op: z.literal("delete"),
		elementIds: z
			.array(elementRef("Element"))
			.min(1)
			.max(500)
			.describe("Elements to remove. Gaps are NOT closed (ripple is off during AI edits); to cut a time range and close the gap on every track, use remove_range."),
	})
	.describe("Remove elements from the timeline.");

export const RemoveRangeOpSchema = z
	.strictObject({
		op: z.literal("remove_range"),
		start: TimeSecondsSchema.describe("Start of the range to remove, timeline seconds."),
		end: TimeSecondsSchema.describe("End of the range to remove, timeline seconds (greater than start)."),
		tracks: z
			.array(z.union([z.literal("main"), EntityIdSchema]))
			.min(1)
			.max(100)
			.optional()
			.describe(
				'Tracks to cut: "main", track ids, or "@name" (a track from new_track, or an element whose track is used). Default: EVERY track, which keeps captions, overlays and audio in sync. Restrict it only on purpose (e.g. to leave the music running), then fix what you left out yourself.',
			),
	})
	.describe(
		"Remove a time range from the timeline and close the gap in one step: elements crossing start or end are split there (their keyframes follow), the pieces inside are deleted, and everything after end on the cut tracks moves left by end - start. Bookmarks inside the range are removed and later ones move left too. Use it to remove a retake, a silence or a flub, instead of split + delete + move (which leaves the other tracks out of sync). Later ops of the plan see the shortened timeline, so when removing several ranges in one plan list them from the LAST to the FIRST: the earlier times then stay valid.",
	);

export const DuplicateOpSchema = z
	.strictObject({
		op: z.literal("duplicate"),
		elementIds: z
			.array(elementRef("Element"))
			.min(1)
			.max(200)
			.describe("Elements to copy. The copies keep their timeline times and go on a NEW track of the same kind (one per source track)."),
		as: RefNameSchema.optional().describe(`${AS_DESC} Only when duplicating exactly one element; it names the copy.`),
	})
	.describe("Copy elements with their params, keyframes, effects and masks. Move the copies afterwards (move op) if they belong elsewhere.");

export const UpdateElementOpSchema = z
	.strictObject({
		op: z.literal("update_element"),
		elementId: elementRef(),
		params: ParamRecordSchema.optional().describe(
			'Param values to set (shallow merge), keyed by param path, e.g. {"content": "New text", "fontFamily": "Figtree", "transform.positionY": -730, "transform.scale": 1.2, "opacity": 0.8, "volume": -6, "blendMode": "screen"}. Positions in canvas px from centre (+y down), rotate in degrees, opacity 0..1, volume in dB (-60..20). Scaling: "transform.scale" sets scaleX AND scaleY together (a zoom); scaleX or scaleY alone stretches the picture. Use get_element to see the keys valid for an element.',
		),
		name: z.string().min(1).max(200).optional().describe("New display name in the timeline."),
		hidden: z.boolean().optional().describe("Hide (true) or show (false) the element."),
		muted: z.boolean().optional().describe("Mute (true) or unmute (false) the element's audio."),
	})
	.describe("Change an element's params (content, style, transform, opacity, volume...), name or visibility.");

export const SetSpeedOpSchema = z
	.strictObject({
		op: z.literal("set_speed"),
		elementId: elementRef("Video or audio element"),
		rate: z
			.number()
			.min(0.01)
			.max(5)
			.describe("Constant playback rate: 1 = normal, 2 = twice as fast (the clip gets half as long), 0.5 = slow motion. Range 0.01..5."),
		maintainPitch: z
			.boolean()
			.optional()
			.describe("Keep the voice pitch when the rate changes. Default true."),
	})
	.describe("Set a constant speed on a video or audio clip. Its timeline duration becomes source span / rate. Keyframes are not rescaled, and those past the new end are dropped.");

export const KeyframeOpSchema = z
	.strictObject({
		op: z.literal("keyframe"),
		elementId: elementRef(),
		property: z
			.union([
				z.enum(KEYFRAME_PROPERTIES),
				z.string().regex(GRAPHIC_PARAM_PROPERTY_PATTERN),
				z.string().regex(EFFECT_PARAM_PROPERTY_PATTERN),
			])
			.describe(
				'Animatable property. transform.positionX/Y: canvas px from centre (+y down). transform.scale: zoom, sets scaleX and scaleY together (1 = fit); scaleX or scaleY alone stretches the picture. transform.rotate: degrees. opacity: 0..1. volume: dB (-60..20). color, background.color: hex. background.*: px. Text-only: color and background.*. Graphic shapes: "params.<key>" (e.g. "params.fill" hex, "params.cornerRadius"). Clip effects: "effect.<param>" (e.g. "effect.intensity" for a blur-in) together with effectId.',
			),
		effectId: EntityIdSchema.optional().describe(
			'Required with property "effect.<param>": the clip effect to animate, an id from get_element or "@name" of an effect added earlier in this plan.',
		),
		time: TimeSecondsSchema.describe(
			"Keyframe time in seconds RELATIVE TO THE ELEMENT START (0 = its first frame), not timeline time.",
		),
		value: z
			.union([z.number(), z.string()])
			.optional()
			.describe("Value at that time: a number, or a hex string for colour properties (color, background.color, colour params such as params.fill). Required unless remove is true."),
		interpolation: z
			.enum(KEYFRAME_INTERPOLATIONS)
			.optional()
			.describe('Easing from this keyframe to the next: "linear" (default), "hold" (jump), "bezier" (smooth).'),
		remove: z
			.boolean()
			.optional()
			.describe("true removes the keyframe of this property at this time instead of setting it."),
	})
	.describe("Add, update or remove one keyframe. Two keyframes on the same property make an animation.");

export const ClipEffectOpSchema = z
	.strictObject({
		op: z.literal("clip_effect"),
		elementId: elementRef(),
		action: z
			.enum(["add", "update", "toggle", "remove"])
			.describe('"add" a new effect, "update" its params, "toggle" it on/off, "remove" it.'),
		effect: z.enum(EFFECT_TYPES).optional().describe('Effect type for "add". Only "blur" exists.'),
		effectId: EntityIdSchema.optional().describe(
			'Effect to change for update/toggle/remove: an id from get_element, or "@name" of an effect added earlier in this plan.',
		),
		params: ParamRecordSchema.optional().describe('Effect params, e.g. {"intensity": 30} (blur 0..100).'),
		as: RefNameSchema.optional().describe(`${AS_DESC} Only with action "add"; it names the new effect.`),
	})
	.describe("Manage effects applied to a single clip (unlike add_effect_layer, which affects every layer below).");

export const MaskOpSchema = z
	.strictObject({
		op: z.literal("mask"),
		elementId: elementRef("Video, image or graphic element"),
		action: z
			.enum(["set", "remove", "invert"])
			.describe('"set" replaces the element\'s mask (one mask per element), "remove" deletes it, "invert" flips it.'),
		type: z
			.enum(SETTABLE_MASK_TYPES)
			.optional()
			.describe('Mask shape, required for "set". "split" keeps one side of a line (two-shot layouts), "cinematic-bars" letterboxes. Freeform masks are drawn by hand in the editor only.'),
		params: ParamRecordSchema.optional().describe(
			'Mask params for set, in STORED units (the editor UI shows some of them x100): centerX/centerY = offset from the element centre as a FRACTION of the element width/height (-1..1; 0.25 = a quarter of the width to the right, NOT 25); width/height (box shapes) = fraction of the element size (default 0.6); scale: 1 = 100% (0.01..5); rotation: degrees 0..360; feather: 0..1000 px; content (text masks). Split: rotation is the direction of the KEPT side: 0 keeps the right of a vertical line, 90 the bottom of a horizontal line, 180 the left, 270 the top; centerX moves a vertical line, centerY a horizontal one. See get_element or list_capabilities.',
		),
	})
	.describe("Set, remove or invert the mask of a visual element. Masks cannot be keyframed.");

export const NewTrackOpSchema = z
	.strictObject({
		op: z.literal("new_track"),
		type: z.enum(TRACK_TYPES).describe("Track kind: video (video/image), text, audio, graphic (shapes/stickers), effect (adjustment layers)."),
		position: z
			.union([z.enum(["top", "bottom"]), z.number().int().min(0)])
			.optional()
			.describe('"top" (default) = above every layer; "bottom" = just above the main track (or last audio track); a number = index in the overlay stack from the top (0 = top) or in the audio stack.'),
		as: RefNameSchema.optional().describe(AS_DESC),
	})
	.describe("Create a track. An empty new track is removed automatically, so place something on it in the same plan (track: \"@name\").");

export const ToggleTrackOpSchema = z
	.strictObject({
		op: z.literal("toggle_track"),
		trackId: z
			.union([z.literal("main"), EntityIdSchema])
			.describe('Track id from get_editor_state, "main", or "@name" (a track from new_track, or an element whose track is used).'),
		mute: z.boolean().optional().describe("Desired state: true = muted, false = audible (video/audio tracks)."),
		hide: z.boolean().optional().describe("Desired state: true = hidden, false = visible (visual tracks)."),
	})
	.describe("Set a track's mute and/or visibility state (no change if already in that state).");

export const SourceAudioOpSchema = z
	.strictObject({
		op: z.literal("source_audio"),
		elementId: elementRef("Video element"),
		separate: z
			.boolean()
			.describe(
				"true: copy the video's own sound onto a new audio element (on an audio track) and silence it in the video. false: re-enable the video's own sound ONLY; the detached audio element stays on its track, so delete it too (delete op, with the id returned when it was detached, or the audio element with the same mediaId and start in get_editor_state), otherwise the sound plays twice.",
			),
		as: RefNameSchema.optional().describe(`${AS_DESC} Only with separate true; it names the new audio element.`),
	})
	.describe(
		"Detach or reattach the sound of a video clip. Asking for the state the clip is already in changes nothing (a warning is returned). A clip whose media has no audio fails with INVALID_EDIT.",
	);

export const BookmarkOpSchema = z
	.strictObject({
		op: z.literal("bookmark"),
		time: TimeSecondsSchema.describe("Timeline time in seconds. For update/remove it identifies the existing bookmark (nearest frame)."),
		action: z.enum(["add", "update", "remove"]),
		note: z.string().max(500).optional().describe("Short note shown on the marker. No em dash."),
		color: HexColorSchema.optional().describe("Marker colour, hex. Default #009dff."),
		duration: TimeSecondsSchema.optional().describe("Length in seconds for a ranged marker (review range). 0 or omitted = point marker."),
	})
	.describe("Add, update or remove a timeline bookmark (marker). For proposing cuts prefer the mark_ranges tool.");

export const ProjectSettingsOpSchema = z
	.strictObject({
		op: z.literal("project_settings"),
		canvas: z
			.union([CanvasPresetSchema, CanvasSizeSchema])
			.optional()
			.describe('Canvas size: a preset ("16:9" 1920x1080, "9:16" 1080x1920, "1:1" 1080x1080, "4:3" 1440x1080, "4:5" 1080x1350) or {width, height} in px.'),
		fps: FpsSchema.optional(),
		background: z
			.discriminatedUnion("type", [
				z.strictObject({
					type: z.literal("color"),
					color: z
						.union([
							HexColorSchema,
							z.literal("transparent"),
							z.string().max(2000).regex(CSS_GRADIENT_PATTERN),
						])
						.describe('Background: a hex colour, "transparent", or a CSS gradient such as "linear-gradient(180deg, #111111, #333333)".'),
				}),
				z.strictObject({
					type: z.literal("blur"),
					intensity: z
						.number()
						.min(0)
						.max(1000)
						.describe("Blurred-footage background strength. The editor's presets are Light 100, Medium 200, Heavy 500 (default 10)."),
				}),
			])
			.optional()
			.describe("What shows behind the footage where the canvas is not covered."),
	})
	.describe(
		"Change project settings (canvas size, frame rate, background). Editor rule: on an EMPTY timeline, the first video or image inserted resets the canvas size and fps to that media's (not undoable). So when a plan starts from an empty timeline, put project_settings AFTER its first insert_media, and after import_media placed the first clip, re-apply the canvas you want.",
	);

export const EditOpSchema = z.discriminatedUnion("op", [
	InsertMediaOpSchema,
	AddTextOpSchema,
	AddGraphicOpSchema,
	AddEffectLayerOpSchema,
	SplitOpSchema,
	TrimOpSchema,
	MoveOpSchema,
	DeleteOpSchema,
	RemoveRangeOpSchema,
	DuplicateOpSchema,
	UpdateElementOpSchema,
	SetSpeedOpSchema,
	KeyframeOpSchema,
	ClipEffectOpSchema,
	MaskOpSchema,
	NewTrackOpSchema,
	ToggleTrackOpSchema,
	SourceAudioOpSchema,
	BookmarkOpSchema,
	ProjectSettingsOpSchema,
]);

export type EditOp = z.infer<typeof EditOpSchema>;
export type EditOpName = EditOp["op"];
export type EditOpOf<K extends EditOpName> = Extract<EditOp, { op: K }>;

export const EDIT_OP_NAMES = EditOpSchema.options.map(
	(option) => option.shape.op.value,
) as EditOpName[];

export type InsertMediaOp = EditOpOf<"insert_media">;
export type AddTextOp = EditOpOf<"add_text">;
export type AddGraphicOp = EditOpOf<"add_graphic">;
export type AddEffectLayerOp = EditOpOf<"add_effect_layer">;
export type SplitOp = EditOpOf<"split">;
export type TrimOp = EditOpOf<"trim">;
export type MoveOp = EditOpOf<"move">;
export type DeleteOp = EditOpOf<"delete">;
export type RemoveRangeOp = EditOpOf<"remove_range">;
export type DuplicateOp = EditOpOf<"duplicate">;
export type UpdateElementOp = EditOpOf<"update_element">;
export type SetSpeedOp = EditOpOf<"set_speed">;
export type KeyframeOp = EditOpOf<"keyframe">;
export type ClipEffectOp = EditOpOf<"clip_effect">;
export type MaskOp = EditOpOf<"mask">;
export type NewTrackOp = EditOpOf<"new_track">;
export type ToggleTrackOp = EditOpOf<"toggle_track">;
export type SourceAudioOp = EditOpOf<"source_audio">;
export type BookmarkOp = EditOpOf<"bookmark">;
export type ProjectSettingsOp = EditOpOf<"project_settings">;
export type TextStyle = z.infer<typeof TextStyleSchema>;

// ---------------------------------------------------------------------------
// Plan-level validation (pure, shared by both ends)
// ---------------------------------------------------------------------------

export type PlanRefKind = "element" | "track" | "effect";

export interface PlanRefUse {
	/** Path of the field inside the op, e.g. ["elementIds", 2]. */
	path: (string | number)[];
	value: string;
	accepts: readonly PlanRefKind[];
}

export interface OpRefs {
	/** What `as` names, when this op creates something nameable. */
	defines: { name: string; kind: PlanRefKind } | null;
	/** Fields that may hold "@name" references (values that are not references are included too). */
	uses: PlanRefUse[];
}

const ELEMENT_ONLY: readonly PlanRefKind[] = ["element"];
const TRACK_OR_ELEMENT: readonly PlanRefKind[] = ["track", "element"];
const EFFECT_ONLY: readonly PlanRefKind[] = ["effect"];

/** Which fields of an op may reference earlier ops, and what the op itself defines. */
export function getOpRefs(op: EditOp): OpRefs {
	const uses: PlanRefUse[] = [];
	const useElement = (path: (string | number)[], value: string) =>
		uses.push({ path, value, accepts: ELEMENT_ONLY });
	const useTrack = (path: (string | number)[], value: string | undefined) => {
		if (value !== undefined) uses.push({ path, value, accepts: TRACK_OR_ELEMENT });
	};
	const element = (name: string | undefined) =>
		name === undefined ? null : { name, kind: "element" as const };

	switch (op.op) {
		case "insert_media":
			useTrack(["track"], op.track);
			return { defines: element(op.as), uses };
		case "add_text":
		case "add_graphic":
		case "add_effect_layer":
			useTrack(["track"], op.track);
			return { defines: element(op.as), uses };
		case "split":
			op.elementIds.forEach((id, i) => useElement(["elementIds", i], id));
			return { defines: element(op.as), uses };
		case "delete":
			op.elementIds.forEach((id, i) => useElement(["elementIds", i], id));
			return { defines: null, uses };
		case "duplicate":
			op.elementIds.forEach((id, i) => useElement(["elementIds", i], id));
			return { defines: element(op.as), uses };
		case "remove_range":
			op.tracks?.forEach((track, i) => useTrack(["tracks", i], track));
			return { defines: null, uses };
		case "move":
			useElement(["elementId"], op.elementId);
			useTrack(["track"], op.track);
			return { defines: null, uses };
		case "trim":
		case "update_element":
		case "set_speed":
		case "mask":
			useElement(["elementId"], op.elementId);
			return { defines: null, uses };
		case "keyframe":
			useElement(["elementId"], op.elementId);
			if (op.effectId !== undefined) {
				uses.push({ path: ["effectId"], value: op.effectId, accepts: EFFECT_ONLY });
			}
			return { defines: null, uses };
		case "clip_effect":
			useElement(["elementId"], op.elementId);
			if (op.effectId !== undefined) {
				uses.push({ path: ["effectId"], value: op.effectId, accepts: EFFECT_ONLY });
			}
			return {
				defines: op.as === undefined ? null : { name: op.as, kind: "effect" },
				uses,
			};
		case "source_audio":
			useElement(["elementId"], op.elementId);
			return { defines: element(op.as), uses };
		case "new_track":
			return {
				defines: op.as === undefined ? null : { name: op.as, kind: "track" },
				uses,
			};
		case "toggle_track":
			useTrack(["trackId"], op.trackId);
			return { defines: null, uses };
		case "bookmark":
		case "project_settings":
			return { defines: null, uses };
	}
}

export interface PlanIssue {
	/** Path inside the ops array, e.g. [3, "elementIds", 0]. */
	path: (string | number)[];
	message: string;
}

const COLOR_PROPS = new Set<string>(COLOR_KEYFRAME_PROPERTIES);

function checkOpFields(op: EditOp): PlanIssue[] {
	const issues: PlanIssue[] = [];
	const add = (path: (string | number)[], message: string) =>
		issues.push({ path, message });

	switch (op.op) {
		case "split":
			if (op.as !== undefined && (op.elementIds.length !== 1 || op.keep === "left")) {
				add(["as"], 'split "as" needs exactly one element and keep "both" or "right" (it names the right-hand piece).');
			}
			break;
		case "trim":
			if (op.start === undefined && op.end === undefined) {
				add([], "trim needs start and/or end.");
			} else if (op.start !== undefined && op.end !== undefined && op.end <= op.start) {
				add(["end"], "trim end must be greater than start.");
			}
			break;
		case "move":
			if (op.start === undefined && op.track === undefined) {
				add([], "move needs start and/or track.");
			}
			break;
		case "remove_range":
			if (op.end <= op.start) {
				add(["end"], "remove_range end must be greater than start.");
			}
			break;
		case "duplicate":
			if (op.as !== undefined && op.elementIds.length !== 1) {
				add(["as"], 'duplicate "as" needs exactly one element (it names the copy).');
			}
			break;
		case "add_graphic":
			if (
				op.size !== undefined &&
				op.params !== undefined &&
				("transform.scaleX" in op.params || "transform.scaleY" in op.params)
			) {
				add(["size"], "add_graphic: pass size or transform.scaleX/Y in params, not both.");
			}
			break;
		case "update_element": {
			const hasParams = op.params !== undefined && Object.keys(op.params).length > 0;
			if (!hasParams && op.name === undefined && op.hidden === undefined && op.muted === undefined) {
				add([], "update_element needs at least one of params, name, hidden, muted.");
			}
			break;
		}
		case "keyframe": {
			const isEffectParam = EFFECT_PARAM_PROPERTY_PATTERN.test(op.property);
			if (isEffectParam && op.effectId === undefined) {
				add(["effectId"], `keyframe on "${op.property}" needs effectId (the clip effect to animate).`);
			} else if (!isEffectParam && op.effectId !== undefined) {
				add(["effectId"], 'effectId is only used with property "effect.<param>".');
			}
			if (op.remove === true) break;
			if (op.value === undefined) {
				add(["value"], "keyframe value is required unless remove is true.");
			} else if (COLOR_PROPS.has(op.property)) {
				if (typeof op.value !== "string" || !HEX_COLOR_PATTERN.test(op.value)) {
					add(["value"], `${op.property} keyframes take a hex colour string such as "#ffffff".`);
				}
			} else if (isEffectParam || GRAPHIC_PARAM_PROPERTY_PATTERN.test(op.property)) {
				// The type depends on the param (fill is a colour, cornerRadius a number): the tab checks it.
				if (typeof op.value === "string" && !HEX_COLOR_PATTERN.test(op.value)) {
					add(["value"], `${op.property} keyframes take a number or a hex colour string.`);
				}
			} else if (typeof op.value !== "number") {
				add(["value"], `${op.property} keyframes take a number.`);
			}
			break;
		}
		case "clip_effect":
			if (op.action === "add") {
				if (op.effect === undefined) add(["effect"], 'clip_effect "add" needs effect.');
				if (op.effectId !== undefined) add(["effectId"], 'clip_effect "add" creates a new effect: omit effectId (use "as" to name it).');
			} else {
				if (op.effectId === undefined) add(["effectId"], `clip_effect "${op.action}" needs effectId.`);
				if (op.as !== undefined) add(["as"], 'clip_effect "as" is only allowed with action "add".');
				if (op.action === "update" && (op.params === undefined || Object.keys(op.params).length === 0)) {
					add(["params"], 'clip_effect "update" needs params.');
				}
			}
			break;
		case "mask":
			if (op.action === "set" && op.type === undefined) {
				add(["type"], 'mask "set" needs type.');
			}
			break;
		case "toggle_track":
			if (op.mute === undefined && op.hide === undefined) {
				add([], "toggle_track needs mute and/or hide.");
			}
			break;
		case "source_audio":
			if (op.as !== undefined && !op.separate) {
				add(["as"], 'source_audio "as" is only allowed with separate true.');
			}
			break;
		case "bookmark":
			if (op.action === "update" && op.note === undefined && op.color === undefined && op.duration === undefined) {
				add([], 'bookmark "update" needs note, color and/or duration.');
			}
			break;
		case "project_settings":
			if (op.canvas === undefined && op.fps === undefined && op.background === undefined) {
				add([], "project_settings needs canvas, fps and/or background.");
			}
			break;
		default:
			break;
	}
	return issues;
}

/**
 * Validates cross-field rules and "@name" references of a whole plan: names are unique, every reference
 * points to an EARLIER op, and its kind fits the field (element / track / effect).
 * Returns an empty array when the plan is consistent. Does not know the editor state.
 */
export function checkEditPlan(ops: readonly EditOp[]): PlanIssue[] {
	const issues: PlanIssue[] = [];
	const defined = new Map<string, { kind: PlanRefKind; index: number }>();

	ops.forEach((op, index) => {
		const { defines, uses } = getOpRefs(op);

		for (const use of uses) {
			if (!isPlanRef(use.value)) continue;
			const path = [index, ...use.path];
			const name = planRefName(use.value);
			if (name === null) {
				issues.push({ path, message: `"${use.value}" is not a valid reference (expected "@name").` });
				continue;
			}
			const target = defined.get(name);
			if (!target) {
				issues.push({
					path,
					message: `"@${name}" is not defined by an earlier op of this plan (add "as": "${name}" to the op that creates it, before this op).`,
				});
				continue;
			}
			if (!use.accepts.includes(target.kind)) {
				issues.push({
					path,
					message: `"@${name}" names a ${target.kind} (op ${target.index}) but this field expects a ${use.accepts.join(" or ")}.`,
				});
			}
		}

		for (const issue of checkOpFields(op)) {
			issues.push({ path: [index, ...issue.path], message: issue.message });
		}

		if (defines) {
			const previous = defined.get(defines.name);
			if (previous) {
				issues.push({
					path: [index, "as"],
					message: `"as": "${defines.name}" is already used by op ${previous.index}; names must be unique in a plan.`,
				});
			} else {
				defined.set(defines.name, { kind: defines.kind, index });
			}
		}
	});

	return issues;
}

export const MAX_EDIT_PLAN_OPS = 200;

/** The ops array of apply_edit_plan, with plan-level checks attached (ignored by JSON Schema). */
export const EditPlanSchema = z
	.array(EditOpSchema)
	.min(1)
	.max(MAX_EDIT_PLAN_OPS)
	.superRefine((ops, ctx) => {
		for (const issue of checkEditPlan(ops)) {
			ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
		}
	})
	.describe(
		'Ordered ops, applied in sequence as ONE undo step. Discriminated by "op". Later ops see the result of earlier ones and may reference what they created as "@name".',
	);
export type EditPlan = z.infer<typeof EditPlanSchema>;

// ---------------------------------------------------------------------------
// Result shape (returned in ToolResult.json by the tab)
// ---------------------------------------------------------------------------

export interface EditPlanCreated {
	/** Index of the op that created it. */
	op: number;
	kind: PlanRefKind;
	id: string;
	/** Track holding the element (elements and effects). */
	trackId?: string;
	/** Element holding the effect (effects only). */
	elementId?: string;
	/** The `as` name, if any. */
	as?: string;
}

export interface EditPlanResult {
	dryRun: boolean;
	/** False for a dry run or when nothing was applied. */
	applied: boolean;
	opCount: number;
	label?: string;
	/** Everything the plan created, in op order. */
	created: EditPlanCreated[];
	/** `as` name -> real id. */
	refs: Record<string, string>;
	changedElementIds: string[];
	deletedElementIds: string[];
	/** Non-fatal notes (clamped values, snapped times...). */
	warnings: string[];
	/** Timeline duration after the plan, in seconds. */
	durationSeconds: number;
	/** stateVersion after the plan (unchanged for a dry run), to pass as the next expectStateVersion. */
	stateVersion: number;
}
