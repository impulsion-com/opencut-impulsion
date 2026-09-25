import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import { ProjectManager } from "@/core/managers/project-manager";
import { installFakeIndexedDB } from "@/services/storage/__tests__/fake-browser-storage";

function buildEditorStub() {
	const calls: string[] = [];
	const record = (name: string) => mock(() => calls.push(name));
	const editor = {
		command: { clear: record("command.clear") },
		media: {
			clearAllAssets: record("media.clearAllAssets"),
			loadProjectMedia: mock(async () => {}),
		},
		scenes: {
			clearScenes: record("scenes.clearScenes"),
			initializeScenes: record("scenes.initializeScenes"),
		},
		save: { pause: record("save.pause"), resume: record("save.resume") },
	};
	return { editor, calls };
}

function createProjectManager(editor: ReturnType<typeof buildEditorStub>["editor"]) {
	// Only the managers ProjectManager touches on these paths are stubbed.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return new ProjectManager(editor as unknown as EditorCore);
}

describe("ProjectManager undo history", () => {
	let restoreIndexedDB: () => void;
	let originalConsoleError: typeof console.error;

	beforeEach(() => {
		({ restore: restoreIndexedDB } = installFakeIndexedDB());
		originalConsoleError = console.error;
		console.error = mock(() => {});
	});

	afterEach(() => {
		console.error = originalConsoleError;
		restoreIndexedDB();
	});

	test("closeProject clears the command history", () => {
		const { editor, calls } = buildEditorStub();
		createProjectManager(editor).closeProject();

		expect(calls).toContain("command.clear");
	});

	test("loadProject clears the history before switching scenes, even when loading fails", async () => {
		const { editor, calls } = buildEditorStub();

		await expect(
			createProjectManager(editor).loadProject({ id: "missing" }),
		).rejects.toThrow(/not found/);

		expect(calls.indexOf("command.clear")).toBeGreaterThanOrEqual(0);
		expect(calls.indexOf("command.clear")).toBeLessThan(
			calls.indexOf("scenes.clearScenes"),
		);
	});
});
