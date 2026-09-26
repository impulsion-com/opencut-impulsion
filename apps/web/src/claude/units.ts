import type { FrameRate } from "opencut-wasm";
import type { EditorCore } from "@/core";
import { DEFAULT_FPS } from "@/fps/defaults";
import type {
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline/types";
import {
	mediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundFrameTime,
	roundMediaTime,
	TICKS_PER_SECOND,
	type MediaTime,
} from "@/wasm";
import { BridgeError } from "./types";

// The single conversion point between the tool boundary (float seconds, 3 decimals) and the editor
// (integer MediaTime ticks, TICKS_PER_SECOND = 120000). Timeline times snap to the project frame grid;
// an end is always start + duration, never rounded on its own (map 2.1).

function assertFiniteSeconds({
	seconds,
	what,
}: {
	seconds: number;
	what: string;
}): void {
	if (!Number.isFinite(seconds)) {
		throw new BridgeError({
			code: "INVALID_PARAMS",
			message: `${what} must be a finite number of seconds, got ${seconds}.`,
		});
	}
}

/** Seconds to ticks, snapped to the nearest frame of `fps` (pass the project fps; null skips the snap). */
export function secondsToTicks({
	seconds,
	fps,
}: {
	seconds: number;
	fps: FrameRate | null;
}): MediaTime {
	assertFiniteSeconds({ seconds, what: "time" });
	const time = mediaTimeFromSeconds({ seconds });
	return fps ? roundFrameTime({ time, fps }) : time;
}

/** Ticks to seconds rounded to 3 decimals (what every tool returns). */
export function ticksToSeconds({ ticks }: { ticks: number }): number {
	const seconds = mediaTimeToSeconds({ time: roundMediaTime({ time: ticks }) });
	const rounded = Math.round(seconds * 1000) / 1000;
	return rounded === 0 ? 0 : rounded;
}

/** Length of one frame in ticks (4000 at 30 fps, 4004 at 29.97). */
export function frameTicks({ fps }: { fps: FrameRate }): MediaTime {
	return mediaTime({
		ticks: Math.max(
			1,
			Math.round((TICKS_PER_SECOND * fps.denominator) / fps.numerator),
		),
	});
}

/** A duration in seconds to ticks, snapped to the frame grid and never shorter than one frame. */
export function durationToTicks({
	seconds,
	fps,
}: {
	seconds: number;
	fps: FrameRate;
}): MediaTime {
	assertFiniteSeconds({ seconds, what: "duration" });
	const snapped = secondsToTicks({ seconds, fps });
	const minimum = frameTicks({ fps });
	return snapped < minimum ? minimum : snapped;
}

/** A timeline span: start and duration snapped once each, end derived as start + duration. */
export function spanToTicks({
	start,
	duration,
	fps,
}: {
	start: number;
	duration: number;
	fps: FrameRate;
}): { startTime: MediaTime; duration: MediaTime; endTime: MediaTime } {
	const startTime = secondsToTicks({ seconds: start, fps });
	const durationTicks = durationToTicks({ seconds: duration, fps });
	return {
		startTime,
		duration: durationTicks,
		endTime: mediaTime({ ticks: startTime + durationTicks }),
	};
}

/** fps of the open project (DEFAULT_FPS when none is open). */
export function getProjectFps(editor: EditorCore): FrameRate {
	return editor.project.getActiveOrNull()?.settings.fps ?? DEFAULT_FPS;
}

// ---------------------------------------------------------------------------
// Element lookup
// ---------------------------------------------------------------------------

/** Tracks in display order, top to bottom: overlay tracks, the main track, then audio tracks. */
export function getOrderedTracks(tracks: SceneTracks): TimelineTrack[] {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

export interface ResolvedElement {
	track: TimelineTrack;
	element: TimelineElement;
}

/** Pure lookup in any SceneTracks (e.g. intermediate tracks while planning). Null when absent. */
export function findElementInTracks({
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

/** Finds an element of the ACTIVE scene by id. Throws NO_PROJECT without a scene, NOT_FOUND for an unknown id. */
export function resolveElement({
	editor,
	elementId,
}: {
	editor: EditorCore;
	elementId: string;
}): ResolvedElement {
	const scene = editor.scenes.getActiveSceneOrNull();
	if (!scene) throw new BridgeError({ code: "NO_PROJECT" });
	const found = findElementInTracks({ tracks: scene.tracks, elementId });
	if (!found) {
		throw new BridgeError({
			code: "NOT_FOUND",
			message: `Element "${elementId}" does not exist in the active scene "${scene.name}".`,
			details: { elementId, sceneId: scene.id },
		});
	}
	return found;
}
