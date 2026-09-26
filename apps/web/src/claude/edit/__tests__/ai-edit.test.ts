/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- test fakes stand in for EditorCore and friends */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command, type CommandResult } from "@/commands";
import type { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import type { SceneTracks } from "@/timeline/types";
import {
	AiEditCommand,
	flushSave,
	flushSaveWithin,
	runAiEdit,
} from "@/claude/edit/ai-edit";
import { BridgeError, isBridgeError } from "@/claude/types";
import { registerCanceller } from "@/editor/cancel-interaction";

// A stub editor around the REAL CommandManager: history, undo/redo and the ripple flag behave as in the app.

function tracksNamed(name: string): SceneTracks {
	return {
		overlay: [],
		main: {
			id: `main-${name}`,
			type: "video",
			name,
			elements: [],
			muted: false,
			hidden: false,
		},
		audio: [],
	} as unknown as SceneTracks;
}

function createEditor() {
	const state = {
		tracks: tracksNamed("before"),
		sceneId: "s1",
		hasProject: true,
		loading: false,
		mediaLoading: false,
		preview: false,
		scrubbing: false,
		exporting: false,
		updateCalls: 0,
	};
	const editor = {
		project: {
			getActiveOrNull: () =>
				state.hasProject ? { metadata: { id: "p1" } } : null,
			getIsLoading: () => state.loading,
			getExportState: () => ({
				isExporting: state.exporting,
				progress: 0,
				result: null,
			}),
		},
		media: { isLoadingMedia: () => state.mediaLoading },
		scenes: {
			getActiveScene: () => ({
				id: state.sceneId,
				name: "Main",
				tracks: state.tracks,
			}),
			getActiveSceneOrNull: () => ({
				id: state.sceneId,
				name: "Main",
				tracks: state.tracks,
			}),
		},
		timeline: {
			isPreviewActive: () => state.preview,
			updateTracks: (tracks: SceneTracks) => {
				state.updateCalls += 1;
				state.tracks = tracks;
			},
		},
		playback: { getIsScrubbing: () => state.scrubbing },
		selection: {
			getSnapshot: () => ({}),
			applySelectionPatch: () => ({}),
			restoreSnapshot: () => {},
		},
	} as Record<string, unknown>;
	const command = new CommandManager(editor as unknown as EditorCore);
	editor.command = command;
	return { editor: editor as unknown as EditorCore, state, command };
}

type Harness = ReturnType<typeof createEditor>;

/** Writes new tracks and restores the previous ones on undo, like the real timeline commands. */
class SetTracksCommand extends Command {
	private saved: SceneTracks | null = null;
	rippleSeen: boolean | null = null;

	private readonly harness: Harness;
	private readonly next: SceneTracks;

	constructor({ harness, next }: { harness: Harness; next: SceneTracks }) {
		super();
		this.harness = harness;
		this.next = next;
	}

	execute(): CommandResult | undefined {
		this.rippleSeen = this.harness.command.isRippleEnabled;
		this.saved = this.harness.state.tracks;
		this.harness.editor.timeline.updateTracks(this.next);
		return undefined;
	}

	undo(): void {
		if (this.saved) this.harness.editor.timeline.updateTracks(this.saved);
	}
}

/** Fails like MoveElementCommand on an invalid ref, optionally after writing tracks. */
class ThrowingCommand extends Command {
	private readonly harness: Harness;
	private readonly writeFirst: boolean;

	constructor({
		harness,
		writeFirst,
	}: {
		harness: Harness;
		writeFirst: boolean;
	}) {
		super();
		this.harness = harness;
		this.writeFirst = writeFirst;
	}

	execute(): CommandResult | undefined {
		if (this.writeFirst)
			this.harness.editor.timeline.updateTracks(tracksNamed("garbage"));
		throw new Error("Element not found: e404");
	}
}

function expectBridgeError({
	run,
	code,
}: {
	run: () => unknown;
	code: BridgeError["code"];
}): BridgeError {
	try {
		run();
	} catch (error) {
		expect(isBridgeError(error)).toBe(true);
		expect((error as BridgeError).code).toBe(code);
		return error as BridgeError;
	}
	throw new Error(`expected a BridgeError ${code}`);
}

const originalError = console.error;
beforeEach(() => {
	console.error = mock(() => {});
});
afterEach(() => {
	console.error = originalError;
});

describe("runAiEdit", () => {
	test("applies every command as ONE undo step with ripple pinned off", () => {
		const harness = createEditor();
		const { editor, state, command } = harness;
		command.isRippleEnabled = true;
		const before = state.tracks;
		const middle = tracksNamed("middle");
		const after = tracksNamed("after");
		const first = new SetTracksCommand({ harness, next: middle });
		const second = new SetTracksCommand({ harness, next: after });

		const result = runAiEdit({
			editor,
			label: "Hook title",
			build: (tracks) => {
				expect(tracks).toBe(before);
				return [first, second];
			},
		});

		expect(result.command).toBeInstanceOf(AiEditCommand);
		expect(result.command?.label).toBe("Hook title");
		expect(result.commands).toEqual([first, second]);
		expect(result.before).toBe(before);
		expect(result.after).toBe(after);
		expect(first.rippleSeen).toBe(false);
		expect(second.rippleSeen).toBe(false);
		expect(command.isRippleEnabled).toBe(true);

		command.undo();
		expect(state.tracks).toBe(before);
		expect(command.canUndo()).toBe(false);
		command.redo();
		expect(state.tracks).toBe(after);
	});

	test("guards: NO_PROJECT, USER_INTERACTING, EXPORTING, and build is never called", () => {
		const cases: [Partial<Harness["state"]>, BridgeError["code"]][] = [
			[{ hasProject: false }, "NO_PROJECT"],
			[{ loading: true }, "NO_PROJECT"],
			[{ mediaLoading: true }, "NO_PROJECT"],
			[{ preview: true }, "USER_INTERACTING"],
			[{ scrubbing: true }, "USER_INTERACTING"],
			[{ exporting: true }, "EXPORTING"],
		];
		for (const [patch, code] of cases) {
			const harness = createEditor();
			Object.assign(harness.state, patch);
			const build = mock(() => [] as Command[]);
			expectBridgeError({
				run: () => runAiEdit({ editor: harness.editor, label: "x", build }),
				code,
			});
			expect(build).not.toHaveBeenCalled();
		}
	});

	test("a clip being dragged (a gesture canceller, not the preview overlay) refuses the edit; an open popover does not", () => {
		const harness = createEditor();
		const build = mock(() => [] as Command[]);
		const release = registerCanceller({ fn: () => {} });
		try {
			expectBridgeError({
				run: () => runAiEdit({ editor: harness.editor, label: "x", build }),
				code: "USER_INTERACTING",
			});
		} finally {
			release();
		}
		expect(build).not.toHaveBeenCalled();
		const releasePopover = registerCanceller({ fn: () => {}, gesture: false });
		try {
			runAiEdit({ editor: harness.editor, label: "x", build });
			expect(build).toHaveBeenCalledTimes(1);
		} finally {
			releasePopover();
		}
	});

	test("a failed verify undoes the edit, leaves no undo and no redo entry, and restores ripple", () => {
		const harness = createEditor();
		const { editor, state, command } = harness;
		command.isRippleEnabled = true;
		const before = state.tracks;
		const error = expectBridgeError({
			run: () =>
				runAiEdit({
					editor,
					label: "insert",
					build: () => [
						new SetTracksCommand({ harness, next: tracksNamed("after") }),
					],
					verify: () => "insert_media op 0 could not be placed.",
				}),
			code: "INVALID_EDIT",
		});
		expect(error.message).toContain("could not be placed");
		expect(state.tracks).toBe(before);
		expect(command.canUndo()).toBe(false);
		expect(command.canRedo()).toBe(false);
		expect(command.isRippleEnabled).toBe(true);
	});

	test("a batch that throws halfway is rolled back without a history entry", () => {
		const harness = createEditor();
		const { editor, state, command } = harness;
		const before = state.tracks;
		const first = new SetTracksCommand({
			harness,
			next: tracksNamed("middle"),
		});
		const error = expectBridgeError({
			run: () =>
				runAiEdit({
					editor,
					label: "move",
					build: () => [
						first,
						new ThrowingCommand({ harness, writeFirst: false }),
					],
				}),
			code: "INVALID_EDIT",
		});
		expect(error.message).toContain("e404");
		expect(error.message).toContain("Nothing was applied");
		expect(state.tracks).toBe(before);
		expect(command.canUndo()).toBe(false);
	});

	test("tracks written by the throwing command itself are restored too", () => {
		const harness = createEditor();
		const { editor, state, command } = harness;
		const before = state.tracks;
		expectBridgeError({
			run: () =>
				runAiEdit({
					editor,
					label: "move",
					build: () => [new ThrowingCommand({ harness, writeFirst: true })],
				}),
			code: "INVALID_EDIT",
		});
		expect(state.tracks).toBe(before);
		expect(command.canUndo()).toBe(false);
	});

	test("errors from build propagate unchanged and nothing runs", () => {
		const harness = createEditor();
		const stale = new BridgeError({ code: "STALE_STATE" });
		expect(() =>
			runAiEdit({
				editor: harness.editor,
				label: "x",
				build: () => {
					throw stale;
				},
			}),
		).toThrow(stale);
		expect(harness.state.updateCalls).toBe(0);
		expect(harness.command.canUndo()).toBe(false);
	});

	test("an empty build pushes nothing", () => {
		const harness = createEditor();
		const result = runAiEdit({
			editor: harness.editor,
			label: "noop",
			build: () => [],
		});
		expect(result.command).toBeNull();
		expect(result.after).toBe(result.before);
		expect(harness.command.canUndo()).toBe(false);
	});
});

describe("flushSave", () => {
	function saveStub({ dirtyPolls }: { dirtyPolls: number }) {
		let remaining = dirtyPolls;
		const flush = mock(async () => {});
		return {
			flush,
			editor: {
				project: { getActiveOrNull: () => ({}), getIsLoading: () => false },
				save: {
					flush,
					getIsDirty: () => {
						if (remaining <= 0) return false;
						remaining -= 1;
						return true;
					},
				},
			} as unknown as EditorCore,
		};
	}

	test("resolves true once nothing is pending, waiting for a save in flight", async () => {
		const clean = saveStub({ dirtyPolls: 0 });
		expect(await flushSave(clean.editor)).toBe(true);
		expect(clean.flush).toHaveBeenCalledTimes(1);

		const busy = saveStub({ dirtyPolls: 2 });
		expect(await flushSave(busy.editor)).toBe(true);
		expect(busy.flush).toHaveBeenCalledTimes(3);
	});

	test("resolves false without a project or when the save never settles", async () => {
		const none = {
			project: { getActiveOrNull: () => null, getIsLoading: () => false },
			save: { flush: mock(async () => {}), getIsDirty: () => true },
		} as unknown as EditorCore;
		expect(await flushSave(none)).toBe(false);

		const stuck = saveStub({ dirtyPolls: Number.POSITIVE_INFINITY });
		expect(
			await flushSaveWithin({ editor: stuck.editor, timeoutMs: 120 }),
		).toBe(false);
	});
});
