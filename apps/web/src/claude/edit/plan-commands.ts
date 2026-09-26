import {
	Command,
	type CommandResult,
	TracksSnapshotCommand,
	UpdateProjectSettingsCommand,
} from "@/commands";
import { EditorCore } from "@/core";
import type { TProjectSettings } from "@/project/types";
import { updateSceneInArray } from "@/timeline/scenes";
import type { Bookmark, SceneTracks } from "@/timeline/types";
import type { PlanSettingsStep, PlanState } from "./plan-state";
import type { ResolvedEditPlan } from "./resolve-plan";

// Turns a resolved plan into the sub-commands of ONE AiEditCommand (runAiEdit): project settings in plan order,
// then the whole-scene tracks snapshot, then the scene bookmarks. Every part restores what it replaced on undo,
// and redo re-applies the same snapshots, so the ids a plan reported stay valid after undo + redo.

/** Replaces the bookmarks of one scene (atomic, unlike a series of Toggle/Update bookmark commands). */
export class SceneBookmarksCommand extends Command {
	private readonly sceneId: string;
	private readonly before: Bookmark[];
	private readonly after: Bookmark[];

	constructor({
		sceneId,
		before,
		after,
	}: {
		sceneId: string;
		before: Bookmark[];
		after: Bookmark[];
	}) {
		super();
		this.sceneId = sceneId;
		this.before = before;
		this.after = after;
	}

	private write({ bookmarks }: { bookmarks: Bookmark[] }): void {
		const editor = EditorCore.getInstance();
		const scenes = editor.scenes.getScenes();
		if (!scenes.some((scene) => scene.id === this.sceneId)) return;
		editor.scenes.setScenes({
			scenes: updateSceneInArray({
				scenes,
				sceneId: this.sceneId,
				updates: { bookmarks },
			}),
		});
	}

	execute(): CommandResult | undefined {
		this.write({ bookmarks: this.after });
		return undefined;
	}

	undo(): void {
		this.write({ bookmarks: this.before });
	}
}

/**
 * One project settings step. Undoable steps behave like UpdateProjectSettingsCommand; the first-clip canvas rule is
 * re-applied on redo but, like InsertElementCommand's, never reverted.
 */
export class PlanSettingsCommand extends Command {
	private readonly patch: Partial<TProjectSettings>;
	private readonly undoable: boolean;
	private inner: UpdateProjectSettingsCommand | null = null;

	constructor({
		patch,
		undoable,
	}: {
		patch: Partial<TProjectSettings>;
		undoable: boolean;
	}) {
		super();
		this.patch = patch;
		this.undoable = undoable;
	}

	execute(): CommandResult | undefined {
		this.inner = new UpdateProjectSettingsCommand(this.patch);
		this.inner.execute();
		return undefined;
	}

	undo(): void {
		if (this.undoable) this.inner?.undo();
	}
}

export function buildPlanCommands({
	sceneId,
	before,
	resolved,
}: {
	sceneId: string;
	before: PlanState;
	resolved: ResolvedEditPlan;
}): Command[] {
	const commands: Command[] = resolved.settingsSteps.map(
		(step: PlanSettingsStep) =>
			new PlanSettingsCommand({ patch: step.patch, undoable: step.undoable }),
	);
	if (resolved.tracksChanged) {
		const after: SceneTracks = resolved.state.tracks;
		commands.push(new TracksSnapshotCommand({ before: before.tracks, after }));
	}
	if (resolved.bookmarksChanged) {
		commands.push(
			new SceneBookmarksCommand({
				sceneId,
				before: before.bookmarks,
				after: resolved.state.bookmarks,
			}),
		);
	}
	return commands;
}
