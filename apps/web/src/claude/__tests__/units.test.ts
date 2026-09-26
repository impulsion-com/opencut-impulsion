/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- test fakes stand in for EditorCore and friends */
import { describe, expect, test } from "bun:test";
import type { FrameRate } from "opencut-wasm";
import type { EditorCore } from "@/core";
import type { SceneTracks } from "@/timeline/types";
import {
	durationToTicks,
	findElementInTracks,
	frameTicks,
	getOrderedTracks,
	getProjectFps,
	resolveElement,
	secondsToTicks,
	spanToTicks,
	ticksToSeconds,
} from "@/claude/units";
import { BridgeError, isBridgeError } from "@/claude/types";
import { TICKS_PER_SECOND, type MediaTime } from "@/wasm";

/** MediaTime is a branded number; compare it as a plain number. */
const n = (value: MediaTime): number => value;

const FPS_30: FrameRate = { numerator: 30, denominator: 1 };
const FPS_25: FrameRate = { numerator: 25, denominator: 1 };
const FPS_NTSC: FrameRate = { numerator: 30_000, denominator: 1_001 };

function element({ id, type = "video" }: { id: string; type?: string }) {
	return {
		id,
		type,
		name: id,
		startTime: 0,
		duration: TICKS_PER_SECOND,
		trimStart: 0,
		trimEnd: 0,
		params: {},
	};
}

const TRACKS = {
	overlay: [
		{
			id: "t-text",
			type: "text",
			name: "Titres",
			hidden: false,
			elements: [element({ id: "hook", type: "text" })],
		},
		{
			id: "t-broll",
			type: "video",
			name: "B-roll",
			hidden: false,
			muted: false,
			elements: [element({ id: "broll" })],
		},
	],
	main: {
		id: "t-main",
		type: "video",
		name: "Main",
		hidden: false,
		muted: false,
		elements: [element({ id: "rush-1" }), element({ id: "rush-2" })],
	},
	audio: [
		{
			id: "t-music",
			type: "audio",
			name: "Musique",
			muted: false,
			elements: [element({ id: "music", type: "audio" })],
		},
	],
} as unknown as SceneTracks;

function editorWith({
	tracks,
	fps,
}: {
	tracks: SceneTracks | null;
	fps?: FrameRate;
}): EditorCore {
	return {
		scenes: {
			getActiveSceneOrNull: () =>
				tracks ? { id: "s1", name: "Scène principale", tracks } : null,
		},
		project: {
			getActiveOrNull: () => (fps ? { settings: { fps } } : null),
		},
	} as unknown as EditorCore;
}

function expectBridgeError({
	run,
	code,
}: {
	run: () => unknown;
	code: BridgeError["code"];
}): BridgeError {
	try {
		run();
	} catch (error) {
		expect(isBridgeError(error)).toBe(true);
		expect((error as BridgeError).code).toBe(code);
		return error as BridgeError;
	}
	throw new Error(`expected a BridgeError ${code}`);
}

