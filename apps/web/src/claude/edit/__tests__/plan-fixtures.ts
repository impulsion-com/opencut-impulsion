import type { EditOp } from "@opencut/claude-tools";
import { EditPlanSchema } from "@opencut/claude-tools";
import type { FrameRate } from "opencut-wasm";
import type { MediaAsset } from "@/media/types";
import type { TProjectSettings } from "@/project/types";
import type {
	AudioTrack,
	Bookmark,
	ImageElement,
	OverlayTrack,
	SceneTracks,
	TextElement,
	TimelineElement,
	UploadAudioElement,
	VideoElement,
	VideoTrack,
} from "@/timeline/types";
import { getOrderedTracks } from "@/claude/units";
import { type MediaTime, mediaTimeFromSeconds } from "@/wasm";
import type { PlanState } from "../plan-state";
import { resolveEditPlan, type ResolvedEditPlan } from "../resolve-plan";
import type { TextMeasurer } from "../text-layout";

// Shared fixtures for the edit-plan tests: seconds helpers, element and track builders, media assets and a
// resolve() wrapper that validates the ops with the contract schema first (like the bridge client does).

export const FPS_30: FrameRate = { numerator: 30, denominator: 1 };
export const FPS_2997: FrameRate = { numerator: 30_000, denominator: 1_001 };

export function t(seconds: number): MediaTime {
	return mediaTimeFromSeconds({ seconds });
}

export function settings({
	fps = FPS_30,
	width = 1080,
	height = 1920,
}: {
	fps?: FrameRate;
	width?: number;
	height?: number;
} = {}): TProjectSettings {
	return {
		fps,
		canvasSize: { width, height },
		canvasSizeMode: "preset",
		lastCustomCanvasSize: null,
		originalCanvasSize: null,
		background: { type: "color", color: "#000000" },
	};
}

export function videoEl({
	id,
	start,
	duration,
	mediaId = "m-video",
	trimStart = 0,
	sourceDuration,
}: {
	id: string;
	start: number;
	duration: number;
	mediaId?: string;
	trimStart?: number;
	sourceDuration?: number;
}): VideoElement {
	const source = sourceDuration ?? trimStart + duration;
	return {
		id,
		type: "video",
		name: id,
		mediaId,
		startTime: t(start),
		duration: t(duration),
		trimStart: t(trimStart),
		trimEnd: t(source - trimStart - duration),
		sourceDuration: t(source),
		isSourceAudioEnabled: true,
		hidden: false,
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
			blendMode: "normal",
			volume: 0,
			muted: false,
		},
	};
}

export function imageEl({
	id,
	start,
	duration,
}: {
	id: string;
	start: number;
	duration: number;
}): ImageElement {
	return {
		id,
		type: "image",
		name: id,
		mediaId: "m-image",
		startTime: t(start),
		duration: t(duration),
		trimStart: t(0),
		trimEnd: t(0),
		hidden: false,
		params: { "transform.scaleX": 1, "transform.scaleY": 1, opacity: 1 },
	};
}

export function textEl({
	id,
	start,
	duration,
	content = id,
}: {
	id: string;
	start: number;
	duration: number;
	content?: string;
}): TextElement {
	return {
		id,
		type: "text",
		name: id,
		startTime: t(start),
		duration: t(duration),
		trimStart: t(0),
		trimEnd: t(0),
		params: {
			content,
			fontFamily: "Arial",
			fontSize: 15,
			color: "#ffffff",
			opacity: 1,
		},
	};
}

export function audioEl({
	id,
	start,
	duration,
	mediaId = "m-audio",
}: {
	id: string;
	start: number;
	duration: number;
	mediaId?: string;
}): UploadAudioElement {
	return {
		id,
		type: "audio",
		sourceType: "upload",
		mediaId,
		name: id,
		startTime: t(start),
		duration: t(duration),
		trimStart: t(0),
		trimEnd: t(0),
		sourceDuration: t(duration),
		params: { volume: 0, muted: false },
	};
}

