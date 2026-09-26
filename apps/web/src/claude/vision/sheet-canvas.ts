import { BridgeError } from "@/claude/types";
import { labelFontSize, type GridLayout } from "./contact-sheet-layout";

// Canvas side of the grid images (browser only): the sheet itself, cell labels and JPEG encoding.

const SHEET_BACKGROUND = "#111111";
const LABEL_BACKGROUND = "rgba(0, 0, 0, 0.72)";
const LABEL_COLOR = "#ffffff";
export const SHEET_JPEG_QUALITY = 0.85;

export interface SheetCanvas {
	canvas: HTMLCanvasElement;
	context: CanvasRenderingContext2D;
}

export function createSheetCanvas({
	layout,
}: {
	layout: GridLayout;
}): SheetCanvas {
	const canvas = document.createElement("canvas");
	canvas.width = layout.width;
	canvas.height = layout.height;
	const context = canvas.getContext("2d");
	if (!context) {
		throw new BridgeError({
			code: "INTERNAL",
			message: "The browser refused a 2D canvas for the contact sheet.",
		});
	}
	context.fillStyle = SHEET_BACKGROUND;
	context.fillRect(0, 0, layout.width, layout.height);
	return { canvas, context };
}

/** Draws `source` letterboxed into the cell, keeping its aspect ratio. */
export function drawIntoCell({
	context,
	layout,
	index,
	source,
	sourceWidth,
	sourceHeight,
}: {
	context: CanvasRenderingContext2D;
	layout: GridLayout;
	index: number;
	source: CanvasImageSource;
	sourceWidth: number;
	sourceHeight: number;
}): void {
	const cell = layout.cells[index];
	if (!cell) return;
	const scale = Math.min(
		layout.cellWidth / Math.max(1, sourceWidth),
		layout.cellHeight / Math.max(1, sourceHeight),
	);
	const width = sourceWidth * scale;
	const height = sourceHeight * scale;
	context.drawImage(
		source,
		cell.x + (layout.cellWidth - width) / 2,
		cell.y + (layout.cellHeight - height) / 2,
		width,
		height,
	);
}

/** A small dark tag in the top-left corner of the cell. */
export function drawCellLabel({
	context,
	layout,
	index,
	text,
}: {
	context: CanvasRenderingContext2D;
	layout: GridLayout;
	index: number;
	text: string;
}): void {
	const cell = layout.cells[index];
	if (!cell) return;
	const fontSize = labelFontSize({ cellHeight: layout.cellHeight });
	const padding = Math.round(fontSize * 0.35);
	context.save();
	context.font = `600 ${fontSize}px ui-monospace, "SF Mono", Menlo, monospace`;
	context.textBaseline = "top";
	const textWidth = context.measureText(text).width;
	context.fillStyle = LABEL_BACKGROUND;
	context.fillRect(
		cell.x,
		cell.y,
		Math.ceil(textWidth + padding * 2),
		fontSize + padding * 2,
	);
	context.fillStyle = LABEL_COLOR;
	context.fillText(text, cell.x + padding, cell.y + padding);
	context.restore();
}

export function encodeJpeg({ canvas }: { canvas: HTMLCanvasElement }): string {
	return canvas.toDataURL("image/jpeg", SHEET_JPEG_QUALITY);
}
