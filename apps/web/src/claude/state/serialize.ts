import type { ElementKeyframe } from "@/animation/types";
import { getElementKeyframes } from "@/animation/keyframe-query";
import { frameRateToFloat } from "@/fps/utils";
import type { MediaAsset } from "@/media/types";
import { buildElementParamValues, getElementParams } from "@/params/registry";
import type { ParamValue, ParamValues } from "@/params";
import type { TBackground, TProject } from "@/project/types";
import type {
	Bookmark,
	ElementRef,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	TScene,
} from "@/timeline/types";
import { mediaTime, type MediaTime } from "@/wasm";
import { getOrderedTracks, ticksToSeconds } from "@/claude/units";
import { round3 } from "./handler-kit";

// Pure projection of the editor state into the compact, JSON-safe shapes the read tools return (map 9.1).
// Seconds at the boundary (3 decimals), ids verbatim, runtime-only data (AudioBuffers, Files, URLs) dropped.

export type EditorStateDetail = "summary" | "full";

/** Long captions are cut in summaries; get_element (or detail "full") returns the whole text. */
export const SUMMARY_TEXT_MAX_CHARS = 200;

const secondsOf = (ticks: number) => ticksToSeconds({ ticks });

function hasMedia(
	element: TimelineElement,
): element is Extract<TimelineElement, { mediaId: string }> {
	return "mediaId" in element;
}

function isHidden(element: TimelineElement): boolean {
	return "hidden" in element && element.hidden === true;
}

/** End of the last element in timeline ticks, i.e. the duration of these tracks (TimelineManager.getTotalDuration). */
export function tracksDuration(tracks: SceneTracks): MediaTime {
	let end = 0;
	for (const track of getOrderedTracks(tracks)) {
		for (const element of track.elements) {
			end = Math.max(end, element.startTime + element.duration);
		}
	}
	return mediaTime({ ticks: end });
}

// ---------------------------------------------------------------------------
// Params and keyframes
// ---------------------------------------------------------------------------

/** Registry params whose value differs from the default (content excluded: summaries carry it as `text`). */
export function nonDefaultParams(element: TimelineElement): ParamValues {
	const result: ParamValues = {};
	for (const param of getElementParams({ element })) {
		if (param.key === "content") continue;
		const value = element.params[param.key];
		if (value !== undefined && value !== param.default) {
			result[param.key] = value;
		}
	}
	return result;
}

/** Every param value: registry params (defaults filled in) plus element-specific keys (graphic shape params). */
export function allParams(element: TimelineElement): ParamValues {
	return { ...element.params, ...buildElementParamValues({ element }) };
}

export interface KeyframeGroup {
	/** Edit-plan vocabulary: an ANIMATION path, "params.<key>" (graphics) or "effect.<key>" (with effectId). */
	property: string;
	effectId?: string;
	/** Times in seconds relative to the element start. */
	keys: { time: number; value: ParamValue; interpolation: string }[];
}

const EFFECT_PARAM_PATH = /^effects\.([^.]+)\.params\.(.+)$/;

/** Keyframes grouped per property, effect channels renamed to the apply_edit_plan "effect.<key>" form. */
export function groupKeyframes(
	keyframes: readonly ElementKeyframe[],
): KeyframeGroup[] {
	const groups = new Map<string, KeyframeGroup>();
	for (const keyframe of keyframes) {
		const effectMatch = EFFECT_PARAM_PATH.exec(keyframe.propertyPath);
		const property = effectMatch
			? `effect.${effectMatch[2]}`
			: keyframe.propertyPath;
		const effectId = effectMatch?.[1];
		const groupKey = `${property}|${effectId ?? ""}`;
		let group = groups.get(groupKey);
		if (!group) {
			group = { property, ...(effectId ? { effectId } : {}), keys: [] };
			groups.set(groupKey, group);
		}
		group.keys.push({
			time: secondsOf(keyframe.time),
			value: keyframe.value,
			interpolation: keyframe.interpolation,
		});
	}
	for (const group of groups.values()) {
		group.keys.sort((a, b) => a.time - b.time);
	}
	return [...groups.values()];
}

