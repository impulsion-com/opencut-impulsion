import { z } from "zod";
import {
	CanvasPresetSchema,
	EntityIdSchema,
	EXPORT_FORMATS,
	EXPORT_QUALITIES,
	FpsSchema,
	HexColorSchema,
	TimeSecondsSchema,
	TOOL_DEFAULTS,
} from "./common";
import { defineTool, type ToolDefinition } from "./define";
import { EditPlanSchema, TRACK_KEYWORDS } from "./edit-plan";

// The v1 tool catalogue. Pure definitions: the sidecar registers them on its MCP servers,
// the tab validates params with `input` and dispatches to its handlers.
// Descriptions are prompts: what the tool does, when to use it, what it returns, units, gotchas.

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const UI_ACTION = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const elementId = () =>
	EntityIdSchema.describe("Element id from get_editor_state (ids change after split, undo and redo).");

// ---------------------------------------------------------------------------
// READ
// ---------------------------------------------------------------------------

export const getEditorStateTool = defineTool({
	name: "get_editor_state",
	title: "Get editor state",
	group: "read",
	runsIn: "tab",
	alwaysLoad: true,
	annotations: READ_ONLY,
	input: z.strictObject({
		detail: z
			.enum(["summary", "full"])
			.optional()
			.describe('"summary" (default): tracks and element summaries. "full": also every element\'s params, trims, speed, effects, masks and keyframed properties (large).'),
	}),
	description: `Read the open project: settings (canvas px, fps, background), the active scene and the list of scenes, tracks of the ACTIVE scene in display order top to bottom (overlay tracks, then the main video track, then audio tracks) with their elements, media summary, bookmarks, playhead, selection, playing flag, canUndo/canRedo, ripple/snapping modes and busy flags (exporting, user dragging).
Call it FIRST in every task and again after undo, redo, split or a failed edit: element ids change.
Returns JSON {project, scene:{id, name, isMain}, scenes:[{id, name, isMain}], tracks:[{id, type, isMain, muted?, hidden?, elements:[{id, type, name, start, end, duration, mediaId?, text?}]}], media, bookmarks, playhead, selection, isPlaying, canUndo, canRedo, modes, busy, stateVersion}. All times in seconds. Pass stateVersion as expectStateVersion to apply_edit_plan so an edit made meanwhile (e.g. by the user) is detected instead of overwritten.`,
});

export const getElementTool = defineTool({
	name: "get_element",
	title: "Get element details",
	group: "read",
	runsIn: "tab",
	alwaysLoad: true,
	annotations: READ_ONLY,
	input: z.strictObject({ elementId: elementId() }),
	description: `Read one element in full: every param value, source trims (trimStart/trimEnd in source seconds), speed, keyframes per property (times relative to the element start, in seconds), clip effects (with effect ids), mask, and the param schema that applies (keys, min, max, options).
Use it before update_element, keyframe, clip_effect or mask ops to learn valid keys and current values.
Returns JSON {id, trackId, type, name, start, end, duration, params, keyframes, effects, mask, retime, paramSchema}. Fails with NOT_FOUND for an unknown or stale id.`,
});

export const listCapabilitiesTool = defineTool({
	name: "list_capabilities",
	title: "List editor capabilities",
	group: "read",
	runsIn: "tab",
	annotations: READ_ONLY,
	input: z.strictObject({}),
	description: `List what the editor can do: element kinds and which track types accept them, param schemas per element kind (keys, ranges, options), effects (blur only), graphic shapes (rectangle, ellipse, polygon, star), mask types, blend modes and animatable keyframe properties with ranges.
Use it once when unsure whether a param, mask or effect exists. Not implemented at all: transitions, speed ramps, track reordering, slip/slide/roll.
Returns JSON {elementKinds, trackCompatibility, params, effects, graphics, masks, blendModes, keyframeProperties}.`,
});

