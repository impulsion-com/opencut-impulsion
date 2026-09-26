import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	DEFAULT_CHAT_MODEL,
	EDITOR_ORIGIN,
	TOOL_NAMES,
} from "@opencut/claude-tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConfigError, loadConfig, type BridgeConfig } from "../config";
import { silentLogger } from "../log";
import { createBridgeServer, type BridgeServer } from "../server";
import { BRIDGE_VERSION } from "../version";
import { connectTab } from "./helpers";

let base: string;
let bridge: BridgeServer;
let port: number;
let origin: string;

function rawRequest({
	method = "GET",
	path: requestPath,
	headers = {},
	body,
}: {
	method?: string;
	path: string;
	headers?: Record<string, string>;
	body?: string;
}) {
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port, method, path: requestPath, headers },
			(res) => {
				let text = "";
				res.on("data", (chunk) => (text += chunk));
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, body: text }),
				);
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}

beforeAll(async () => {
	base = await realpath(await mkdtemp(path.join(tmpdir(), "opencut-server-")));
	const config: BridgeConfig = {
		...loadConfig({
			env: {},
			home: base,
			configFile: path.join(base, "missing.json"),
		}),
		port: 0,
		dataDir: path.join(base, "data"),
		exportsDir: path.join(base, "exports"),
		allowedRoots: [base],
	};
	bridge = createBridgeServer({ config, logger: silentLogger, chatCwd: base });
	port = await bridge.listen();
	origin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	await bridge.close();
	await rm(base, { recursive: true, force: true });
});

describe("HTTP routes", () => {
	test("GET /health reports the version, the tab and the sessions", async () => {
		const health = (await (await fetch(`${origin}/health`)).json()) as Record<
			string,
			unknown
		>;
		expect(health).toMatchObject({
			ok: true,
			version: BRIDGE_VERSION,
			tab: { connected: false, role: null, projectId: null },
			sessions: { mcp: 0, chat: 0 },
		});
	});

	test("refuses foreign Host headers (DNS rebinding) and unknown routes", async () => {
		expect(
			(
				await rawRequest({
					path: "/health",
					headers: { Host: "evil.example:3457" },
				})
			).status,
		).toBe(403);
		expect((await rawRequest({ path: "/nope" })).status).toBe(404);
	});

	test("/mcp refuses any browser Origin and requests without a session", async () => {
		const init = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "x", version: "0" },
			},
		});
		const headers = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		expect(
			(
				await rawRequest({
					method: "POST",
					path: "/mcp",
					headers: { ...headers, Origin: EDITOR_ORIGIN },
					body: init,
				})
			).status,
		).toBe(403);
		expect(
			(
				await rawRequest({
					method: "POST",
					path: "/mcp",
					headers,
					body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
				})
			).status,
		).toBe(400);
		expect(
			(
				await rawRequest({
					method: "POST",
					path: "/mcp",
					headers: { ...headers, "mcp-session-id": "unknown" },
					body: init,
				})
			).status,
		).toBe(404);
	});

	test("an MCP client can initialize, list every tool and get a clean EDITOR_NOT_CONNECTED", async () => {
		const client = new Client({ name: "test", version: "0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)),
		);
		expect(client.getServerVersion()).toMatchObject({
			name: "opencut",
			version: BRIDGE_VERSION,
		});
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual(
			[...TOOL_NAMES].sort(),
		);
		const result = await client.callTool({
			name: "capture_frame",
			arguments: {},
		});
		expect(result.isError).toBe(true);
		expect((result.content as Array<{ text: string }>)[0]?.text).toStartWith(
			"EDITOR_NOT_CONNECTED",
		);
		expect(bridge.mcp.count()).toBe(1);
		await client.close();
	});

	test("/mcp accepts contract-valid calls above express's 100 kB default body limit", async () => {
		const client = new Client({ name: "test", version: "0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)),
		);
		// 200 ranges with 500-character notes: the schema allows it, and it weighs well over 100 kB.
		const note = "é".repeat(500);
		const ranges = Array.from({ length: 200 }, (_, index) => ({
			start: index,
			end: index + 0.5,
			note,
			color: "#ffcc00",
		}));
		expect(Buffer.byteLength(JSON.stringify({ ranges }))).toBeGreaterThan(
			150 * 1024,
		);
		const result = await client.callTool({
			name: "mark_ranges",
			arguments: { ranges },
		});
		// No editor tab in this test: reaching the tool at all proves the body was read (no HTTP 413).
		expect(result.isError).toBe(true);
		expect((result.content as Array<{ text: string }>)[0]?.text).toStartWith(
			"EDITOR_NOT_CONNECTED",
		);
		await client.close();
	});

	test("the editor hub shares the port and feeds /health", async () => {
		const tab = await connectTab({ port, tabId: "t", projectId: "p9" });
		expect((await tab.nextOf("welcome")).role).toBe("active");
		const health = (await (await fetch(`${origin}/health`)).json()) as {
			tab: Record<string, unknown>;
		};
		expect(health.tab).toMatchObject({
			connected: true,
			role: "active",
			projectId: "p9",
		});
		await tab.close();
	});
});

