import { describe, expect, test } from "bun:test";
import type { FrameRate } from "opencut-wasm";
import {
	getElementKeyframes,
	resolveAnimationPathValueAtTime,
	upsertPathKeyframe,
} from "@/animation";
import type { ElementAnimations } from "@/animation/types";
import { NUMBER_CHANNEL_LAYOUT } from "@/params";
import {
	normalizeTimeRanges,
	removeTimeRanges,
	splitElementAt,
} from "@/ripple/remove-ranges";
import type {
	AudioTrack,
	Bookmark,
	SceneTracks,
	TextElement,
	TextTrack,
	TimelineElement,
	UploadAudioElement,
	VideoElement,
	VideoTrack,
} from "@/timeline/types";
import { type MediaTime, mediaTime, mediaTimeFromSeconds } from "@/wasm";

const FPS_30: FrameRate = { numerator: 30, denominator: 1 };
const FPS_2997: FrameRate = { numerator: 30_000, denominator: 1_001 };

function t(seconds: number): MediaTime {
	return mediaTimeFromSeconds({ seconds });
}

function video({
	id,
	start,
	duration,
	trimStart = 0,
	sourceDuration,
	rate,
	animations,
}: {
	id: string;
	start: number;
	duration: number;
	trimStart?: number;
	sourceDuration?: number;
	rate?: number;
	animations?: ElementAnimations;
}): VideoElement {
	const source = sourceDuration ?? trimStart + duration * (rate ?? 1);
	return {
		id,
		type: "video",
		name: id,
		mediaId: `media-${id}`,
		startTime: t(start),
		duration: t(duration),
		trimStart: t(trimStart),
		trimEnd: t(source - trimStart - duration * (rate ?? 1)),
		sourceDuration: t(source),
		params: {},
		...(rate !== undefined ? { retime: { rate } } : {}),
		...(animations ? { animations } : {}),
	};
}

function text({
	id,
	start,
	duration,
	animations,
}: {
	id: string;
	start: number;
	duration: number;
	animations?: ElementAnimations;
}): TextElement {
	return {
		id,
		type: "text",
		name: id,
		startTime: t(start),
		duration: t(duration),
		trimStart: t(0),
		trimEnd: t(0),
		params: { content: id },
		...(animations ? { animations } : {}),
	};
}

function audio({
	id,
	start,
	duration,
}: {
	id: string;
	start: number;
	duration: number;
}): UploadAudioElement {
	return {
		id,
		type: "audio",
		sourceType: "upload",
		mediaId: `media-${id}`,
		name: id,
		startTime: t(start),
		duration: t(duration),
		trimStart: t(0),
		trimEnd: t(0),
		sourceDuration: t(duration),
		params: {},
	};
}

function scene({
	main = [],
	texts = [],
	audios = [],
}: {
	main?: VideoElement[];
	texts?: TextElement[];
	audios?: UploadAudioElement[];
}): SceneTracks {
	const textTrack: TextTrack = {
		id: "text-track",
		name: "Text",
		type: "text",
		elements: texts,
		hidden: false,
	};
	const mainTrack: VideoTrack = {
		id: "main-track",
		name: "Main",
		type: "video",
		elements: main,
		muted: false,
		hidden: false,
	};
	const audioTrack: AudioTrack = {
		id: "audio-track",
		name: "Audio",
		type: "audio",
		elements: audios,
		muted: false,
	};
	return { overlay: [textTrack], main: mainTrack, audio: [audioTrack] };
}

function opacityKeys({
	keys,
}: {
	keys: [number, number][];
}): ElementAnimations | undefined {
	let animations: ElementAnimations | undefined;
	for (const [seconds, value] of keys) {
		animations = upsertPathKeyframe({
			animations,
			propertyPath: "opacity",
			time: t(seconds),
			value,
			channelLayout: NUMBER_CHANNEL_LAYOUT,
			coerceValue: ({ value: raw }) => raw,
		});
	}
	return animations;
}

