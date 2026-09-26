import type { FrameRate } from "opencut-wasm";
import { splitAnimationsAtTime } from "@/animation";
import { getSourceSpanAtClipTime } from "@/retime";
import type {
	Bookmark,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import {
	addMediaTime,
	type MediaTime,
	roundFrameTime,
	roundMediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

// Pure multi-track "cut a time range and close the gap" (map 5.2 step 4). Unlike ripple (diff.ts), which only
// closes gaps a command freed on the track it touched, this shifts EVERY selected track, so captions, overlays and
// audio stay in sync with the main track.

export interface TimeRange {
	start: MediaTime;
	end: MediaTime;
}

export interface SplitElementResult {
	left: TimelineElement;
	right: TimelineElement;
}

/**
 * Cuts one element at an absolute timeline time with SplitElementsCommand's math: the source-side split point is
 * rounded once and the right half derived from it, so `leftSpan + rightSpan == totalSpan` holds exactly under
 * retime; keyframes are split with a boundary key on each side (right-hand times rebased to 0). The left piece keeps
 * the id; the right piece gets `rightId`. `splitTime` must fall strictly inside the element.
 */
export function splitElementAt({
	element,
	splitTime,
	rightId,
}: {
	element: TimelineElement;
	splitTime: MediaTime;
	rightId: string;
}): SplitElementResult {
	const relativeTime = subMediaTime({ a: splitTime, b: element.startTime });
	if (relativeTime <= 0 || relativeTime >= element.duration) {
		throw new Error(
			`splitElementAt: ${splitTime} is not strictly inside element ${element.id}`,
		);
	}
	const retime =
		element.type === "video" || element.type === "audio"
			? element.retime
			: undefined;
	const leftSourceSpan = roundMediaTime({
		time: getSourceSpanAtClipTime({ clipTime: relativeTime, retime }),
	});
	const totalSourceSpan = roundMediaTime({
		time: getSourceSpanAtClipTime({ clipTime: element.duration, retime }),
	});
	const rightSourceSpan = subMediaTime({
		a: totalSourceSpan,
		b: leftSourceSpan,
	});
	const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
		animations: element.animations,
		splitTime: relativeTime,
		shouldIncludeSplitBoundary: true,
	});

	return {
		left: {
			...element,
			duration: relativeTime,
			trimEnd: addMediaTime({ a: element.trimEnd, b: rightSourceSpan }),
			animations: leftAnimations,
		},
		right: {
			...element,
			id: rightId,
			startTime: splitTime,
			duration: subMediaTime({ a: element.duration, b: relativeTime }),
			trimStart: addMediaTime({ a: element.trimStart, b: leftSourceSpan }),
			animations: rightAnimations,
		},
	};
}

/** Snaps (when fps is given), drops empty ranges, sorts, and merges overlapping or touching ranges. */
export function normalizeTimeRanges({
	ranges,
	fps,
}: {
	ranges: readonly TimeRange[];
	fps?: FrameRate | null;
}): TimeRange[] {
	const snapped = ranges
		.map((range) =>
			fps
				? {
						start: roundFrameTime({ time: range.start, fps }),
						end: roundFrameTime({ time: range.end, fps }),
					}
				: range,
		)
		.map((range) => ({
			start: range.start < 0 ? ZERO_MEDIA_TIME : range.start,
			end: range.end,
		}))
		.filter((range) => range.end > range.start)
		.sort((a, b) => a.start - b.start);

	const merged: TimeRange[] = [];
	for (const range of snapped) {
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end) {
			if (range.end > last.end) {
				merged[merged.length - 1] = { start: last.start, end: range.end };
			}
			continue;
		}
		merged.push({ ...range });
	}
	return merged;
}

/**
 * Elements with no source timing and no keyframes (text, image, sticker, graphic, effect layer). One that spans a
 * whole range is shortened instead of being cut in two: both halves would show exactly the same thing.
 */
function isStaticElement(element: TimelineElement): boolean {
	if (element.type === "video" || element.type === "audio") return false;
	return !element.animations || Object.keys(element.animations).length === 0;
}

export interface RemovedRangeElementPiece {
	trackId: string;
	elementId: string;
	/** The element it was cut from (which keeps its own id for the left part). */
	sourceElementId: string;
}

export interface RemoveTimeRangesResult {
	tracks: SceneTracks;
	bookmarks: Bookmark[];
	/** The ranges actually removed (normalized), in timeline times BEFORE the removal. */
	ranges: TimeRange[];
	/** Sum of the removed ranges. */
	removedDuration: MediaTime;
	/** Elements that were entirely inside a range. */
	deletedElementIds: string[];
	/** New right-hand pieces of elements that spanned a whole range (new ids). */
	createdElements: RemovedRangeElementPiece[];
	/** Existing elements that were trimmed, shortened or shifted. */
	changedElementIds: string[];
	/** Bookmarks dropped because they fell inside a range (or collided with another after the shift). */
	removedBookmarkCount: number;
	/**
	 * How far the first main-track clip had to be moved back to 0 s (editor invariant) when a range removed
	 * everything before it but left a gap; zero otherwise.
	 */
	mainStartAdjustment: MediaTime;
}

