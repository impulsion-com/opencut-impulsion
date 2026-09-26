/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- a stub stands in for EditorCore */
import { describe, expect, test } from "bun:test";
import type { EditorCore } from "@/core";
import {
	createProjectLoadProbe,
	editorPath,
	waitForProjectLoaded,
} from "@/claude/project/navigation";
import { isBridgeError } from "@/claude/types";

// A stub editor exposing only what the probe reads, with the listeners ProjectManager/ScenesManager/MediaManager
// would notify. `step` drives it through ProjectManager.loadProject's sequence of side effects.

function createStubEditor() {
	const state = {
		activeId: "old" as string | null,
		isLoading: false,
		mediaLoading: false,
		hasScene: true,
		savePaused: false,
		path: "/editor/old",
	};
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};
	const subscribe = (listener: () => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	const editor = {
		project: {
			getActiveOrNull: () =>
				state.activeId ? { metadata: { id: state.activeId } } : null,
			getIsLoading: () => state.isLoading,
			subscribe,
		},
		scenes: {
			getActiveSceneOrNull: () => (state.hasScene ? { id: "s" } : null),
			subscribe,
		},
		media: { isLoadingMedia: () => state.mediaLoading, subscribe },
		save: {
			get isPaused() {
				return state.savePaused;
			},
		},
	} as unknown as EditorCore;

	/** ProjectManager.loadProject for `id`, one notification per side effect. */
	const loadSteps = (id: string): (() => void)[] => [
		() => {
			state.savePaused = true;
			state.path = editorPath({ projectId: id });
		},
		() => {
			state.hasScene = false;
			notify();
		},
		() => {
			state.activeId = id;
			notify();
		},
		() => {
			state.hasScene = true;
			notify();
		},
		() => {
			state.mediaLoading = true;
			notify();
		},
		() => {
			state.mediaLoading = false;
			notify();
		},
		() => {
			state.isLoading = false;
			notify();
			state.savePaused = false;
		},
	];
	return { editor, state, notify, loadSteps, getPath: () => state.path };
}

describe("createProjectLoadProbe", () => {
	test("create_project: the in-memory project is not 'loaded' until the page reload of it ends", () => {
		const stub = createStubEditor();
		// createNewProject put "new" in memory, active and idle, before the navigation.
		stub.state.activeId = "new";
		stub.state.path = editorPath({ projectId: "new" });
		const probe = createProjectLoadProbe({
			editor: stub.editor,
			projectId: "new",
			requireReload: true,
			getPath: stub.getPath,
		});
		expect(probe.observe()).toBe(false);
		const steps = stub.loadSteps("new");
		const seen = steps.map((step) => {
			step();
			return probe.observe();
		});
		// Only the last step (SaveManager resumed) completes the load.
		expect(seen).toEqual([false, false, false, false, false, false, true]);
	});

	test("the id alone is not enough: a load of another project never completes", () => {
		const stub = createStubEditor();
		const probe = createProjectLoadProbe({
			editor: stub.editor,
			projectId: "target",
			requireReload: true,
			getPath: stub.getPath,
		});
		for (const step of stub.loadSteps("other")) step();
		expect(probe.observe()).toBe(false);
	});

	test("an already open, idle project counts as loaded without a reload", () => {
		const stub = createStubEditor();
		const probe = createProjectLoadProbe({
			editor: stub.editor,
			projectId: "old",
			requireReload: false,
			getPath: stub.getPath,
		});
		expect(probe.observe()).toBe(true);
	});
});

describe("waitForProjectLoaded", () => {
	test("resolves on the notification that completes the load", async () => {
		const stub = createStubEditor();
		const waiting = waitForProjectLoaded({
			editor: stub.editor,
			projectId: "next",
			requireReload: true,
			getPath: stub.getPath,
			timeoutMs: 5_000,
		});
		for (const step of stub.loadSteps("next")) step();
		// The final step resumes saving after its notification: the poll picks it up.
		await waiting;
		expect(stub.state.activeId).toBe("next");
	});

	test("waits for a quiet period: a late notification or a save in flight postpones it", async () => {
		const stub = createStubEditor();
		let saving = true;
		Object.defineProperty(stub.editor.save, "isSaving", { get: () => saving });
		let resolved = false;
		const waiting = waitForProjectLoaded({
			editor: stub.editor,
			projectId: "old",
			requireReload: false,
			getPath: stub.getPath,
			settleMs: 60,
		}).then(() => {
			resolved = true;
		});
		await new Promise((done) => setTimeout(done, 120));
		expect(resolved).toBe(false); // a save is in flight
		saving = false;
		stub.notify(); // e.g. the save's updateMetadata notification
		await new Promise((done) => setTimeout(done, 30));
		expect(resolved).toBe(false); // quiet period restarted
		await waiting;
		expect(resolved).toBe(true);
	});

	test("rejects with TIMEOUT when the project never loads", async () => {
		const stub = createStubEditor();
		let caught: unknown = null;
		try {
			await waitForProjectLoaded({
				editor: stub.editor,
				projectId: "never",
				requireReload: true,
				getPath: stub.getPath,
				timeoutMs: 50,
			});
		} catch (error) {
			caught = error;
		}
		expect(isBridgeError(caught) && caught.code).toBe("TIMEOUT");
	});

	test("rejects with the abort reason when the call is aborted", async () => {
		const stub = createStubEditor();
		const controller = new AbortController();
		const waiting = waitForProjectLoaded({
			editor: stub.editor,
			projectId: "never",
			requireReload: true,
			getPath: stub.getPath,
			signal: controller.signal,
		});
		controller.abort();
		let name = "";
		try {
			await waiting;
		} catch (error) {
			name = error instanceof Error ? error.name : "";
		}
		expect(name).toBe("AbortError");
	});
});
