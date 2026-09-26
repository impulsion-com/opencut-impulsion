import type { EditorCore } from "@/core";
import type { Command, CommandResult } from "@/commands";
import type { EditorSelectionSnapshot } from "@/selection/editor-selection";
import { applyRippleAdjustments, computeRippleAdjustments } from "@/ripple";
import type { SceneTracks } from "@/timeline/types";

interface CommandHistoryEntry {
	command: Command;
	previousSelection: EditorSelectionSnapshot;
	selectionOverride?: EditorSelectionSnapshot;
	/**
	 * Whether ripple ran when the command was first executed. Redo replays that, not the current toggle, so a
	 * redo gives back the timeline the command produced (an AI edit, run with ripple pinned off, never ripples).
	 */
	rippled: boolean;
}

export class CommandManager {
	public isRippleEnabled = false;
	private history: CommandHistoryEntry[] = [];
	private redoStack: CommandHistoryEntry[] = [];
	private reactors: Array<() => void> = [];
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	/** Notified after execute, push, undo, redo, clear and discardRedo (history changes, not track changes). */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** The command the next undo() would revert, or null. */
	peekUndo(): Command | null {
		return this.history[this.history.length - 1]?.command ?? null;
	}

	/** The command the next redo() would re-apply, or null. */
	peekRedo(): Command | null {
		return this.redoStack[this.redoStack.length - 1]?.command ?? null;
	}

	/**
	 * Drops `command` from the top of the redo stack (e.g. an edit that was undone because it was refused), so
	 * redo cannot re-apply it. Returns false, and changes nothing, when it is not the next redo entry.
	 */
	discardRedo({ command }: { command: Command }): boolean {
		if (this.peekRedo() !== command) return false;
		this.redoStack.pop();
		this.notify();
		return true;
	}

	execute({ command }: { command: Command }): Command {
		const rippled = this.isRippleEnabled;
		const beforeTracks = rippled
			? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = command.execute();
		this.applyRipple({ beforeTracks });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();
		this.history.push({
			command,
			previousSelection,
			selectionOverride,
			rippled,
		});
		this.redoStack = [];
		this.notify();
		return command;
	}

	push({ command }: { command: Command }): void {
		this.history.push({
			command,
			previousSelection: this.getSelectionSnapshot(),
			rippled: false,
		});
		this.redoStack = [];
		this.notify();
	}

	registerReactor(reactor: () => void): void {
		this.reactors.push(reactor);
	}

	undo(): void {
		if (this.history.length === 0) return;
		const entry = this.history.pop();
		entry?.command.undo();
		if (entry) {
			// Only restore selection for commands that explicitly changed it.
			// Commands without selection intent leave selection untouched,
			// preserving any UI-driven selection changes (clicks, box select)
			// that happened between commands. Commands that remove editor-owned
			// selection targets must declare a selection override to clear stale refs.
			if (entry.selectionOverride !== undefined) {
				this.editor.selection.restoreSnapshot({
					snapshot: entry.previousSelection,
				});
			}
			this.redoStack.push(entry);
			this.notify();
		}
	}

	redo(): void {
		if (this.redoStack.length === 0) return;
		const entry = this.redoStack.pop();
		if (!entry) {
			return;
		}

		// Replays the ripple of the original execute, whatever the toggle says now.
		const beforeTracks = entry.rippled
			? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = entry.command.redo();
		this.applyRipple({ beforeTracks });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();

		this.history.push({
			command: entry.command,
			previousSelection,
			selectionOverride,
			rippled: entry.rippled,
		});
		this.notify();
	}

	canUndo(): boolean {
		return this.history.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	clear(): void {
		this.history = [];
		this.redoStack = [];
		this.notify();
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	private getSelectionSnapshot(): EditorSelectionSnapshot {
		return this.editor.selection.getSnapshot();
	}

	private applySelectionOverride(
		result: CommandResult | undefined,
	): EditorSelectionSnapshot | undefined {
		if (!result?.selection) {
			return undefined;
		}
		return this.editor.selection.applySelectionPatch({
			patch: result.selection,
		});
	}

	private runReactors(): void {
		for (const reactor of this.reactors) {
			reactor();
		}
	}

	/** Closes the gaps the command opened; a no-op when beforeTracks is null (ripple did not apply). */
	private applyRipple({
		beforeTracks,
	}: {
		beforeTracks: SceneTracks | null;
	}): void {
		if (!beforeTracks) {
			return;
		}

		const afterTracks = this.editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!afterTracks) {
			return;
		}
		const adjustments = computeRippleAdjustments({
			beforeTracks,
			afterTracks,
		});
		if (adjustments.length === 0) {
			return;
		}

		const tracksWithRipple = applyRippleAdjustments({
			tracks: afterTracks,
			adjustments,
		});
		this.editor.timeline.updateTracks(tracksWithRipple);
	}
}
