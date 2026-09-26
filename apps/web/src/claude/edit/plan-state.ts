import type {
	EditOpName,
	EditPlanCreated,
	PlanRefKind,
} from "@opencut/claude-tools";
import type { MediaAsset } from "@/media/types";
import type { TProjectSettings } from "@/project/types";
import { buildEmptyTrack } from "@/timeline/placement";
import type {
	AudioTrack,
	Bookmark,
	OverlayTrack,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	TrackType,
} from "@/timeline/types";
import { getOrderedTracks, type ResolvedElement } from "@/claude/units";
import { BridgeError } from "@/claude/types";
import type { TextMeasurer } from "./text-layout";

// The working copy an edit plan is resolved against. Every op is a pure transform of PlanState, so a dry run and a
// real run compute exactly the same result; only the real run then applies it (plan-commands.ts).

export interface PlanState {
	tracks: SceneTracks;
	bookmarks: Bookmark[];
	settings: TProjectSettings;
}

/** A project settings change in plan order. `undoable: false` mirrors the editor's first-clip canvas rule. */
export interface PlanSettingsStep {
	opIndex: number;
	patch: Partial<TProjectSettings>;
	undoable: boolean;
}

export type PlanRefTarget =
	| { kind: "element"; id: string }
	| { kind: "track"; id: string }
	| { kind: "effect"; id: string; elementId: string };

export interface PlanContext {
	state: PlanState;
	readonly mediaAssets: readonly MediaAsset[];
	readonly generateId: () => string;
	/** Text width measurer for add_text maxWidth (null outside the browser: wrapping is skipped with a warning). */
	readonly measureText: TextMeasurer | null;
	readonly refs: Map<string, PlanRefTarget>;
	readonly created: EditPlanCreated[];
	readonly warnings: string[];
	readonly settingsSteps: PlanSettingsStep[];
	opIndex: number;
	opName: EditOpName;
}

// ---------------------------------------------------------------------------
// Errors and notes (always prefixed with the op, so the model knows which one to fix)
// ---------------------------------------------------------------------------

export function planError({
	ctx,
	message,
	code = "INVALID_EDIT",
	path,
	details,
}: {
	ctx: PlanContext;
	message: string;
	code?: "INVALID_EDIT" | "NOT_FOUND";
	path?: (string | number)[];
	details?: Record<string, unknown>;
}): BridgeError {
	return new BridgeError({
		code,
		message: `op ${ctx.opIndex} (${ctx.opName}): ${message} Nothing was applied.`,
		details: {
			opIndex: ctx.opIndex,
			op: ctx.opName,
			...(path ? { path: [ctx.opIndex, ...path] } : {}),
			...details,
		},
	});
}

export function warn({
	ctx,
	message,
}: {
	ctx: PlanContext;
	message: string;
}): void {
	ctx.warnings.push(`op ${ctx.opIndex} (${ctx.opName}): ${message}`);
}