function byId({
	tracks,
	id,
}: {
	tracks: SceneTracks;
	id: string;
}): TimelineElement {
	const found = [...tracks.overlay, tracks.main, ...tracks.audio]
		.flatMap((track): TimelineElement[] => track.elements)
		.find((element) => element.id === id);
	if (!found) throw new Error(`element ${id} missing`);
	return found;
}

function ids({ elements }: { elements: readonly TimelineElement[] }): string[] {
	return elements.map((element) => element.id);
}

function sequentialIds(): () => string {
	let counter = 0;
	return () => `piece-${++counter}`;
}

/** trimStart + duration * rate + trimEnd must stay equal to sourceDuration. */
function expectTrimInvariant({ element }: { element: TimelineElement }): void {
	if (element.type !== "video" && element.type !== "audio") return;
	const rate = element.retime?.rate ?? 1;
	expect(
		element.trimStart + Math.round(element.duration * rate) + element.trimEnd,
	).toBe(element.sourceDuration ?? -1);
}

describe("normalizeTimeRanges", () => {
	test("sorts, merges overlapping and touching ranges, drops empty ones", () => {
		const merged = normalizeTimeRanges({
			ranges: [
				{ start: t(5), end: t(6) },
				{ start: t(1), end: t(2) },
				{ start: t(1.5), end: t(3) },
				{ start: t(3), end: t(4) },
				{ start: t(7), end: t(7) },
			],
		});
		expect(merged).toEqual([
			{ start: t(1), end: t(4) },
			{ start: t(5), end: t(6) },
		]);
	});

	test("snaps to the frame grid at 30 and 29.97 fps", () => {
		expect(
			normalizeTimeRanges({
				ranges: [{ start: t(1.01), end: t(2.02) }],
				fps: FPS_30,
			}),
		).toEqual([{ start: t(1), end: t(2.0333333333333) }]);
		const [ntsc] = normalizeTimeRanges({
			ranges: [{ start: t(1), end: t(2) }],
			fps: FPS_2997,
		});
		// 29.97 fps: one frame = 4004 ticks. 1 s is 29.97 frames -> 30 frames; 2 s -> 60 frames.
		expect(ntsc).toEqual({
			start: mediaTime({ ticks: 30 * 4004 }),
			end: mediaTime({ ticks: 60 * 4004 }),
		});
	});
});

describe("splitElementAt", () => {
	test("keeps the source span invariant under retime", () => {
		const clip = video({
			id: "v",
			start: 0,
			duration: 3,
			rate: 2,
			sourceDuration: 10,
			trimStart: 1,
		});
		const { left, right } = splitElementAt({
			element: clip,
			splitTime: t(1),
			rightId: "r",
		});
		expect(left.id).toBe("v");
		expect(right.id).toBe("r");
		expect(left.duration).toBe(t(1));
		expect(right.startTime).toBe(t(1));
		expect(right.duration).toBe(t(2));
		// 1 s of timeline at 2x = 2 s of source.
		expect(right.trimStart).toBe(t(3));
		expectTrimInvariant({ element: left });
		expectTrimInvariant({ element: right });
	});
});

