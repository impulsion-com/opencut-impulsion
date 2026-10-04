// One motion graphic, as the vendored Graphics layer expects it. Times are in ms from the start of the render.
export interface Graphic {
	kind: "headline" | "program" | "prompt" | "growth" | "stack" | "notify" | "cta" | "shot";
	startMs: number;
	endMs: number;
	/** Centre of the block, as a fraction of the canvas width / height. */
	x: number;
	y: number;
	scale: number;
	// biome-ignore lint/suspicious/noExplicitAny: each kind reads its own keys (see the header of each component)
	props: any;
}