export const listMediaTool = defineTool({
	name: "list_media",
	title: "List project media",
	group: "read",
	runsIn: "tab",
	alwaysLoad: true,
	annotations: READ_ONLY,
	input: z.strictObject({}),
	description: `List the media assets imported into the open project (the only media usable in insert_media).
Returns JSON [{id, name, type: "video"|"image"|"audio", duration (seconds), width, height, fps, hasAudio, size (bytes), path? (disk path, added by the sidecar from its import_media index; absent for media added by hand in the editor)}].
To bring a disk file in, use list_disk_media then import_media. Never invent a media id.`,
});

export const listProjectsTool = defineTool({
	name: "list_projects",
	title: "List projects",
	group: "read",
	runsIn: "tab",
	annotations: READ_ONLY,
	input: z.strictObject({}),
	description: `List the projects saved in this browser (all projects live in the editor tab's local storage).
Returns JSON [{id, name, duration (seconds), updatedAt (ISO date), isOpen}]. Use the id with open_project.`,
});

// ---------------------------------------------------------------------------
// VISION
// ---------------------------------------------------------------------------

export const captureFrameTool = defineTool({
	name: "capture_frame",
	title: "Capture a frame",
	group: "vision",
	runsIn: "tab",
	alwaysLoad: true,
	annotations: READ_ONLY,
	input: z.strictObject({
		time: TimeSecondsSchema.optional().describe("Timeline time in seconds. Default: the playhead. Clamped to the last frame."),
		maxEdge: z
			.number()
			.int()
			.min(256)
			.max(TOOL_DEFAULTS.captureMaxEdgeLimit)
			.optional()
			.describe(`Longest edge of the image in px. Default ${TOOL_DEFAULTS.captureMaxEdge} (about 1.2k tokens); go higher only to read small details.`),
	}),
	description: `Render the composed output (every visible layer, exactly as exported) at one timeline time.
Use it to check any visual change (text placement, faces, scale, masks, effects, canvas) before saying it is done. Pauses playback.
Returns one JPEG image captioned like "frame @12.400s 1080x1920", plus JSON {time (seconds), width, height}. For a time range, prefer capture_contact_sheet (one image instead of many).`,
});

export const captureContactSheetTool = defineTool({
	name: "capture_contact_sheet",
	title: "Capture a contact sheet",
	group: "vision",
	runsIn: "tab",
	alwaysLoad: true,
	annotations: READ_ONLY,
	input: z.strictObject({
		start: TimeSecondsSchema.optional().describe("Range start in seconds. Default 0."),
		end: TimeSecondsSchema.optional().describe("Range end in seconds. Default: timeline end."),
		count: z
			.number()
			.int()
			.min(2)
			.max(36)
			.optional()
			.describe(`Number of evenly spaced frames between start and end. Default ${TOOL_DEFAULTS.contactSheetCount}.`),
		times: z
			.array(TimeSecondsSchema)
			.min(1)
			.max(36)
			.optional()
			.describe("Exact timeline times in seconds; overrides start, end and count."),
		columns: z
			.number()
			.int()
			.min(1)
			.max(8)
			.optional()
			.describe("Grid columns. Default: about the square root of the frame count."),
	}),
	description: `Render several timeline times into ONE grid image (JPEG), each cell labelled with its timecode. Pauses playback.
Use it to review pacing, shot changes, caption placement or a whole edit at a glance; far cheaper than many capture_frame calls.
Returns the image plus JSON {times (seconds, in grid order), columns, rows, cellWidth, cellHeight}.`,
});

export const peekMediaTool = defineTool({
	name: "peek_media",
	title: "Look at source media",
	group: "vision",
	runsIn: "tab",
	annotations: READ_ONLY,
	input: z.strictObject({
		mediaId: EntityIdSchema.describe("Video or image asset id from list_media."),
		times: z
			.array(TimeSecondsSchema)
			.min(1)
			.max(36)
			.optional()
			.describe(`SOURCE times in seconds, from the start of the media file (not timeline times). Default: ${TOOL_DEFAULTS.contactSheetCount} frames spread evenly over the media.`),
		columns: z
			.number()
			.int()
			.min(1)
			.max(8)
			.optional()
			.describe("Grid columns. Default: about the square root of the frame count."),
	}),
	description: `Look at a media asset's own frames (the raw file, before any edit), e.g. to choose a b-roll in-point (insert_media trimStart) or check framing before placing it. For an image, returns the image itself.
Returns ONE grid image (JPEG), each cell labelled with its source time, plus JSON {mediaId, times (source seconds, in grid order), columns, rows}. Does not touch the timeline or the playhead.`,
});

