import { stat } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	BRIDGE_EXPORTS_PATH,
	BRIDGE_FILES_PATH,
	EDITOR_WS_PATH,
} from "@opencut/claude-tools";
import {
	hostHeaderValidation,
	localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import express, {
	type Express,
	type NextFunction,
	type Request,
	type Response,
} from "express";
import { createChatManager, type ChatManager } from "./chat";
import type { BridgeConfig } from "./config";
import { createExportUploads } from "./exports";
import { createFileRegistry } from "./files";
import { sendJson } from "./http-utils";
import { createEditorHub, type EditorHub } from "./hub";
import { createJobTable, type JobTable } from "./jobs";
import type { Logger } from "./log";
import { createMcpEndpoint, type McpEndpoint } from "./mcp";
import { createMediaIndex } from "./media-index";
import { createMotionService, type MotionService } from "./motion";
import { registerMotionRoutes } from "./motion-http";
import { createProber } from "./probe";
import { createToolRegistry, type ToolRegistry } from "./tools";
import { BRIDGE_VERSION } from "./version";

// Assembles the sidecar: one HTTP server on 127.0.0.1:3457 (Express that refuses Host headers other than
// localhost/127.0.0.1 and so blocks DNS rebinding, like the MCP SDK's createMcpExpressApp) with GET /health, /mcp,
// /files/<id>, POST /exports/<jobId>, and the WebSocket hub on the same port at /editor.

/**
 * JSON body limit for /mcp. createMcpExpressApp keeps express.json()'s 100 kB default, which contract-valid calls
 * exceed (mark_ranges with 200 long notes, a 200-op caption plan): Claude then got a bare HTTP 413 instead of a
 * result. Everything stays on the loopback interface, so a generous limit costs nothing.
 */
export const MCP_JSON_LIMIT = "16mb";

const LOCALHOST_HOSTS = ["127.0.0.1", "localhost", "::1"];

/** createMcpExpressApp with a larger JSON limit: same Host validation, then the JSON parser. */
function createBridgeExpressApp({ host }: { host: string }): Express {
	const app = express();
	app.use(
		LOCALHOST_HOSTS.includes(host)
			? localhostHostValidation()
			: hostHeaderValidation([host, ...LOCALHOST_HOSTS]),
	);
	app.use(express.json({ limit: MCP_JSON_LIMIT }));
	return app;
}

/** The opencut repo root: the chat's Claude Code runs there (apps/bridge/src -> ../../..). */
export const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);

export interface BridgeServer {
	readonly hub: EditorHub;
	readonly jobs: JobTable;
	readonly registry: ToolRegistry;
	readonly mcp: McpEndpoint;
	readonly chat: ChatManager;
	readonly motion: MotionService;
	readonly app: Express;
	/** Starts listening; resolves with the bound port. */
	listen(): Promise<number>;
	close(): Promise<void>;
	health(): Record<string, unknown>;
}

