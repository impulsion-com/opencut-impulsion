import {
	CANVAS_PRESETS,
	EDITOR_CANVAS_PRESET_NAMES,
	type BookmarkOp,
	type NewTrackOp,
	type ProjectSettingsOp,
} from "@opencut/claude-tools";
import { DEFAULT_CANVAS_PRESETS } from "@/canvas/sizes";
import { floatToFrameRate, frameRatesEqual } from "@/fps/utils";
import type {
	TBackground,
	TCanvasSize,
	TProjectSettings,
} from "@/project/types";
import { findBookmarkIndex } from "@/timeline/bookmarks/utils";
import type { Bookmark } from "@/timeline/types";
import { frameTicks, secondsToTicks, ticksToSeconds } from "@/claude/units";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";
import { planFps, toDurationTicks, toTicks } from "./plan-refs";
import {
	insertEmptyTrack,
	planError,
	recordCreated,
	warn,
	type PlanContext,
} from "./plan-state";

// Ops on tracks, bookmarks and project settings: new_track, bookmark, project_settings.

// ---------------------------------------------------------------------------
// new_track
// ---------------------------------------------------------------------------

export function applyNewTrack({
	ctx,
	op,
}: {
	ctx: PlanContext;
	op: NewTrackOp;
}): void {
	const tracks = ctx.state.tracks;
	const position = op.position ?? "top";
	let displayIndex: number;
	if (op.type === "audio") {
		const firstAudio = tracks.overlay.length + 1;
		displayIndex =
			position === "top"
				? firstAudio
				: position === "bottom"
					? firstAudio + tracks.audio.length
					: firstAudio + Math.min(position, tracks.audio.length);
	} else {
		displayIndex =
			position === "top"
				? 0
				: position === "bottom"
					? tracks.overlay.length
					: Math.min(position, tracks.overlay.length);
	}
	const id = ctx.generateId();
	ctx.state = {
		...ctx.state,
		tracks: insertEmptyTrack({ tracks, type: op.type, displayIndex, id }),
	};
	recordCreated({ ctx, kind: "track", id, as: op.as });
}

// ---------------------------------------------------------------------------
// bookmark
// ---------------------------------------------------------------------------

function sortBookmarks({ bookmarks }: { bookmarks: Bookmark[] }): Bookmark[] {
	return [...bookmarks].sort((a, b) => a.time - b.time);
}

function patchBookmark({
	bookmark,
	op,
	ctx,
}: {
	bookmark: Bookmark;
	op: BookmarkOp;
	ctx: PlanContext;
}): Bookmark {
	const next: Bookmark = { ...bookmark };
	if (op.note !== undefined) next.note = op.note;
	if (op.color !== undefined) next.color = op.color;
	if (op.duration !== undefined) {
		if (op.duration > 0)
			next.duration = toDurationTicks({ ctx, seconds: op.duration });
		else delete next.duration;
	}
	return next;
}

function listBookmarkTimes({
	bookmarks,
}: {
	bookmarks: readonly Bookmark[];
}): string {
	if (bookmarks.length === 0) return "the scene has no bookmarks";
	const times = bookmarks
		.slice(0, 20)
		.map((bookmark) => ticksToSeconds({ ticks: bookmark.time }));
	return `bookmarks at ${times.join(", ")} s${bookmarks.length > 20 ? ", ..." : ""}`;
}

/**
 * The bookmark at `seconds`: the one on that frame, or failing that the nearest within half a frame of the
 * unsnapped time. Bookmarks keep their ticks when the fps changes, so they can sit off the current frame grid;
 * half a frame never merges two distinct frames of the same grid. -1 when there is none.
 */
function findNearestBookmarkIndex({
	ctx,
	bookmarks,
	time,
	seconds,
}: {
	ctx: PlanContext;
	bookmarks: Bookmark[];
	time: MediaTime;
	seconds: number;
}): number {
	const exact = findBookmarkIndex({ bookmarks, frameTime: time });
	if (exact >= 0) return exact;
	const target = secondsToTicks({ seconds, fps: null });
	const halfFrame = frameTicks({ fps: planFps({ ctx }) }) / 2;
	let best = -1;
	let bestDistance = Number.POSITIVE_INFINITY;
	bookmarks.forEach((bookmark, index) => {
		const distance = Math.abs(bookmark.time - target);
		if (distance <= halfFrame && distance < bestDistance) {
			best = index;
			bestDistance = distance;
		}
	});
	return best;
}