describe("removeTimeRanges", () => {
	test("single range across main, overlay and audio: cut, drop inside pieces, shift everything after", () => {
		const tracks = scene({
			main: [
				video({ id: "v1", start: 0, duration: 4, sourceDuration: 20 }),
				video({ id: "v2", start: 4, duration: 4, sourceDuration: 4 }),
			],
			texts: [
				text({ id: "t-in", start: 2.2, duration: 0.5 }),
				text({ id: "t-after", start: 5, duration: 1 }),
			],
			audios: [audio({ id: "a", start: 0, duration: 8 })],
		});
		const result = removeTimeRanges({
			tracks,
			ranges: [{ start: t(2), end: t(3) }],
			fps: FPS_30,
			generateId: sequentialIds(),
		});

		expect(result.removedDuration).toBe(t(1));
		expect(result.deletedElementIds).toEqual(["t-in"]);
		// v1 (0-4) spans the range: it is cut in two; the part after 3 s becomes a new element at 2 s.
		expect(ids({ elements: result.tracks.main.elements })).toEqual([
			"v1",
			"piece-1",
			"v2",
		]);
		const v1 = byId({ tracks: result.tracks, id: "v1" });
		const v1Right = byId({ tracks: result.tracks, id: "piece-1" });
		expect(v1.duration).toBe(t(2));
		expect(v1Right.startTime).toBe(t(2));
		expect(v1Right.duration).toBe(t(1));
		expect(v1Right.trimStart).toBe(t(3));
		expectTrimInvariant({ element: v1 });
		expectTrimInvariant({ element: v1Right });
		// Everything after the range moved left by 1 s on every track.
		expect(byId({ tracks: result.tracks, id: "v2" }).startTime).toBe(t(3));
		expect(byId({ tracks: result.tracks, id: "t-after" }).startTime).toBe(t(4));
		// The music spans the range too: cut like the video, so it stays in sync.
		expect(ids({ elements: result.tracks.audio[0].elements })).toEqual([
			"a",
			"piece-2",
		]);
		expect(byId({ tracks: result.tracks, id: "piece-2" }).trimStart).toBe(t(3));
		expect(
			result.createdElements.map((piece) => piece.sourceElementId),
		).toEqual(["v1", "a"]);
		expect(result.changedElementIds.sort()).toEqual([
			"a",
			"t-after",
			"v1",
			"v2",
		]);
	});

	test("elements crossing only one edge are trimmed and keep their id", () => {
		const tracks = scene({
			main: [
				video({ id: "left", start: 0, duration: 3, sourceDuration: 3 }),
				video({
					id: "right",
					start: 3,
					duration: 3,
					sourceDuration: 10,
					trimStart: 2,
				}),
			],
		});
		const result = removeTimeRanges({
			tracks,
			ranges: [{ start: t(2), end: t(4) }],
			fps: FPS_30,
		});
		const left = byId({ tracks: result.tracks, id: "left" });
		const right = byId({ tracks: result.tracks, id: "right" });
		expect(left.duration).toBe(t(2));
		expect(left.trimEnd).toBe(t(1));
		expect(right.startTime).toBe(t(2));
		expect(right.duration).toBe(t(2));
		expect(right.trimStart).toBe(t(3));
		expectTrimInvariant({ element: left });
		expectTrimInvariant({ element: right });
		expect(result.createdElements).toEqual([]);
	});

	test("a retimed clip is cut with the source span scaled by its rate", () => {
		const tracks = scene({
			main: [
				video({
					id: "fast",
					start: 0,
					duration: 4,
					rate: 2,
					sourceDuration: 8,
				}),
			],
		});
		const result = removeTimeRanges({
			tracks,
			ranges: [{ start: t(1), end: t(2) }],
			generateId: sequentialIds(),
		});
		const left = byId({ tracks: result.tracks, id: "fast" });
		const right = byId({ tracks: result.tracks, id: "piece-1" });
		expect(left.duration).toBe(t(1));
		expect(left.trimEnd).toBe(t(6));
		expect(right.startTime).toBe(t(1));
		expect(right.duration).toBe(t(2));
		expect(right.trimStart).toBe(t(4));
		expectTrimInvariant({ element: left });
		expectTrimInvariant({ element: right });
	});

	test("keyframes follow: each piece keeps its part of the animation with a boundary key", () => {
		const animations = opacityKeys({
			keys: [
				[0, 0],
				[4, 1],
			],
		});
		const tracks = scene({
			main: [
				video({
					id: "v",
					start: 0,
					duration: 4,
					sourceDuration: 4,
					animations,
				}),
			],
		});
		const result = removeTimeRanges({
			tracks,
			ranges: [{ start: t(1), end: t(3) }],
			generateId: sequentialIds(),
		});
		const left = byId({ tracks: result.tracks, id: "v" });
		const right = byId({ tracks: result.tracks, id: "piece-1" });
		const valueAt = ({
			element,
			seconds,
		}: {
			element: TimelineElement;
			seconds: number;
		}) =>
			resolveAnimationPathValueAtTime({
				animations: element.animations,
				propertyPath: "opacity",
				localTime: t(seconds),
				fallbackValue: -1,
			});
		expect(valueAt({ element: left, seconds: 0 })).toBeCloseTo(0);
		expect(valueAt({ element: left, seconds: 1 })).toBeCloseTo(0.25);
		// The right piece starts where the source resumed (3 s of 4): opacity 0.75, rebased to local time 0.
		expect(valueAt({ element: right, seconds: 0 })).toBeCloseTo(0.75);
		expect(valueAt({ element: right, seconds: 1 })).toBeCloseTo(1);
		expect(
			getElementKeyframes({ animations: right.animations }).map(
				(key) => key.time,
			),
		).toEqual([t(0), t(1)]);
	});

	test("a static element (no source, no keyframes) spanning the range is shortened, not cut", () => {
		const animated = text({
			id: "animated",
			start: 0,
			duration: 4,
			animations: opacityKeys({
				keys: [
					[0, 0],
					[1, 1],
				],
			}),
		});
		const tracks = scene({
			texts: [text({ id: "title", start: 0, duration: 4 })],
			main: [video({ id: "v", start: 0, duration: 4 })],
		});
		const shortened = removeTimeRanges({
			tracks,
			ranges: [{ start: t(1), end: t(2) }],
		});
		expect(ids({ elements: shortened.tracks.overlay[0].elements })).toEqual([
			"title",
		]);
		expect(byId({ tracks: shortened.tracks, id: "title" }).duration).toBe(t(3));

		const withKeys = removeTimeRanges({
			tracks: scene({
				texts: [animated],
				main: [video({ id: "v", start: 0, duration: 4 })],
			}),
			ranges: [{ start: t(1), end: t(2) }],
			generateId: sequentialIds(),
		});
		expect(withKeys.tracks.overlay[0].elements).toHaveLength(2);
	});

	test("several ranges, in any order, overlapping or adjacent, are merged and applied last to first", () => {
		const tracks = scene({
			main: [video({ id: "v", start: 0, duration: 10, sourceDuration: 10 })],
			texts: [text({ id: "end-card", start: 9, duration: 1 })],
		});
		const result = removeTimeRanges({
			tracks,
			ranges: [
				{ start: t(6), end: t(7) },
				{ start: t(1), end: t(2) },
				{ start: t(1.5), end: t(2.5) },
				{ start: t(2.5), end: t(3) },
			],
			fps: FPS_30,
			generateId: sequentialIds(),
		});
		expect(result.ranges).toEqual([
			{ start: t(1), end: t(3) },
			{ start: t(6), end: t(7) },
		]);
		expect(result.removedDuration).toBe(t(3));
		const pieces = result.tracks.main.elements;
		expect(
			pieces.map((piece) => [
				piece.startTime,
				piece.startTime + piece.duration,
			]),
		).toEqual([
			[t(0), t(1)],
			[t(1), t(4)],
			[t(4), t(7)],
		]);
		// Source continuity: 0-1, then 3-6, then 7-10.
		expect(pieces.map((piece) => piece.trimStart)).toEqual([t(0), t(3), t(7)]);
		pieces.forEach((piece) => expectTrimInvariant({ element: piece }));
		expect(byId({ tracks: result.tracks, id: "end-card" }).startTime).toBe(
			t(6),
		);
	});

	test("a range beyond the end of the timeline changes nothing", () => {
		const tracks = scene({ main: [video({ id: "v", start: 0, duration: 4 })] });
		const result = removeTimeRanges({
			tracks,
			ranges: [{ start: t(10), end: t(12) }],
		});
		expect(result.tracks.main.elements[0]).toBe(tracks.main.elements[0]);
		// The track objects themselves are kept, so an identity check sees no change.
		expect(result.tracks.main).toBe(tracks.main);
		expect(result.deletedElementIds).toEqual([]);
		expect(result.changedElementIds).toEqual([]);
	});

	test("a range running past the end trims the last clip", () => {
		const tracks = scene({
			main: [video({ id: "v", start: 0, duration: 4, sourceDuration: 4 })],
		});
		const result = removeTimeRanges({
			tracks,
			ranges: [{ start: t(3), end: t(9) }],
		});
		expect(byId({ tracks: result.tracks, id: "v" }).duration).toBe(t(3));
	});

	test("bookmarks: inside removed, after shifted, ranged ones crossing an edge shortened", () => {
		const bookmarks: Bookmark[] = [
			{ time: t(1), note: "before" },
			{ time: t(2.5), note: "inside" },
			{ time: t(5), note: "after" },
			{ time: t(1.5), duration: t(1), note: "crosses start" },
			{ time: t(2.5), duration: t(2), note: "crosses end" },
			{ time: t(0.5), duration: t(4), note: "spans" },
			{ time: t(2.2), duration: t(0.5), note: "within" },
		];
		const tracks = scene({
			main: [video({ id: "v", start: 0, duration: 10 })],
		});
		const result = removeTimeRanges({
			tracks,
			ranges: [{ start: t(2), end: t(3) }],
			bookmarks,
			generateId: sequentialIds(),
		});
		const summary = result.bookmarks.map((bookmark) => [
			bookmark.note,
			bookmark.time,
			bookmark.duration ?? 0,
		]);
		expect(summary).toEqual([
			["spans", t(0.5), t(3)],
			["before", t(1), 0],
			["crosses start", t(1.5), t(0.5)],
			["crosses end", t(2), t(1.5)],
			["after", t(4), 0],
		]);
		expect(result.removedBookmarkCount).toBe(2);
	});

	test("the main track keeps starting at 0 s when the cut leaves a gap before its first remaining clip", () => {
		const tracks = scene({
			main: [
				video({ id: "intro", start: 0, duration: 2 }),
				video({ id: "body", start: 3, duration: 4 }),
			],
			texts: [text({ id: "caption", start: 3, duration: 1 })],
		});
		const result = removeTimeRanges({
			tracks,
			ranges: [{ start: t(0), end: t(2.5) }],
		});
		expect(result.deletedElementIds).toEqual(["intro"]);
		expect(byId({ tracks: result.tracks, id: "body" }).startTime).toBe(t(0));
		expect(result.mainStartAdjustment).toBe(t(0.5));
		// Other tracks are shifted by the range only.
		expect(byId({ tracks: result.tracks, id: "caption" }).startTime).toBe(
			t(0.5),
		);
	});

	test("trackFilter: unselected tracks are neither cut nor shifted", () => {
		const tracks = scene({
			main: [video({ id: "v", start: 0, duration: 6, sourceDuration: 6 })],
			audios: [audio({ id: "music", start: 0, duration: 6 })],
		});
		const result = removeTimeRanges({
			tracks,
			ranges: [{ start: t(1), end: t(2) }],
			trackFilter: (track) => track.type !== "audio",
			generateId: sequentialIds(),
		});
		expect(result.tracks.audio[0]).toBe(tracks.audio[0]);
		expect(result.tracks.main.elements).toHaveLength(2);
	});

	test("ids created for one range and deleted by an earlier one are not reported", () => {
		const tracks = scene({
			main: [video({ id: "v", start: 0, duration: 10, sourceDuration: 10 })],
		});
		const result = removeTimeRanges({
			tracks,
			ranges: [
				{ start: t(2), end: t(3) },
				{ start: t(5), end: t(6) },
			],
			generateId: sequentialIds(),
		});
		const reported = new Set(
			result.createdElements.map((piece) => piece.elementId),
		);
		for (const element of result.tracks.main.elements) {
			if (element.id !== "v") expect(reported.has(element.id)).toBe(true);
		}
		expect(result.createdElements).toHaveLength(2);
	});
});
