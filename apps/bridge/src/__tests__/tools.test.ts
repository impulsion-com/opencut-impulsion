import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	BRIDGE_ORIGIN,
	ERROR_HINTS,
	TOOL_NAMES,
	TOOLS,
	type RpcMethod,
	type ToolResult,
} from "@opencut/claude-tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeError } from "../errors";
import { createFileRegistry } from "../files";
import type { EditorHub, HubCallOptions } from "../hub";
import { createJobTable, type JobTable } from "../jobs";
import { silentLogger } from "../log";
import { toCallToolResult, toErrorCallToolResult } from "../mcp-result";
import {
	createMediaIndex,
	projectFolderName,
	type MediaIndex,
} from "../media-index";
import {
	createProgressNotifier,
	createToolRegistry,
	registerToolsOnServer,
	sanitizeExportName,
	type ToolRegistry,
} from "../tools";

// A scriptable stand-in for the hub: records every call and answers from `responses`.
interface FakeHub {
	hub: EditorHub;
	calls: Array<{ method: RpcMethod; params: unknown; options: HubCallOptions }>;
	responses: Map<string, (params: unknown) => ToolResult | Promise<ToolResult>>;
	state: {
		connected: boolean;
		projectId: string | null;
		projectName: string | null;
	};
}

function createFakeHub(): FakeHub {
	const calls: FakeHub["calls"] = [];
	const responses: FakeHub["responses"] = new Map();
	const state: FakeHub["state"] = {
		connected: true,
		projectId: "p1",
		projectName: "Reel test",
	};
	const hub = {
		async call(
			method: RpcMethod,
			params: unknown,
			options: HubCallOptions = {},
		) {
			calls.push({ method, params, options });
			if (!state.connected)
				throw new BridgeError({ code: "EDITOR_NOT_CONNECTED" });
			options.onDispatch?.({ connectionId: "conn-1", tabId: "tab-1" });
			const respond = responses.get(method);
			if (!respond) return { json: { method } };
			return respond(params);
		},
		isConnected: () => state.connected,
		getActiveProjectId: () => (state.connected ? state.projectId : null),
		getActiveProjectName: () => state.projectName,
	} as unknown as EditorHub;
	return { hub, calls, responses, state };
}

let base: string;
let root: string;
let exportsDir: string;
let fake: FakeHub;
let jobs: JobTable;
let mediaIndex: MediaIndex;
let registry: ToolRegistry;
const mcpOrigin = { origin: { kind: "mcp" as const } };

beforeAll(async () => {
	base = await realpath(await mkdtemp(path.join(tmpdir(), "opencut-tools-")));
	root = path.join(base, "videos");
	exportsDir = path.join(base, "videos", "exports");
	await mkdir(path.join(root, "rushes"), { recursive: true });
	await mkdir(path.join(root, ".cache"), { recursive: true });
	await writeFile(path.join(root, "rushes", "a.mp4"), "video");
	await writeFile(path.join(root, "rushes", "b.wav"), "audio");
	await writeFile(path.join(root, "rushes", "notes.txt"), "text");
	await writeFile(path.join(root, "rushes", ".DS_Store"), "x");
	await writeFile(path.join(root, ".cache", "c.mp4"), "x");
	await writeFile(path.join(base, "outside.mp4"), "x");
});

afterAll(async () => {
	await rm(base, { recursive: true, force: true });
});

beforeEach(() => {
	fake = createFakeHub();
	jobs = createJobTable({ logger: silentLogger });
	mediaIndex = createMediaIndex({
		dataDir: path.join(base, "data"),
		logger: silentLogger,
	});
	const files = createFileRegistry({
		getRoots: () => [root],
		ttlMs: 60_000,
		logger: silentLogger,
	});
	registry = createToolRegistry({
		hub: fake.hub,
		jobs,
		files,
		uploads: { abort: () => false },
		mediaIndex,
		prober: null,
		config: { allowedRoots: [root], exportsDir },
		logger: silentLogger,
		now: () => new Date(2026, 8, 25, 16, 5, 12),
	});
});