// ---------------------------------------------------------------------------
// EDIT
// ---------------------------------------------------------------------------

export const applyEditPlanTool = defineTool({
	name: "apply_edit_plan",
	title: "Apply an edit plan",
	group: "edit",
	runsIn: "tab",
	alwaysLoad: true,
	annotations: EDIT,
	input: z.strictObject({
		ops: EditPlanSchema,
		label: z
			.string()
			.min(1)
			.max(80)
			.optional()
			.describe('Short label of the change, e.g. "Hook title + zoom", shown to the user.'),
		dryRun: z
			.boolean()
			.optional()
			.describe(
				"true: check the plan without changing anything: schema, @name references, that every id exists, and for each op in order the track compatibility, overlaps and trim/source limits (computed with the editor's pure placement helpers, not by running the edit). Not simulated: project settings, the first-clip canvas rule, keyframe clamping. Returns the same JSON with applied false; ids in created/refs are placeholders, the real run creates different ones. Default false.",
			),
		expectStateVersion: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe("stateVersion from your last get_editor_state. If the timeline changed since (e.g. the user edited it), nothing is applied and the call fails with STALE_STATE. Recommended for every edit."),
	}),
	description: `The main editing tool. Applies an ordered list of ops as ONE undo step (one Cmd+Z for the user). If any op fails, nothing is kept.
Ops: insert_media, add_text, add_graphic, add_effect_layer, split, trim, move, delete, remove_range, duplicate, update_element, set_speed, keyframe, clip_effect, mask, new_track, toggle_track, source_audio, bookmark, project_settings.
Rules: all times in SECONDS (timeline times are absolute; keyframe times are relative to the element start). Reference elements by elementId only. An op that creates something may set "as": "name"; later ops in the SAME plan use "@name" in place of an element, track or effect id. Ripple is off: delete and trim leave gaps; to cut a range out and close the gap on every track (retakes, silences), use remove_range.
Group one logical change per call; do not spread it over many calls.
Example: {"ops":[{"op":"new_track","type":"text","as":"titles"},{"op":"add_text","text":"3 erreurs en pub","start":0,"duration":2.5,"track":"@titles","style":{"fontFamily":"Figtree","fontSize":9,"fontWeight":"bold"},"position":{"y":-730},"as":"hook"},{"op":"keyframe","elementId":"@hook","property":"opacity","time":0,"value":0},{"op":"keyframe","elementId":"@hook","property":"opacity","time":0.3,"value":1}],"label":"Hook title"}
Returns JSON {applied, dryRun, opCount, created:[{op, kind, id, trackId?, as?}], refs:{name: id}, changedElementIds, deletedElementIds, warnings, durationSeconds, stateVersion}. Ids of split pieces and created elements are new: use the returned ids afterwards. Errors: INVALID_PARAMS (schema), INVALID_EDIT (the timeline refuses it, e.g. overlap), NOT_FOUND (stale id), STALE_STATE (the timeline changed since expectStateVersion).`,
});

