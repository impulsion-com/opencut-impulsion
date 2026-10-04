import React from "react";
import { Composition } from "remotion";
import { Block, type BlockRenderProps } from "./Block";

const DEFAULTS: BlockRenderProps = {
	block: "headline",
	props: {},
	durationInFrames: 120,
	fps: 30,
	width: 1920,
	height: 1080,
};

// One composition for every block: the size, frame rate and length come from the input props, so a block is
// rendered at the canvas of the project it lands in.
export const Root: React.FC = () => (
	<Composition
		id="Block"
		component={Block}
		defaultProps={DEFAULTS}
		width={DEFAULTS.width}
		height={DEFAULTS.height}
		fps={DEFAULTS.fps}
		durationInFrames={DEFAULTS.durationInFrames}
		calculateMetadata={({ props }) => ({
			width: props.width,
			height: props.height,
			fps: props.fps,
			durationInFrames: props.durationInFrames,
		})}
	/>
);