describe("registry", () => {
	test("covers every contract tool exactly once, in catalogue order", () => {
		const names = registry.entries.map((entry) => entry.tool.name);
		expect(names).toEqual([...TOOL_NAMES]);
		expect(new Set(names).size).toBe(TOOLS.length);
		for (const entry of registry.entries) {
			expect(entry.handledBy).toBe(
				entry.tool.runsIn === "tab" ? "tab" : "sidecar",
			);
			expect(typeof entry.handler).toBe("function");
		}
	});

	test("validates params with the contract schema before running", async () => {
		const error = await registry
			.run("apply_edit_plan", { ops: [], dry_run: true }, mcpOrigin)
			.catch((caught: unknown) => caught);
		expect((error as BridgeError).code).toBe("INVALID_PARAMS");
		expect(fake.calls).toEqual([]);
		const unknown = await registry
			.run("nope", {}, mcpOrigin)
			.catch((caught: unknown) => caught);
		expect((unknown as BridgeError).code).toBe("INVALID_PARAMS");
	});

	test("tab tools are forwarded unchanged with the caller's signal", async () => {
		const controller = new AbortController();
		const result = await registry.run(
			"get_element",
			{ elementId: "el-1" },
			{ signal: controller.signal, origin: { kind: "mcp" } },
		);
		expect(result).toEqual({ json: { method: "get_element" } });
		expect(fake.calls[0]).toMatchObject({
			method: "get_element",
			params: { elementId: "el-1" },
		});
		expect(fake.calls[0]?.options.signal).toBe(controller.signal);
	});
});