export const markRangesTool = defineTool({
	name: "mark_ranges",
	title: "Mark ranges for review",
	group: "edit",
	runsIn: "tab",
	alwaysLoad: true,
	annotations: EDIT,
	input: z.strictObject({
		ranges: z
			.array(
				z.strictObject({
					start: TimeSecondsSchema.describe("Range start, timeline seconds."),
					end: TimeSecondsSchema.describe("Range end, timeline seconds (greater than start)."),
					note: z.string().max(500).optional().describe('Why this range is marked, e.g. "retake: second version is cleaner". No em dash.'),
					color: HexColorSchema.optional().describe("Marker colour, hex. Default #009dff."),
				})
				.refine((range) => range.end > range.start, {
					message: "end must be greater than start",
					path: ["end"],
				}),
			)
			.min(1)
			.max(200)
			.describe("Ranges to mark as ranged bookmarks on the timeline."),
		clearExisting: z
			.boolean()
			.optional()
			.describe("true: first remove every existing RANGED bookmark of the active scene (point bookmarks are kept). Default false."),
		expectStateVersion: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe("stateVersion from your last get_editor_state; the call fails with STALE_STATE if the timeline changed since, so the ranges you computed still match."),
	}),
	description: `Show proposed ranges on the timeline as ranged bookmarks (review markers) without cutting anything. One undo step.
Use it to propose take/retake cuts, silences or problems, then WAIT for the user's approval before cutting with apply_edit_plan.
Returns JSON {marked, removed, bookmarks:[{time, duration, note}]}. Times in seconds.`,
});

export const undoTool = defineTool({
	name: "undo",
	title: "Undo",
	group: "edit",
	runsIn: "tab",
	alwaysLoad: true,
	annotations: EDIT,
	input: z.strictObject({
		steps: z.number().int().min(1).max(50).optional().describe(`How many history steps to undo. Default ${TOOL_DEFAULTS.historySteps}.`),
	}),
	description: `Undo the last history step(s), exactly like Cmd+Z. One apply_edit_plan call is one step. Beware: the history is shared with the user, so the last step may be a manual edit.
Returns JSON {undone, canUndo, canRedo}. Element ids revert: call get_editor_state before the next edit.`,
});

export const redoTool = defineTool({
	name: "redo",
	title: "Redo",
	group: "edit",
	runsIn: "tab",
	annotations: EDIT,
	input: z.strictObject({
		steps: z.number().int().min(1).max(50).optional().describe(`How many undone steps to redo. Default ${TOOL_DEFAULTS.historySteps}.`),
	}),
	description: `Redo step(s) previously undone, exactly like Cmd+Shift+Z. Only possible right after undo (any new edit clears the redo stack).
Returns JSON {redone, canUndo, canRedo}. Split pieces get NEW ids on redo: call get_editor_state before the next edit.`,
});

// ---------------------------------------------------------------------------
// PLAYBACK / UI
// ---------------------------------------------------------------------------

export const seekTool = defineTool({
	name: "seek",
	title: "Move the playhead",
	group: "playback",
	runsIn: "tab",
	annotations: UI_ACTION,
	input: z.strictObject({
		time: TimeSecondsSchema.describe("Timeline time in seconds (clamped to the timeline)."),
	}),
	description: `Move the playhead to a timeline time, e.g. to show the user a moment you are talking about. Does not edit anything.
Returns JSON {playhead} in seconds.`,
});

export const playTool = defineTool({
	name: "play",
	title: "Play",
	group: "playback",
	runsIn: "tab",
	annotations: UI_ACTION,
	input: z.strictObject({}),
	description: `Start playback in the editor preview from the playhead so the user can watch. You cannot hear or see playback yourself: use capture_frame to look.
Returns JSON {isPlaying, playhead}.`,
});

export const pauseTool = defineTool({
	name: "pause",
	title: "Pause",
	group: "playback",
	runsIn: "tab",
	annotations: UI_ACTION,
	input: z.strictObject({}),
	description: `Pause playback in the editor preview. Harmless if already paused.
Returns JSON {isPlaying, playhead}.`,
});

export const selectTool = defineTool({
	name: "select",
	title: "Select elements",
	group: "playback",
	runsIn: "tab",
	annotations: UI_ACTION,
	input: z.strictObject({
		elementIds: z
			.array(EntityIdSchema)
			.max(500)
			.describe("Element ids to select; an empty array clears the selection."),
	}),
	description: `Select elements in the timeline, e.g. to point the user at what you mean or to prepare a manual action. Selection does not affect apply_edit_plan (ops name their targets).
Returns JSON {selected}.`,
});