type ElementBuckets = {
	elements: TimelineElement[];
	deleted: string[];
	created: RemovedRangeElementPiece[];
	changed: Set<string>;
};

function removeRangeFromElements({
	track,
	elements,
	range,
	generateId,
	buckets,
}: {
	track: TimelineTrack;
	elements: readonly TimelineElement[];
	range: TimeRange;
	generateId: () => string;
	buckets: Omit<ElementBuckets, "elements">;
}): TimelineElement[] {
	const { start: rangeStart, end: rangeEnd } = range;
	const length = subMediaTime({ a: rangeEnd, b: rangeStart });
	const next: TimelineElement[] = [];

	for (const element of elements) {
		const start = element.startTime;
		const end = addMediaTime({ a: start, b: element.duration });

		if (end <= rangeStart) {
			next.push(element);
			continue;
		}
		if (start >= rangeEnd) {
			next.push({
				...element,
				startTime: subMediaTime({ a: start, b: length }),
			});
			buckets.changed.add(element.id);
			continue;
		}
		if (start >= rangeStart && end <= rangeEnd) {
			buckets.deleted.push(element.id);
			buckets.changed.delete(element.id);
			continue;
		}

		buckets.changed.add(element.id);
		if (start < rangeStart && end > rangeEnd) {
			if (isStaticElement(element)) {
				next.push({
					...element,
					duration: subMediaTime({ a: element.duration, b: length }),
				});
				continue;
			}
			// Cut out the middle: the left part keeps the id, the part after the range becomes a new element.
			const leftCut = splitElementAt({
				element,
				splitTime: rangeStart,
				rightId: element.id,
			});
			const rightId = generateId();
			const rightCut = splitElementAt({
				element,
				splitTime: rangeEnd,
				rightId,
			});
			next.push(leftCut.left, { ...rightCut.right, startTime: rangeStart });
			buckets.created.push({
				trackId: track.id,
				elementId: rightId,
				sourceElementId: element.id,
			});
			continue;
		}
		if (start < rangeStart) {
			next.push(
				splitElementAt({ element, splitTime: rangeStart, rightId: element.id })
					.left,
			);
			continue;
		}
		// Starts inside the range, ends after it: keep the part after the range, moved to the range start.
		const { right } = splitElementAt({
			element,
			splitTime: rangeEnd,
			rightId: element.id,
		});
		next.push({ ...right, startTime: rangeStart });
	}

	return next;
}

function removeRangeFromBookmarks({
	bookmarks,
	range,
}: {
	bookmarks: readonly Bookmark[];
	range: TimeRange;
}): { bookmarks: Bookmark[]; removed: number } {
	const { start: rangeStart, end: rangeEnd } = range;
	const length = subMediaTime({ a: rangeEnd, b: rangeStart });
	const next: Bookmark[] = [];
	let removed = 0;

	for (const bookmark of bookmarks) {
		const start = bookmark.time;
		const duration =
			bookmark.duration != null && bookmark.duration > 0
				? bookmark.duration
				: ZERO_MEDIA_TIME;

		if (duration === 0) {
			if (start < rangeStart) next.push(bookmark);
			else if (start >= rangeEnd)
				next.push({ ...bookmark, time: subMediaTime({ a: start, b: length }) });
			else removed += 1;
			continue;
		}

		const end = addMediaTime({ a: start, b: duration });
		if (end <= rangeStart) {
			next.push(bookmark);
		} else if (start >= rangeEnd) {
			next.push({ ...bookmark, time: subMediaTime({ a: start, b: length }) });
		} else if (start >= rangeStart && end <= rangeEnd) {
			removed += 1;
		} else if (start < rangeStart && end > rangeEnd) {
			next.push({
				...bookmark,
				duration: subMediaTime({ a: duration, b: length }),
			});
		} else if (start < rangeStart) {
			next.push({
				...bookmark,
				duration: subMediaTime({ a: rangeStart, b: start }),
			});
		} else {
			next.push({
				...bookmark,
				time: rangeStart,
				duration: subMediaTime({ a: end, b: rangeEnd }),
			});
		}
	}

	return { bookmarks: next, removed };
}

/** Bookmarks are keyed by time in the editor: keep the first one at each time, sorted. */
function dedupeBookmarks({ bookmarks }: { bookmarks: Bookmark[] }): {
	bookmarks: Bookmark[];
	removed: number;
} {
	const seen = new Set<number>();
	const kept: Bookmark[] = [];
	for (const bookmark of bookmarks) {
		if (seen.has(bookmark.time)) continue;
		seen.add(bookmark.time);
		kept.push(bookmark);
	}
	kept.sort((a, b) => a.time - b.time);
	return { bookmarks: kept, removed: bookmarks.length - kept.length };
}

