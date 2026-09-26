import {
	CANVAS_PRESETS,
	EDITOR_CANVAS_PRESET_NAMES,
	type CanvasPreset,
	type ToolResult,
} from "@opencut/claude-tools";
import type { EditorCore } from "@/core";
import { floatToFrameRate, frameRateToFloat } from "@/fps/utils";
import type { TProjectMetadata, TProjectSettings } from "@/project/types";
import { storageService } from "@/services/storage/service";
import { flushSave } from "@/claude/edit/ai-edit";
import { BridgeError, jsonResult } from "@/claude/types";
import { ticksToSeconds } from "@/claude/units";
import {
	assertNotExporting,
	isUserInteracting,
	requireReadyProject,
	round3,
	sleep,
	type HandlerArgs,
} from "@/claude/state/handler-kit";
import { editorPath, navigateTab, waitForProjectLoaded } from "./navigation";

// list_projects, create_project, open_project, switch_scene, save_project (map 9.5).

// ---------------------------------------------------------------------------
// Project list
// ---------------------------------------------------------------------------

/**
 * Saved projects, without side effects on the open editor: ProjectManager.loadAllProjects flips isLoading on
 * a first call, which would briefly refuse edits, so storage is read directly while a project is open.
 */
async function readSavedProjects(
	editor: EditorCore,
): Promise<TProjectMetadata[]> {
	if (editor.project.getIsInitialized())
		return editor.project.getSavedProjects();
	if (!editor.project.getActiveOrNull() && !editor.project.getIsLoading()) {
		await editor.project.loadAllProjects();
		return editor.project.getSavedProjects();
	}
	const stored = await storageService.loadAllProjectsMetadata();
	const active = editor.project.getActiveOrNull()?.metadata;
	// The open project's name may be newer in memory than on disk.
	return active
		? stored.map((metadata) => (metadata.id === active.id ? active : metadata))
		: stored;
}

