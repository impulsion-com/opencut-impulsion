// Pure geometry and sampling for capture_contact_sheet and peek_media: one grid image, each cell a frame
// labelled with its time. Sized for Claude's vision budget (long edge and total pixels), never upscaled.

/** Claude resizes images above ~1568 px on the long edge or ~1.15 MP; staying under both keeps every pixel. */
export const SHEET_MAX_EDGE = 1568;
export const SHEET_MAX_PIXELS = 1_150_000;
export const SHEET_GAP = 4;
/** Below this a cell is unreadable; the sheet grows past the budget instead. */
export const SHEET_MIN_CELL_WIDTH = 96;
export const SHEET_MAX_COLUMNS = 8;

export interface GridCell {
	x: number;
	y: number;
}

export interface GridLayout {
	columns: number;
	rows: number;
	cellWidth: number;
	cellHeight: number;
	gap: number;
	width: number;
	height: number;
	/** Top-left corner of each cell, in grid order (row by row). */
	cells: GridCell[];
}

/** "About the square root of the frame count" (the contract's default), capped at SHEET_MAX_COLUMNS. */
export function defaultColumns({ count }: { count: number }): number {
	return Math.max(
		1,
		Math.min(SHEET_MAX_COLUMNS, count, Math.ceil(Math.sqrt(count))),
	);
}

export function computeGridLayout({
	count,
	columns,
	frameWidth,
	frameHeight,
	maxEdge = SHEET_MAX_EDGE,
	maxPixels = SHEET_MAX_PIXELS,
	gap = SHEET_GAP,
}: {
	count: number;
	/** Requested columns; clamped to 1..count. Default: defaultColumns. */
	columns?: number;
	/** Source frame size (canvas or media), for the cell aspect ratio and the no-upscale cap. */
	frameWidth: number;
	frameHeight: number;
	maxEdge?: number;
	maxPixels?: number;
	gap?: number;
}): GridLayout {
	const safeCount = Math.max(1, Math.floor(count));
	const cols = Math.max(
		1,
		Math.min(
			safeCount,
			Math.floor(columns ?? defaultColumns({ count: safeCount })),
		),
	);
	const rows = Math.ceil(safeCount / cols);
	const aspect =
		frameWidth > 0 && frameHeight > 0 ? frameWidth / frameHeight : 16 / 9;

	// Largest cell width that keeps both edges and the pixel budget.
	const byWidth = (maxEdge - (cols + 1) * gap) / cols;
	const byHeight = ((maxEdge - (rows + 1) * gap) / rows) * aspect;
	const byPixels = Math.sqrt((maxPixels * aspect) / (cols * rows));
	const noUpscale = frameWidth > 0 ? frameWidth : Number.POSITIVE_INFINITY;
	const heightOf = (width: number) => Math.max(1, Math.floor(width / aspect));
	const sheetPixels = (width: number) =>
		(cols * width + (cols + 1) * gap) *
		(rows * heightOf(width) + (rows + 1) * gap);
	let cellWidth = Math.max(
		SHEET_MIN_CELL_WIDTH,
		Math.floor(Math.min(byWidth, byHeight, byPixels, noUpscale)),
	);
	// byPixels ignores the gaps: shrink until they fit too.
	while (
		cellWidth > SHEET_MIN_CELL_WIDTH &&
		sheetPixels(cellWidth) > maxPixels
	) {
		cellWidth -= 1;
	}
	const cellHeight = heightOf(cellWidth);

	const cells: GridCell[] = [];
	for (let index = 0; index < safeCount; index++) {
		const column = index % cols;
		const row = Math.floor(index / cols);
		cells.push({
			x: gap + column * (cellWidth + gap),
			y: gap + row * (cellHeight + gap),
		});
	}
	return {
		columns: cols,
		rows,
		cellWidth,
		cellHeight,
		gap,
		width: cols * cellWidth + (cols + 1) * gap,
		height: rows * cellHeight + (rows + 1) * gap,
		cells,
	};
}

/** `count` times from start to end inclusive, evenly spaced (seconds). A single time is `start`. */
export function sampleEvenTimes({
	start,
	end,
	count,
}: {
	start: number;
	end: number;
	count: number;
}): number[] {
	const safeCount = Math.max(1, Math.floor(count));
	if (safeCount === 1 || end <= start) {
		return Array.from({ length: safeCount }, () => start);
	}
	const step = (end - start) / (safeCount - 1);
	return Array.from({ length: safeCount }, (_, index) =>
		index === safeCount - 1 ? end : start + step * index,
	);
}

/**
 * `count` times spread over a media file: the centres of equal slices, which skips the black first frame and
 * the end of file (seconds).
 */
export function sampleMediaTimes({
	duration,
	count,
}: {
	duration: number;
	count: number;
}): number[] {
	const safeCount = Math.max(1, Math.floor(count));
	if (!(duration > 0)) return [0];
	return Array.from(
		{ length: safeCount },
		(_, index) => (duration * (index + 0.5)) / safeCount,
	);
}

/** "0:12.40", "12:03.10", "1:02:03.40": minutes (and hours) plus seconds to the hundredth. */
export function formatTimeLabel({ seconds }: { seconds: number }): string {
	const centis = Math.max(0, Math.round(seconds * 100));
	const hours = Math.floor(centis / 360_000);
	const minutes = Math.floor((centis % 360_000) / 6_000);
	const secs = (centis % 6_000) / 100;
	const secText = secs.toFixed(2).padStart(5, "0");
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${secText}`
		: `${minutes}:${secText}`;
}

/** Label text for a cell: its 1-based position in the grid and its time. */
export function cellLabel({
	index,
	seconds,
}: {
	index: number;
	seconds: number;
}): string {
	return `${index + 1} · ${formatTimeLabel({ seconds })}`;
}

/** Font size for the cell labels, readable without hiding the frame. */
export function labelFontSize({ cellHeight }: { cellHeight: number }): number {
	return Math.max(11, Math.min(22, Math.round(cellHeight * 0.08)));
}