export const setEditorModesTool = defineTool({
	name: "set_editor_modes",
	title: "Set editor modes",
	group: "playback",
	runsIn: "tab",
	annotations: UI_ACTION,
	input: z.strictObject({
		ripple: z.boolean().optional().describe("Ripple editing for the user's manual edits (closing gaps after deletes)."),
		snapping: z.boolean().optional().describe("Timeline snapping for the user's manual drags."),
	}),
	description: `Turn the user's ripple-editing and snapping toggles on or off. Only affects manual editing: apply_edit_plan always runs with ripple off.
Returns JSON {ripple, snapping}.`,
});

// ---------------------------------------------------------------------------
// PROJECT
// ---------------------------------------------------------------------------

export const createProjectTool = defineTool({
	name: "create_project",
	title: "Create a project",
	group: "project",
	runsIn: "tab",
	annotations: EDIT,
	input: z.strictObject({
		name: z.string().min(1).max(120).describe("Project name."),
		preset: CanvasPresetSchema.optional().describe('Canvas preset: "16:9" (1920x1080), "9:16" (1080x1920, reels), "1:1", "4:3", "4:5". Default 16:9 until the first video or image is placed.'),
		fps: FpsSchema.optional(),
	}),
	description: `Create a new empty project and open it in the editor tab (the current project is saved first). Beware: the first video or image placed on the empty timeline replaces the canvas size and fps with that media's (editor rule), preset or not. To keep a preset (e.g. 9:16 for a reel), apply project_settings after the first clip is placed (same apply_edit_plan, after its insert_media, or right after import_media placed it).
Returns JSON {projectId, name}. Call get_editor_state afterwards.`,
});

export const openProjectTool = defineTool({
	name: "open_project",
	title: "Open a project",
	group: "project",
	runsIn: "tab",
	annotations: UI_ACTION,
	input: z.strictObject({
		projectId: EntityIdSchema.describe("Project id from list_projects."),
	}),
	description: `Open a saved project in the editor tab (the current one is saved first) and wait until its media is loaded.
Returns JSON {projectId, name}. Fails with NOT_FOUND for an unknown id (never guess ids). Call get_editor_state afterwards.`,
});

export const switchSceneTool = defineTool({
	name: "switch_scene",
	title: "Switch scene",
	group: "project",
	runsIn: "tab",
	annotations: UI_ACTION,
	input: z.strictObject({
		sceneId: EntityIdSchema.describe("Scene id from get_editor_state (scenes)."),
	}),
	description: `Make another scene of the open project the active one. The preview, every edit and capture tool, and start_export work on the active scene only.
Returns JSON {sceneId, name}. Tracks and element ids differ per scene: call get_editor_state afterwards.`,
});

export const saveProjectTool = defineTool({
	name: "save_project",
	title: "Save the project",
	group: "project",
	runsIn: "tab",
	annotations: UI_ACTION,
	input: z.strictObject({}),
	description: `Flush pending changes of the open project to browser storage now. Autosave already runs about a second after each edit, so this is only needed before risky steps or when the user asks.
Returns JSON {saved, wasDirty}.`,
});

// ---------------------------------------------------------------------------
// MEDIA
// ---------------------------------------------------------------------------

export const listDiskMediaTool = defineTool({
	name: "list_disk_media",
	title: "Browse media on disk",
	group: "media",
	runsIn: "hybrid",
	annotations: READ_ONLY,
	input: z.strictObject({
		folder: z
			.string()
			.min(1)
			.max(1000)
			.optional()
			.describe('Absolute folder path (or starting with "~/") inside an allowed root. Default: list the allowed roots themselves.'),
		recursive: z.boolean().optional().describe("Include sub-folders. Default false."),
		extensions: z
			.array(z.string().min(1).max(10))
			.max(30)
			.optional()
			.describe('Filter by extension without the dot, e.g. ["mp4","mov","wav"]. Default: common video, audio and image types.'),
	}),
	description: `Browse media files on the local disk, restricted to the allow-listed folders (e.g. ~/impulsion/videos). Read-only.
Use it to find rushes, music or images before import_media.
Returns JSON {roots, folder, entries:[{path, name, kind: "folder"|"video"|"audio"|"image", size (bytes), modifiedAt (ISO), mediaId? (if already imported in the open project; only when an editor tab is connected)}]}. Paths outside the allowed roots fail with INVALID_PARAMS.`,
});