describe("version", () => {
	test("BRIDGE_VERSION matches apps/bridge/package.json", async () => {
		const pkg = JSON.parse(
			await readFile(
				path.join(import.meta.dir, "..", "..", "package.json"),
				"utf8",
			),
		) as { version: string };
		expect(BRIDGE_VERSION).toBe(pkg.version);
	});
});

describe("config", () => {
	test("defaults follow the brief", () => {
		const config = loadConfig({
			env: {},
			home: "/Users/me",
			configFile: "/nonexistent/config.json",
		});
		expect(config.allowedRoots).toEqual([
			"/Users/me/impulsion/videos",
			"/Users/me/Movies",
			"/Users/me/Downloads",
			"/Users/me/Desktop",
			"/Volumes",
		]);
		expect(config.exportsDir).toBe("/Users/me/impulsion/videos/exports");
		expect(config.claudePath).toBe("/Users/me/.local/bin/claude");
		expect(config.profiles).toEqual({
			A: "/Users/me/.claude",
			B: "/Users/me/.claude-b",
		});
		expect(config.defaultModel).toBe(DEFAULT_CHAT_MODEL);
		expect(config).toMatchObject({
			host: "127.0.0.1",
			port: 3457,
			defaultProfile: "A",
			configFile: null,
		});
	});

	test("the config file, then the environment, override the defaults", async () => {
		const file = path.join(base, "config.json");
		await writeFile(
			file,
			JSON.stringify({
				allowedRoots: ["~/Rushes"],
				claudePath: "~/bin/claude",
				defaultProfile: "B",
				fileTokenTtlHours: 2,
			}),
		);
		const config = loadConfig({
			env: {
				OPENCUT_BRIDGE_EXPORTS_DIR: "~/out",
				OPENCUT_BRIDGE_DEFAULT_MODEL: "claude-sonnet-5",
				OPENCUT_BRIDGE_PORT: "4000",
			},
			home: "/Users/me",
			configFile: file,
		});
		expect(config.allowedRoots).toEqual(["/Users/me/Rushes"]);
		expect(config.claudePath).toBe("/Users/me/bin/claude");
		expect(config.exportsDir).toBe("/Users/me/out");
		expect(config).toMatchObject({
			defaultProfile: "B",
			defaultModel: "claude-sonnet-5",
			port: 4000,
			fileTokenTtlMs: 2 * 3600_000,
			configFile: file,
		});
		expect(JSON.parse(await readFile(file, "utf8")).claudePath).toBe(
			"~/bin/claude",
		);
	});

	test("typos and bad values are reported", async () => {
		const file = path.join(base, "typo.json");
		await writeFile(file, JSON.stringify({ allowedRoot: ["~/x"] }));
		expect(() =>
			loadConfig({ env: {}, home: "/Users/me", configFile: file }),
		).toThrow(ConfigError);
		expect(() =>
			loadConfig({
				env: { OPENCUT_BRIDGE_DEFAULT_PROFILE: "C" },
				home: "/Users/me",
				configFile: "/nonexistent",
			}),
		).toThrow(ConfigError);
	});
});
