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
import { parseToolInput } from "@opencut/claude-tools";
import { EditorCore } from "@/core";
import {
	installFakeIndexedDB,
	installFakeOPFS,
	type FakeIndexedDB,
	type FakeOPFS,
} from "@/services/storage/__tests__/fake-browser-storage";
import { storageService } from "@/services/storage/service";
import { createStateTracker } from "@/claude/bridge/state-tracker";
import type { TabHandlerContext } from "@/claude/types";
import { handleApplyEditPlan } from "@/claude/edit/apply-plan";
import { handleUndo } from "@/claude/edit/history";
import { removeMedia } from "@/claude/media/media-handlers";
import { asset } from "@/claude/edit/__tests__/plan-fixtures";

// remove_media then undo on a REAL EditorCore whose assets were LOADED from storage (fake IndexedDB + OPFS).
// A loaded asset's File is backed by its OPFS entry: deleting that entry on remove made the File unreadable,
// so the undo could not write it back and the media vanished from the project at the next load while its
// elements stayed on the timeline.

const AUDIO = asset({ id: "m-audio", type: "audio", duration: 30 });

let fakeIndexedDB: FakeIndexedDB;
let fakeOPFS: FakeOPFS;
let restoreStorage: () => void = () => {};
let editor: EditorCore;
let projectId: string;
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
		method: "remove_media",
		reportProgress: () => {},
		emit: () => {},
		getStateVersion: () => tracker.getVersion(),
	};
}

function parsed<N extends "apply_edit_plan" | "remove_media" | "undo">({
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

/** The commands write storage without awaiting it: let those writes settle. */
async function settleStorage(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function storedMetadataIds(): string[] {
	return fakeIndexedDB
		.getRecords({
			dbName: `video-editor-media-${projectId}`,
			storeName: "media-metadata",
		})
		.map((record) => String(Reflect.get(Object(record), "id")));
}

function storedFileIds(): string[] {
	const directory = fakeOPFS.directories.get(`media-files-${projectId}`);
	return directory ? [...directory.files.keys()] : [];
}

async function reloadProject(): Promise<void> {
	await editor.save.flush();
	await editor.project.loadProject({ id: projectId });
}

function audioElementIds(): string[] {
	return editor.scenes
		.getActiveScene()
		.tracks.audio.flatMap((track) =>
			track.elements.map((element) => element.id),
		);
}

beforeAll(() => {
	const indexedDB = installFakeIndexedDB();
	const opfs = installFakeOPFS();
	fakeIndexedDB = indexedDB.indexedDB;
	fakeOPFS = opfs.opfs;
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
	projectId = await editor.project.createNewProject({ name: "Médias" });
	await storageService.saveMediaAsset({ projectId, mediaAsset: AUDIO });
	// Loading gives the assets their OPFS-backed Files, as after any page reload.
	await editor.project.loadProject({ id: projectId });
	expect(editor.media.getAssets().map((media) => media.id)).toEqual([AUDIO.id]);
	await handleApplyEditPlan({
		input: parsed({
			tool: "apply_edit_plan",
			params: {
				ops: [
					{
						op: "insert_media",
						mediaId: AUDIO.id,
						start: 0,
						duration: 5,
						track: "audio",
					},
				],
			},
		}),
		ctx: { ...makeContext(), method: "apply_edit_plan" },
	});
	expect(audioElementIds()).toHaveLength(1);
});

afterEach(async () => {
	await editor.save.flush();
	editor.save.stop();
	console.error = originalConsoleError;
});

describe("remove_media on media loaded from storage", () => {
	test("undo restores the media in storage: it is still there, readable, after a reload", async () => {
		const ctx = makeContext();
		await removeMedia({
			input: parsed({ tool: "remove_media", params: { mediaIds: [AUDIO.id] } }),
			ctx,
		});
		await settleStorage();
		expect(editor.media.getAssets()).toHaveLength(0);
		expect(storedMetadataIds()).toEqual([]);
		// The file is kept for the undo.
		expect(storedFileIds()).toEqual([AUDIO.id]);

		await handleUndo({ input: parsed({ tool: "undo", params: {} }), ctx });
		await settleStorage();
		expect(storedMetadataIds()).toEqual([AUDIO.id]);
		expect(storedFileIds()).toEqual([AUDIO.id]);

		await reloadProject();
		const [restored] = editor.media.getAssets();
		expect(restored?.id).toBe(AUDIO.id);
		expect(await restored?.file.text()).toBe(await AUDIO.file.text());
		expect(audioElementIds()).toHaveLength(1);
	});

	test("a removal that is never undone frees the file once it is old enough", async () => {
		await removeMedia({
			input: parsed({ tool: "remove_media", params: { mediaIds: [AUDIO.id] } }),
			ctx: makeContext(),
		});
		await settleStorage();

		await reloadProject();
		await settleStorage();
		expect(editor.media.getAssets()).toHaveLength(0);
		// The load's own prune keeps a file written less than a minute ago.
		expect(storedFileIds()).toEqual([AUDIO.id]);

		const deleted = await storageService.pruneOrphanedMediaFiles({
			projectId,
			now: Date.now() + 120_000,
		});
		expect(deleted).toBe(1);
		expect(storedFileIds()).toEqual([]);
	});
});
