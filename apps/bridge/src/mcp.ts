import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EDITOR_RULES } from "@opencut/claude-tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { originOf, sendJson } from "./http-utils";
import type { Logger } from "./log";
import { registerToolsOnServer, type ToolRegistry } from "./tools";
import { MCP_SERVER_NAME } from "./version";

// Stateful Streamable HTTP MCP endpoint at /mcp, shared by every Claude Code session (profiles A and B, parallel
// terminals). One McpServer + transport per MCP session; sessions end on DELETE, on transport close, or after a
// day without requests. Mounted behind the server's Express app, which refuses Host headers other than localhost.

const IDLE_SESSION_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 100;

interface Session {
	id: string;
	server: McpServer;
	transport: StreamableHTTPServerTransport;
	lastSeen: number;
}

export interface McpEndpoint {
	handle(options: {
		req: IncomingMessage & { body?: unknown };
		res: ServerResponse;
	}): Promise<void>;
	count(): number;
	close(): Promise<void>;
}

function rpcError({
	res,
	status,
	message,
}: {
	res: ServerResponse;
	status: number;
	message: string;
}): void {
	sendJson({
		res,
		status,
		body: { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
	});
}

export function createMcpEndpoint({
	registry,
	logger,
	version,
	now = () => Date.now(),
}: {
	registry: ToolRegistry;
	logger: Logger;
	version: string;
	now?: () => number;
}): McpEndpoint {
	const sessions = new Map<string, Session>();

	function buildServer(): McpServer {
		const server = new McpServer(
			{ name: MCP_SERVER_NAME, version },
			{ instructions: EDITOR_RULES },
		);
		registerToolsOnServer({
			server,
			registry,
			getOrigin: ({ sessionId }) => ({
				kind: "mcp",
				...(sessionId ? { sessionId } : {}),
			}),
			logger,
		});
		return server;
	}

	async function closeSession(session: Session, reason: string): Promise<void> {
		if (!sessions.delete(session.id)) return;
		logger.info("mcp session closed", { sessionId: session.id, reason });
		await session.transport.close().catch(() => {});
		await session.server.close().catch(() => {});
	}

	const sweep = setInterval(() => {
		const at = now();
		for (const session of sessions.values()) {
			if (at - session.lastSeen > IDLE_SESSION_MS)
				void closeSession(session, "idle");
		}
	}, SWEEP_EVERY_MS);
	sweep.unref?.();

	async function handle({
		req,
		res,
	}: {
		req: IncomingMessage & { body?: unknown };
		res: ServerResponse;
	}): Promise<void> {
		// Claude Code never sends an Origin; a browser always does. No website may talk to /mcp.
		if (originOf(req) !== undefined) {
			rpcError({ res, status: 403, message: "Forbidden origin" });
			return;
		}
		const header = req.headers["mcp-session-id"];
		const sessionId = Array.isArray(header) ? header[0] : header;
		if (sessionId) {
			const session = sessions.get(sessionId);
			if (!session) {
				rpcError({ res, status: 404, message: "Session not found" });
				return;
			}
			session.lastSeen = now();
			await session.transport.handleRequest(req, res, req.body);
			return;
		}
		if (req.method !== "POST" || !isInitializeRequest(req.body)) {
			rpcError({
				res,
				status: 400,
				message: "Bad Request: No valid session ID provided",
			});
			return;
		}
		if (sessions.size >= MAX_SESSIONS) {
			const oldest = [...sessions.values()].sort(
				(a, b) => a.lastSeen - b.lastSeen,
			)[0];
			if (oldest) await closeSession(oldest, "too many sessions");
		}
		const server = buildServer();
		const transport: StreamableHTTPServerTransport =
			new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessioninitialized: (id) => {
					sessions.set(id, { id, server, transport, lastSeen: now() });
					logger.info("mcp session opened", {
						sessionId: id,
						sessions: sessions.size,
					});
				},
			});
		transport.onclose = () => {
			const id = transport.sessionId;
			const session = id ? sessions.get(id) : undefined;
			if (session) void closeSession(session, "transport closed");
		};
		await server.connect(transport);
		await transport.handleRequest(req, res, req.body);
	}

	return {
		handle,
		count: () => sessions.size,
		async close() {
			clearInterval(sweep);
			await Promise.all(
				[...sessions.values()].map((session) =>
					closeSession(session, "shutdown"),
				),
			);
		},
	};
}
