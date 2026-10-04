import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import {
	clampMotionDuration,
	getMotionBlock,
	normalizeMotionProps,
	type MotionProps,
} from "./catalog";

// Node side of the motion blocks: bundles the Remotion project once per process, then renders one block to a
// WebM with an alpha channel (VP9, yuva420p) that the editor composites over the timeline.

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(here, "remotion", "index.ts");
const PUBLIC_DIR = path.join(here, "..", "public");

let bundlePromise: Promise<string> | null = null;

function getBundle(): Promise<string> {
	if (!bundlePromise) {
		bundlePromise = bundle({ entryPoint: ENTRY, publicDir: PUBLIC_DIR }).catch(
			(error: unknown) => {
				bundlePromise = null;
				throw error;
			},
		);
	}
	return bundlePromise;
}

/** Builds the Remotion bundle ahead of the first render (about 10 s once per process). Never throws. */
export function prewarmMotionBundle(): Promise<boolean> {
	return getBundle().then(
		() => true,
		() => false,
	);
}

export interface RenderMotionBlockInput {
	block: string;
	props: unknown;
	/** Seconds. Clamped to the block's minimum and to 60 s. */
	duration: number;
	fps: number;
	width: number;
	height: number;
	/** Absolute path of the .webm to write. */
	outputPath: string;
	onProgress?: (progress: number) => void;
	signal?: AbortSignal;
}

export interface RenderMotionBlockResult {
	outputPath: string;
	props: MotionProps;
	duration: number;
	durationInFrames: number;
}

function resolve(input: Pick<RenderMotionBlockInput, "block" | "props" | "duration" | "fps" | "width" | "height">) {
	const block = getMotionBlock(input.block);
	if (!block) throw new Error(`Unknown motion block "${input.block}"`);
	const props = normalizeMotionProps(block, input.props);
	const duration = clampMotionDuration(block, input.duration);
	// Remotion wants integer frames and even dimensions.
	const fps = Math.max(1, Math.round(input.fps));
	const durationInFrames = Math.max(2, Math.round(duration * fps));
	const inputProps = {
		block: block.id,
		props,
		durationInFrames,
		fps,
		width: Math.round(input.width / 2) * 2,
		height: Math.round(input.height / 2) * 2,
	};
	return { props, durationInFrames, inputProps, fps };
}

export async function renderMotionBlock(
	input: RenderMotionBlockInput,
): Promise<RenderMotionBlockResult> {
	const { props, durationInFrames, inputProps, fps } = resolve(input);
	const serveUrl = await getBundle();
	const composition = await selectComposition({ serveUrl, id: "Block", inputProps });
	const controller = input.signal ? makeCancel(input.signal) : null;
	await renderMedia({
		composition,
		serveUrl,
		inputProps,
		codec: "vp9",
		pixelFormat: "yuva420p",
		imageFormat: "png",
		crf: 20,
		// No audio track: a block is picture only, and a silent track would show up as a waveform in the editor.
		muted: true,
		// libvpx-vp9 at its default "good" deadline takes about 10 times longer than drawing the frames. Realtime
		// encoding makes a block re-render in a couple of seconds, at a quality that holds for flat graphics.
		ffmpegOverride: ({ args }) => [
			...args.slice(0, -1),
			"-deadline",
			"realtime",
			"-cpu-used",
			"8",
			"-row-mt",
			"1",
			...args.slice(-1),
		],
		outputLocation: input.outputPath,
		overwrite: true,
		logLevel: "error",
		onProgress: ({ progress }) => input.onProgress?.(progress),
		...(controller ? { cancelSignal: controller } : {}),
	});
	return {
		outputPath: input.outputPath,
		props,
		duration: durationInFrames / fps,
		durationInFrames,
	};
}

/** One PNG frame of a block, for previews and tests. */
export async function renderMotionStill(
	input: Omit<RenderMotionBlockInput, "onProgress" | "signal"> & { atSeconds: number },
): Promise<void> {
	const { durationInFrames, inputProps, fps } = resolve(input);
	const serveUrl = await getBundle();
	const composition = await selectComposition({ serveUrl, id: "Block", inputProps });
	await renderStill({
		composition,
		serveUrl,
		inputProps,
		output: input.outputPath,
		imageFormat: "png",
		frame: Math.min(durationInFrames - 1, Math.max(0, Math.round(input.atSeconds * fps))),
		logLevel: "error",
	});
}

function makeCancel(signal: AbortSignal) {
	// Remotion's cancel signal is a callback registrar, not an AbortSignal.
	return (callback: () => void) => {
		if (signal.aborted) callback();
		else signal.addEventListener("abort", callback, { once: true });
	};
}