export function createBridgeServer({
	config,
	logger,
	chatCwd = REPO_ROOT,
}: {
	config: BridgeConfig;
	logger: Logger;
	chatCwd?: string;
}): BridgeServer {
	const hub = createEditorHub({
		logger: logger.child("hub"),
		version: BRIDGE_VERSION,
	});
	const jobs = createJobTable({ logger: logger.child("jobs") });
	const prober = createProber({
		ffprobePath: config.ffprobePath,
		logger: logger.child("probe"),
	});
	const files = createFileRegistry({
		// Rendered motion blocks are served to the tab like any imported file.
		getRoots: () => [...config.allowedRoots, config.motionDir],
		ttlMs: config.fileTokenTtlMs,
		logger: logger.child("files"),
	});
	const uploads = createExportUploads({
		jobs,
		getExportsDir: () => config.exportsDir,
		maxBytes: config.maxExportBytes,
		logger: logger.child("exports"),
		probeDuration: async (filePath) => {
			const stats = await stat(filePath);
			return (
				await prober.probe({
					path: filePath,
					size: stats.size,
					mtimeMs: stats.mtimeMs,
				})
			)?.duration;
		},
	});
	const mediaIndex = createMediaIndex({
		dataDir: config.dataDir,
		logger: logger.child("media-index"),
	});
	const motion = createMotionService({
		dataDir: config.dataDir,
		motionDir: config.motionDir,
		packs: config.motionPacks,
		logger: logger.child("motion"),
	});
	const registry = createToolRegistry({
		hub,
		jobs,
		files,
		uploads,
		mediaIndex,
		motion,
		prober,
		config,
		logger: logger.child("tools"),
	});
	const mcp = createMcpEndpoint({
		registry,
		logger: logger.child("mcp"),
		version: BRIDGE_VERSION,
	});
	const chat = createChatManager({
		config,
		registry,
		jobs,
		logger: logger.child("chat"),
		cwd: chatCwd,
		emit: (sessionKey, event) => {
			hub.broadcastChatEvent(sessionKey, event);
		},
	});

	hub.onTabEvent((event) => jobs.applyTabEvent(event));
	hub.onConnectionClosed((connectionId) =>
		jobs.failJobsOfConnection(connectionId),
	);
	hub.onChatMessage((message) => chat.handle(message));
	// A tab that reloaded (or reconnected) lost the permission prompts shown before: the turn still waits on them.
	hub.onTabHello(() => {
		chat.resendPendingPermissions();
	});

	function health(): Record<string, unknown> {
		const status = hub.getStatus();
		return {
			ok: true,
			version: BRIDGE_VERSION,
			tab: {
				connected: status.connected,
				role: status.role,
				projectId: status.projectId,
				projectName: status.projectName,
				path: status.activeTab?.path ?? null,
				tabs: status.tabs,
				stateVersion: status.stateVersion,
			},
			sessions: { mcp: mcp.count(), chat: chat.count() },
			jobs: {
				running: jobs
					.list()
					.filter((job) => job.status === "running" || job.status === "queued")
					.length,
			},
		};
	}

	const app = createBridgeExpressApp({ host: config.host });
	app.disable("x-powered-by");
	app.get("/health", (_req: Request, res: Response) =>
		sendJson({ res, status: 200, body: health() }),
	);
	app.all("/mcp", (req: Request, res: Response, next: NextFunction) => {
		mcp.handle({ req, res }).catch(next);
	});
	app.all(
		`${BRIDGE_FILES_PATH}/:id`,
		(req: Request, res: Response, next: NextFunction) => {
			files.handle({ req, res, id: String(req.params.id) }).catch(next);
		},
	);
	app.all(
		`${BRIDGE_EXPORTS_PATH}/:jobId`,
		(req: Request, res: Response, next: NextFunction) => {
			uploads.handle({ req, res, jobId: String(req.params.jobId) }).catch(next);
		},
	);
	registerMotionRoutes({
		app,
		hub,
		motion,
		registry,
		logger: logger.child("motion-http"),
	});
	app.use((_req: Request, res: Response) =>
		sendJson({ res, status: 404, body: { error: "not found" } }),
	);
	app.use(
		(error: unknown, req: Request, res: Response, _next: NextFunction) => {
			const status =
				typeof error === "object" &&
				error !== null &&
				typeof Reflect.get(error, "status") === "number"
					? Number(Reflect.get(error, "status"))
					: 500;
			logger.error("request failed", {
				method: req.method,
				path: req.path,
				status,
				error: error instanceof Error ? error.message : String(error),
			});
			sendJson({
				res,
				status,
				body: {
					error:
						status === 500
							? "internal error"
							: String((error as Error).message ?? "error"),
				},
			});
		},
	);

	let server: Server | null = null;

	return {
		hub,
		jobs,
		registry,
		mcp,
		chat,
		motion,
		app,
		health,
		listen() {
			return new Promise<number>((resolve, reject) => {
				const listening = app.listen(config.port, config.host);
				listening.once("error", reject);
				listening.once("listening", () => {
					listening.off("error", reject);
					server = listening;
					hub.attach(listening);
					const port = (listening.address() as AddressInfo).port;
					logger.info("sidecar listening", {
						url: `http://${config.host}:${port}`,
						ws: `ws://${config.host}:${port}${EDITOR_WS_PATH}`,
					});
					resolve(port);
				});
			});
		},
		async close() {
			await chat.close();
			await mcp.close();
			await hub.close();
			jobs.dispose();
			if (server) {
				const closing = server;
				server = null;
				await new Promise<void>((resolve) => {
					closing.close(() => resolve());
					closing.closeAllConnections?.();
				});
			}
		},
	};
}
