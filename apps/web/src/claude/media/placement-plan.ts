import type { TrackKeyword } from "@opencut/claude-tools";
import type { MediaType } from "@/media/types";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { applyPlacement } from "@/timeline/placement/apply";
import { canElementGoOnTrack } from "@/timeline/placement/compatibility";
import { canPlaceTimeSpansOnTrack } from "@/timeline/placement/overlap";
import { resolveTrackPlacement } from "@/timeline/placement/resolve";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import type { SceneTracks, TimelineElement, TrackType } from "@/timeline/types";
import { mediaTime, type MediaTime } from "@/wasm";
import { getOrderedTracks, ticksToSeconds } from "@/claude/units";

// Where import_media puts each file (contract: place.start / place.track). Pure: it simulates the inserts with
// the same placement helpers InsertElementCommand uses, so a refusal is known before anything is applied and
// the files follow each other back to back even when the main track moves the first one to 0 s.

export type ImportTrackTarget = TrackKeyword | { trackId: string };

export type ImportPlacement =
	| { mode: "explicit"; trackId: string }
	| { mode: "auto"; trackType: TrackType };

export interface ImportPlacementItem {
	mediaType: MediaType;
	/** Timeline duration in ticks (the media duration, or the default image length). */
	duration: MediaTime;
}

export interface ImportPlacementStep {
	/** Index into the items. */
	index: number;
	/** startTime to give the element (InsertElementCommand applies the main-track rule itself). */
	startTime: MediaTime;
	/** Where the element should land once the editor's rules apply. */
	expectedStart: MediaTime;
	placement: ImportPlacement;
}

export interface NewTrackIds {
	video: string;
	audio: string;
}

export interface ImportPlacementPlan {
	steps: ImportPlacementStep[];
	/** Tracks the batch must create first (AddTrackCommand with these ids), for the "overlay" keyword. */
	newTracks: { kind: "video" | "audio"; trackId: string }[];
	warnings: string[];
}

export type ImportPlacementResult =
	| { ok: true; plan: ImportPlacementPlan }
	| { ok: false; reason: string };

function trackTypeFor(mediaType: MediaType): TrackType {
	return mediaType === "audio" ? "audio" : "video";
}

/**
 * Checks a place.track value before any byte is fetched: an unknown track id or a track that cannot hold one
 * of the files is refused (returns the reason); keywords always pass (mismatches fall back, with a warning).
 */
export function validateImportTarget({
	tracks,
	target,
	mediaTypes,
}: {
	tracks: SceneTracks;
	target: ImportTrackTarget;
	mediaTypes: readonly MediaType[];
}): { code: "NOT_FOUND" | "INVALID_PARAMS"; message: string } | null {
	if (typeof target === "string") return null;
	if (target.trackId.startsWith("@")) {
		return {
			code: "INVALID_PARAMS",
			message: `"${target.trackId}": @name references only exist inside apply_edit_plan. Use a track id, "main", "overlay", "audio" or "auto".`,
		};
	}
	const track = getOrderedTracks(tracks).find(
		(candidate) => candidate.id === target.trackId,
	);
	if (!track) {
		return {
			code: "NOT_FOUND",
			message: `Track "${target.trackId}" does not exist in the active scene. Call get_editor_state for the current track ids.`,
		};
	}
	const refused = [...new Set(mediaTypes)].filter(
		(mediaType) =>
			!canElementGoOnTrack({
				elementType: mediaType,
				trackType: track.type,
			}),
	);
	if (refused.length > 0) {
		return {
			code: "INVALID_PARAMS",
			message: `Track "${track.id}" is a ${track.type} track: it cannot hold ${refused.join(" or ")} media.`,
		};
	}
	return null;
}

function planElement({
	item,
	startTime,
	index,
}: {
	item: ImportPlacementItem;
	startTime: MediaTime;
	index: number;
}): TimelineElement {
	return {
		...buildElementFromMedia({
			mediaId: `plan-media-${index}`,
			mediaType: item.mediaType,
			name: `plan-${index}`,
			duration: item.duration,
			startTime,
		}),
		id: `plan-element-${index}`,
	};
}