export function tracks({
	main = [],
	overlay = [],
	audio = [],
}: {
	main?: (VideoElement | ImageElement)[];
	overlay?: OverlayTrack[];
	audio?: AudioTrack[];
}): SceneTracks {
	const mainTrack: VideoTrack = {
		id: "main",
		name: "Main Track",
		type: "video",
		elements: main,
		muted: false,
		hidden: false,
	};
	return { overlay, main: mainTrack, audio };
}

export function textTrack({
	id,
	elements,
}: {
	id: string;
	elements: TextElement[];
}): OverlayTrack {
	return { id, name: "Text track", type: "text", elements, hidden: false };
}

export function audioTrack({
	id,
	elements,
}: {
	id: string;
	elements: UploadAudioElement[];
}): AudioTrack {
	return { id, name: "Audio track", type: "audio", elements, muted: false };
}

export function state({
	sceneTracks,
	bookmarks = [],
	projectSettings = settings(),
}: {
	sceneTracks: SceneTracks;
	bookmarks?: Bookmark[];
	projectSettings?: TProjectSettings;
}): PlanState {
	return { tracks: sceneTracks, bookmarks, settings: projectSettings };
}

export function asset({
	id,
	type,
	duration,
	width,
	height,
	fps,
	hasAudio,
}: {
	id: string;
	type: MediaAsset["type"];
	duration?: number;
	width?: number;
	height?: number;
	fps?: number;
	hasAudio?: boolean;
}): MediaAsset {
	return {
		id,
		name: `${id}.${type === "image" ? "png" : type === "audio" ? "wav" : "mp4"}`,
		type,
		file: new File([], id),
		...(duration !== undefined ? { duration } : {}),
		...(width !== undefined ? { width } : {}),
		...(height !== undefined ? { height } : {}),
		...(fps !== undefined ? { fps } : {}),
		...(hasAudio !== undefined ? { hasAudio } : {}),
	};
}

export const MEDIA: MediaAsset[] = [
	asset({
		id: "m-video",
		type: "video",
		duration: 20,
		width: 1920,
		height: 1080,
		fps: 30,
		hasAudio: true,
	}),
	asset({
		id: "m-silent",
		type: "video",
		duration: 10,
		width: 1080,
		height: 1920,
		fps: 25,
		hasAudio: false,
	}),
	asset({ id: "m-image", type: "image", width: 1000, height: 1000 }),
	asset({ id: "m-audio", type: "audio", duration: 30 }),
];

/** A fake measurer: every character is 10 px wide (letter spacing ignored). */
export const FAKE_MEASURER: TextMeasurer = ({ text }) => text.length * 10;

export function sequentialIds({
	prefix = "id",
}: { prefix?: string } = {}): () => string {
	let counter = 0;
	return () => `${prefix}-${++counter}`;
}

/** Parses the ops with the contract schema (field rules and "@name" checks), then resolves them. */
export function resolve({
	ops,
	initial,
	media = MEDIA,
}: {
	ops: unknown[];
	initial: PlanState;
	media?: MediaAsset[];
}): ResolvedEditPlan {
	const parsed: EditOp[] = EditPlanSchema.parse(ops);
	return resolveEditPlan({
		ops: parsed,
		state: initial,
		mediaAssets: media,
		generateId: sequentialIds(),
		measureText: FAKE_MEASURER,
	});
}

export function element({
	plan,
	id,
}: {
	plan: ResolvedEditPlan | PlanState;
	id: string;
}): TimelineElement {
	const sceneTracks = "state" in plan ? plan.state.tracks : plan.tracks;
	const found = getOrderedTracks(sceneTracks)
		.flatMap((track): TimelineElement[] => track.elements)
		.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`element ${id} not found`);
	return found;
}

export function trackOf({
	plan,
	id,
}: {
	plan: ResolvedEditPlan;
	id: string;
}): string {
	const found = getOrderedTracks(plan.state.tracks).find((track) =>
		track.elements.some((candidate) => candidate.id === id),
	);
	if (!found) throw new Error(`element ${id} not found`);
	return found.id;
}