export function recordCreated({
	ctx,
	kind,
	id,
	trackId,
	elementId,
	as,
}: {
	ctx: PlanContext;
	kind: PlanRefKind;
	id: string;
	trackId?: string;
	elementId?: string;
	as?: string;
}): void {
	ctx.created.push({
		op: ctx.opIndex,
		kind,
		id,
		...(trackId === undefined ? {} : { trackId }),
		...(elementId === undefined ? {} : { elementId }),
		...(as === undefined ? {} : { as }),
	});
	if (as !== undefined) {
		ctx.refs.set(
			as,
			kind === "effect"
				? { kind, id, elementId: elementId ?? "" }
				: { kind, id },
		);
	}
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function findTrack({
	tracks,
	trackId,
}: {
	tracks: SceneTracks;
	trackId: string;
}): TimelineTrack | null {
	return getOrderedTracks(tracks).find((track) => track.id === trackId) ?? null;
}

export function findElement({
	tracks,
	elementId,
}: {
	tracks: SceneTracks;
	elementId: string;
}): ResolvedElement | null {
	for (const track of getOrderedTracks(tracks)) {
		const elements: readonly TimelineElement[] = track.elements;
		const element = elements.find((candidate) => candidate.id === elementId);
		if (element) return { track, element };
	}
	return null;
}

export function countElements({ tracks }: { tracks: SceneTracks }): number {
	return getOrderedTracks(tracks).reduce(
		(total, track) => total + track.elements.length,
		0,
	);
}

// ---------------------------------------------------------------------------
// Immutable track updates
// ---------------------------------------------------------------------------

function withElements<TTrack extends TimelineTrack>({
	track,
	elements,
}: {
	track: TTrack;
	elements: TimelineElement[];
}): TTrack {
	// Callers only ever put elements of a kind the track accepts (checked with canElementGoOnTrack).
	return { ...track, elements } as TTrack;
}

export function mapTracks({
	tracks,
	map,
}: {
	tracks: SceneTracks;
	map: <TTrack extends TimelineTrack>(track: TTrack) => TTrack;
}): SceneTracks {
	return {
		overlay: tracks.overlay.map((track) => map(track)),
		main: map(tracks.main),
		audio: tracks.audio.map((track) => map(track)),
	};
}

export function updateTrackElements({
	tracks,
	trackId,
	update,
}: {
	tracks: SceneTracks;
	trackId: string;
	update: (elements: readonly TimelineElement[]) => TimelineElement[];
}): SceneTracks {
	return mapTracks({
		tracks,
		map: (track) =>
			track.id === trackId
				? withElements({ track, elements: update(track.elements) })
				: track,
	});
}

export function replaceElement({
	tracks,
	element,
}: {
	tracks: SceneTracks;
	element: TimelineElement;
}): SceneTracks {
	return mapTracks({
		tracks,
		map: (track) =>
			track.elements.some((candidate) => candidate.id === element.id)
				? withElements({
						track,
						elements: track.elements.map((candidate) =>
							candidate.id === element.id ? element : candidate,
						),
					})
				: track,
	});
}

export function removeElements({
	tracks,
	elementIds,
}: {
	tracks: SceneTracks;
	elementIds: ReadonlySet<string>;
}): SceneTracks {
	return mapTracks({
		tracks,
		map: (track) =>
			track.elements.some((element) => elementIds.has(element.id))
				? withElements({
						track,
						elements: track.elements.filter(
							(element) => !elementIds.has(element.id),
						),
					})
				: track,
	});
}

export function addElementsToTrack({
	tracks,
	trackId,
	elements,
}: {
	tracks: SceneTracks;
	trackId: string;
	elements: TimelineElement[];
}): SceneTracks {
	return updateTrackElements({
		tracks,
		trackId,
		update: (current) => [...current, ...elements],
	});
}

export function updateTrack({
	tracks,
	trackId,
	update,
}: {
	tracks: SceneTracks;
	trackId: string;
	update: <TTrack extends TimelineTrack>(track: TTrack) => TTrack;
}): SceneTracks {
	return mapTracks({
		tracks,
		map: (track) => (track.id === trackId ? update(track) : track),
	});
}

/**
 * Inserts an empty track at a DISPLAY index (overlay tracks, then main, then audio), with the same index math as
 * applyPlacement and AddTrackCommand: audio tracks land below main, other kinds above it.
 */
export function insertEmptyTrack({
	tracks,
	type,
	displayIndex,
	id,
}: {
	tracks: SceneTracks;
	type: TrackType;
	displayIndex: number;
	id: string;
}): SceneTracks {
	if (type === "audio") {
		const track: AudioTrack = buildEmptyTrack({ id, type: "audio" });
		const audioIndex = Math.max(
			0,
			Math.min(displayIndex - tracks.overlay.length - 1, tracks.audio.length),
		);
		const audio = [...tracks.audio];
		audio.splice(audioIndex, 0, track);
		return { ...tracks, audio };
	}
	const track: OverlayTrack =
		type === "video"
			? buildEmptyTrack({ id, type: "video" })
			: type === "text"
				? buildEmptyTrack({ id, type: "text" })
				: type === "graphic"
					? buildEmptyTrack({ id, type: "graphic" })
					: buildEmptyTrack({ id, type: "effect" });
	const overlayIndex = Math.max(
		0,
		Math.min(displayIndex, tracks.overlay.length),
	);
	const overlay = [...tracks.overlay];
	overlay.splice(overlayIndex, 0, track);
	return { ...tracks, overlay };
}

/** The editor's empty-track reactor (core/index.ts): overlay and audio tracks without elements are dropped. */
export function pruneEmptyTracks({ tracks }: { tracks: SceneTracks }): {
	tracks: SceneTracks;
	prunedTrackIds: string[];
} {
	const pruned = [...tracks.overlay, ...tracks.audio]
		.filter((track) => track.elements.length === 0)
		.map((track) => track.id);
	if (pruned.length === 0) return { tracks, prunedTrackIds: [] };
	return {
		tracks: {
			...tracks,
			overlay: tracks.overlay.filter((track) => track.elements.length > 0),
			audio: tracks.audio.filter((track) => track.elements.length > 0),
		},
		prunedTrackIds: pruned,
	};
}