export const importMediaTool = defineTool({
	name: "import_media",
	title: "Import media from disk",
	group: "media",
	runsIn: "hybrid",
	annotations: EDIT,
	input: z.strictObject({
		paths: z
			.array(z.string().min(1).max(1000))
			.min(1)
			.max(50)
			.describe('Absolute file paths (or starting with "~/") inside the allowed roots, as returned by list_disk_media.'),
		place: z
			.strictObject({
				start: TimeSecondsSchema.optional().describe("Timeline time in seconds for the first file; the next files follow back to back. Default: end of the timeline."),
				track: z
					.union([z.enum(TRACK_KEYWORDS), EntityIdSchema])
					.optional()
					.describe('"main", "overlay" (new top track), "audio", "auto" or a track id. Default "auto".'),
			})
			.optional()
			.describe("Also place the imported files on the timeline. Omit to only add them to the media library."),
	}),
	description: `Import files from disk into the open project's media library (the bytes are copied into browser storage, so big rushes take a while), optionally placing them on the timeline. Media add plus placement is one undo step.
Returns JSON {imported:[{path, mediaId, name, type, duration (seconds), width?, height?}], elementIds? (when placed), skipped:[{path, reason}]}. Use the mediaIds with insert_media.`,
});

export const removeMediaTool = defineTool({
	name: "remove_media",
	title: "Remove media",
	group: "media",
	runsIn: "tab",
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	input: z.strictObject({
		mediaIds: z.array(EntityIdSchema).min(1).max(200).describe("Media asset ids from list_media."),
	}),
	description: `Remove media assets from the project library AND delete every timeline element that uses them. Destructive: ask the user first. Files on disk are never touched. Undo may need two steps.
Returns JSON {removed, deletedElementIds}.`,
});

// ---------------------------------------------------------------------------
// EXPORT
// ---------------------------------------------------------------------------

export const startExportTool = defineTool({
	name: "start_export",
	title: "Start an export",
	group: "export",
	runsIn: "hybrid",
	longRunning: true,
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	input: z.strictObject({
		format: z.enum(EXPORT_FORMATS).optional().describe(`Container/codec: mp4 (H.264 + AAC) or webm (VP9 + Opus). Default ${TOOL_DEFAULTS.exportFormat}.`),
		quality: z.enum(EXPORT_QUALITIES).optional().describe(`Bitrate level. Default ${TOOL_DEFAULTS.exportQuality}; "low" for quick drafts.`),
		includeAudio: z.boolean().optional().describe("Include the audio mix. Default true."),
		fileName: z
			.string()
			.min(1)
			.max(120)
			.optional()
			.describe("Output file name without extension (sanitised). Default: project name plus a timestamp."),
	}),
	description: `Start rendering the WHOLE active scene to a video file on disk (exports folder, e.g. ~/impulsion/videos/exports). Runs in the background at canvas resolution and project fps; it can take minutes. Partial exports are not supported yet.
Returns JSON {jobId, outputPath} immediately. Then poll job_status {jobId} (use waitSeconds to avoid busy polling). While exporting, edits are refused with EXPORTING.`,
});

export const jobStatusTool = defineTool({
	name: "job_status",
	title: "Get job status",
	group: "export",
	runsIn: "sidecar",
	annotations: READ_ONLY,
	input: z.strictObject({
		jobId: EntityIdSchema.describe("Job id returned by a start_* tool."),
		waitSeconds: z
			.number()
			.min(0)
			.max(50)
			.optional()
			.describe("Block up to this many seconds until the job finishes before answering. Default 0 (answer now)."),
	}),
	description: `Read the state of a background job (exports for now).
Returns JSON {jobId, kind, status: "queued"|"running"|"done"|"failed"|"cancelled", progress (0..1), phase?, startedAt, finishedAt?, result? ({path, sizeBytes, durationSeconds} for exports), error?}.`,
});