export function planImportPlacement({
	tracks,
	items,
	target,
	start,
	newTrackIds,
}: {
	tracks: SceneTracks;
	items: readonly ImportPlacementItem[];
	target: ImportTrackTarget;
	/** Timeline start of the first file, in ticks. */
	start: MediaTime;
	/** Ids for the tracks "overlay" creates (from AddTrackCommand.getTrackId()). */
	newTrackIds: NewTrackIds;
}): ImportPlacementResult {
	let simulated = tracks;
	let cursor = start;
	const steps: ImportPlacementStep[] = [];
	const newTracks: ImportPlacementPlan["newTracks"] = [];
	const warnings = new Set<string>();

	for (const [index, item] of items.entries()) {
		const trackType = trackTypeFor(item.mediaType);
		let placement: ImportPlacement = { mode: "auto", trackType };

		if (target === "main") {
			if (trackType === "video") {
				placement = { mode: "explicit", trackId: simulated.main.id };
			} else {
				warnings.add(
					'Audio files cannot go on "main" (video and images only): they were placed on an audio track.',
				);
			}
		} else if (target === "audio" && trackType !== "audio") {
			warnings.add(
				'Video and image files cannot go on an audio track: they were placed with "auto".',
			);
		} else if (target === "overlay") {
			const kind = trackType === "audio" ? "audio" : "video";
			const trackId = newTrackIds[kind];
			if (!newTracks.some((track) => track.kind === kind)) {
				newTracks.push({ kind, trackId });
				// Same positions as AddTrackCommand: video on top of every layer, audio after the last audio track.
				simulated =
					kind === "video"
						? {
								...simulated,
								overlay: [
									buildEmptyTrack({ id: trackId, type: "video" }),
									...simulated.overlay,
								],
							}
						: {
								...simulated,
								audio: [
									...simulated.audio,
									buildEmptyTrack({ id: trackId, type: "audio" }),
								],
							};
			}
			placement = { mode: "explicit", trackId };
		} else if (typeof target === "object") {
			placement = { mode: "explicit", trackId: target.trackId };
		}

		const result = resolveTrackPlacement({
			tracks: simulated,
			trackType,
			timeSpans: [{ startTime: cursor, duration: item.duration }],
			strategy:
				placement.mode === "explicit"
					? { type: "explicit", trackId: placement.trackId }
					: { type: "firstAvailable" },
		});
		if (!result) {
			return {
				ok: false,
				reason:
					placement.mode === "explicit"
						? `track "${placement.trackId}" cannot take file ${index + 1} (${item.mediaType})`
						: `no ${trackType} track can take file ${index + 1}`,
			};
		}
		const expectedStart =
			result.kind === "existingTrack" && result.adjustedStartTime !== undefined
				? result.adjustedStartTime
				: cursor;

		if (placement.mode === "explicit") {
			// Explicit placement skips the overlap check in InsertElementCommand: do it here.
			const track = getOrderedTracks(simulated).find(
				(candidate) => candidate.id === placement.trackId,
			);
			if (
				track &&
				!canPlaceTimeSpansOnTrack({
					track,
					timeSpans: [{ startTime: expectedStart, duration: item.duration }],
				})
			) {
				return {
					ok: false,
					reason: `file ${index + 1} would overlap another clip on track "${track.id}" at ${ticksToSeconds({ ticks: expectedStart })}s`,
				};
			}
		}

		const applied = applyPlacement({
			tracks: simulated,
			placementResult: result,
			elements: [planElement({ item, startTime: expectedStart, index })],
		});
		if (!applied) {
			return { ok: false, reason: `file ${index + 1} could not be placed` };
		}
		simulated = applied.updatedTracks;
		steps.push({ index, startTime: cursor, expectedStart, placement });
		cursor = mediaTime({ ticks: expectedStart + item.duration });
	}

	return { ok: true, plan: { steps, newTracks, warnings: [...warnings] } };
}