export function applyBookmark({
	ctx,
	op,
}: {
	ctx: PlanContext;
	op: BookmarkOp;
}): void {
	const time = toTicks({ ctx, seconds: op.time });
	const bookmarks = ctx.state.bookmarks;
	const index = findNearestBookmarkIndex({
		ctx,
		bookmarks,
		time,
		seconds: op.time,
	});

	if (op.action === "add") {
		if (index >= 0) {
			warn({
				ctx,
				message: `a bookmark already existed at ${ticksToSeconds({ ticks: bookmarks[index].time })} s; it was updated instead.`,
			});
			const updated = [...bookmarks];
			updated[index] = patchBookmark({ bookmark: bookmarks[index], op, ctx });
			ctx.state = { ...ctx.state, bookmarks: updated };
			return;
		}
		const added = patchBookmark({ bookmark: { time }, op, ctx });
		ctx.state = {
			...ctx.state,
			bookmarks: sortBookmarks({ bookmarks: [...bookmarks, added] }),
		};
		return;
	}

	if (index < 0) {
		throw planError({
			ctx,
			code: "NOT_FOUND",
			message: `there is no bookmark at ${op.time} s (${listBookmarkTimes({ bookmarks })}).`,
			path: ["time"],
		});
	}
	if (op.action === "remove") {
		ctx.state = {
			...ctx.state,
			bookmarks: bookmarks.filter((_, i) => i !== index),
		};
		return;
	}
	const updated = [...bookmarks];
	updated[index] = patchBookmark({ bookmark: bookmarks[index], op, ctx });
	ctx.state = { ...ctx.state, bookmarks: updated };
}

// ---------------------------------------------------------------------------
// project_settings
// ---------------------------------------------------------------------------

function sameSize({
	a,
	b,
}: {
	a: TCanvasSize | null | undefined;
	b: TCanvasSize;
}): boolean {
	return !!a && a.width === b.width && a.height === b.height;
}

function sameBackground({ a, b }: { a: TBackground; b: TBackground }): boolean {
	if (a.type === "color" && b.type === "color") return a.color === b.color;
	if (a.type === "blur" && b.type === "blur")
		return a.blurIntensity === b.blurIntensity;
	return false;
}

export function applyProjectSettings({
	ctx,
	op,
}: {
	ctx: PlanContext;
	op: ProjectSettingsOp;
}): void {
	const current = ctx.state.settings;
	const patch: Partial<TProjectSettings> = {};

	if (op.canvas !== undefined) {
		const size: TCanvasSize =
			typeof op.canvas === "string"
				? { ...CANVAS_PRESETS[op.canvas] }
				: { ...op.canvas };
		const isEditorPreset =
			typeof op.canvas === "string"
				? EDITOR_CANVAS_PRESET_NAMES.some((name) => name === op.canvas)
				: DEFAULT_CANVAS_PRESETS.some((preset) =>
						sameSize({ a: preset, b: size }),
					);
		// Like the Settings panel: presets it lists use mode "preset", anything else "custom" plus lastCustomCanvasSize.
		const mode = isEditorPreset ? "preset" : "custom";
		if (!sameSize({ a: current.canvasSize, b: size })) patch.canvasSize = size;
		if ((current.canvasSizeMode ?? "preset") !== mode)
			patch.canvasSizeMode = mode;
		if (
			mode === "custom" &&
			!sameSize({ a: current.lastCustomCanvasSize, b: size })
		) {
			patch.lastCustomCanvasSize = size;
		}
	}

	if (op.fps !== undefined) {
		const fps = floatToFrameRate(op.fps);
		if ((TICKS_PER_SECOND * fps.denominator) % fps.numerator !== 0) {
			throw planError({
				ctx,
				message: `${op.fps} fps is not supported by the timeline (no whole number of ticks per frame); use 23.976, 24, 25, 29.97, 30, 50, 59.94, 60 or 120.`,
				path: ["fps"],
			});
		}
		if (!frameRatesEqual({ a: current.fps, b: fps })) patch.fps = fps;
	}

	if (op.background !== undefined) {
		const background: TBackground =
			op.background.type === "color"
				? { type: "color", color: op.background.color }
				: { type: "blur", blurIntensity: op.background.intensity };
		if (!sameBackground({ a: current.background, b: background }))
			patch.background = background;
	}

	if (Object.keys(patch).length === 0) {
		warn({
			ctx,
			message: "the project already has these settings; nothing changed.",
		});
		return;
	}
	ctx.settingsSteps.push({ opIndex: ctx.opIndex, patch, undoable: true });
	ctx.state = { ...ctx.state, settings: { ...current, ...patch } };
}
