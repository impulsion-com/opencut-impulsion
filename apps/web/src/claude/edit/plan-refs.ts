import { planRefName } from "@opencut/claude-tools";
import type { FrameRate } from "opencut-wasm";
import type { TimelineTrack } from "@/timeline/types";
import type { ResolvedElement } from "@/claude/units";
import { durationToTicks, secondsToTicks } from "@/claude/units";
import type { MediaTime } from "@/wasm";
import {
	findElement,
	findTrack,
	planError,
	type PlanContext,
} from "./plan-state";

// Resolution of ids and "@name" references against the WORKING state, plus the single seconds -> ticks
// conversion point of the planner (frame-snapped to the working fps, which a plan may change).

export function planFps({ ctx }: { ctx: PlanContext }): FrameRate {
	return ctx.state.settings.fps;
}

/** Timeline seconds to frame-snapped ticks. */
export function toTicks({
	ctx,
	seconds,
}: {
	ctx: PlanContext;
	seconds: number;
}): MediaTime {
	return secondsToTicks({ seconds, fps: planFps({ ctx }) });
}

/** Duration seconds to frame-snapped ticks, at least one frame. */
export function toDurationTicks({
	ctx,
	seconds,
}: {
	ctx: PlanContext;
	seconds: number;
}): MediaTime {
	return durationToTicks({ seconds, fps: planFps({ ctx }) });
}

/** The element an id or "@name" designates now (split and remove_range pieces keep or get ids as documented). */
export function resolveElementRef({
	ctx,
	value,
	path,
}: {
	ctx: PlanContext;
	value: string;
	path: (string | number)[];
}): ResolvedElement {
	let elementId = value;
	const name = value.startsWith("@") ? planRefName(value) : null;
	if (name !== null) {
		const target = ctx.refs.get(name);
		if (!target || target.kind !== "element") {
			throw planError({
				ctx,
				message: `"${value}" does not name an element created earlier in this plan.`,
				path,
			});
		}
		elementId = target.id;
	}
	const found = findElement({ tracks: ctx.state.tracks, elementId });
	if (!found) {
		throw planError({
			ctx,
			code: "NOT_FOUND",
			message:
				name !== null
					? `element "${value}" (${elementId}) no longer exists: an earlier op of this plan removed it.`
					: `element "${value}" does not exist in the active scene (ids change after split, undo and redo; call get_editor_state).`,
			path,
			details: { elementId },
		});
	}
	return found;
}

/**
 * The track an id or "@name" designates: a track made by new_track, or the track currently holding a named
 * element. "main" is the main track. Other keywords ("overlay", "audio", "auto") are handled by the callers.
 */
export function resolveTrackRef({
	ctx,
	value,
	path,
}: {
	ctx: PlanContext;
	value: string;
	path: (string | number)[];
}): TimelineTrack {
	if (value === "main") return ctx.state.tracks.main;
	const name = value.startsWith("@") ? planRefName(value) : null;
	if (name !== null) {
		const target = ctx.refs.get(name);
		if (target?.kind === "element") {
			return resolveElementRef({ ctx, value, path }).track;
		}
		if (target?.kind === "track") {
			const track = findTrack({ tracks: ctx.state.tracks, trackId: target.id });
			if (!track) {
				throw planError({
					ctx,
					code: "NOT_FOUND",
					message: `track "${value}" no longer exists.`,
					path,
				});
			}
			return track;
		}
		throw planError({
			ctx,
			message: `"${value}" does not name a track or an element created earlier in this plan.`,
			path,
		});
	}
	const track = findTrack({ tracks: ctx.state.tracks, trackId: value });
	if (!track) {
		throw planError({
			ctx,
			code: "NOT_FOUND",
			message: `track "${value}" does not exist in the active scene (call get_editor_state for track ids).`,
			path,
			details: { trackId: value },
		});
	}
	return track;
}

/** Resolves an effect id or "@name" (clip_effect "as") to an effect id. */
export function resolveEffectRef({
	ctx,
	value,
	path,
}: {
	ctx: PlanContext;
	value: string;
	path: (string | number)[];
}): string {
	const name = value.startsWith("@") ? planRefName(value) : null;
	if (name === null) return value;
	const target = ctx.refs.get(name);
	if (!target || target.kind !== "effect") {
		throw planError({
			ctx,
			message: `"${value}" does not name a clip effect added earlier in this plan.`,
			path,
		});
	}
	return target.id;
}