function toIsoDate(value: Date | string | undefined): string | null {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function listProjects({
	ctx,
}: HandlerArgs<"list_projects">): Promise<ToolResult> {
	const { editor } = ctx;
	const openId = editor.project.getActiveOrNull()?.metadata.id ?? null;
	const projects = await readSavedProjects(editor);
	return jsonResult(
		[...projects]
			.sort(
				(a, b) =>
					new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
			)
			.map((project) => ({
				id: project.id,
				name: project.name,
				duration: ticksToSeconds({ ticks: project.duration }),
				updatedAt: toIsoDate(project.updatedAt),
				isOpen: project.id === openId,
			})),
	);
}

// ---------------------------------------------------------------------------
// Create / open
// ---------------------------------------------------------------------------

function presetSettings({
	preset,
	fps,
}: {
	preset?: CanvasPreset;
	fps?: number;
}): Partial<TProjectSettings> {
	const settings: Partial<TProjectSettings> = {};
	if (preset) {
		const canvasSize = { ...CANVAS_PRESETS[preset] };
		settings.canvasSize = canvasSize;
		// Like the Settings panel: sizes outside its preset list are stored as "custom".
		if (EDITOR_CANVAS_PRESET_NAMES.some((name) => name === preset)) {
			settings.canvasSizeMode = "preset";
		} else {
			settings.canvasSizeMode = "custom";
			settings.lastCustomCanvasSize = canvasSize;
		}
	}
	if (fps !== undefined) settings.fps = floatToFrameRate(fps);
	return settings;
}

function settingsApplied({
	editor,
	settings,
}: {
	editor: EditorCore;
	settings: Partial<TProjectSettings>;
}): boolean {
	const current = editor.project.getActiveOrNull()?.settings;
	if (!current) return false;
	const canvasOk =
		!settings.canvasSize ||
		(current.canvasSize.width === settings.canvasSize.width &&
			current.canvasSize.height === settings.canvasSize.height);
	const fpsOk =
		!settings.fps ||
		(current.fps.numerator === settings.fps.numerator &&
			current.fps.denominator === settings.fps.denominator);
	return canvasOk && fpsOk;
}

const SETTINGS_ATTEMPTS = 3;
const SETTINGS_CHECK_DELAY_MS = 300;

/**
 * Applies the initial format of a fresh project (no undo entry) and checks it held: a project save that read
 * the project before the change and lands after it writes the old settings back (ProjectManager
 * .saveCurrentProject), so re-apply until it sticks.
 */
async function applyInitialSettings({
	editor,
	settings,
	signal,
}: {
	editor: EditorCore;
	settings: Partial<TProjectSettings>;
	signal?: AbortSignal;
}): Promise<boolean> {
	for (let attempt = 0; attempt < SETTINGS_ATTEMPTS; attempt++) {
		await editor.project.updateSettings({ settings, pushHistory: false });
		await flushSave(editor);
		await sleep({ ms: SETTINGS_CHECK_DELAY_MS, signal });
		if (settingsApplied({ editor, settings })) return true;
	}
	return false;
}

/** Saves the open project and leaves it cleanly (thumbnail, history), like the editor header's exit. */
async function leaveOpenProject(editor: EditorCore): Promise<void> {
	if (!editor.project.getActiveOrNull()) return;
	await flushSave(editor);
	try {
		await editor.project.prepareExit();
	} catch (error) {
		console.error("[claude] prepareExit failed", error);
	}
	editor.project.closeProject();
}

function openedProjectSummary(editor: EditorCore) {
	const project = editor.project.getActiveOrNull();
	if (!project) return null;
	return {
		projectId: project.metadata.id,
		name: project.metadata.name,
		canvas: { ...project.settings.canvasSize },
		fps: round3(frameRateToFloat(project.settings.fps)),
		sceneCount: editor.scenes.getScenes().length,
		mediaCount: editor.media.getAssets().length,
	};
}

export async function createProject({
	input,
	ctx,
}: HandlerArgs<"create_project">): Promise<ToolResult> {
	const { editor } = ctx;
	assertNotExporting({
		editor,
		message: "An export is running: creating a project now would interrupt it.",
	});
	if (editor.project.getActiveOrNull()) {
		// createNewProject replaces the open project in memory: a pending autosave would be lost.
		await flushSave(editor);
	}
	const projectId = await editor.project.createNewProject({ name: input.name });

	// The editor page loads the project from storage on mount (EditorProvider), replacing what createNewProject
	// put in memory: wait for that load before touching the settings.
	const loaded = waitForProjectLoaded({
		editor,
		projectId,
		requireReload: true,
		signal: ctx.signal,
	});
	if (navigateTab({ path: editorPath({ projectId }) }) === "hard") {
		// The page reloads: nothing more can run here.
		return jsonResult({ projectId, name: input.name, reloading: true });
	}
	await loaded;

	const settings = presetSettings({ preset: input.preset, fps: input.fps });
	const held =
		Object.keys(settings).length === 0 ||
		(await applyInitialSettings({ editor, settings, signal: ctx.signal }));
	return jsonResult({
		...openedProjectSummary(editor),
		projectId,
		name: input.name,
		...(held
			? {}
			: {
					warnings: [
						"The canvas preset or fps did not stick. Apply them with apply_edit_plan project_settings.",
					],
				}),
	});
}

export async function openProject({
	input,
	ctx,
}: HandlerArgs<"open_project">): Promise<ToolResult> {
	const { editor } = ctx;
	const { projectId } = input;
	const saved = await readSavedProjects(editor);
	if (!saved.some((project) => project.id === projectId)) {
		// Never navigate to an unknown id: the editor would silently create an "Untitled Project".
		throw new BridgeError({
			code: "NOT_FOUND",
			message: `No saved project has the id "${projectId}". Use list_projects for the current ids.`,
			details: { projectId },
		});
	}

	const isOpenHere =
		editor.project.getActiveOrNull()?.metadata.id === projectId &&
		window.location.pathname === editorPath({ projectId });
	if (isOpenHere) {
		await waitForProjectLoaded({
			editor,
			projectId,
			requireReload: false,
			signal: ctx.signal,
		});
		return jsonResult({ ...openedProjectSummary(editor), alreadyOpen: true });
	}

	assertNotExporting({
		editor,
		message: "An export is running: switching projects now would interrupt it.",
	});
	await leaveOpenProject(editor);

	const loaded = waitForProjectLoaded({
		editor,
		projectId,
		requireReload: true,
		signal: ctx.signal,
	});
	if (navigateTab({ path: editorPath({ projectId }) }) === "hard") {
		return jsonResult({ projectId, reloading: true });
	}
	await loaded;
	return jsonResult(openedProjectSummary(editor));
}

// ---------------------------------------------------------------------------
// Scenes and saving
// ---------------------------------------------------------------------------

export async function switchScene({
	input,
	ctx,
}: HandlerArgs<"switch_scene">): Promise<ToolResult> {
	const { editor } = ctx;
	const { scene: activeScene } = requireReadyProject(editor);
	const scenes = editor.scenes.getScenes();
	const target = scenes.find((scene) => scene.id === input.sceneId);
	if (!target) {
		throw new BridgeError({
			code: "NOT_FOUND",
			message: `Scene "${input.sceneId}" does not exist in this project.`,
			details: {
				sceneId: input.sceneId,
				scenes: scenes.map((scene) => ({ id: scene.id, name: scene.name })),
			},
		});
	}
	if (target.id !== activeScene.id) {
		if (isUserInteracting(editor)) {
			throw new BridgeError({ code: "USER_INTERACTING" });
		}
		editor.playback.pause();
		// Element ids of the old scene mean nothing in the new one.
		editor.selection.clearSelection();
		await editor.scenes.switchToScene({ sceneId: target.id });
	}
	return jsonResult({ sceneId: target.id, name: target.name });
}

export async function saveProject({
	ctx,
}: HandlerArgs<"save_project">): Promise<ToolResult> {
	const { editor } = ctx;
	requireReadyProject(editor);
	const wasDirty = editor.save.getIsDirty();
	const saved = await flushSave(editor);
	return jsonResult({ saved, wasDirty });
}
