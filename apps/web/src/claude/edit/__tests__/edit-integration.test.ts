import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { parseToolInput, type ToolResult } from "@opencut/claude-tools";
import { EditorCore } from "@/core";
import {
	installFakeIndexedDB,
	installFakeOPFS,
} from "@/services/storage/__tests__/fake-browser-storage";
import { storageService } from "@/services/storage/service";
import { createStateTracker } from "@/claude/bridge/state-tracker";
import {
	isBridgeError,
	type BridgeError,
	type TabHandlerContext,
} from "@/claude/types";
import { handleApplyEditPlan } from "@/claude/edit/apply-plan";
import { editHandlers } from "@/claude/edit/edit-handlers";
import { handleRedo, handleUndo } from "@/claude/edit/history";
import { handleMarkRanges } from "@/claude/edit/mark-ranges";
import { getOrderedTracks } from "@/claude/units";
import type { SceneTracks } from "@/timeline/types";
import { MEDIA, t } from "./plan-fixtures";

// End to end against a REAL EditorCore (fake IndexedDB): the handlers run exactly as in the tab, through
// runAiEdit, the real CommandManager (history, reactor, ripple flag) and the SaveManager.

let restoreStorage: () => void = () => {};
let editor: EditorCore;
let ctx: TabHandlerContext;
const originalConsoleError = console.error;

function makeContext(): TabHandlerContext {
	const tracker = createStateTracker({
		getEditor: () => EditorCore.getInstance(),
		timers: { schedule: () => null, cancel: () => {} },
		now: () => Date.now(),
		onStateChanged: () => {},
		onProjectChanged: () => {},
	});
	tracker.bind();
	return {
		editor: EditorCore.getInstance(),
		method: "apply_edit_plan",
		reportProgress: () => {},
		emit: () => {},
		getStateVersion: () => tracker.getVersion(),
	};
}

type EditTool = "apply_edit_plan" | "mark_ranges" | "undo" | "redo";

function parsed<N extends EditTool>({
	tool,
	params,
}: {
	tool: N;
	params: unknown;
}) {
	const result = parseToolInput(tool, params);
	if (!result.ok) throw new Error(result.message);
	return result.data;
}

async function run({
	tool,
	params,
}: {
	tool: EditTool;
	params: unknown;
}): Promise<ToolResult> {
	const context = { ...ctx, method: tool };
	switch (tool) {
		case "apply_edit_plan":
			return handleApplyEditPlan({
				input: parsed({ tool, params }),
				ctx: context,
			});
		case "mark_ranges":
			return handleMarkRanges({
				input: parsed({ tool, params }),
				ctx: context,
			});
		case "undo":
			return handleUndo({ input: parsed({ tool, params }), ctx: context });
		case "redo":
			return handleRedo({ input: parsed({ tool, params }), ctx: context });
	}
}

async function call({
	tool,
	params,
}: {
	tool: EditTool;
	params: unknown;
}): Promise<Record<string, unknown>> {
	const json = (await run({ tool, params })).json;
	if (typeof json !== "object" || json === null)
		throw new Error("expected a JSON result");
	return { ...json };
}

async function expectCallError({
	tool,
	params,
	code,
}: {
	tool: "apply_edit_plan" | "mark_ranges";
	params: unknown;
	code: BridgeError["code"];
}): Promise<BridgeError> {
	try {
		await call({ tool, params });
	} catch (error) {
		if (!isBridgeError(error)) throw error;
		expect(error.code).toBe(code);
		return error;
	}
	throw new Error(`expected ${code}`);
}

function sceneTracks(): SceneTracks {
	return editor.scenes.getActiveScene().tracks;
}

function allIds(): string[] {
	return getOrderedTracks(sceneTracks()).flatMap((track) =>
		track.elements.map((element) => element.id),
	);
}

async function seedTimeline(): Promise<Record<string, string>> {
	const result = await call({
		tool: "apply_edit_plan",
		params: {
			label: "Base",
			ops: [
				{
					op: "insert_media",
					mediaId: "m-video",
					start: 0,
					track: "main",
					duration: 6,
					as: "a",
				},
				{
					op: "insert_media",
					mediaId: "m-video",
					start: 6,
					track: "main",
					trimStart: 10,
					duration: 4,
					as: "b",
				},
				{
					op: "add_text",
					text: "Titre",
					start: 0,
					duration: 3,
					track: "overlay",
					as: "title",
				},
				{
					op: "insert_media",
					mediaId: "m-audio",
					start: 0,
					track: "audio",
					duration: 10,
					as: "music",
				},
				{ op: "project_settings", canvas: "9:16" },
			],
		},
	});
	const refs = result.refs;
	if (typeof refs !== "object" || refs === null) throw new Error("no refs");
	return Object.fromEntries(
		Object.entries(refs).map(([key, value]) => [key, String(value)]),
	);
}

