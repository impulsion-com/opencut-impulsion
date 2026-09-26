import {
	TOOL_DEFAULTS,
	type ToolInput,
	type ToolResult,
} from "@opencut/claude-tools";
import { BatchCommand, type Command, TracksSnapshotCommand } from "@/commands";
import type { EditorCore } from "@/core";
import { calculateTotalDuration } from "@/timeline";
import { jsonResult, type TabHandlerContext } from "@/claude/types";
import { getOrderedTracks, ticksToSeconds } from "@/claude/units";
import { AiEditCommand, assertCanEdit, flushSave } from "./ai-edit";

// undo / redo: exactly Cmd+Z / Cmd+Shift+Z on the shared history, one or more steps, with a short description of
// each step and of the timeline afterwards (so the model knows what it just reverted, possibly a manual edit).

/** Short English description of a history entry, for the model. */
export function describeHistoryStep({
	command,
}: {
	command: Command | null;
}): string {
	if (!command) return "nothing";
	if (command instanceof AiEditCommand) return `AI edit "${command.label}"`;
	if (command instanceof TracksSnapshotCommand)
		return "timeline drag or resize (manual)";
	if (command instanceof BatchCommand) return "grouped edit (manual)";
	const name = command.constructor.name.replace(/Command$/, "");
	if (name.length < 3) return "edit (manual)";
	const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
	return `${words} (manual)`;
}

export function summarizeTimeline(editor: EditorCore): {
	sceneId: string | null;
	durationSeconds: number;
	trackCount: number;
	elementCount: number;
	bookmarkCount: number;
} {
	const scene = editor.scenes.getActiveSceneOrNull();
	if (!scene) {
		return {
			sceneId: null,
			durationSeconds: 0,
			trackCount: 0,
			elementCount: 0,
			bookmarkCount: 0,
		};
	}
	const tracks = getOrderedTracks(scene.tracks);
	return {
		sceneId: scene.id,
		durationSeconds: ticksToSeconds({
			ticks: calculateTotalDuration({ tracks: scene.tracks }),
		}),
		trackCount: tracks.length,
		elementCount: tracks.reduce(
			(total, track) => total + track.elements.length,
			0,
		),
		bookmarkCount: scene.bookmarks.length,
	};
}

async function step({
	ctx,
	steps,
	direction,
}: {
	ctx: TabHandlerContext;
	steps: number;
	direction: "undo" | "redo";
}): Promise<{
	count: number;
	descriptions: string[];
	/** Read right after stepping, before the save: a user edit made while it runs must stay detectable. */
	after: {
		canUndo: boolean;
		canRedo: boolean;
		timeline: ReturnType<typeof summarizeTimeline>;
		stateVersion: number;
	};
}> {
	const { editor } = ctx;
	assertCanEdit(editor);
	const descriptions: string[] = [];
	for (let index = 0; index < steps; index++) {
		const canStep =
			direction === "undo"
				? editor.command.canUndo()
				: editor.command.canRedo();
		if (!canStep) break;
		const command =
			direction === "undo"
				? editor.command.peekUndo()
				: editor.command.peekRedo();
		descriptions.push(describeHistoryStep({ command }));
		if (direction === "undo") editor.command.undo();
		else editor.command.redo();
	}
	const after = {
		canUndo: editor.command.canUndo(),
		canRedo: editor.command.canRedo(),
		timeline: summarizeTimeline(editor),
		stateVersion: ctx.getStateVersion(),
	};
	if (descriptions.length > 0) await flushSave(editor);
	return { count: descriptions.length, descriptions, after };
}

export async function handleUndo({
	input,
	ctx,
}: {
	input: ToolInput<"undo">;
	ctx: TabHandlerContext;
}): Promise<ToolResult> {
	const requested = input.steps ?? TOOL_DEFAULTS.historySteps;
	const { count, descriptions, after } = await step({
		ctx,
		steps: requested,
		direction: "undo",
	});
	return jsonResult({
		undone: count,
		steps: descriptions,
		canUndo: after.canUndo,
		canRedo: after.canRedo,
		...(count < requested
			? {
					note:
						count === 0
							? "Nothing to undo."
							: `Only ${count} step(s) could be undone.`,
				}
			: {}),
		timeline: after.timeline,
		stateVersion: after.stateVersion,
	});
}

export async function handleRedo({
	input,
	ctx,
}: {
	input: ToolInput<"redo">;
	ctx: TabHandlerContext;
}): Promise<ToolResult> {
	const requested = input.steps ?? TOOL_DEFAULTS.historySteps;
	const { count, descriptions, after } = await step({
		ctx,
		steps: requested,
		direction: "redo",
	});
	return jsonResult({
		redone: count,
		steps: descriptions,
		canUndo: after.canUndo,
		canRedo: after.canRedo,
		...(count < requested
			? {
					note:
						count === 0
							? "Nothing to redo."
							: `Only ${count} step(s) could be redone.`,
				}
			: {}),
		timeline: after.timeline,
		stateVersion: after.stateVersion,
	});
}
