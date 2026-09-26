import type {
	EditPlanResult,
	ToolInput,
	ToolResult,
} from "@opencut/claude-tools";
import type { EditorCore } from "@/core";
import { loadFonts } from "@/fonts/google-fonts";
import {
	BridgeError,
	jsonResult,
	type TabHandlerContext,
} from "@/claude/types";
import { ticksToSeconds } from "@/claude/units";
import { assertCanEdit, flushSave, runAiEdit } from "./ai-edit";
import { buildPlanCommands } from "./plan-commands";
import type { PlanState } from "./plan-state";
import {
	collectPlanFontFamilies,
	resolveEditPlan,
	type ResolvedEditPlan,
} from "./resolve-plan";
import { createCanvasTextMeasurer } from "./text-layout";

// apply_edit_plan: resolve the whole plan purely against the active scene, then apply it as ONE history entry
// (runAiEdit). A plan that fails at any op applies nothing; a dry run stops after resolving.

const FONT_LOAD_TIMEOUT_MS = 5_000;

/** Throws STALE_STATE when the timeline moved since the caller's get_editor_state. */
export function assertStateVersion({
	expected,
	ctx,
}: {
	expected: number | undefined;
	ctx: TabHandlerContext;
}): void {
	if (expected === undefined) return;
	const current = ctx.getStateVersion();
	if (current !== expected) {
		throw new BridgeError({
			code: "STALE_STATE",
			message: `The timeline changed since stateVersion ${expected} (now ${current}). Nothing was applied.`,
			details: { expectedStateVersion: expected, stateVersion: current },
		});
	}
}

export function assertNotAborted({ ctx }: { ctx: TabHandlerContext }): void {
	if (ctx.signal?.aborted) {
		throw new BridgeError({
			code: "TIMEOUT",
			message:
				"The call timed out before the edit was applied. Nothing was applied.",
		});
	}
}

/** Loads Google fonts the plan uses (browser only), giving up after a few seconds: text then renders in a fallback. */
export async function loadPlanFonts({
	families,
}: {
	families: string[];
}): Promise<boolean> {
	if (families.length === 0 || typeof document === "undefined") return true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), FONT_LOAD_TIMEOUT_MS);
	});
	try {
		return await Promise.race([
			loadFonts({ families }).then(() => true),
			timeout,
		]);
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

export function readPlanState(editor: EditorCore): {
	state: PlanState;
	sceneId: string;
} {
	const project = editor.project.getActiveOrNull();
	const scene = editor.scenes.getActiveSceneOrNull();
	if (!project || !scene || editor.project.getIsLoading()) {
		throw new BridgeError({ code: "NO_PROJECT" });
	}
	return {
		sceneId: scene.id,
		state: {
			tracks: scene.tracks,
			bookmarks: scene.bookmarks,
			settings: project.settings,
		},
	};
}

export function defaultPlanLabel({ opCount }: { opCount: number }): string {
	return `Montage IA (${opCount} opération${opCount > 1 ? "s" : ""})`;
}

function dryRunIdFactory(): () => string {
	let counter = 0;
	return () => {
		counter += 1;
		return `dry-run-${counter}`;
	};
}

function buildResult({
	resolved,
	dryRun,
	applied,
	opCount,
	label,
	stateVersion,
	sceneId,
	extraWarnings,
}: {
	resolved: ResolvedEditPlan;
	dryRun: boolean;
	applied: boolean;
	opCount: number;
	label: string;
	stateVersion: number;
	sceneId: string;
	extraWarnings: string[];
}): EditPlanResult & { sceneId: string } {
	return {
		dryRun,
		applied,
		opCount,
		label,
		created: resolved.created,
		refs: resolved.refs,
		changedElementIds: resolved.changedElementIds,
		deletedElementIds: resolved.deletedElementIds,
		warnings: [...resolved.warnings, ...extraWarnings],
		durationSeconds: ticksToSeconds({ ticks: resolved.durationTicks }),
		stateVersion,
		sceneId,
	};
}

export async function handleApplyEditPlan({
	input,
	ctx,
}: {
	input: ToolInput<"apply_edit_plan">;
	ctx: TabHandlerContext;
}): Promise<ToolResult> {
	const { editor } = ctx;
	const dryRun = input.dryRun === true;
	const label = input.label ?? defaultPlanLabel({ opCount: input.ops.length });
	assertStateVersion({ expected: input.expectStateVersion, ctx });
	if (dryRun) readPlanState(editor);
	else assertCanEdit(editor);

	const extraWarnings: string[] = [];
	const families = collectPlanFontFamilies({ ops: input.ops });
	if (!(await loadPlanFonts({ families }))) {
		extraWarnings.push(
			`font(s) ${families.join(", ")} did not load in time: text may render in a fallback font until they do.`,
		);
	}
	// Fonts load asynchronously: the timeline may have changed meanwhile.
	assertNotAborted({ ctx });
	assertStateVersion({ expected: input.expectStateVersion, ctx });
	const measureText = createCanvasTextMeasurer();

	if (dryRun) {
		const { state, sceneId } = readPlanState(editor);
		const resolved = resolveEditPlan({
			ops: input.ops,
			state,
			mediaAssets: editor.media.getAssets(),
			generateId: dryRunIdFactory(),
			measureText,
		});
		return jsonResult(
			buildResult({
				resolved,
				dryRun: true,
				applied: false,
				opCount: input.ops.length,
				label,
				stateVersion: ctx.getStateVersion(),
				sceneId,
				extraWarnings,
			}),
		);
	}

	// Filled by build (runAiEdit runs it synchronously); a holder object so TS does not narrow it to null.
	const planned: { plan: ResolvedEditPlan | null; sceneId: string } = {
		plan: null,
		sceneId: "",
	};
	const edit = runAiEdit({
		editor,
		label,
		build: (tracks) => {
			const current = readPlanState(editor);
			const state: PlanState = { ...current.state, tracks };
			const plan = resolveEditPlan({
				ops: input.ops,
				state,
				mediaAssets: editor.media.getAssets(),
				measureText,
			});
			planned.plan = plan;
			planned.sceneId = current.sceneId;
			return buildPlanCommands({
				sceneId: current.sceneId,
				before: state,
				resolved: plan,
			});
		},
		verify: () => {
			const plan = planned.plan;
			const scene = editor.scenes.getActiveSceneOrNull();
			if (!plan || !scene)
				return "the active scene disappeared during the edit.";
			if (plan.tracksChanged && scene.tracks !== plan.state.tracks) {
				return "the timeline did not end up in the planned state (internal mismatch).";
			}
			if (plan.bookmarksChanged && scene.bookmarks !== plan.state.bookmarks) {
				return "the bookmarks did not end up in the planned state (internal mismatch).";
			}
			return null;
		},
	});
	const plan = planned.plan;
	if (!plan) {
		throw new BridgeError({
			code: "INTERNAL",
			message: "The plan was not resolved.",
		});
	}

	const applied = edit.command !== null;
	// Read before the save: a user edit made while it runs must still fail the next expectStateVersion.
	const stateVersion = ctx.getStateVersion();
	if (applied && !(await flushSave(editor))) {
		extraWarnings.push(
			"the project took longer than usual to save; it will be saved automatically.",
		);
	}
	if (!applied) {
		extraWarnings.push(
			"the plan changed nothing (every op was already in the requested state).",
		);
	}
	return jsonResult(
		buildResult({
			resolved: plan,
			dryRun: false,
			applied,
			opCount: input.ops.length,
			label,
			stateVersion,
			sceneId: planned.sceneId,
			extraWarnings,
		}),
	);
}