describe("claude units: seconds and ticks", () => {
	test("TICKS_PER_SECOND is 120000", () => {
		expect(TICKS_PER_SECOND).toBe(120_000);
	});

	test("secondsToTicks snaps to the nearest frame of the project fps", () => {
		expect(n(secondsToTicks({ seconds: 1, fps: FPS_30 }))).toBe(120_000);
		expect(n(secondsToTicks({ seconds: 1.01, fps: FPS_30 }))).toBe(120_000);
		expect(n(secondsToTicks({ seconds: 1.02, fps: FPS_30 }))).toBe(124_000);
		expect(n(secondsToTicks({ seconds: 12.4, fps: FPS_25 }))).toBe(1_488_000);
		// 29.97 fps: one frame = 4004 ticks, 1 s rounds to 30 frames.
		expect(n(secondsToTicks({ seconds: 1, fps: FPS_NTSC }))).toBe(120_120);
		expect(n(secondsToTicks({ seconds: 0, fps: FPS_30 }))).toBe(0);
	});

	test("secondsToTicks without fps keeps tick precision", () => {
		expect(n(secondsToTicks({ seconds: 1.2345, fps: null }))).toBe(148_140);
		expect(
			Number.isInteger(secondsToTicks({ seconds: 0.1234567, fps: null })),
		).toBe(true);
	});

	test("non-finite seconds are INVALID_PARAMS", () => {
		expectBridgeError({
			run: () => secondsToTicks({ seconds: Number.NaN, fps: FPS_30 }),
			code: "INVALID_PARAMS",
		});
		expectBridgeError({
			run: () =>
				durationToTicks({ seconds: Number.POSITIVE_INFINITY, fps: FPS_30 }),
			code: "INVALID_PARAMS",
		});
	});

	test("ticksToSeconds rounds to 3 decimals", () => {
		expect(ticksToSeconds({ ticks: 120_000 })).toBe(1);
		expect(ticksToSeconds({ ticks: 120_120 })).toBe(1.001);
		expect(ticksToSeconds({ ticks: 148_140 })).toBe(1.235);
		expect(ticksToSeconds({ ticks: 4_004 })).toBe(0.033);
		expect(ticksToSeconds({ ticks: 0 })).toBe(0);
		expect(Object.is(ticksToSeconds({ ticks: -10 }), -0)).toBe(false);
	});

	test("seconds survive a round trip at frame precision", () => {
		for (const seconds of [0, 0.5, 2.8, 12.4, 42.5, 3599.9]) {
			expect(
				ticksToSeconds({ ticks: secondsToTicks({ seconds, fps: FPS_30 }) }),
			).toBeCloseTo(seconds, 1);
		}
	});

	test("frameTicks and durationToTicks never go below one frame", () => {
		expect(n(frameTicks({ fps: FPS_30 }))).toBe(4_000);
		expect(n(frameTicks({ fps: FPS_NTSC }))).toBe(4_004);
		expect(n(frameTicks({ fps: { numerator: 60, denominator: 1 } }))).toBe(
			2_000,
		);
		expect(n(durationToTicks({ seconds: 0.001, fps: FPS_30 }))).toBe(4_000);
		expect(n(durationToTicks({ seconds: 2.5, fps: FPS_30 }))).toBe(300_000);
	});

	test("spanToTicks derives the end from start + duration", () => {
		const half = spanToTicks({ start: 0.5, duration: 1, fps: FPS_30 });
		expect([n(half.startTime), n(half.duration), n(half.endTime)]).toEqual([
			60_000, 120_000, 180_000,
		]);
		const span = spanToTicks({ start: 1.01, duration: 0.99, fps: FPS_30 });
		expect(n(span.endTime)).toBe(span.startTime + span.duration);
		expect(span.startTime % 4_000).toBe(0);
		expect(span.duration % 4_000).toBe(0);
	});

	test("getProjectFps falls back to 30 fps without a project", () => {
		expect(getProjectFps(editorWith({ tracks: TRACKS, fps: FPS_25 }))).toEqual(
			FPS_25,
		);
		expect(getProjectFps(editorWith({ tracks: TRACKS }))).toEqual(FPS_30);
	});
});

describe("claude units: element lookup", () => {
	test("tracks are listed top to bottom: overlay, main, audio", () => {
		expect(getOrderedTracks(TRACKS).map((track) => track.id)).toEqual([
			"t-text",
			"t-broll",
			"t-main",
			"t-music",
		]);
	});

	test("findElementInTracks finds elements on every kind of track", () => {
		expect(
			findElementInTracks({ tracks: TRACKS, elementId: "hook" })?.track.id,
		).toBe("t-text");
		expect(
			findElementInTracks({ tracks: TRACKS, elementId: "rush-2" })?.track.id,
		).toBe("t-main");
		expect(
			findElementInTracks({ tracks: TRACKS, elementId: "music" })?.element.id,
		).toBe("music");
		expect(
			findElementInTracks({ tracks: TRACKS, elementId: "ghost" }),
		).toBeNull();
	});

	test("resolveElement reads the active scene and throws NOT_FOUND or NO_PROJECT", () => {
		const editor = editorWith({ tracks: TRACKS, fps: FPS_30 });
		const found = resolveElement({ editor, elementId: "broll" });
		expect(found.track.id).toBe("t-broll");
		expect(found.element.id).toBe("broll");

		const missing = expectBridgeError({
			run: () => resolveElement({ editor, elementId: "ghost" }),
			code: "NOT_FOUND",
		});
		expect(missing.message).toContain("ghost");
		expect(missing.details).toEqual({ elementId: "ghost", sceneId: "s1" });

		expectBridgeError({
			run: () =>
				resolveElement({
					editor: editorWith({ tracks: null }),
					elementId: "broll",
				}),
			code: "NO_PROJECT",
		});
	});
});
