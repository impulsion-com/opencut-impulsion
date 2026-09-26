/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- test fakes stand in for EditorCore and fetch */
import { afterEach, describe, expect, test } from "bun:test";
import { BRIDGE_ORIGIN, BRIDGE_EXPORTS_PATH } from "@opencut/claude-tools";
import type { EditorCore } from "@/core";
import type { ExportResult, ExportState } from "@/export";
import type { TabHandlerContext } from "@/claude/types";
import {
	exportCancel,
	exportStart,
	getActiveExportJobId,
} from "@/claude/export/export-handlers";

// The tab half of start_export against a fake editor: what happens to the rendered buffer when the upload fails
// (sidecar restarted, disk full), and cancelling by job id.

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function fakeEditor({ result }: { result: ExportResult }) {
	let state: ExportState = { isExporting: false, progress: 0, result: null };
	let release: () => void = () => {};
	const rendered = new Promise<void>((resolve) => {
		release = resolve;
	});
	let cleared = 0;
	const project = {
		metadata: { id: "p1", name: "Reel" },
		settings: { fps: { numerator: 30, denominator: 1 } },
	};
	const editor = {
		project: {
			getActiveOrNull: () => project,
			getActive: () => project,
			getIsLoading: () => false,
			getExportState: () => state,
			clearExportState: () => {
				cleared += 1;
				state = { isExporting: false, progress: 0, result: null };
			},
			cancelExport: () => {},
			export: async () => {
				state = { isExporting: true, progress: 0, result: null };
				await rendered;
				state = { isExporting: false, progress: 1, result };
				return result;
			},
		},
		media: { isLoadingMedia: () => false },
		scenes: { getActiveSceneOrNull: () => ({ id: "s1", tracks: {} }) },
		timeline: { getTotalDuration: () => 120_000 },
	};
	return {
		editor: editor as unknown as EditorCore,
		finishRender: () => release(),
		getState: () => state,
		getCleared: () => cleared,
	};
}

function context(editor: EditorCore) {
	const events: Array<{ phase: string; error?: string }> = [];
	const ctx: TabHandlerContext = {
		editor,
		method: "internal.export_start",
		reportProgress: () => {},
		emit: (event) => {
			if (event.type === "event" && event.name === "export-progress")
				events.push(event.payload);
		},
		getStateVersion: () => 0,
	};
	return { ctx, events };
}

const input = (jobId: string) => ({
	jobId,
	format: "mp4" as const,
	quality: "low" as const,
	includeAudio: true,
	fileName: "Reel.mp4",
	uploadUrl: `${BRIDGE_ORIGIN}${BRIDGE_EXPORTS_PATH}/${jobId}`,
});

async function settle(): Promise<void> {
	for (let index = 0; index < 5; index++)
		await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("export handlers", () => {
	test("a refused upload keeps the rendered buffer for the Export button; a stored one clears it", async () => {
		const buffer = new ArrayBuffer(8);
		const refused = fakeEditor({ result: { success: true, buffer } });
		globalThis.fetch = (async () =>
			new Response("unknown job", { status: 404 })) as unknown as typeof fetch;
		const first = context(refused.editor);
		await exportStart({ input: input("job-1"), ctx: first.ctx });
		expect(getActiveExportJobId()).toBe("job-1");
		refused.finishRender();
		await settle();
		expect(first.events.at(-1)?.phase).toBe("failed");
		expect(first.events.at(-1)?.error).toContain("HTTP 404");
		expect(first.events.at(-1)?.error).toContain("Export button");
		expect(refused.getCleared()).toBe(0);
		expect(refused.getState().result?.buffer).toBe(buffer);
		expect(getActiveExportJobId()).toBeNull();

		const stored = fakeEditor({ result: { success: true, buffer } });
		globalThis.fetch = (async () =>
			new Response("{}", { status: 200 })) as unknown as typeof fetch;
		const second = context(stored.editor);
		await exportStart({ input: input("job-2"), ctx: second.ctx });
		stored.finishRender();
		await settle();
		expect(second.events.at(-1)?.phase).toBe("done");
		expect(stored.getCleared()).toBe(1);
	});

	test("export_cancel stops the export with that job id only", async () => {
		const fake = fakeEditor({ result: { success: false, cancelled: true } });
		const { ctx, events } = context(fake.editor);
		await exportStart({ input: input("job-3"), ctx });
		const other = await exportCancel({ input: { jobId: "job-x" }, ctx });
		expect(other.json).toMatchObject({ cancelled: false });
		const cancelled = await exportCancel({ input: { jobId: "job-3" }, ctx });
		expect(cancelled.json).toEqual({ cancelled: true });
		fake.finishRender();
		await settle();
		expect(events.at(-1)?.phase).toBe("cancelled");
	});
});
