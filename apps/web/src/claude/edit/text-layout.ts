import { setCanvasLetterSpacing } from "@/text/layout";
import { buildTextFontString } from "@/text/primitives";
import type { TextFontStyle, TextFontWeight } from "@/text/primitives";
import { FONT_SIZE_SCALE_REFERENCE } from "@/text/typography";

// add_text maxWidth: greedy word wrapping like the editor's captions (subtitles/build-subtitle-text-element.ts),
// with the measurer injected so the planner stays pure (a canvas in the tab, a fake in tests).

/** Width in canvas px of one line of text drawn with a CSS font string. */
export type TextMeasurer = (input: {
	text: string;
	font: string;
	letterSpacingPx: number;
}) => number;

/** A 2D canvas measurer, or null outside the browser. */
export function createCanvasTextMeasurer(): TextMeasurer | null {
	if (typeof document === "undefined") return null;
	const ctx = document.createElement("canvas").getContext("2d");
	if (!ctx) return null;
	return ({ text, font, letterSpacingPx }) => {
		ctx.font = font;
		setCanvasLetterSpacing({ ctx, letterSpacingPx });
		return ctx.measureText(text).width;
	};
}

export function buildMeasureFont({
	fontFamily,
	fontSize,
	fontWeight,
	fontStyle,
	canvasHeight,
}: {
	fontFamily: string;
	fontSize: number;
	fontWeight: TextFontWeight;
	fontStyle: TextFontStyle;
	canvasHeight: number;
}): string {
	return buildTextFontString({
		fontFamily,
		fontWeight,
		fontStyle,
		scaledFontSize: fontSize * (canvasHeight / FONT_SIZE_SCALE_REFERENCE),
	});
}

/** Wraps each paragraph so no line is wider than maxWidthPx (a single word longer than that stays on its line). */
export function wrapText({
	text,
	maxWidthPx,
	measure,
}: {
	text: string;
	maxWidthPx: number;
	measure: (line: string) => number;
}): string {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((paragraph) => {
			const words = paragraph.trim().split(/\s+/).filter(Boolean);
			if (words.length === 0) return "";
			const lines: string[] = [];
			let current = words[0];
			for (const word of words.slice(1)) {
				const candidate = `${current} ${word}`;
				if (measure(candidate) <= maxWidthPx) {
					current = candidate;
				} else {
					lines.push(current);
					current = word;
				}
			}
			lines.push(current);
			return lines.join("\n");
		})
		.join("\n");
}