/** Animated properties, for summaries (e.g. ["opacity", "transform.scaleX"]). */
export function animatedProperties(element: TimelineElement): string[] {
	return groupKeyframes(
		getElementKeyframes({ animations: element.animations }),
	).map((group) =>
		group.effectId ? `${group.property}@${group.effectId}` : group.property,
	);
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

export interface ElementSummary {
	id: string;
	type: TimelineElement["type"];
	name: string;
	start: number;
	end: number;
	duration: number;
	mediaId?: string;
	text?: string;
	textTruncated?: true;
	trimStart?: number;
	trimEnd?: number;
	speed?: number;
	hidden?: true;
	muted?: true;
	sourceAudio?: false;
	shape?: string;
	stickerId?: string;
	effect?: string;
	params?: ParamValues;
	effectCount?: number;
	maskCount?: number;
	animated?: string[];
}

export function summarizeElement(element: TimelineElement): ElementSummary {
	const summary: ElementSummary = {
		id: element.id,
		type: element.type,
		name: element.name,
		start: secondsOf(element.startTime),
		end: secondsOf(element.startTime + element.duration),
		duration: secondsOf(element.duration),
	};
	if (hasMedia(element)) summary.mediaId = element.mediaId;
	if (element.type === "text") {
		const content = String(element.params.content ?? "");
		if (content.length > SUMMARY_TEXT_MAX_CHARS) {
			summary.text = `${content.slice(0, SUMMARY_TEXT_MAX_CHARS)}...`;
			summary.textTruncated = true;
		} else {
			summary.text = content;
		}
	}
	if (element.type === "video" || element.type === "audio") {
		summary.trimStart = secondsOf(element.trimStart);
		summary.trimEnd = secondsOf(element.trimEnd);
		const rate = element.retime?.rate;
		if (rate !== undefined && rate !== 1) summary.speed = round3(rate);
	}
	if (isHidden(element)) summary.hidden = true;
	if (element.params.muted === true) summary.muted = true;
	if (element.type === "video" && element.isSourceAudioEnabled === false) {
		summary.sourceAudio = false;
	}
	if (element.type === "graphic") summary.shape = element.definitionId;
	if (element.type === "sticker") summary.stickerId = element.stickerId;
	if (element.type === "effect") summary.effect = element.effectType;

	const params = nonDefaultParams(element);
	if (Object.keys(params).length > 0) summary.params = params;
	const effects = "effects" in element ? (element.effects ?? []) : [];
	if (effects.length > 0) summary.effectCount = effects.length;
	const masks = "masks" in element ? (element.masks ?? []) : [];
	if (masks.length > 0) summary.maskCount = masks.length;
	const animated = animatedProperties(element);
	if (animated.length > 0) summary.animated = animated;
	return summary;
}

export interface ElementDetail {
	id: string;
	trackId: string;
	trackType: TimelineTrack["type"];
	type: TimelineElement["type"];
	name: string;
	start: number;
	end: number;
	duration: number;
	/** Source seconds skipped at each end (video, audio; 0 for other kinds). */
	trimStart: number;
	trimEnd: number;
	sourceDuration?: number;
	mediaId?: string;
	hidden: boolean;
	params: ParamValues;
	keyframes: KeyframeGroup[];
	effects: {
		id: string;
		type: string;
		enabled: boolean;
		params: ParamValues;
	}[];
	/** The UI allows one mask per element; `masks` lists every mask when there are several. */
	mask: { id: string; type: string; params: Record<string, unknown> } | null;
	masks?: { id: string; type: string; params: Record<string, unknown> }[];
	retime: { rate: number; maintainPitch: boolean } | null;
	isSourceAudioEnabled?: boolean;
	shape?: string;
	stickerId?: string;
	effect?: string;
	sourceType?: "upload" | "library";
}

export function describeElement({
	track,
	element,
}: {
	track: TimelineTrack;
	element: TimelineElement;
}): ElementDetail {
	const effects = "effects" in element ? (element.effects ?? []) : [];
	const masks = ("masks" in element ? (element.masks ?? []) : []).map(
		(mask) => ({
			id: mask.id,
			type: mask.type,
			params: { ...mask.params },
		}),
	);
	const retime =
		element.type === "video" || element.type === "audio"
			? element.retime
			: undefined;
	const detail: ElementDetail = {
		id: element.id,
		trackId: track.id,
		trackType: track.type,
		type: element.type,
		name: element.name,
		start: secondsOf(element.startTime),
		end: secondsOf(element.startTime + element.duration),
		duration: secondsOf(element.duration),
		trimStart: secondsOf(element.trimStart),
		trimEnd: secondsOf(element.trimEnd),
		hidden: isHidden(element),
		params: allParams(element),
		keyframes: groupKeyframes(
			getElementKeyframes({ animations: element.animations }),
		),
		effects: effects.map((effect) => ({
			id: effect.id,
			type: effect.type,
			enabled: effect.enabled,
			params: { ...effect.params },
		})),
		mask: masks[0] ?? null,
		retime: retime
			? { rate: retime.rate, maintainPitch: retime.maintainPitch ?? true }
			: null,
	};
	if (masks.length > 1) detail.masks = masks;
	if (element.sourceDuration !== undefined) {
		detail.sourceDuration = secondsOf(element.sourceDuration);
	}
	if (hasMedia(element)) detail.mediaId = element.mediaId;
	if (element.type === "video") {
		detail.isSourceAudioEnabled = element.isSourceAudioEnabled !== false;
	}
	if (element.type === "graphic") detail.shape = element.definitionId;
	if (element.type === "sticker") detail.stickerId = element.stickerId;
	if (element.type === "effect") detail.effect = element.effectType;
	if (element.type === "audio") detail.sourceType = element.sourceType;
	return detail;
}

// ---------------------------------------------------------------------------
// Tracks, scenes, media, project
// ---------------------------------------------------------------------------

/** detail "full": the summary fields plus every ElementDetail field (detail values win). */
export type FullElementSummary = Omit<ElementSummary, keyof ElementDetail> &
	ElementDetail;

export interface TrackSummary {
	id: string;
	type: TimelineTrack["type"];
	name: string;
	isMain: boolean;
	muted?: true;
	hidden?: true;
	elements: (ElementSummary | FullElementSummary)[];
}

export function summarizeTracks({
	tracks,
	detail,
}: {
	tracks: SceneTracks;
	detail: EditorStateDetail;
}): TrackSummary[] {
	return getOrderedTracks(tracks).map((track) => {
		const summary: TrackSummary = {
			id: track.id,
			type: track.type,
			name: track.name,
			isMain: track.id === tracks.main.id,
			elements: [...track.elements]
				.sort((a, b) => a.startTime - b.startTime)
				.map((element) =>
					detail === "full"
						? {
								...summarizeElement(element),
								...describeElement({ track, element }),
							}
						: summarizeElement(element),
				),
		};
		if ("muted" in track && track.muted) summary.muted = true;
		if ("hidden" in track && track.hidden) summary.hidden = true;
		return summary;
	});
}

export interface MediaSummary {
	id: string;
	name: string;
	type: MediaAsset["type"];
	duration?: number;
	width?: number;
	height?: number;
	fps?: number;
	hasAudio?: boolean;
}

export function summarizeMedia(asset: MediaAsset): MediaSummary {
	const summary: MediaSummary = {
		id: asset.id,
		name: asset.name,
		type: asset.type,
	};
	if (typeof asset.duration === "number" && Number.isFinite(asset.duration)) {
		summary.duration = round3(asset.duration);
	}
	if (asset.width) summary.width = asset.width;
	if (asset.height) summary.height = asset.height;
	if (asset.fps) summary.fps = round3(asset.fps);
	if (asset.type !== "image" && asset.hasAudio !== undefined) {
		summary.hasAudio = asset.hasAudio;
	}
	return summary;
}

export function summarizeBookmarks(bookmarks: readonly Bookmark[]): {
	time: number;
	duration?: number;
	note?: string;
	color?: string;
}[] {
	return [...bookmarks]
		.sort((a, b) => a.time - b.time)
		.map((bookmark) => ({
			time: secondsOf(bookmark.time),
			...(bookmark.duration && bookmark.duration > 0
				? { duration: secondsOf(bookmark.duration) }
				: {}),
			...(bookmark.note ? { note: bookmark.note } : {}),
			...(bookmark.color ? { color: bookmark.color } : {}),
		}));
}

export function summarizeBackground(
	background: TBackground,
): { type: "color"; color: string } | { type: "blur"; intensity: number } {
	return background.type === "blur"
		? { type: "blur", intensity: background.blurIntensity }
		: { type: "color", color: background.color };
}

export function summarizeProjectSettings(project: TProject) {
	const { settings } = project;
	return {
		id: project.metadata.id,
		name: project.metadata.name,
		canvas: {
			width: settings.canvasSize.width,
			height: settings.canvasSize.height,
		},
		fps: round3(frameRateToFloat(settings.fps)),
		background: summarizeBackground(settings.background),
	};
}

export function summarizeScene(scene: TScene) {
	return {
		id: scene.id,
		name: scene.name,
		isMain: scene.isMain,
		duration: secondsOf(tracksDuration(scene.tracks)),
	};
}

// ---------------------------------------------------------------------------
// get_editor_state
// ---------------------------------------------------------------------------

export interface EditorStateInput {
	project: TProject;
	scenes: readonly TScene[];
	activeScene: TScene;
	mediaAssets: readonly MediaAsset[];
	playhead: number;
	isPlaying: boolean;
	selection: readonly ElementRef[];
	canUndo: boolean;
	canRedo: boolean;
	modes: { ripple: boolean; snapping: boolean };
	busy: { exporting: boolean; exportProgress: number; userDragging: boolean };
	stateVersion: number;
	detail: EditorStateDetail;
}

export function serializeEditorState(input: EditorStateInput) {
	const { activeScene } = input;
	return {
		project: {
			...summarizeProjectSettings(input.project),
			duration: secondsOf(tracksDuration(activeScene.tracks)),
		},
		scene: {
			id: activeScene.id,
			name: activeScene.name,
			isMain: activeScene.isMain,
		},
		scenes: input.scenes.map(summarizeScene),
		tracks: summarizeTracks({
			tracks: activeScene.tracks,
			detail: input.detail,
		}),
		media: input.mediaAssets.map(summarizeMedia),
		bookmarks: summarizeBookmarks(activeScene.bookmarks),
		playhead: secondsOf(input.playhead),
		selection: input.selection.map((ref) => ref.elementId),
		isPlaying: input.isPlaying,
		canUndo: input.canUndo,
		canRedo: input.canRedo,
		modes: input.modes,
		busy: {
			exporting: input.busy.exporting,
			...(input.busy.exporting
				? { exportProgress: round3(input.busy.exportProgress) }
				: {}),
			userDragging: input.busy.userDragging,
		},
		detail: input.detail,
		stateVersion: input.stateVersion,
	};
}
