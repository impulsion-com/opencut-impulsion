import type { MediaAsset } from "@/media/types";
import type { SceneTracks } from "@/timeline";
import { mediaTimeToSeconds } from "@/wasm";
import { isMotionAssetName } from "./motion-client";

// Pure half of the auto-fit: which motion blocks no longer match their render.

/** Below this the timeline and the render agree (frame rounding). */
const TOLERANCE_SECONDS = 0.05;

export interface MotionMisfit {
	elementId: string;
	/** Seconds the element now lasts on the timeline. */
	duration: number;
	key: string;
}

/** Motion blocks whose length on the timeline no longer matches their render (stretched or trimmed by hand). */
export function findMotionMisfits({
	tracks,
	assets,
}: {
	tracks: SceneTracks;
	assets: readonly MediaAsset[];
}): MotionMisfit[] {
	const assetById = new Map(assets.map((asset) => [asset.id, asset]));
	const misfits: MotionMisfit[] = [];
	for (const track of [...tracks.overlay, tracks.main]) {
		for (const element of track.elements) {
			if (element.type !== "video") continue;
			const asset = assetById.get(element.mediaId);
			if (!asset || !isMotionAssetName(asset.name)) continue;
			if (typeof asset.duration !== "number") continue;
			const duration = mediaTimeToSeconds({ time: element.duration });
			const trimmed =
				mediaTimeToSeconds({ time: element.trimStart }) > TOLERANCE_SECONDS ||
				mediaTimeToSeconds({ time: element.trimEnd }) > TOLERANCE_SECONDS;
			if (!trimmed && Math.abs(duration - asset.duration) <= TOLERANCE_SECONDS) continue;
			const rounded = Math.round(duration * 100) / 100;
			misfits.push({
				elementId: element.id,
				duration: rounded,
				key: `${element.id}:${element.mediaId}:${rounded}`,
			});
		}
	}
	return misfits;
}
