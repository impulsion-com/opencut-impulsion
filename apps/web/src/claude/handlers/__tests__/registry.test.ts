/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- test fakes stand in for EditorCore and friends */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { INTERNAL_METHODS, TOOLS } from "@opencut/claude-tools";
import {
	getTabHandler,
	getTabHandlerOwner,
	isTabMethod,
	listMissingTabHandlers,
	registerTabHandlers,
	resetTabHandlersForTests,
	SIDECAR_TOOL_TAB_DEPENDENCIES,
} from "@/claude/handlers/registry";
import { internalHandlers } from "@/claude/handlers/internal-handlers";
import {
	jsonResult,
	type TabHandlerContext,
	type TabHandlerMap,
} from "@/claude/types";

const originalError = console.error;

beforeEach(() => {
	resetTabHandlersForTests();
	console.error = mock(() => {});
});

afterEach(() => {
	resetTabHandlersForTests();
	console.error = originalError;
});

describe("claude tab handler registry", () => {
	test("registers and looks up handlers by method", async () => {
		const map: TabHandlerMap = {
			seek: async (input) => jsonResult({ playhead: input.time }),
		};
		expect(registerTabHandlers({ handlers: map, owner: "test-a" })).toEqual([]);
		const handler = getTabHandler("seek");
		expect(handler).toBeDefined();
		expect(await handler?.({ time: 2 }, {} as TabHandlerContext)).toEqual({
			json: { playhead: 2 },
		});
		expect(getTabHandlerOwner("seek")).toBe("test-a");
		expect(getTabHandler("play")).toBeUndefined();
		expect(getTabHandler("toString")).toBeUndefined();
		// Only tab methods are accepted: hybrid and sidecar tools never reach the tab by name.
		registerTabHandlers({
			handlers: { import_media: map.seek } as unknown as TabHandlerMap,
			owner: "test-a",
		});
		expect(getTabHandler("import_media")).toBeUndefined();
		expect(isTabMethod("seek")).toBe(true);
		expect(isTabMethod("internal.ping")).toBe(true);
		expect(isTabMethod("job_status")).toBe(false);
	});

	test("the same owner may re-register (HMR); another owner is refused with an error", () => {
		const first = async () => jsonResult(1);
		const second = async () => jsonResult(2);
		const intruder = async () => jsonResult(3);
		registerTabHandlers({ handlers: { play: first }, owner: "core" });
		registerTabHandlers({ handlers: { play: second }, owner: "core" });
		expect(getTabHandler("play")).toBe(second);
		expect(
			registerTabHandlers({
				handlers: { play: intruder, pause: intruder },
				owner: "edit",
			}),
		).toEqual(["play"]);
		expect(getTabHandler("play")).toBe(second);
		expect(getTabHandler("pause")).toBe(intruder);
		expect(console.error).toHaveBeenCalledTimes(1);
	});

	test("lists tab tools, internal methods and sidecar tools that cannot be served yet", () => {
		const empty = listMissingTabHandlers();
		expect(empty.tabTools.length).toBe(
			TOOLS.filter((tool) => tool.runsIn === "tab").length,
		);
		expect(empty.internalMethods).toEqual([...INTERNAL_METHODS]);
		expect(
			empty.sidecarTools.map((entry): string => entry.tool).sort(),
		).toEqual(Object.keys(SIDECAR_TOOL_TAB_DEPENDENCIES).sort());

		registerTabHandlers({ handlers: internalHandlers, owner: "internal" });
		registerTabHandlers({
			handlers: { list_media: async () => jsonResult([]) },
			owner: "core",
		});
		const after = listMissingTabHandlers();
		expect(after.internalMethods).not.toContain("internal.ping");
		expect(after.tabTools).not.toContain("list_media");
		expect(after.sidecarTools.map((entry) => entry.tool)).not.toContain(
			"list_disk_media",
		);
		expect(
			after.sidecarTools.find((entry) => entry.tool === "import_media")
				?.missing,
		).toEqual(["internal.import_files"]);
	});

	test("every hybrid tool declares its tab dependencies", () => {
		for (const tool of TOOLS.filter(
			(candidate) => candidate.runsIn === "hybrid",
		)) {
			expect(Object.keys(SIDECAR_TOOL_TAB_DEPENDENCIES)).toContain(tool.name);
		}
	});

	test("internal.ping answers ok", async () => {
		const ping = internalHandlers["internal.ping"];
		expect(await ping?.({}, {} as TabHandlerContext)).toEqual({
			json: { ok: true },
		});
	});
});
