import type { FrameRate } from "opencut-wasm";
import type { MediaAsset } from "@/media/types";

type MediaAssetFpsInput = Pick<MediaAsset, "type" | "fps">;

const STANDARD_FRAME_RATES: Array<{ value: number; rate: FrameRate }> = [
	{ value: 24_000 / 1_001, rate: { numerator: 24_000, denominator: 1_001 } },
	{ value: 24, rate: { numerator: 24, denominator: 1 } },
	{ value: 25, rate: { numerator: 25, denominator: 1 } },
	{ value: 30_000 / 1_001, rate: { numerator: 30_000, denominator: 1_001 } },
	{ value: 30, rate: { numerator: 30, denominator: 1 } },
	{ value: 48, rate: { numerator: 48, denominator: 1 } },
	{ value: 50, rate: { numerator: 50, denominator: 1 } },
	{ value: 60_000 / 1_001, rate: { numerator: 60_000, denominator: 1_001 } },
	{ value: 60, rate: { numerator: 60, denominator: 1 } },
	{ value: 120, rate: { numerator: 120, denominator: 1 } },
];

const STANDARD_FRAME_RATE_TOLERANCE = 0.01;

export function frameRateToFloat(rate: FrameRate): number {
	return rate.numerator / rate.denominator;
}

export function frameRatesEqual({
	a,
	b,
}: {
	a: FrameRate;
	b: FrameRate;
}): boolean {
	return a.numerator === b.numerator && a.denominator === b.denominator;
}

export function floatToFrameRate(fps: number): FrameRate {
	const standard = STANDARD_FRAME_RATES.find(
		(candidate) => Math.abs(fps - candidate.value) <= STANDARD_FRAME_RATE_TOLERANCE,
	);
	if (standard) return standard.rate;

	if (Number.isInteger(fps)) {
		return { numerator: fps, denominator: 1 };
	}

	const ARBITRARY_DENOMINATOR = 1_000_000;
	const scaledNumerator = Math.round(fps * ARBITRARY_DENOMINATOR);
	const divisor = gcd({
		left: scaledNumerator,
		right: ARBITRARY_DENOMINATOR,
	});
	return {
		numerator: scaledNumerator / divisor,
		denominator: ARBITRARY_DENOMINATOR / divisor,
	};
}

/**
 * A measured rate this close to a standard rate is that rate. Much tighter than
 * `STANDARD_FRAME_RATE_TOLERANCE`: a constant frame rate NTSC clip measures
 * 29.97003 almost exactly, while a variable frame rate 30 fps clip (phone
 * rushes, screen recordings) can average anywhere around 29.9..30.1 and must
 * stay 30, not become 29.97.
 */
const MEASURED_STANDARD_TOLERANCE = 0.002;

/** Ticks per second of `MediaTime` (rust/crates/time/src/media_time.rs). */
const MEDIA_TICKS_PER_SECOND = 120_000;

function hasWholeTicksPerFrame(fps: number): boolean {
	return MEDIA_TICKS_PER_SECOND % fps === 0;
}

/**
 * Nearest integer rate with a whole number of ticks per frame (the lower
 * neighbour wins a tie). The time crate's `ticks_per_frame` rejects other
 * rates, which disables frame snapping and blanks the frame timecode.
 */
function nearestTickableIntegerRate(fps: number): number | undefined {
	const rounded = Math.round(fps);
	if (rounded < 1) return undefined;
	for (let distance = 0; distance <= rounded; distance++) {
		const lower = rounded - distance;
		if (lower >= 1 && hasWholeTicksPerFrame(lower)) return lower;
		const upper = rounded + distance;
		if (hasWholeTicksPerFrame(upper)) return upper;
	}
	return undefined;
}

/**
 * Clean up a frame rate measured from packet timestamps (mediabunny's
 * `averagePacketRate`). A measurement within `MEASURED_STANDARD_TOLERANCE` of
 * a standard rate snaps to its exact value, so NTSC sources stay 29.97 /
 * 23.976 / 59.94 (30000/1001 once through `floatToFrameRate`). Anything else
 * (variable frame rate averages such as 30.03 or 29.94) is rounded to an
 * integer like the original `Math.round`, then moved to the nearest rate the
 * timeline can snap to, so importing such a clip never gives the project a
 * rate that breaks snapping or timecodes.
 */
export function normalizeMeasuredFps(fps: number): number | undefined {
	if (!Number.isFinite(fps) || fps <= 0) return undefined;

	const standard = STANDARD_FRAME_RATES.find(
		(candidate) => Math.abs(fps - candidate.value) <= MEASURED_STANDARD_TOLERANCE,
	);
	if (standard) return standard.value;

	return nearestTickableIntegerRate(fps);
}

function gcd({ left, right }: { left: number; right: number }): number {
	let a = Math.abs(left);
	let b = Math.abs(right);
	while (b !== 0) {
		const remainder = a % b;
		a = b;
		b = remainder;
	}
	return a || 1;
}

export function getHighestImportedVideoFps({
	mediaAssets,
}: {
	mediaAssets: MediaAssetFpsInput[];
}): number | null {
	let highestFps: number | null = null;

	for (const asset of mediaAssets) {
		const fps = asset.fps ?? Number.NaN;
		if (asset.type !== "video") continue;
		if (!Number.isFinite(fps) || fps <= 0) continue;

		highestFps = highestFps === null ? fps : Math.max(highestFps, fps);
	}

	return highestFps;
}

export function getRaisedProjectFpsForImportedMedia({
	currentFps,
	importedAssets,
}: {
	currentFps: FrameRate;
	importedAssets: MediaAssetFpsInput[];
}): FrameRate | null {
	const highestImportedVideoFps = getHighestImportedVideoFps({
		mediaAssets: importedAssets,
	});

	const currentFpsFloat = frameRateToFloat(currentFps);

	if (highestImportedVideoFps === null || highestImportedVideoFps <= currentFpsFloat) {
		return null;
	}

	return floatToFrameRate(highestImportedVideoFps);
}
