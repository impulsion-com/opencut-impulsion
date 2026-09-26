import { BatchCommand, type Command, type CommandResult } from "@/commands";
import type { EditorCore } from "@/core";
import type { SceneTracks } from "@/timeline/types";
import { getActiveExportJobId } from "@/claude/export/export-handlers";
import { isUserInteracting } from "@/claude/state/handler-kit";
import { BridgeError, isBridgeError } from "@/claude/types";

// The transaction wrapper every mutating tab tool uses (map 3.3): one AiEditCommand (a BatchCommand) per tool
// call, so one Cmd+Z; ripple pinned off; verified after execution and undone when the check fails; a batch that
// throws halfway is rolled back before the error propagates.

/**
 * A labelled BatchCommand that remembers how many sub-commands ran, so a batch that throws halfway can undo
 * exactly those. Undo and redo are BatchCommand's.
 */
export class AiEditCommand extends BatchCommand {
	readonly label: string;
	private readonly subCommands: readonly Command[];
	private executedCount = 0;

	constructor({ commands, label }: { commands: Command[]; label: string }) {
		super(commands);
		this.subCommands = [...commands];
		this.label = label;
	}

	getCommands(): readonly Command[] {
		return this.subCommands;
	}

	execute(): CommandResult | undefined {
		// Same loop as BatchCommand.execute, counting the sub-commands that returned.
		this.executedCount = 0;
		let latestSelectionResult: CommandResult | undefined;
		for (const command of this.subCommands) {
			const result = command.execute();
			this.executedCount += 1;
			if (result?.selection !== undefined) latestSelectionResult = result;
		}
		return latestSelectionResult;
	}

	/** Best-effort undo of the sub-commands that completed during a failed execute, newest first. */
	undoExecuted(): void {
		const executed = this.subCommands.slice(0, this.executedCount).reverse();
		this.executedCount = 0;
		for (const command of executed) {
			try {
				command.undo();
			} catch (error) {
				console.error("[claude] rollback: undo of a sub-command failed", error);
			}
		}
	}
}

/** Refuses edits the user would not expect right now. Handlers that mutate without runAiEdit call it too. */
export function assertCanEdit(editor: EditorCore): void {
	if (
		!editor.project.getActiveOrNull() ||
		editor.project.getIsLoading() ||
		editor.media.isLoadingMedia() ||
		!editor.scenes.getActiveSceneOrNull()
	) {
		throw new BridgeError({ code: "NO_PROJECT" });
	}
	if (isUserInteracting(editor)) {
		throw new BridgeError({ code: "USER_INTERACTING" });
	}
	if (editor.project.getExportState().isExporting) {
		const jobId = getActiveExportJobId();
		throw new BridgeError(
			jobId
				? {
						code: "EXPORTING",
						message: `Export job ${jobId} is rendering and edits wait for it: job_status or cancel_job with jobId "${jobId}".`,
						details: { jobId },
					}
				: { code: "EXPORTING" },
		);
	}
}

export interface RunAiEditOptions {
	editor: EditorCore;
	/** Short label of the change (apply_edit_plan's label), kept on the history entry. */
	label: string;
	/** Builds the commands from the tracks of the active scene before the edit. May throw a BridgeError. */
	build: (tracks: SceneTracks) => Command[];
	/**
	 * Runs after execution; return a problem message to undo the whole edit (INVALID_EDIT), e.g. an
	 * InsertElementCommand whose getTrackId() is still null.
	 */
	verify?: (commands: Command[]) => string | null;
}

export interface AiEditResult {
	label: string;
	/** The history entry, or null when build returned no command (nothing applied, nothing pushed). */
	command: AiEditCommand | null;
	/** The executed sub-commands, in order (read their getters for created ids). */
	commands: Command[];
	/** Active scene tracks before and after the edit. */
	before: SceneTracks;
	after: SceneTracks;
}