beforeAll(() => {
	const indexedDB = installFakeIndexedDB();
	const opfs = installFakeOPFS();
	restoreStorage = () => {
		opfs.restore();
		indexedDB.restore();
	};
});

afterAll(() => {
	restoreStorage();
});

beforeEach(async () => {
	console.error = mock(() => {});
	EditorCore.reset();
	editor = EditorCore.getInstance();
	// Like the editor route: create, then load (loading is what clears ProjectManager's isLoading flag).
	const projectId = await editor.project.createNewProject({
		name: "Montage test",
	});
	await editor.project.loadProject({ id: projectId });
	editor.media.setAssets({ assets: MEDIA });
	ctx = makeContext();
});

afterEach(async () => {
	// EditorCore.reset() only drops the reference: stop this instance's autosave, or its debounced save would
	// write into whatever fake IndexedDB the next test file installs.
	await editor.save.flush();
	editor.save.stop();
	console.error = originalConsoleError;
});

describe("apply_edit_plan on a real editor", () => {
	test("a whole plan is ONE undo step; the first clip's canvas rule is not undone, project_settings is", async () => {
		const settingsBefore = editor.project.getActive().settings;
		expect(settingsBefore.canvasSize).toEqual({ width: 1920, height: 1080 });
		const refs = await seedTimeline();
		expect(Object.keys(refs).sort()).toEqual(["a", "b", "music", "title"]);
		expect(editor.project.getActive().settings.canvasSize).toEqual({
			width: 1080,
			height: 1920,
		});
		expect(sceneTracks().main.elements.map((element) => element.id)).toEqual([
			refs.a,
			refs.b,
		]);

		editor.command.undo();
		expect(allIds()).toEqual([]);
		expect(editor.command.canUndo()).toBe(false);
		// The media's canvas (1920x1080 here) stays: InsertElementCommand's rule is not undoable either.
		expect(editor.project.getActive().settings.canvasSize).toEqual({
			width: 1920,
			height: 1080,
		});

		editor.command.redo();
		expect(sceneTracks().main.elements.map((element) => element.id)).toEqual([
			refs.a,
			refs.b,
		]);
		expect(editor.project.getActive().settings.canvasSize).toEqual({
			width: 1080,
			height: 1920,
		});
	});

	test("split + delete, then undo restores the exact previous tracks and redo the exact result (same ids)", async () => {
		const refs = await seedTimeline();
		const before = sceneTracks();
		const version = ctx.getStateVersion();
		const result = await call({
			tool: "apply_edit_plan",
			params: {
				expectStateVersion: version,
				ops: [
					{ op: "split", elementIds: [refs.a], at: 2, as: "tail" },
					{ op: "delete", elementIds: ["@tail"] },
				],
			},
		});
		expect(result.applied).toBe(true);
		expect(result.stateVersion).toBeGreaterThan(version);
		expect(result.changedElementIds).toEqual([refs.a]);
		const after = sceneTracks();
		expect(
			after.main.elements.find((element) => element.id === refs.a)?.duration,
		).toBe(t(2));

		editor.command.undo();
		expect(sceneTracks()).toBe(before);
		editor.command.redo();
		expect(sceneTracks()).toBe(after);
	});

	test("dry run: nothing changes, ids are placeholders, stateVersion stays", async () => {
		const refs = await seedTimeline();
		const before = sceneTracks();
		const version = ctx.getStateVersion();
		const result = await call({
			tool: "apply_edit_plan",
			params: {
				dryRun: true,
				ops: [
					{ op: "split", elementIds: [refs.b], at: 8, as: "piece" },
					{ op: "add_text", text: "x", start: 1, duration: 1, as: "t2" },
				],
			},
		});
		expect(result.dryRun).toBe(true);
		expect(result.applied).toBe(false);
		const dryRefs = result.refs;
		expect(
			typeof dryRefs === "object" &&
				dryRefs !== null &&
				Object.values(dryRefs).every((id) => String(id).startsWith("dry-run-")),
		).toBe(true);
		expect(sceneTracks()).toBe(before);
		expect(ctx.getStateVersion()).toBe(version);
		expect(result.stateVersion).toBe(version);
	});

	test("STALE_STATE when the timeline moved since expectStateVersion; nothing applied", async () => {
		const refs = await seedTimeline();
		const stale = ctx.getStateVersion();
		await call({
			tool: "apply_edit_plan",
			params: {
				ops: [
					{
						op: "update_element",
						elementId: refs.title,
						params: { opacity: 0.5 },
					},
				],
			},
		});
		const before = sceneTracks();
		await expectCallError({
			tool: "apply_edit_plan",
			params: {
				expectStateVersion: stale,
				ops: [{ op: "delete", elementIds: [refs.title] }],
			},
			code: "STALE_STATE",
		});
		expect(sceneTracks()).toBe(before);
	});

	test("the returned stateVersion is read before the save: a user edit made while it runs stays detectable", async () => {
		const refs = await seedTimeline();
		// A plain follow-up with the returned version passes (the save itself is not a change).
		const first = await call({
			tool: "apply_edit_plan",
			params: {
				ops: [{ op: "update_element", elementId: refs.title, params: { opacity: 0.5 } }],
			},
		});
		await call({
			tool: "apply_edit_plan",
			params: {
				expectStateVersion: first.stateVersion,
				ops: [{ op: "update_element", elementId: refs.title, params: { opacity: 0.6 } }],
			},
		});

		// The user trims a clip while the next plan's save is in flight.
		const originalFlush = editor.save.flush.bind(editor.save);
		let userEdited = false;
		editor.save.flush = async () => {
			if (!userEdited) {
				userEdited = true;
				editor.timeline.updateTracks({
					...sceneTracks(),
					overlay: sceneTracks().overlay.map((track) => ({ ...track })),
				});
			}
			return originalFlush();
		};
		let second: Record<string, unknown>;
		try {
			second = await call({
				tool: "apply_edit_plan",
				params: {
					ops: [{ op: "update_element", elementId: refs.title, params: { opacity: 0.7 } }],
				},
			});
		} finally {
			editor.save.flush = originalFlush;
		}
		expect(userEdited).toBe(true);
		await expectCallError({
			tool: "apply_edit_plan",
			params: {
				expectStateVersion: second.stateVersion,
				ops: [{ op: "delete", elementIds: [refs.title] }],
			},
			code: "STALE_STATE",
		});
	});

	test("a plan failing at op 2 applies nothing and adds no history entry", async () => {
		const refs = await seedTimeline();
		const before = sceneTracks();
		const error = await expectCallError({
			tool: "apply_edit_plan",
			params: {
				ops: [
					{ op: "delete", elementIds: [refs.title] },
					{ op: "move", elementId: refs.music, start: 1 },
					{ op: "move", elementId: refs.b, start: 1 },
				],
			},
			code: "INVALID_EDIT",
		});
		expect(error.message.startsWith("op 2 (move)")).toBe(true);
		expect(sceneTracks()).toBe(before);
		editor.command.undo();
		// The only entry left was the seed plan.
		expect(allIds()).toEqual([]);
	});

	test("a plan that changes nothing pushes no history entry", async () => {
		await seedTimeline();
		const result = await call({
			tool: "apply_edit_plan",
			params: { ops: [{ op: "toggle_track", trackId: "main", mute: false }] },
		});
		expect(result.applied).toBe(false);
		editor.command.undo();
		expect(allIds()).toEqual([]);
	});

	test("remove_range on every track moves bookmarks too, in the same undo step", async () => {
		const refs = await seedTimeline();
		await call({
			tool: "apply_edit_plan",
			params: {
				ops: [{ op: "bookmark", action: "add", time: 8, note: "fin" }],
			},
		});
		const bookmarksBefore = editor.scenes.getActiveScene().bookmarks;
		const result = await call({
			tool: "apply_edit_plan",
			params: { ops: [{ op: "remove_range", start: 1, end: 2 }] },
		});
		expect(result.durationSeconds).toBe(9);
		expect(editor.scenes.getActiveScene().bookmarks).toEqual([
			{ time: t(7), note: "fin" },
		]);
		expect(
			sceneTracks().main.elements.find((element) => element.id === refs.b)
				?.startTime,
		).toBe(t(5));
		editor.command.undo();
		expect(editor.scenes.getActiveScene().bookmarks).toBe(bookmarksBefore);
		expect(
			sceneTracks().main.elements.find((element) => element.id === refs.b)
				?.startTime,
		).toBe(t(6));
	});

	test("ripple stays pinned off during the edit and is restored afterwards", async () => {
		const refs = await seedTimeline();
		editor.command.isRippleEnabled = true;
		await call({
			tool: "apply_edit_plan",
			params: { ops: [{ op: "delete", elementIds: [refs.a] }] },
		});
		expect(editor.command.isRippleEnabled).toBe(true);
		// Ripple would have pulled b to 0; with ripple pinned off only the main-track rule applies (none here).
		expect(
			sceneTracks().main.elements.find((element) => element.id === refs.b)
				?.startTime,
		).toBe(t(6));
	});

	test("redo of an AI edit gives back the planned timeline even with ripple on (Cmd+Shift+Z and the redo tool)", async () => {
		const refs = await seedTimeline();
		editor.command.isRippleEnabled = true;
		// delete keeps its gap: a rippled redo would pull b to 0.
		await call({
			tool: "apply_edit_plan",
			params: { ops: [{ op: "delete", elementIds: [refs.a] }] },
		});
		const afterDelete = sceneTracks();
		editor.command.undo();
		editor.command.redo();
		expect(sceneTracks()).toBe(afterDelete);
		editor.command.undo();

		// remove_range already shifted later clips: a rippled redo would shift them a second time.
		await call({
			tool: "apply_edit_plan",
			params: { ops: [{ op: "remove_range", start: 1, end: 2 }] },
		});
		const afterCut = sceneTracks();
		await call({ tool: "undo", params: {} });
		await call({ tool: "redo", params: {} });
		expect(sceneTracks()).toBe(afterCut);
		expect(editor.command.isRippleEnabled).toBe(true);
	});

	test("the project is saved when the handler returns", async () => {
		const refs = await seedTimeline();
		expect(editor.save.getIsDirty()).toBe(false);
		const saved = await storageService.loadProject({
			id: editor.project.getActive().metadata.id,
		});
		const savedIds = saved?.project.scenes.flatMap((scene) =>
			getOrderedTracks(scene.tracks).flatMap((track) =>
				track.elements.map((element) => element.id),
			),
		);
		expect(savedIds).toContain(refs.title);
	});
});

