import { describe, expect, test } from "bun:test";
import {
	cellLabel,
	computeGridLayout,
	defaultColumns,
	formatTimeLabel,
	labelFontSize,
	sampleEvenTimes,
	sampleMediaTimes,
	SHEET_MAX_EDGE,
	SHEET_MAX_PIXELS,
	SHEET_MAX_COLUMNS,
	SHEET_MIN_CELL_WIDTH,
} from "@/claude/vision/contact-sheet-layout";

describe("defaultColumns", () => {
	test("about the square root, capped", () => {
		expect(defaultColumns({ count: 1 })).toBe(1);
		expect(defaultColumns({ count: 2 })).toBe(2);
		expect(defaultColumns({ count: 4 })).toBe(2);
		expect(defaultColumns({ count: 9 })).toBe(3);
		expect(defaultColumns({ count: 10 })).toBe(4);
		expect(defaultColumns({ count: 36 })).toBe(6);
		expect(defaultColumns({ count: 100 })).toBe(SHEET_MAX_COLUMNS);
	});
});

describe("computeGridLayout", () => {
	function expectWithinBudget(layout: ReturnType<typeof computeGridLayout>) {
		expect(layout.width).toBeLessThanOrEqual(SHEET_MAX_EDGE);
		expect(layout.height).toBeLessThanOrEqual(SHEET_MAX_EDGE);
		expect(layout.width * layout.height).toBeLessThanOrEqual(SHEET_MAX_PIXELS);
	}

	test("9 landscape frames: 3x3, inside the vision budget, aspect kept", () => {
		const layout = computeGridLayout({
			count: 9,
			frameWidth: 1920,
			frameHeight: 1080,
		});
		expect(layout.columns).toBe(3);
		expect(layout.rows).toBe(3);
		expectWithinBudget(layout);
		expect(
			Math.abs(layout.cellWidth / layout.cellHeight - 16 / 9),
		).toBeLessThan(0.02);
		expect(layout.cells).toHaveLength(9);
	});

	test("9 portrait frames (9:16 reel) stay inside the budget", () => {
		const layout = computeGridLayout({
			count: 9,
			frameWidth: 1080,
			frameHeight: 1920,
		});
		expectWithinBudget(layout);
		expect(layout.cellHeight).toBeGreaterThan(layout.cellWidth);
	});

	test("cells tile row by row with the gap, and the sheet wraps them exactly", () => {
		const layout = computeGridLayout({
			count: 5,
			columns: 2,
			frameWidth: 1000,
			frameHeight: 1000,
			gap: 4,
		});
		expect(layout.columns).toBe(2);
		expect(layout.rows).toBe(3);
		const { cellWidth: w, cellHeight: h } = layout;
		expect(layout.cells).toEqual([
			{ x: 4, y: 4 },
			{ x: 8 + w, y: 4 },
			{ x: 4, y: 8 + h },
			{ x: 8 + w, y: 8 + h },
			{ x: 4, y: 12 + 2 * h },
		]);
		expect(layout.width).toBe(2 * w + 12);
		expect(layout.height).toBe(3 * h + 16);
	});

	test("requested columns are clamped to 1..count", () => {
		expect(
			computeGridLayout({
				count: 3,
				columns: 8,
				frameWidth: 16,
				frameHeight: 9,
			}).columns,
		).toBe(3);
		expect(
			computeGridLayout({
				count: 3,
				columns: 0,
				frameWidth: 16,
				frameHeight: 9,
			}).columns,
		).toBe(1);
	});

	test("never upscales a small source", () => {
		const layout = computeGridLayout({
			count: 1,
			frameWidth: 320,
			frameHeight: 180,
			gap: 0,
		});
		expect(layout.cellWidth).toBe(320);
		expect(layout.cellHeight).toBe(180);
		expect(layout.width).toBe(320);
	});

	test("a single big frame fits the long edge (peek_media image, 1280 px)", () => {
		const layout = computeGridLayout({
			count: 1,
			frameWidth: 4000,
			frameHeight: 3000,
			maxEdge: 1280,
			gap: 0,
		});
		expect(layout.width).toBeLessThanOrEqual(1280);
		expect(layout.width * layout.height).toBeLessThanOrEqual(SHEET_MAX_PIXELS);
	});

	test("36 frames keep a readable minimum cell width", () => {
		const layout = computeGridLayout({
			count: 36,
			frameWidth: 1920,
			frameHeight: 1080,
		});
		expect(layout.columns).toBe(6);
		expect(layout.cellWidth).toBeGreaterThanOrEqual(SHEET_MIN_CELL_WIDTH);
		expectWithinBudget(layout);
	});

	test("an unknown frame size falls back to 16:9", () => {
		const layout = computeGridLayout({
			count: 4,
			frameWidth: 0,
			frameHeight: 0,
		});
		expect(
			Math.abs(layout.cellWidth / layout.cellHeight - 16 / 9),
		).toBeLessThan(0.02);
	});
});

describe("sampling", () => {
	test("sampleEvenTimes includes both ends", () => {
		expect(sampleEvenTimes({ start: 0, end: 8, count: 5 })).toEqual([
			0, 2, 4, 6, 8,
		]);
		expect(sampleEvenTimes({ start: 2, end: 3, count: 2 })).toEqual([2, 3]);
		expect(sampleEvenTimes({ start: 5, end: 9, count: 1 })).toEqual([5]);
		expect(sampleEvenTimes({ start: 5, end: 5, count: 3 })).toEqual([5, 5, 5]);
	});

	test("sampleMediaTimes takes slice centres", () => {
		expect(sampleMediaTimes({ duration: 10, count: 5 })).toEqual([
			1, 3, 5, 7, 9,
		]);
		expect(sampleMediaTimes({ duration: 0, count: 9 })).toEqual([0]);
	});
});

describe("labels", () => {
	test("formatTimeLabel", () => {
		expect(formatTimeLabel({ seconds: 0 })).toBe("0:00.00");
		expect(formatTimeLabel({ seconds: 12.4 })).toBe("0:12.40");
		expect(formatTimeLabel({ seconds: 723.1 })).toBe("12:03.10");
		expect(formatTimeLabel({ seconds: 3723.4 })).toBe("1:02:03.40");
		expect(formatTimeLabel({ seconds: 59.999 })).toBe("1:00.00");
		expect(formatTimeLabel({ seconds: -1 })).toBe("0:00.00");
	});

	test("cellLabel is 1-based and has no em dash", () => {
		const label = cellLabel({ index: 2, seconds: 4.5 });
		expect(label).toBe("3 · 0:04.50");
		expect(label).not.toContain(String.fromCharCode(0x2014)); // no em dash
	});

	test("labelFontSize is bounded", () => {
		expect(labelFontSize({ cellHeight: 50 })).toBe(11);
		expect(labelFontSize({ cellHeight: 200 })).toBe(16);
		expect(labelFontSize({ cellHeight: 2000 })).toBe(22);
	});
});