describe("MCP registration", () => {
	test("every tool is listed, strict, and errors carry the contract hint", async () => {
		const server = new McpServer({ name: "opencut", version: "test" });
		registerToolsOnServer({
			server,
			registry,
			getOrigin: () => ({ kind: "mcp" }),
			logger: silentLogger,
		});
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		const client = new Client({ name: "test", version: "0" });
		await client.connect(clientTransport);
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
		expect(
			tools.find((tool) => tool.name === "apply_edit_plan")?.inputSchema
				.additionalProperties,
		).toBe(false);

		fake.state.connected = false;
		const result = await client.callTool({
			name: "get_editor_state",
			arguments: {},
		});
		expect(result.isError).toBe(true);
		const text =
			(result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
		expect(text).toStartWith("EDITOR_NOT_CONNECTED: ");
		expect(text).toContain(ERROR_HINTS.EDITOR_NOT_CONNECTED);
		await client.close();
	});

	test("ToolResult to MCP content: images with captions, then text, then compact JSON", () => {
		expect(
			toCallToolResult({
				json: { a: 1 },
				text: "note",
				images: [
					{ data: "AAA", mimeType: "image/jpeg", caption: "frame @1.000s" },
				],
			}),
		).toEqual({
			content: [
				{ type: "image", data: "AAA", mimeType: "image/jpeg" },
				{ type: "text", text: "frame @1.000s" },
				{ type: "text", text: "note" },
				{ type: "text", text: '{"a":1}' },
			],
		});
		expect(toCallToolResult({})).toEqual({
			content: [{ type: "text", text: "ok" }],
		});
		const error = toErrorCallToolResult(
			new BridgeError({
				code: "STALE_STATE",
				message: "v3 != v4",
				details: { expected: 3 },
			}),
		);
		expect(error.isError).toBe(true);
		expect((error.content[0] as { text: string }).text).toBe(
			`STALE_STATE: v3 != v4\n${ERROR_HINTS.STALE_STATE}\nDetails: {"expected":3}`,
		);
	});
});

describe("list_media", () => {
	test("adds the disk path of media imported through import_media", async () => {
		await mediaIndex.record("p1", {
			m1: {
				path: "/videos/a.mp4",
				size: 5,
				mtimeMs: 1,
				importedAt: "2026-09-25T00:00:00.000Z",
			},
		});
		fake.responses.set("list_media", () => ({
			json: [
				{ id: "m1", name: "a.mp4" },
				{ id: "m2", name: "drop.mov" },
			],
		}));
		const result = await registry.run("list_media", {}, mcpOrigin);
		expect(result.json).toEqual([
			{ id: "m1", name: "a.mp4", path: "/videos/a.mp4" },
			{ id: "m2", name: "drop.mov" },
		]);
	});
});

describe("list_disk_media", () => {
	test("lists the roots, then a folder with media only, no dotfiles, and mediaIds of imported files", async () => {
		const roots = await registry.run("list_disk_media", {}, mcpOrigin);
		expect(roots.json).toMatchObject({
			roots: [root],
			folder: null,
			entries: [{ path: root, kind: "folder" }],
		});

		await mediaIndex.record("p1", {
			m9: {
				path: path.join(root, "rushes", "a.mp4"),
				size: 5,
				mtimeMs: 1,
				importedAt: "x",
			},
		});
		fake.responses.set("list_media", () => ({ json: [{ id: "m9" }] }));
		const listing = await registry.run(
			"list_disk_media",
			{ folder: path.join(root, "rushes") },
			mcpOrigin,
		);
		const entries = (
			listing.json as {
				entries: Array<{
					name: string;
					kind: string;
					mediaId?: string;
					size?: number;
				}>;
			}
		).entries;
		expect(
			entries.map((entry) => [entry.name, entry.kind, entry.mediaId]),
		).toEqual([
			["a.mp4", "video", "m9"],
			["b.wav", "audio", undefined],
		]);
		expect(entries[0]?.size).toBe(5);

		const recursive = await registry.run(
			"list_disk_media",
			{ folder: root, recursive: true, extensions: ["wav"] },
			mcpOrigin,
		);
		expect(
			(recursive.json as { entries: Array<{ name: string }> }).entries.map(
				(entry) => entry.name,
			),
		).toEqual(["b.wav"]);
	});

	test("refuses folders outside the roots and missing ones", async () => {
		const outside = await registry
			.run("list_disk_media", { folder: base }, mcpOrigin)
			.catch((caught: unknown) => caught);
		expect((outside as BridgeError).code).toBe("INVALID_PARAMS");
		const hidden = await registry
			.run("list_disk_media", { folder: path.join(root, ".cache") }, mcpOrigin)
			.catch((caught: unknown) => caught);
		expect((hidden as BridgeError).code).toBe("INVALID_PARAMS");
		const missing = await registry
			.run("list_disk_media", { folder: path.join(root, "nope") }, mcpOrigin)
			.catch((caught: unknown) => caught);
		expect((missing as BridgeError).code).toBe("NOT_FOUND");
	});
});

describe("import_media", () => {
	test("serves allowed files by opaque URL, records the media index and merges skipped paths", async () => {
		fake.responses.set("internal.import_files", (params) => {
			const files = (params as { files: Array<{ path: string }> }).files;
			return {
				json: {
					imported: files.map((file, index) => ({
						path: file.path,
						mediaId: `media-${index}`,
						name: path.basename(file.path),
						type: "video",
					})),
					elementIds: ["el-1"],
					skipped: [],
				},
			};
		});
		const result = await registry.run(
			"import_media",
			{
				paths: [
					path.join(root, "rushes", "a.mp4"),
					path.join(root, "rushes", "notes.txt"),
					path.join(base, "outside.mp4"),
					path.join(root, "rushes", "a.mp4"),
				],
				place: { start: 0, track: "main" },
			},
			{ origin: { kind: "chat", sessionKey: "k" } },
		);
		const call = fake.calls.find(
			(entry) => entry.method === "internal.import_files",
		);
		const params = call?.params as {
			jobId: string;
			files: Array<{
				path: string;
				url: string;
				mimeType: string;
				size: number;
			}>;
			place: unknown;
		};
		expect(call?.options.projectId).toBe("p1");
		expect(params.files).toHaveLength(1);
		expect(params.files[0]).toMatchObject({
			path: path.join(root, "rushes", "a.mp4"),
			mimeType: "video/mp4",
			size: 5,
		});
		expect(params.files[0]?.url).toStartWith(`${BRIDGE_ORIGIN}/files/`);
		expect(params.files[0]?.url).not.toContain("rushes");
		expect(params.place).toEqual({ start: 0, track: "main" });

		const json = result.json as {
			imported: unknown[];
			skipped: Array<{ path: string; reason: string }>;
			elementIds: string[];
		};
		expect(json.imported).toHaveLength(1);
		expect(json.elementIds).toEqual(["el-1"]);
		expect(json.skipped.map((entry) => entry.reason)).toEqual([
			"unsupported file type (video, audio or image expected)",
			"outside the allowed folders",
			"listed twice",
		]);
		const job = jobs.get(params.jobId);
		expect(job).toMatchObject({
			kind: "import",
			status: "done",
			origin: { kind: "chat", sessionKey: "k" },
		});

		const index = JSON.parse(
			await readFile(mediaIndex.fileFor("p1"), "utf8"),
		) as { entries: Record<string, { path: string; size: number }> };
		expect(index.entries["media-0"]).toMatchObject({
			path: path.join(root, "rushes", "a.mp4"),
			size: 5,
		});
	});

	test("needs a connected tab with an open project", async () => {
		fake.state.projectId = null;
		const noProject = await registry
			.run(
				"import_media",
				{ paths: [path.join(root, "rushes", "a.mp4")] },
				mcpOrigin,
			)
			.catch((caught: unknown) => caught);
		expect((noProject as BridgeError).code).toBe("NO_PROJECT");
		fake.state.connected = false;
		const noTab = await registry
			.run(
				"import_media",
				{ paths: [path.join(root, "rushes", "a.mp4")] },
				mcpOrigin,
			)
			.catch((caught: unknown) => caught);
		expect((noTab as BridgeError).code).toBe("EDITOR_NOT_CONNECTED");
	});

	test("over MCP, a waiting import sends progress notifications, and a retry does not copy the same files again", async () => {
		let finish: (result: ToolResult) => void = () => {};
		let jobId = "";
		fake.responses.set("internal.import_files", (params) => {
			const typed = params as { jobId: string; files: Array<{ path: string }> };
			jobId = typed.jobId;
			return new Promise<ToolResult>((resolve) => {
				finish = resolve;
			});
		});
		const server = new McpServer({ name: "opencut", version: "test" });
		registerToolsOnServer({
			server,
			registry,
			getOrigin: () => ({ kind: "mcp" }),
			logger: silentLogger,
		});
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		const client = new Client({ name: "test", version: "0" });
		await client.connect(clientTransport);

		const file = path.join(root, "rushes", "a.mp4");
		const progress: Array<{ progress: number; message?: string }> = [];
		const call = client.callTool(
			{ name: "import_media", arguments: { paths: [file] } },
			undefined,
			{ onprogress: (update) => progress.push(update) },
		);
		while (!jobId) await new Promise((resolve) => setTimeout(resolve, 5));
		jobs.update(jobId, { progress: 0.5, message: "Copie des fichiers" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(progress.length).toBeGreaterThanOrEqual(1);
		expect(progress.at(-1)).toMatchObject({ total: 100 });

		const retry = await registry.run("import_media", { paths: [file] }, mcpOrigin);
		expect(retry.json).toEqual({
			imported: [],
			skipped: [
				{
					path: file,
					reason: `already being imported by job ${jobId}: wait for it with job_status, then list_media`,
				},
			],
		});
		expect(
			fake.calls.filter((entry) => entry.method === "internal.import_files"),
		).toHaveLength(1);

		finish({
			json: { imported: [{ path: file, mediaId: "m-1" }], skipped: [] },
		});
		const result = await call;
		expect(result.isError).toBeFalsy();
		// Once finished, the same file can be imported again.
		fake.responses.set("internal.import_files", () => ({
			json: { imported: [{ path: file, mediaId: "m-2" }], skipped: [] },
		}));
		const again = await registry.run("import_media", { paths: [file] }, mcpOrigin);
		expect((again.json as { imported: unknown[] }).imported).toHaveLength(1);
		await client.close();
	});

	test("progress notifications only ever increase, heartbeats included", () => {
		const sent: number[] = [];
		const notify = createProgressNotifier({
			progressToken: 1,
			send: async (notification) => {
				sent.push(notification.params.progress);
			},
		});
		notify({ progress: 0.2 });
		notify({ progress: 0.2 });
		notify({ progress: 0.1 });
		notify({ progress: 0.9 });
		expect(sent[0]).toBe(20);
		for (let index = 1; index < sent.length; index++)
			expect(sent[index]).toBeGreaterThan(sent[index - 1] ?? 0);
		expect(sent.at(-1)).toBe(90);
	});

	test("a failed tab import fails the job and surfaces the code", async () => {
		fake.responses.set("internal.import_files", () => {
			throw new BridgeError({ code: "BUSY", message: "quota" });
		});
		const error = await registry
			.run(
				"import_media",
				{ paths: [path.join(root, "rushes", "b.wav")] },
				mcpOrigin,
			)
			.catch((caught: unknown) => caught);
		expect((error as BridgeError).code).toBe("BUSY");
		expect(jobs.list().find((job) => job.kind === "import")?.status).toBe(
			"failed",
		);
	});
});

describe("exports and jobs", () => {
	test("start_export creates a job, hands the tab its upload URL and returns the planned path", async () => {
		const result = await registry.run(
			"start_export",
			{ quality: "low", fileName: "Mon reel: v2.mp4" },
			mcpOrigin,
		);
		const { jobId, outputPath } = result.json as {
			jobId: string;
			outputPath: string;
		};
		expect(outputPath).toBe(path.join(exportsDir, "Mon reel- v2.mp4"));
		const call = fake.calls.find(
			(entry) => entry.method === "internal.export_start",
		);
		expect(call?.params).toEqual({
			jobId,
			format: "mp4",
			quality: "low",
			includeAudio: true,
			fileName: "Mon reel- v2.mp4",
			uploadUrl: `${BRIDGE_ORIGIN}/exports/${jobId}`,
		});
		expect(call?.options.projectId).toBe("p1");
		expect(jobs.get(jobId)).toMatchObject({
			kind: "export",
			status: "running",
			export: { connectionId: "conn-1", upload: "none" },
		});

		const status = await registry.run("job_status", { jobId }, mcpOrigin);
		expect(status.json).toMatchObject({
			jobId,
			kind: "export",
			status: "running",
		});

		const cancelled = await registry.run("cancel_job", { jobId }, mcpOrigin);
		expect(cancelled.json).toEqual({ jobId, status: "cancelled" });
		expect(fake.calls.at(-1)).toMatchObject({
			method: "internal.export_cancel",
			params: { jobId },
		});
		expect(
			(await registry.run("cancel_job", { jobId }, mcpOrigin)).json,
		).toEqual({ jobId, status: "cancelled" });
	});

	test("the default file name is the project name plus a timestamp", async () => {
		const result = await registry.run(
			"start_export",
			{ format: "webm" },
			mcpOrigin,
		);
		expect((result.json as { outputPath: string }).outputPath).toBe(
			path.join(exportsDir, "Reel test 2026-09-25 16h05m12.webm"),
		);
	});

	test("a refused export_start fails the job", async () => {
		fake.responses.set("internal.export_start", () => {
			throw new BridgeError({
				code: "EXPORTING",
				message: "already exporting",
			});
		});
		const error = await registry
			.run("start_export", {}, mcpOrigin)
			.catch((caught: unknown) => caught);
		expect((error as BridgeError).code).toBe("EXPORTING");
		expect(jobs.list().at(-1)).toMatchObject({
			kind: "export",
			status: "failed",
		});
	});

	test("cancel_job reaches a tab still rendering an export the sidecar forgot (restart) or failed (socket drop)", async () => {
		let rendering = "old-job";
		fake.responses.set("internal.export_cancel", (params) => {
			const { jobId } = params as { jobId: string };
			const cancelled = jobId === rendering;
			if (cancelled) rendering = "";
			return { json: { cancelled } };
		});
		expect(
			(await registry.run("cancel_job", { jobId: "old-job" }, mcpOrigin)).json,
		).toEqual({ jobId: "old-job", status: "cancelled" });
		const unknown = await registry
			.run("cancel_job", { jobId: "old-job" }, mcpOrigin)
			.catch((caught: unknown) => caught);
		expect((unknown as BridgeError).code).toBe("NOT_FOUND");

		const failed = jobs.create({
			kind: "export",
			origin: { kind: "mcp" },
			projectId: "p1",
			export: {
				fileName: "a.mp4",
				format: "mp4",
				outputPath: path.join(exportsDir, "a.mp4"),
				upload: "none",
			},
			status: "running",
		});
		jobs.finish(failed.id, { status: "failed", error: "CONNECTION_LOST" });
		rendering = failed.id;
		expect(
			(await registry.run("cancel_job", { jobId: failed.id }, mcpOrigin)).json,
		).toEqual({ jobId: failed.id, status: "failed" });
		expect(rendering).toBe("");
	});

	test("job_status and cancel_job on unknown or import jobs", async () => {
		const unknown = await registry
			.run("job_status", { jobId: "nope" }, mcpOrigin)
			.catch((caught: unknown) => caught);
		expect((unknown as BridgeError).code).toBe("NOT_FOUND");
		const importJob = jobs.create({
			kind: "import",
			origin: { kind: "mcp" },
			projectId: "p1",
			status: "running",
		});
		const refused = await registry
			.run("cancel_job", { jobId: importJob.id }, mcpOrigin)
			.catch((caught: unknown) => caught);
		expect((refused as BridgeError).code).toBe("INVALID_PARAMS");
		setTimeout(() => jobs.finish(importJob.id, { status: "done" }), 30);
		const waited = await registry.run(
			"job_status",
			{ jobId: importJob.id, waitSeconds: 2 },
			mcpOrigin,
		);
		expect(waited.json).toMatchObject({ status: "done", progress: 1 });
	});

	test("sanitizeExportName", () => {
		expect(sanitizeExportName("  ../../etc/passwd ")).toBe("etc-passwd");
		expect(sanitizeExportName("Reel.WEBM")).toBe("Reel");
		expect(sanitizeExportName("...")).toBe("export");
		expect(sanitizeExportName("a\u0000b")).toBe("a-b");
		expect(projectFolderName("abc-123")).toBe("abc-123");
		expect(projectFolderName("../x")).toStartWith("id-");
	});
});