export const cancelJobTool = defineTool({
	name: "cancel_job",
	title: "Cancel a job",
	group: "export",
	runsIn: "sidecar",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	input: z.strictObject({
		jobId: EntityIdSchema.describe("Job id returned by a start_* tool."),
	}),
	description: `Cancel a running background job (e.g. an export started by mistake). The partial output is discarded; the project is untouched.
Returns JSON {jobId, status}.`,
});

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export const TOOLS = [
	getEditorStateTool,
	getElementTool,
	listCapabilitiesTool,
	listMediaTool,
	listProjectsTool,
	captureFrameTool,
	captureContactSheetTool,
	peekMediaTool,
	applyEditPlanTool,
	markRangesTool,
	undoTool,
	redoTool,
	seekTool,
	playTool,
	pauseTool,
	selectTool,
	setEditorModesTool,
	createProjectTool,
	openProjectTool,
	switchSceneTool,
	saveProjectTool,
	listDiskMediaTool,
	importMediaTool,
	removeMediaTool,
	startExportTool,
	jobStatusTool,
	cancelJobTool,
] as const;

export type AnyTool = (typeof TOOLS)[number];
export type ToolName = AnyTool["name"];
export type ToolByName<N extends ToolName> = Extract<AnyTool, { name: N }>;
/** Parsed params the handler of tool N receives (after `input.parse`). */
export type ToolInput<N extends ToolName> = z.output<ToolByName<N>["input"]>;
/** Params as a caller may send them to tool N (before parsing). */
export type ToolRawInput<N extends ToolName> = z.input<ToolByName<N>["input"]>;

/** Tools the hub forwards to the tab unchanged: the tab has a handler for each. */
export type TabToolName = Extract<AnyTool, { runsIn: "tab" }>["name"];
/** Tools the sidecar handles, calling the tab through internal methods or tab tools (never by their own name). */
export type HybridToolName = Extract<AnyTool, { runsIn: "hybrid" }>["name"];
/** Tools handled by the sidecar alone. */
export type SidecarToolName = Extract<AnyTool, { runsIn: "sidecar" }>["name"];

export const TOOL_NAMES = TOOLS.map((tool) => tool.name) as ToolName[];

export const TOOL_BY_NAME = Object.freeze(
	Object.fromEntries(TOOLS.map((tool) => [tool.name, tool])),
) as { readonly [N in ToolName]: ToolByName<N> };

export function isToolName(value: string): value is ToolName {
	return Object.prototype.hasOwnProperty.call(TOOL_BY_NAME, value);
}

export type ParseToolInputResult<N extends ToolName> =
	| { ok: true; data: ToolInput<N> }
	| { ok: false; message: string; issues: z.core.$ZodIssue[] };

/** Validates params for a tool (both ends use it). The message is compact and model-readable. */
export function parseToolInput<N extends ToolName>(
	name: N,
	params: unknown,
): ParseToolInputResult<N> {
	const tool: ToolDefinition = TOOL_BY_NAME[name];
	const result = tool.input.safeParse(params ?? {});
	if (result.success) {
		return { ok: true, data: result.data as ToolInput<N> };
	}
	return {
		ok: false,
		message: formatIssues(result.error.issues),
		issues: result.error.issues,
	};
}

/** "ops.2.elementId: Invalid input; ops.3: trim needs start and/or end." */
export function formatIssues(issues: readonly z.core.$ZodIssue[], max = 8): string {
	const parts = issues.slice(0, max).map((issue) => {
		const path = issue.path.map(String).join(".");
		return path ? `${path}: ${issue.message}` : issue.message;
	});
	if (issues.length > max) parts.push(`(+${issues.length - max} more)`);
	return parts.join("; ");
}
