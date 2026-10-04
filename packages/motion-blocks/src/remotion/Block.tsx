import React from "react";
import { AbsoluteFill, staticFile, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/fonts";
import type { MotionProps } from "../catalog";
import { Graphics } from "./vendor/Graphics";
import type { Graphic } from "./vendor/types";

for (const [file, weight] of [
	["Figtree-Medium.ttf", "500"],
	["Figtree-SemiBold.ttf", "600"],
	["Figtree-Bold.ttf", "700"],
	["Figtree-ExtraBold.ttf", "800"],
] as const) {
	loadFont({ family: "Figtree", url: staticFile(`fonts/${file}`), weight });
}

// A type alias, not an interface: Remotion wants composition props assignable to Record<string, unknown>.
export type BlockRenderProps = {
	block: string;
	props: MotionProps;
	durationInFrames: number;
	fps: number;
	width: number;
	height: number;
};

const SHOT_BLOCKS = new Set(["pillSlot", "scramble", "blurSlide"]);
const FIRST_REVEAL_MS = 450;

type Row = Record<string, string | number>;

function rows(value: unknown): Row[] {
	return Array.isArray(value) ? (value as Row[]) : [];
}

function splitList(value: unknown): string[] {
	return String(value ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "");
}

/** Reveal times spread from `from` to at most `until`, never more than 900 ms apart. */
function stagger(count: number, from: number, until: number): number[] {
	if (count <= 1) return [from];
	const step = Math.min(900, Math.max(120, (until - from) / (count - 1)));
	return Array.from({ length: count }, (_, index) => Math.round(from + index * step));
}

/** Turns the editable settings of a block into the timed graphic the vendored layer draws. */
export function toGraphic({
	block,
	props,
	durationMs,
}: {
	block: string;
	props: MotionProps;
	durationMs: number;
}): Graphic {
	const base = { startMs: 0, endMs: durationMs };
	if (SHOT_BLOCKS.has(block)) {
		const shotProps: Record<string, unknown> = { name: block, ...props };
		if (block === "pillSlot") {
			const pills = splitList(props.pills);
			shotProps.pills = pills.length ? pills : ["…"];
			// The pill changes on a beat (in frames at 30 fps); fit every word in the first 80 % of the shot.
			shotProps.beat = Math.max(
				10,
				Math.round(((durationMs / 1000) * 30 * 0.8 - 12) / Math.max(1, pills.length)),
			);
		}
		return { ...base, kind: "shot", x: 0.5, y: 0.5, scale: 1, props: shotProps };
	}

	const placement = String(props.placement ?? "left");
	const x = placement === "left" ? 0.035 : placement === "right" ? 0.965 : 0.5;
	const align = placement === "center" ? undefined : placement;
	const until = durationMs * 0.72;
	const out: Record<string, unknown> = { ...props, align };
	delete out.placement;
	delete out.y;
	delete out.scale;

	if (block === "program") {
		const items = rows(props.items);
		const starts = stagger(items.length, FIRST_REVEAL_MS, durationMs * 0.8);
		out.items = items.map((item, index) => {
			const chips = splitList(item.chips);
			const next = starts[index + 1] ?? durationMs * 0.92;
			const chipTimes = stagger(chips.length, starts[index] + 250, next - 150);
			return {
				title: item.title,
				ms: starts[index],
				chips: chips.map((label, chipIndex) => ({ label, ms: chipTimes[chipIndex] })),
			};
		});
	} else if (block === "prompt") {
		const typeMs = Math.round(Math.min(1400, durationMs * 0.25));
		out.typeMs = typeMs;
		const lines = rows(props.lines);
		const times = stagger(lines.length, 350 + typeMs + 350, Math.max(until, 350 + typeMs + 600));
		out.lines = lines.map((line, index) => ({ label: line.label, ms: times[index] }));
	} else if (block === "stack" || block === "notify") {
		const items = rows(props.items);
		const times = stagger(items.length, FIRST_REVEAL_MS, until);
		out.items = items.map((item, index) => ({ ...item, ms: times[index] }));
	}

	return {
		...base,
		kind: block as Graphic["kind"],
		x,
		y: Number(props.y ?? 0.45),
		scale: Number(props.scale ?? 1),
		props: out,
	};
}

export const Block: React.FC<BlockRenderProps> = ({ block, props, durationInFrames }) => {
	const { fps } = useVideoConfig();
	const graphic = toGraphic({ block, props, durationMs: (durationInFrames / fps) * 1000 });
	return (
		<AbsoluteFill>
			<Graphics p={{ graphics: [graphic] }} />
		</AbsoluteFill>
	);
};
