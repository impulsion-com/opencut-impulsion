import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline/types";
import { mediaTimeFromSeconds, type MediaTime } from "@/wasm";
import { isMotionAssetName } from "@/claude/motion/motion-client";
import { findMotionMisfits } from "@/claude/motion/motion-misfits";

const t = (seconds: number): MediaTime => mediaTimeFromSeconds({ seconds });

function clip({
	id,
	mediaId,
	duration,
	trimStart = 0,
	trimEnd = 0,
}: {
	id: string;
	mediaId: string;
	duration: number;
	trimStart?: number;
	trimEnd?: number;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId,
		startTime: t(0),
		duration: t(duration),
		trimStart: t(trimStart),
		trimEnd: t(trimEnd),
		params: {},
	};
}

function asset({ id, name, duration }: { id: string; name: string; duration: number }): MediaAsset {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return { id, name, type: "video", duration } as MediaAsset;
}

function tracksOf(elements: VideoElement[]): SceneTracks {
	const track = (id: string, list: VideoElement[]): VideoTrack => ({
		id,
		type: "video",
		name: id,
		elements: list,
		muted: false,
		hidden: false,
	});
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return {
		overlay: [track("overlay", elements)],
		main: track("main", []),
		audio: [],
	} as unknown as SceneTracks;
}

describe("motion blocks on the timeline", () => {
	test("a block is recognised by the name the sidecar gives its render", () => {
		expect(isMotionAssetName("bloc-headline-0a1b2c3d.webm")).toBe(true);
		expect(isMotionAssetName("bloc-pillSlot-ffffffff.webm")).toBe(true);
		expect(isMotionAssetName("rush.mp4")).toBe(false);
		expect(isMotionAssetName("bloc-headline.webm")).toBe(false);
		expect(isMotionAssetName(undefined)).toBe(false);
	});

	test("only stretched or trimmed blocks are reported, with their new length", () => {
		const assets = [
			asset({ id: "m-fit", name: "bloc-cta-00000001.webm", duration: 3 }),
			asset({ id: "m-long", name: "bloc-cta-00000002.webm", duration: 3 }),
			asset({ id: "m-trim", name: "bloc-cta-00000003.webm", duration: 4 }),
			asset({ id: "m-rush", name: "rush.mp4", duration: 10 }),
		];
		const misfits = findMotionMisfits({
			assets,
			tracks: tracksOf([
				clip({ id: "fit", mediaId: "m-fit", duration: 3.001 }),
				clip({ id: "long", mediaId: "m-long", duration: 5.5 }),
				clip({ id: "trim", mediaId: "m-trim", duration: 3, trimEnd: 1 }),
				// An ordinary clip trimmed by the user is none of the motion blocks' business.
				clip({ id: "rush", mediaId: "m-rush", duration: 4, trimEnd: 6 }),
			]),
		});
		expect(misfits.map(({ elementId, duration }) => ({ elementId, duration }))).toEqual([
			{ elementId: "long", duration: 5.5 },
			{ elementId: "trim", duration: 3 },
		]);
	});
});
