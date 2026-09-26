import type { ToolInput, ToolResult } from "@opencut/claude-tools";
import type { FrameRate } from "opencut-wasm";
import type { Bookmark } from "@/timeline/types";
import { jsonResult, type TabHandlerContext } from "@/claude/types";
import {
	frameTicks,
	getProjectFps,
	secondsToTicks,
	ticksToSeconds,
} from "@/claude/units";
import { type MediaTime, mediaTime } from "@/wasm";
import { assertCanEdit, flushSave, runAiEdit } from "./ai-edit";
import { assertStateVersion } from "./apply-plan";
import { SceneBookmarksCommand } from "./plan-commands";

// mark_ranges: proposed cuts shown as ranged bookmarks (review markers), one undo step, nothing cut.
// Bookmarks are keyed by their start frame in the editor, so two marks never share a start: a mark on the frame of
// an existing bookmark replaces it, and two new marks starting on the same frame are merged.

export interface MarkRangeInput {
	start: number;
	end: number;
	note?: string;
	color?: string;
}

export interface MarkRangesPlan {
	bookmarks: Bookmark[];
	marked: Bookmark[];
	removed: number;
	warnings: string[];
}

/** Pure: the scene bookmarks after marking `ranges` (seconds), snapped to the frame grid of `fps`. */
export function computeMarkedBookmarks({
	bookmarks,
	ranges,
	clearExisting,
	fps,
}: {
	bookmarks: readonly Bookmark[];
	ranges: readonly MarkRangeInput[];
	clearExisting: boolean;
	fps: FrameRate;
}): MarkRangesPlan {
	const warnings: string[] = [];
	const frame = frameTicks({ fps });
	const kept = clearExisting
		? bookmarks.filter(
				(bookmark) => !bookmark.duration || bookmark.duration <= 0,
			)
		: [...bookmarks];
	let removed = bookmarks.length - kept.length;

	const marksByTime = new Map<number, Bookmark>();
	ranges.forEach((range, index) => {
		const time = secondsToTicks({ seconds: range.start, fps });
		const end = secondsToTicks({ seconds: range.end, fps });
		let duration: MediaTime = mediaTime({ ticks: end - time });
		if (duration < frame) {
			duration = frame;
			warnings.push(
				`range ${index} is shorter than one frame once snapped; it was widened to one frame.`,
			);
		}
		const mark: Bookmark = {
			time,
			duration,
			...(range.note !== undefined ? { note: range.note } : {}),
			...(range.color !== undefined ? { color: range.color } : {}),
		};
		const existing = marksByTime.get(time);
		if (existing) {
			warnings.push(
				`range ${index} starts on the same frame as an earlier range (${ticksToSeconds({ ticks: time })} s); they were merged into one marker.`,
			);
			const notes = [existing.note, mark.note].filter(
				(note): note is string => !!note,
			);
			marksByTime.set(time, {
				...existing,
				duration:
					existing.duration && existing.duration > duration
						? existing.duration
						: duration,
				...(notes.length > 0 ? { note: notes.join(" | ") } : {}),
			});
			return;
		}
		marksByTime.set(time, mark);
	});

	const marked = [...marksByTime.values()].sort((a, b) => a.time - b.time);
	const replaced = kept.filter((bookmark) => marksByTime.has(bookmark.time));
	if (replaced.length > 0) {
		removed += replaced.length;
		warnings.push(
			`${replaced.length} existing bookmark(s) at ${replaced.map((bookmark) => `${ticksToSeconds({ ticks: bookmark.time })} s`).join(", ")} were replaced by the new marker(s) starting on the same frame.`,
		);
	}
	const next = [
		...kept.filter((bookmark) => !marksByTime.has(bookmark.time)),
		...marked,
	].sort((a, b) => a.time - b.time);
	return { bookmarks: next, marked, removed, warnings };
}

export async function handleMarkRanges({
	input,
	ctx,
}: {
	input: ToolInput<"mark_ranges">;
	ctx: TabHandlerContext;
}): Promise<ToolResult> {
	const { editor } = ctx;
	assertStateVersion({ expected: input.expectStateVersion, ctx });
	assertCanEdit(editor);

	const holder: { plan: MarkRangesPlan | null } = { plan: null };
	const edit = runAiEdit({
		editor,
		label: `Marqueurs IA (${input.ranges.length})`,
		build: () => {
			const scene = editor.scenes.getActiveScene();
			const plan = computeMarkedBookmarks({
				bookmarks: scene.bookmarks,
				ranges: input.ranges,
				clearExisting: input.clearExisting === true,
				fps: getProjectFps(editor),
			});
			holder.plan = plan;
			return [
				new SceneBookmarksCommand({
					sceneId: scene.id,
					before: scene.bookmarks,
					after: plan.bookmarks,
				}),
			];
		},
	});
	const plan = holder.plan;
	const warnings = plan ? [...plan.warnings] : [];
	// Read before the save: a user edit made while it runs must still fail the next expectStateVersion.
	const stateVersion = ctx.getStateVersion();
	if (edit.command && !(await flushSave(editor))) {
		warnings.push(
			"the project took longer than usual to save; it will be saved automatically.",
		);
	}

	return jsonResult({
		marked: plan?.marked.length ?? 0,
		removed: plan?.removed ?? 0,
		bookmarks: (plan?.marked ?? []).map((bookmark) => ({
			time: ticksToSeconds({ ticks: bookmark.time }),
			duration: ticksToSeconds({ ticks: bookmark.duration ?? 0 }),
			note: bookmark.note ?? null,
		})),
		warnings,
		stateVersion,
	});
}
