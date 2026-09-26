import { describe, expect, test } from "bun:test";
import type {
	AudioTrack,
	SceneTracks,
	TextTrack,
	VideoElement,
	VideoTrack,
} from "@/timeline/types";
import { mediaTimeFromSeconds, type MediaTime } from "@/wasm";
import {
	planImportPlacement,
	validateImportTarget,
	type ImportPlacementItem,
} from "@/claude/media/placement-plan";

const t = (seconds: number): MediaTime => mediaTimeFromSeconds({ seconds });
const NEW_TRACKS = { video: "new-video", audio: "new-audio" };

function clip({
	id,
	start,
	duration,
}: {
	id: string;
	start: number;
	duration: number;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: `m-${id}`,
		startTime: t(start),
		duration: t(duration),
		trimStart: t(0),
		trimEnd: t(0),
		params: {},
	};
}

function tracks({
	main = [],
	overlay = [],
	audio = [],
}: {
	main?: VideoElement[];
	overlay?: (VideoTrack | TextTrack)[];
	audio?: AudioTrack[];
} = {}): SceneTracks {
	return {
		overlay,
		main: {
			id: "main",
			type: "video",
			name: "Main Track",
			muted: false,
			hidden: false,
			elements: main,
		},
		audio,
	};
}

const video = (seconds: number): ImportPlacementItem => ({
	mediaType: "video",
	duration: t(seconds),
});
const image = (seconds = 5): ImportPlacementItem => ({
	mediaType: "image",
	duration: t(seconds),
});
const sound = (seconds: number): ImportPlacementItem => ({
	mediaType: "audio",
	duration: t(seconds),
});

function plan(
	args: Omit<Parameters<typeof planImportPlacement>[0], "newTrackIds">,
) {
	const result = planImportPlacement({ ...args, newTrackIds: NEW_TRACKS });
	if (!result.ok) throw new Error(`unexpected refusal: ${result.reason}`);
	return result.plan;
}

describe("planImportPlacement", () => {
	test('"main" on an empty timeline: first clip forced to 0 s, the next ones back to back', () => {
		const result = plan({
			tracks: tracks(),
			items: [video(3), video(2)],
			target: "main",
			start: t(10),
		});
		expect(result.steps.map((step) => step.placement)).toEqual([
			{ mode: "explicit", trackId: "main" },
			{ mode: "explicit", trackId: "main" },
		]);
		expect(result.steps.map((step) => step.expectedStart)).toEqual([
			t(0),
			t(3),
		]);
		// The first element is still given the requested start: InsertElementCommand applies the rule itself.
		expect(result.steps[0]?.startTime).toBe(t(10));
		expect(result.steps[1]?.startTime).toBe(t(3));
		expect(result.newTracks).toEqual([]);
	});

	test('"main" after existing clips appends at the given start', () => {
		const result = plan({
			tracks: tracks({ main: [clip({ id: "a", start: 0, duration: 4 })] }),
			items: [image()],
			target: "main",
			start: t(4),
		});
		expect(result.steps[0]?.expectedStart).toBe(t(4));
	});

	test('"main" refuses an overlap instead of stacking clips', () => {
		const result = planImportPlacement({
			tracks: tracks({ main: [clip({ id: "a", start: 0, duration: 4 })] }),
			items: [video(2)],
			target: "main",
			start: t(2),
			newTrackIds: NEW_TRACKS,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("overlap");
	});

	test('audio files with "main" fall back to an audio track, with a warning', () => {
		const result = plan({
			tracks: tracks(),
			items: [video(3), sound(10)],
			target: "main",
			start: t(0),
		});
		expect(result.steps[1]?.placement).toEqual({
			mode: "auto",
			trackType: "audio",
		});
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("audio track");
	});

	test('"overlay" creates one new track per kind and places every file on it', () => {
		const result = plan({
			tracks: tracks({ main: [clip({ id: "a", start: 0, duration: 10 })] }),
			items: [video(2), image(1), sound(4)],
			target: "overlay",
			start: t(1),
		});
		expect(result.newTracks).toEqual([
			{ kind: "video", trackId: "new-video" },
			{ kind: "audio", trackId: "new-audio" },
		]);
		expect(result.steps.map((step) => step.placement)).toEqual([
			{ mode: "explicit", trackId: "new-video" },
			{ mode: "explicit", trackId: "new-video" },
			{ mode: "explicit", trackId: "new-audio" },
		]);
		expect(result.steps.map((step) => step.expectedStart)).toEqual([
			t(1),
			t(3),
			t(4),
		]);
	});

	test('"auto" uses the editor\'s first available track', () => {
		const result = plan({
			tracks: tracks({ main: [clip({ id: "a", start: 0, duration: 10 })] }),
			items: [video(2)],
			target: "auto",
			start: t(0),
		});
		expect(result.steps[0]?.placement).toEqual({
			mode: "auto",
			trackType: "video",
		});
		expect(result.steps[0]?.expectedStart).toBe(t(0));
	});

	test("an explicit track id is used as is", () => {
		const overlay: VideoTrack = {
			id: "broll",
			type: "video",
			name: "B-roll",
			muted: false,
			hidden: false,
			elements: [],
		};
		const result = plan({
			tracks: tracks({ overlay: [overlay] }),
			items: [video(2), video(2)],
			target: { trackId: "broll" },
			start: t(5),
		});
		expect(result.steps.map((step) => step.placement)).toEqual([
			{ mode: "explicit", trackId: "broll" },
			{ mode: "explicit", trackId: "broll" },
		]);
		expect(result.steps.map((step) => step.expectedStart)).toEqual([
			t(5),
			t(7),
		]);
	});
});

describe("validateImportTarget", () => {
	const text: TextTrack = {
		id: "titles",
		type: "text",
		name: "Titles",
		hidden: false,
		elements: [],
	};

	test("keywords always pass", () => {
		expect(
			validateImportTarget({
				tracks: tracks(),
				target: "overlay",
				mediaTypes: ["audio"],
			}),
		).toBeNull();
	});

	test("unknown ids are NOT_FOUND, @refs and incompatible tracks INVALID_PARAMS", () => {
		expect(
			validateImportTarget({
				tracks: tracks(),
				target: { trackId: "nope" },
				mediaTypes: ["video"],
			})?.code,
		).toBe("NOT_FOUND");
		expect(
			validateImportTarget({
				tracks: tracks(),
				target: { trackId: "@titles" },
				mediaTypes: ["video"],
			})?.code,
		).toBe("INVALID_PARAMS");
		expect(
			validateImportTarget({
				tracks: tracks({ overlay: [text] }),
				target: { trackId: "titles" },
				mediaTypes: ["video", "image"],
			})?.code,
		).toBe("INVALID_PARAMS");
		expect(
			validateImportTarget({
				tracks: tracks(),
				target: { trackId: "main" },
				mediaTypes: ["image"],
			}),
		).toBeNull();
	});
});
