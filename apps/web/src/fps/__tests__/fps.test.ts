import { describe, expect, test } from "bun:test";
import {
	floatToFrameRate,
	frameRateToFloat,
	getHighestImportedVideoFps,
	getRaisedProjectFpsForImportedMedia,
	normalizeMeasuredFps,
} from "@/fps/utils";

describe("getHighestImportedVideoFps", () => {
	test("returns the highest valid video fps", () => {
		expect(
			getHighestImportedVideoFps({
				mediaAssets: [
					{ type: "audio" },
					{ type: "video", fps: 30 },
					{ type: "image", fps: 120 },
					{ type: "video", fps: 60 },
				],
			}),
		).toBe(60);
	});

	test("ignores missing and invalid fps values", () => {
		expect(
			getHighestImportedVideoFps({
				mediaAssets: [
					{ type: "video" },
					{ type: "video", fps: 0 },
					{ type: "video", fps: -10 },
					{ type: "audio", fps: 120 },
				],
			}),
		).toBeNull();
	});
});

describe("getRaisedProjectFpsForImportedMedia", () => {
	test("raises the project fps to match a higher-fps import", () => {
		expect(
			getRaisedProjectFpsForImportedMedia({
				currentFps: { numerator: 30, denominator: 1 },
				importedAssets: [{ type: "video", fps: 60 }],
			}),
		).toEqual({ numerator: 60, denominator: 1 });
	});

	test("does not lower the project fps for lower-fps imports", () => {
		expect(
			getRaisedProjectFpsForImportedMedia({
				currentFps: { numerator: 60, denominator: 1 },
				importedAssets: [{ type: "video", fps: 10 }],
			}),
		).toBeNull();
	});

	test("ignores non-video imports", () => {
		expect(
			getRaisedProjectFpsForImportedMedia({
				currentFps: { numerator: 30, denominator: 1 },
				importedAssets: [
					{ type: "image", fps: 60 },
					{ type: "audio", fps: 120 },
				],
			}),
		).toBeNull();
	});
});

describe("normalizeMeasuredFps", () => {
	test("keeps NTSC rates fractional instead of rounding them", () => {
		// mediabunny's averagePacketRate for a 29.97 CFR clip.
		const ntsc = normalizeMeasuredFps(29.97002997002997);
		expect(ntsc).toBe(30_000 / 1_001);
		expect(floatToFrameRate(ntsc ?? 0)).toEqual({
			numerator: 30_000,
			denominator: 1_001,
		});
		expect(normalizeMeasuredFps(23.976)).toBe(24_000 / 1_001);
		expect(normalizeMeasuredFps(59.94)).toBe(60_000 / 1_001);
	});

	test("snaps near-integer standard rates exactly", () => {
		expect(normalizeMeasuredFps(25.000000000001)).toBe(25);
		expect(normalizeMeasuredFps(60)).toBe(60);
	});

	test("rounds variable frame rate averages to the integer rate they came from", () => {
		// mediabunny averages the first 100 packets, so VFR clips land near 30.
		for (const measured of [30.03, 29.94, 30.2, 29.975, 29.51234]) {
			expect(normalizeMeasuredFps(measured)).toBe(30);
		}
		expect(normalizeMeasuredFps(25.04)).toBe(25);
		expect(normalizeMeasuredFps(59.8)).toBe(60);
		expect(normalizeMeasuredFps(12.49999)).toBe(12);
	});

	test("never returns a rate without whole ticks per frame", () => {
		// 120000 ticks per second: 29, 31 or 23 fps cannot snap frames.
		expect(normalizeMeasuredFps(29.4)).toBe(30);
		expect(normalizeMeasuredFps(31)).toBe(30);
		expect(normalizeMeasuredFps(23.2)).toBe(24);
		for (let tenths = 5; tenths <= 1_300; tenths++) {
			const fps = normalizeMeasuredFps(tenths / 10 + 0.0123);
			expect(fps).toBeDefined();
			const rate = floatToFrameRate(fps ?? 0);
			expect((120_000 * rate.denominator) % rate.numerator).toBe(0);
		}
	});

	test("rejects unusable values", () => {
		expect(normalizeMeasuredFps(Number.NaN)).toBeUndefined();
		expect(normalizeMeasuredFps(Number.POSITIVE_INFINITY)).toBeUndefined();
		expect(normalizeMeasuredFps(0)).toBeUndefined();
		expect(normalizeMeasuredFps(-30)).toBeUndefined();
		expect(normalizeMeasuredFps(0.0001)).toBeUndefined();
	});
});

describe("getRaisedProjectFpsForImportedMedia with NTSC media", () => {
	test("raises a 30 fps project to exact 59.94 for a 59.94 import", () => {
		expect(
			getRaisedProjectFpsForImportedMedia({
				currentFps: { numerator: 30, denominator: 1 },
				importedAssets: [
					{ type: "video", fps: normalizeMeasuredFps(59.94005994005994) },
				],
			}),
		).toEqual({ numerator: 60_000, denominator: 1_001 });
	});

	test("does not raise a 30 fps project for slightly-over-30 VFR imports", () => {
		for (const measured of [30.03, 30.2, 30.49]) {
			expect(
				getRaisedProjectFpsForImportedMedia({
					currentFps: { numerator: 30, denominator: 1 },
					importedAssets: [
						{ type: "video", fps: normalizeMeasuredFps(measured) },
					],
				}),
			).toBeNull();
		}
	});

	test("does not raise a 30 fps project for a 29.97 import", () => {
		expect(
			getRaisedProjectFpsForImportedMedia({
				currentFps: { numerator: 30, denominator: 1 },
				importedAssets: [{ type: "video", fps: normalizeMeasuredFps(29.97) }],
			}),
		).toBeNull();
	});
});