/**
 * Runs one AI edit as one undo step. Throws BridgeError: NO_PROJECT, USER_INTERACTING, EXPORTING (guards),
 * INVALID_EDIT (a command threw, or verify failed; nothing is kept), or whatever `build` throws.
 * Call `await flushSave(editor)` afterwards, before reporting success.
 */
export function runAiEdit({
	editor,
	label,
	build,
	verify,
}: RunAiEditOptions): AiEditResult {
	assertCanEdit(editor);
	const scene = editor.scenes.getActiveScene();
	const before = scene.tracks;
	const commands = build(before);
	if (commands.length === 0) {
		return { label, command: null, commands, before, after: before };
	}

	const batch = new AiEditCommand({ commands, label });
	const ripple = editor.command.isRippleEnabled;
	// Safe: the store-to-manager sync effect only re-runs when the store value changes (map 1.2).
	editor.command.isRippleEnabled = false;
	try {
		try {
			editor.command.execute({ command: batch });
		} catch (error) {
			// Thrown before CommandManager pushed the batch to history: undo what ran, then restore the tracks.
			rollbackHalfApplied({ editor, batch, before, sceneId: scene.id });
			if (isBridgeError(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new BridgeError({
				code: "INVALID_EDIT",
				message: `The editor refused the edit: ${message}. Nothing was applied.`,
				details: { cause: message },
			});
		}

		let problem: string | null = null;
		try {
			problem = verify?.(commands) ?? null;
		} catch (error) {
			problem = `verification failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (problem !== null) {
			undoPushedEdit({ editor, batch });
			throw new BridgeError({
				code: "INVALID_EDIT",
				message: `${problem} Nothing was applied.`,
			});
		}
	} finally {
		editor.command.isRippleEnabled = ripple;
	}

	return {
		label,
		command: batch,
		commands,
		before,
		after: editor.scenes.getActiveSceneOrNull()?.tracks ?? before,
	};
}

function rollbackHalfApplied({
	editor,
	batch,
	before,
	sceneId,
}: {
	editor: EditorCore;
	batch: AiEditCommand;
	before: SceneTracks;
	sceneId: string;
}): void {
	batch.undoExecuted();
	const current = editor.scenes.getActiveSceneOrNull();
	if (current && current.id === sceneId && current.tracks !== before) {
		// The only sanctioned direct updateTracks from bridge code: the batch never reached history.
		editor.timeline.updateTracks(before);
	}
}

/** Undoes the batch just pushed, and drops it from the redo stack so Cmd+Shift+Z cannot re-apply a refused edit. */
function undoPushedEdit({
	editor,
	batch,
}: {
	editor: EditorCore;
	batch: AiEditCommand;
}): void {
	editor.command.undo();
	// Only pops the redo entry when it is this batch (a no-op otherwise).
	editor.command.discardRedo({ command: batch });
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

const FLUSH_POLL_MS = 50;
export const FLUSH_SAVE_TIMEOUT_MS = 5_000;

/**
 * Persists the open project now (SaveManager.flush), waiting for a save already in flight. Resolves true once
 * nothing is pending, false when no project is open or the save did not settle within FLUSH_SAVE_TIMEOUT_MS.
 */
export function flushSave(editor: EditorCore): Promise<boolean> {
	return flushSaveWithin({ editor, timeoutMs: FLUSH_SAVE_TIMEOUT_MS });
}

/** flushSave with an explicit time limit. */
export async function flushSaveWithin({
	editor,
	timeoutMs,
}: {
	editor: EditorCore;
	timeoutMs: number;
}): Promise<boolean> {
	if (!editor.project.getActiveOrNull() || editor.project.getIsLoading())
		return false;
	const deadline = Date.now() + timeoutMs;
	await editor.save.flush();
	// flush() returns at once while another save runs; poll until that one and ours have landed.
	while (editor.save.getIsDirty()) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, FLUSH_POLL_MS));
		await editor.save.flush();
	}
	return true;
}