function mapTrackElements<TTrack extends TimelineTrack>({
	track,
	map,
}: {
	track: TTrack;
	map: (elements: readonly TimelineElement[]) => TimelineElement[];
}): TTrack {
	const elements = map(track.elements);
	// A range that touched nothing on this track keeps the track object, so callers comparing by identity see
	// no change (and push no empty undo step).
	if (
		elements.length === track.elements.length &&
		elements.every((element, index) => element === track.elements[index])
	) {
		return track;
	}
	// Elements keep their kind (split and shift never change `type`), so the track's element type still holds.
	return { ...track, elements } as TTrack;
}

function earliestStart({ track }: { track: TimelineTrack }): MediaTime | null {
	let earliest: MediaTime | null = null;
	for (const element of track.elements) {
		if (earliest === null || element.startTime < earliest) {
			earliest = element.startTime;
		}
	}
	return earliest;
}

/**
 * Removes time ranges from the timeline and closes the gaps on every selected track (all tracks by default):
 * elements crossing a range edge are cut there (SplitElementsCommand math, keyframes follow), pieces inside are
 * dropped, everything after a range moves left by its length. Bookmarks (scene-level) always follow: inside a range
 * they are removed, ranged ones crossing an edge are shortened. Ranges are frame-snapped when `fps` is given,
 * merged when they overlap or touch, and applied from the last to the first so their times stay valid.
 * The main track keeps starting at 0 s.
 */
export function removeTimeRanges({
	tracks,
	ranges,
	trackFilter,
	bookmarks = [],
	fps = null,
	generateId = generateUUID,
}: {
	tracks: SceneTracks;
	ranges: readonly TimeRange[];
	/** Which tracks are cut and shifted. Default: every track. */
	trackFilter?: (track: TimelineTrack) => boolean;
	bookmarks?: readonly Bookmark[];
	fps?: FrameRate | null;
	/** Ids for new right-hand pieces (injectable for tests). */
	generateId?: () => string;
}): RemoveTimeRangesResult {
	const normalized = normalizeTimeRanges({ ranges, fps });
	const buckets: Omit<ElementBuckets, "elements"> = {
		deleted: [],
		created: [],
		changed: new Set<string>(),
	};
	const isSelected = (track: TimelineTrack) => trackFilter?.(track) ?? true;
	const mainStartedAtZero = earliestStart({ track: tracks.main }) === 0;

	let nextTracks = tracks;
	let nextBookmarks: Bookmark[] = [...bookmarks];
	let removedBookmarkCount = 0;

	for (const range of [...normalized].reverse()) {
		const cut = <TTrack extends TimelineTrack>(track: TTrack): TTrack =>
			isSelected(track)
				? mapTrackElements({
						track,
						map: (elements) =>
							removeRangeFromElements({
								track,
								elements,
								range,
								generateId,
								buckets,
							}),
					})
				: track;
		nextTracks = {
			overlay: nextTracks.overlay.map((track) => cut(track)),
			main: cut(nextTracks.main),
			audio: nextTracks.audio.map((track) => cut(track)),
		};
		const bookmarkResult = removeRangeFromBookmarks({
			bookmarks: nextBookmarks,
			range,
		});
		nextBookmarks = bookmarkResult.bookmarks;
		removedBookmarkCount += bookmarkResult.removed;
	}

	let mainStartAdjustment = ZERO_MEDIA_TIME;
	const mainEarliest = earliestStart({ track: nextTracks.main });
	if (
		isSelected(tracks.main) &&
		mainStartedAtZero &&
		mainEarliest !== null &&
		mainEarliest > 0
	) {
		// Same rule as the editor's startTime pipeline: the earliest main clip is forced to 0.
		mainStartAdjustment = mainEarliest;
		nextTracks = {
			...nextTracks,
			main: {
				...nextTracks.main,
				elements: nextTracks.main.elements.map((element) =>
					element.startTime === mainEarliest
						? { ...element, startTime: ZERO_MEDIA_TIME }
						: element,
				),
			},
		};
	}

	const deduped = dedupeBookmarks({ bookmarks: nextBookmarks });
	removedBookmarkCount += deduped.removed;

	const createdIds = new Set(buckets.created.map((piece) => piece.elementId));
	const deletedIds = new Set(buckets.deleted);
	const removedDuration = normalized.reduce<MediaTime>(
		(total, range) =>
			addMediaTime({
				a: total,
				b: subMediaTime({ a: range.end, b: range.start }),
			}),
		ZERO_MEDIA_TIME,
	);

	return {
		tracks:
			normalized.length > 0 || mainStartAdjustment > 0 ? nextTracks : tracks,
		bookmarks: normalized.length > 0 ? deduped.bookmarks : [...bookmarks],
		ranges: normalized,
		removedDuration,
		deletedElementIds: [...deletedIds],
		// A piece created for one range can be deleted by an earlier range processed later.
		createdElements: buckets.created.filter(
			(piece) => !deletedIds.has(piece.elementId),
		),
		changedElementIds: [...buckets.changed].filter(
			(id) => !deletedIds.has(id) && !createdIds.has(id),
		),
		removedBookmarkCount,
		mainStartAdjustment,
	};
}