describe("mark_ranges, undo and redo on a real editor", () => {
	test("the handler map registers the four editing tools", () => {
		expect(Object.keys(editHandlers).sort()).toEqual([
			"apply_edit_plan",
			"mark_ranges",
			"redo",
			"undo",
		]);
	});

	test("mark_ranges adds ranged bookmarks in one step; clearExisting removes ranged ones only", async () => {
		await seedTimeline();
		await call({
			tool: "apply_edit_plan",
			params: {
				ops: [{ op: "bookmark", action: "add", time: 9, note: "point" }],
			},
		});
		const first = await call({
			tool: "mark_ranges",
			params: {
				ranges: [
					{ start: 1, end: 2, note: "retake" },
					{ start: 4, end: 4.5, note: "silence", color: "#ff0000" },
				],
			},
		});
		expect(first).toMatchObject({ marked: 2, removed: 0 });
		expect(editor.scenes.getActiveScene().bookmarks).toHaveLength(3);

		const second = await call({
			tool: "mark_ranges",
			params: {
				clearExisting: true,
				ranges: [{ start: 6, end: 7, note: "new" }],
			},
		});
		expect(second).toMatchObject({
			marked: 1,
			removed: 2,
			bookmarks: [{ time: 6, duration: 1, note: "new" }],
		});
		expect(
			editor.scenes.getActiveScene().bookmarks.map((bookmark) => bookmark.note),
		).toEqual(["new", "point"]);

		editor.command.undo();
		expect(editor.scenes.getActiveScene().bookmarks).toHaveLength(3);
	});

	test("undo and redo report what they reverted and the timeline afterwards", async () => {
		await seedTimeline();
		await call({
			tool: "apply_edit_plan",
			params: {
				label: "Hook",
				ops: [
					{
						op: "add_text",
						text: "Hook",
						start: 0,
						duration: 2,
						track: "overlay",
					},
				],
			},
		});
		const undone = await call({ tool: "undo", params: { steps: 5 } });
		expect(undone).toMatchObject({
			undone: 2,
			steps: ['AI edit "Hook"', 'AI edit "Base"'],
			canUndo: false,
			canRedo: true,
		});
		expect(undone.note).toBe("Only 2 step(s) could be undone.");
		expect(undone.timeline).toMatchObject({
			elementCount: 0,
			durationSeconds: 0,
		});

		const redone = await call({ tool: "redo", params: {} });
		expect(redone).toMatchObject({
			redone: 1,
			steps: ['AI edit "Base"'],
			canUndo: true,
			canRedo: true,
		});
		expect(redone.timeline).toMatchObject({
			elementCount: 4,
			durationSeconds: 10,
		});
	});

	test("edits are refused while exporting", async () => {
		await seedTimeline();
		const original = editor.project.getExportState.bind(editor.project);
		editor.project.getExportState = () => ({
			...original(),
			isExporting: true,
		});
		try {
			await expectCallError({
				tool: "apply_edit_plan",
				params: { ops: [{ op: "bookmark", action: "add", time: 1 }] },
				code: "EXPORTING",
			});
			await expectCallError({
				tool: "mark_ranges",
				params: { ranges: [{ start: 1, end: 2 }] },
				code: "EXPORTING",
			});
		} finally {
			editor.project.getExportState = original;
		}
	});
});
