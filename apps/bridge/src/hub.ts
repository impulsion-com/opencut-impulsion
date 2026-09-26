import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
	EDITOR_ORIGIN,
	EDITOR_WS_PATH,
	encodeHubMessage,
	parseTabMessage,
	PROTOCOL_VERSION,
	type ChatEvent,
	type ChatInterruptMessage,
	type ChatPermissionResponseMessage,
	type ChatResetMessage,
	type ChatSendMessage,
	type HelloMessage,
	type HubMessage,
	type RpcMethod,
	type TabEventMessage,
	type TabMessage,
	type ToolResult,
	type WelcomeMessage,
} from "@opencut/claude-tools";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { BridgeError, bridgeErrorFromPayload } from "./errors";
import type { Logger } from "./log";

// The WebSocket hub the editor tab connects to (ws://127.0.0.1:3457/editor). One socket per tab; one tab is
// "active" and receives every rpc, the others are "passive". A hello only takes the role when no tab holds it
// (or when it comes from the active tab itself, on a new socket); a tab takes over with claim-active, which the
// tab sends on its own when it was active before a reconnect or was just opened in the foreground. An active tab
// that drops keeps the role for RECONNECT_GRACE_MS, so a reload gets it back instead of a background tab. The
// hub tracks the active tab's project and stateVersion from its events, forwards job progress and chat messages
// to the sidecar, and broadcasts chat events to every tab.

/** Per-method timeouts: captures 30 s, imports 30 min, edits 60 s, everything else (reads, UI) 15 s. */
export const DEFAULT_CALL_TIMEOUT_MS = 15_000;
export const METHOD_TIMEOUTS_MS: Readonly<Partial<Record<RpcMethod, number>>> =
	{
		capture_frame: 30_000,
		capture_contact_sheet: 30_000,
		peek_media: 30_000,
		apply_edit_plan: 60_000,
		mark_ranges: 60_000,
		undo: 60_000,
		redo: 60_000,
		remove_media: 60_000,
		create_project: 60_000,
		switch_scene: 60_000,
		save_project: 60_000,
		open_project: 120_000,
		"internal.import_files": 30 * 60_000,
		"internal.export_start": 30_000,
	};

export function timeoutFor(method: RpcMethod): number {
	return METHOD_TIMEOUTS_MS[method] ?? DEFAULT_CALL_TIMEOUT_MS;
}

const HEARTBEAT_MS = 20_000;
/**
 * A call made right after the tab dropped (reload, HMR) waits this long for it to come back; the active role is
 * kept for that tab as long, before another tab is promoted.
 */
export const RECONNECT_GRACE_MS = 5_000;
/** ...but only if a tab was connected this recently. */
const RECENT_DISCONNECT_MS = 15_000;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

export interface HubCallOptions {
	/** Defaults to timeoutFor(method). */
	timeoutMs?: number;
	/** Aborting rejects the call at once (the tab may still finish it). */
	signal?: AbortSignal;
	/** When a string, the tab answers PROJECT_MISMATCH if another project is open. */
	projectId?: string | null;
	/** One per Claude tool call; lets the tab answer a re-delivery from its cache. Defaults to a new UUID. */
	idempotencyKey?: string;
	/** Overrides how long to wait for a tab that just dropped. */
	waitForTabMs?: number;
	/** Called with the connection the rpc was sent to. */
	onDispatch?: (info: { connectionId: string; tabId: string }) => void;
}

export interface HubTabInfo {
	connectionId: string;
	tabId: string;
	path: string;
	projectId: string | null;
	projectName: string | null;
	appVersion: string;
	role: "active" | "passive";
}

export interface HubStatus {
	connected: boolean;
	role: "active" | "passive" | null;
	tabs: number;
	activeTab: HubTabInfo | null;
	projectId: string | null;
	projectName: string | null;
	stateVersion: number | null;
}

export type ChatTabMessage =
	| ChatSendMessage
	| ChatInterruptMessage
	| ChatResetMessage
	| ChatPermissionResponseMessage;

export interface EditorHub {
	/** Hand an HTTP upgrade to the hub (returns false when the path is not EDITOR_WS_PATH). */
	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
	/** Listens for upgrades on `server`; returns a detach function. */
	attach(server: Server): () => void;
	call(
		method: RpcMethod,
		params: unknown,
		options?: HubCallOptions,
	): Promise<ToolResult>;
	getStatus(): HubStatus;
	isConnected(): boolean;
	getActiveProjectId(): string | null;
	getActiveProjectName(): string | null;
	getStateVersion(): number | null;
	/** Sends a chat event to every connected tab; returns how many got it. */
	broadcastChatEvent(sessionKey: string, event: ChatEvent): number;
	onTabEvent(
		listener: (
			event: TabEventMessage,
			info: { connectionId: string; active: boolean },
		) => void,
	): () => void;
	onChatMessage(
		listener: (message: ChatTabMessage, info: { connectionId: string }) => void,
	): () => void;
	onConnectionClosed(listener: (connectionId: string) => void): () => void;
	/** Called after a tab's hello was answered (a new tab, a reload or a reconnection). */
	onTabHello(listener: (connectionId: string) => void): () => void;
	close(): Promise<void>;
}

interface Connection {
	id: string;
	socket: WebSocket;
	alive: boolean;
	hello: HelloMessage | null;
	/** Order of claims (0: never claimed); promotion picks the highest. */
	rank: number;
	projectId: string | null;
	projectName: string | null;
	path: string;
}

interface PendingCall {
	id: string;
	method: RpcMethod;
	connectionId: string;
	startedAt: number;
	resolve: (result: ToolResult) => void;
	reject: (error: BridgeError) => void;
	cleanup: () => void;
}

export function createEditorHub({
	logger,
	version,
	now = () => Date.now(),
	heartbeatMs = HEARTBEAT_MS,
	reconnectGraceMs = RECONNECT_GRACE_MS,
}: {
	logger: Logger;
	version: string;
	now?: () => number;
	heartbeatMs?: number;
	reconnectGraceMs?: number;
}): EditorHub {
	const wss = new WebSocketServer({
		noServer: true,
		path: EDITOR_WS_PATH,
		maxPayload: MAX_PAYLOAD_BYTES,
		// WebSockets bypass CORS: this Origin check is what keeps other websites off the hub.
		verifyClient: (
			info: { origin: string; req: IncomingMessage },
			callback: (ok: boolean, code?: number, message?: string) => void,
		) => {
			const originOk = info.origin === EDITOR_ORIGIN;
			const hostOk = isAllowedHost(info.req.headers.host);
			if (!originOk || !hostOk) {
				logger.warn("refused websocket", {
					origin: info.origin ?? "(none)",
					host: info.req.headers.host ?? "(none)",
				});
				callback(false, 403, "Forbidden");
				return;
			}
			callback(true);
		},
	});

	const connections = new Map<string, Connection>();
	const pending = new Map<string, PendingCall>();
	const tabEventListeners = new Set<
		(
			event: TabEventMessage,
			info: { connectionId: string; active: boolean },
		) => void
	>();
	const chatListeners = new Set<
		(message: ChatTabMessage, info: { connectionId: string }) => void
	>();
	const closeListeners = new Set<(connectionId: string) => void>();
	const helloListeners = new Set<(connectionId: string) => void>();
	const connectionWaiters = new Set<() => void>();

	let activeId: string | null = null;
	let rankCounter = 0;
	let stateVersion: number | null = null;
	let lastDisconnectAt = 0;
	let closed = false;
	/** The active tab that just dropped: its tabId gets the role back on hello until the timer promotes another. */
	let droppedActive: {
		tabId: string;
		timer: ReturnType<typeof setTimeout>;
	} | null = null;

	function clearDroppedActive(): void {
		if (!droppedActive) return;
		clearTimeout(droppedActive.timer);
		droppedActive = null;
	}

	const heartbeat = setInterval(() => {
		for (const connection of connections.values()) {
			if (!connection.alive) {
				logger.warn("tab missed a heartbeat, closing", {
					connectionId: connection.id,
				});
				connection.socket.terminate();
				continue;
			}
			connection.alive = false;
			try {
				connection.socket.ping();
			} catch {
				// The close handler cleans up.
			}
		}
	}, heartbeatMs);
	heartbeat.unref?.();

	function active(): Connection | null {
		return activeId ? (connections.get(activeId) ?? null) : null;
	}

	function send(connection: Connection, message: HubMessage): boolean {
		if (connection.socket.readyState !== WebSocket.OPEN) return false;
		connection.socket.send(encodeHubMessage(message));
		return true;
	}

	function activeTabInfo(): WelcomeMessage["activeTab"] {
		const current = active();
		if (!current?.hello) return null;
		return {
			tabId: current.hello.tabId,
			projectId: current.projectId,
			projectName: current.projectName,
			path: current.path,
		};
	}

	function welcomeAll({ only }: { only?: "passive" } = {}): void {
		const activeTab = activeTabInfo();
		for (const connection of connections.values()) {
			if (!connection.hello) continue;
			const role = connection.id === activeId ? "active" : "passive";
			if (only === "passive" && role !== "passive") continue;
			send(connection, {
				type: "welcome",
				protocolVersion: PROTOCOL_VERSION,
				role,
				sidecarVersion: version,
				activeTab,
			});
		}
	}

	function setActive(connection: Connection | null): void {
		const previous = activeId;
		activeId = connection?.id ?? null;
		if (previous !== activeId) {
			// The new active tab re-sends project-changed and state-changed after its welcome.
			stateVersion = null;
			logger.info("active tab changed", {
				connectionId: activeId ?? "(none)",
				tabId: connection?.hello?.tabId,
				projectId: connection?.projectId ?? undefined,
			});
		}
		welcomeAll();
		if (connection) {
			for (const wake of connectionWaiters) wake();
			connectionWaiters.clear();
		}
	}

	function promoteLatest(): void {
		let best: Connection | null = null;
		for (const connection of connections.values()) {
			if (connection.hello && (!best || connection.rank > best.rank))
				best = connection;
		}
		setActive(best);
	}

	function handleMessage(
		connection: Connection,
		data: RawData,
		isBinary: boolean,
	): void {
		if (isBinary) {
			logger.warn("ignored a binary frame", { connectionId: connection.id });
			return;
		}
		const text = rawToString(data);
		const parsed = parseTabMessage(text);
		if (!parsed.ok) {
			failMalformedResult({ connection, text, error: parsed.error });
			logger.warn("ignored a malformed tab frame", {
				connectionId: connection.id,
				error: parsed.error,
			});
			return;
		}
		const message: TabMessage = parsed.message;
		if (message.type === "hello") {
			handleHello(connection, message);
			return;
		}
		if (!connection.hello) {
			logger.warn("ignored a frame sent before hello", {
				connectionId: connection.id,
				type: message.type,
			});
			return;
		}
		switch (message.type) {
			case "rpc-result":
				handleRpcResult(connection, message);
				return;
			case "event":
				handleEvent(connection, message);
				return;
			case "claim-active":
				clearDroppedActive();
				connection.rank = ++rankCounter;
				setActive(connection);
				return;
			case "chat.send":
			case "chat.interrupt":
			case "chat.reset":
			case "chat.permission_response":
				for (const listener of chatListeners) {
					try {
						listener(message, { connectionId: connection.id });
					} catch (error) {
						logger.error("chat listener failed", { error });
					}
				}
				return;
		}
	}

	function handleHello(connection: Connection, message: HelloMessage): void {
		if (message.protocolVersion !== PROTOCOL_VERSION) {
			logger.warn("protocol version mismatch", {
				tab: message.protocolVersion,
				sidecar: PROTOCOL_VERSION,
			});
		}
		connection.hello = message;
		connection.path = message.path;
		connection.projectId = message.projectId;
		logger.info("tab hello", {
			connectionId: connection.id,
			tabId: message.tabId,
			path: message.path,
			projectId: message.projectId ?? undefined,
			appVersion: message.appVersion,
		});
		const current = active();
		const takesRole =
			// The tab that just dropped, back within the grace (reload, HMR, a blip).
			droppedActive?.tabId === message.tabId ||
			// The active tab on a new socket, before its old one was seen closing.
			current?.hello?.tabId === message.tabId ||
			// Nobody holds the role, and no dropped tab is expected back.
			(!current && !droppedActive);
		if (takesRole) {
			clearDroppedActive();
			connection.rank = ++rankCounter;
			setActive(connection);
		} else {
			// Another tab drives: this one is passive until it claims the role.
			welcomeAll({ only: "passive" });
		}
		for (const listener of helloListeners) {
			try {
				listener(connection.id);
			} catch (error) {
				logger.error("hello listener failed", { error });
			}
		}
	}

	function handleRpcResult(
		connection: Connection,
		message: Extract<TabMessage, { type: "rpc-result" }>,
	): void {
		const call = pending.get(message.id);
		if (!call) {
			logger.debug("result for an unknown or finished call", {
				id: message.id,
			});
			return;
		}
		if (call.connectionId !== connection.id) {
			logger.warn("result from another tab ignored", {
				id: message.id,
				connectionId: connection.id,
			});
			return;
		}
		call.cleanup();
		const ms = now() - call.startedAt;
		if (message.ok) {
			logger.debug("rpc ok", { method: call.method, ms });
			call.resolve(message.result);
		} else {
			logger.info("rpc error", {
				method: call.method,
				code: message.error.code,
				ms,
			});
			call.reject(bridgeErrorFromPayload(message.error));
		}
	}

	/** A result the schema refused (e.g. an invalid ToolResult) fails its call now instead of at the timeout. */
	function failMalformedResult({
		connection,
		text,
		error,
	}: {
		connection: Connection;
		text: string;
		error: string;
	}): void {
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			return;
		}
		if (typeof raw !== "object" || raw === null) return;
		const type: unknown = Reflect.get(raw, "type");
		const id: unknown = Reflect.get(raw, "id");
		if (type !== "rpc-result" || typeof id !== "string") return;
		const call = pending.get(id);
		if (!call || call.connectionId !== connection.id) return;
		call.cleanup();
		call.reject(
			new BridgeError({
				code: "INTERNAL",
				message: `The editor tab sent a malformed result: ${error}`,
			}),
		);
	}

	function handleEvent(connection: Connection, event: TabEventMessage): void {
		const isActive = connection.id === activeId;
		if (event.name === "state-changed") {
			// Passive tabs never drive the tools: their view of the project is irrelevant.
			if (!isActive) return;
			stateVersion = event.payload.version;
			connection.projectId = event.payload.projectId;
		} else if (event.name === "project-changed") {
			if (!isActive) return;
			const changed =
				connection.projectId !== event.payload.projectId ||
				connection.projectName !== event.payload.name ||
				connection.path !== event.payload.path;
			connection.projectId = event.payload.projectId;
			connection.projectName = event.payload.name;
			connection.path = event.payload.path;
			if (changed) {
				logger.info("project changed", {
					projectId: event.payload.projectId ?? "(none)",
					path: event.payload.path,
				});
				welcomeAll({ only: "passive" });
			}
		}
		for (const listener of tabEventListeners) {
			try {
				listener(event, { connectionId: connection.id, active: isActive });
			} catch (error) {
				logger.error("tab event listener failed", { error });
			}
		}
	}

	function handleClose(connection: Connection, code: number): void {
		if (!connections.has(connection.id)) return;
		connections.delete(connection.id);
		lastDisconnectAt = now();
		logger.info("tab disconnected", {
			connectionId: connection.id,
			tabId: connection.hello?.tabId,
			code,
		});
		for (const call of [...pending.values()]) {
			if (call.connectionId !== connection.id) continue;
			call.cleanup();
			call.reject(
				new BridgeError({
					code: "CONNECTION_LOST",
					message: `The editor tab disconnected while running ${call.method}.`,
				}),
			);
		}
		for (const listener of closeListeners) {
			try {
				listener(connection.id);
			} catch (error) {
				logger.error("close listener failed", { error });
			}
		}
		if (activeId !== connection.id) return;
		const tabId = connection.hello?.tabId;
		setActive(null);
		const others = [...connections.values()].some((other) => other.hello);
		if (!tabId || !others) return;
		// Keep the role for this tab for the grace: a reload must not hand the editor to a background tab.
		clearDroppedActive();
		const timer = setTimeout(() => {
			droppedActive = null;
			if (!active()) promoteLatest();
		}, reconnectGraceMs);
		timer.unref?.();
		droppedActive = { tabId, timer };
	}

	function onConnection(socket: WebSocket, req: IncomingMessage): void {
		const connection: Connection = {
			id: randomUUID(),
			socket,
			alive: true,
			hello: null,
			rank: 0,
			projectId: null,
			projectName: null,
			path: "",
		};
		connections.set(connection.id, connection);
		logger.info("tab connected", {
			connectionId: connection.id,
			remote: req.socket.remoteAddress,
		});
		socket.on("pong", () => {
			connection.alive = true;
		});
		socket.on("message", (data, isBinary) => {
			try {
				handleMessage(connection, data, isBinary);
			} catch (error) {
				logger.error("tab frame handling failed", { error });
			}
		});
		socket.on("close", (code) => handleClose(connection, code));
		socket.on("error", (error) => {
			logger.warn("tab socket error", { connectionId: connection.id, error });
		});
	}

	function waitForActive(
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<Connection | null> {
		const current = active();
		if (current || timeoutMs <= 0) return Promise.resolve(current);
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", done);
				connectionWaiters.delete(done);
				resolve(active());
			};
			const timer = setTimeout(done, timeoutMs);
			signal?.addEventListener("abort", done, { once: true });
			connectionWaiters.add(done);
		});
	}

	async function call(
		method: RpcMethod,
		params: unknown,
		options: HubCallOptions = {},
	): Promise<ToolResult> {
		if (closed)
			throw new BridgeError({
				code: "EDITOR_NOT_CONNECTED",
				message: "The sidecar is shutting down.",
			});
		if (options.signal?.aborted) throw cancelledError(method);
		let target = active();
		if (!target) {
			const justDropped = now() - lastDisconnectAt < RECENT_DISCONNECT_MS;
			const handshaking = [...connections.values()].some(
				(connection) => !connection.hello,
			);
			const grace =
				options.waitForTabMs ??
				(justDropped || handshaking ? reconnectGraceMs : 0);
			target = await waitForActive(grace, options.signal);
			if (options.signal?.aborted) throw cancelledError(method);
		}
		if (!target?.hello) {
			throw new BridgeError({
				code: "EDITOR_NOT_CONNECTED",
				message: "No editor tab is connected to the sidecar.",
			});
		}
		const connection = target;
		const tabId = connection.hello?.tabId ?? "";
		const timeoutMs = options.timeoutMs ?? timeoutFor(method);
		const id = randomUUID();
		return new Promise<ToolResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.get(id)?.cleanup();
				logger.warn("rpc timeout", { method, timeoutMs });
				reject(
					new BridgeError({
						code: "TIMEOUT",
						message: `The editor did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.`,
					}),
				);
			}, timeoutMs);
			const onAbort = () => {
				pending.get(id)?.cleanup();
				reject(cancelledError(method));
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });
			pending.set(id, {
				id,
				method,
				connectionId: connection.id,
				startedAt: now(),
				resolve,
				reject,
				cleanup: () => {
					clearTimeout(timer);
					options.signal?.removeEventListener("abort", onAbort);
					pending.delete(id);
				},
			});
			try {
				const sent = send(connection, {
					type: "rpc",
					id,
					method,
					params: params ?? {},
					...(typeof options.projectId === "string"
						? { projectId: options.projectId }
						: {}),
					timeoutMs,
					idempotencyKey: options.idempotencyKey ?? randomUUID(),
				});
				if (!sent)
					throw new BridgeError({
						code: "CONNECTION_LOST",
						message: "The editor tab socket is closing.",
					});
				options.onDispatch?.({ connectionId: connection.id, tabId });
			} catch (error) {
				pending.get(id)?.cleanup();
				reject(
					error instanceof BridgeError
						? error
						: new BridgeError({
								code: "INTERNAL",
								message: `Could not send ${method}: ${String(error)}`,
							}),
				);
			}
		});
	}

	function handleUpgrade(
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	): boolean {
		const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
		if (pathname !== EDITOR_WS_PATH || closed) return false;
		wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req));
		return true;
	}

	return {
		handleUpgrade,
		attach(server) {
			const listener = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
				if (!handleUpgrade(req, socket, head)) {
					socket.end(
						"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
					);
				}
			};
			server.on("upgrade", listener);
			return () => server.off("upgrade", listener);
		},
		call,
		getStatus() {
			const current = active();
			const info: HubTabInfo | null = current?.hello
				? {
						connectionId: current.id,
						tabId: current.hello.tabId,
						path: current.path,
						projectId: current.projectId,
						projectName: current.projectName,
						appVersion: current.hello.appVersion,
						role: "active",
					}
				: null;
			const helloCount = [...connections.values()].filter(
				(connection) => connection.hello,
			).length;
			return {
				connected: info !== null,
				role: info ? "active" : helloCount > 0 ? "passive" : null,
				tabs: helloCount,
				activeTab: info,
				projectId: info?.projectId ?? null,
				projectName: info?.projectName ?? null,
				stateVersion,
			};
		},
		isConnected: () => active()?.hello != null,
		getActiveProjectId: () => active()?.projectId ?? null,
		getActiveProjectName: () => active()?.projectName ?? null,
		getStateVersion: () => stateVersion,
		broadcastChatEvent(sessionKey, event) {
			let count = 0;
			for (const connection of connections.values()) {
				if (!connection.hello) continue;
				try {
					if (send(connection, { type: "chat.event", sessionKey, event }))
						count += 1;
				} catch (error) {
					logger.warn("could not send a chat event", {
						type: event.type,
						error,
					});
					return count;
				}
			}
			return count;
		},
		onTabEvent(listener) {
			tabEventListeners.add(listener);
			return () => {
				tabEventListeners.delete(listener);
			};
		},
		onChatMessage(listener) {
			chatListeners.add(listener);
			return () => {
				chatListeners.delete(listener);
			};
		},
		onConnectionClosed(listener) {
			closeListeners.add(listener);
			return () => {
				closeListeners.delete(listener);
			};
		},
		onTabHello(listener) {
			helloListeners.add(listener);
			return () => {
				helloListeners.delete(listener);
			};
		},
		async close() {
			closed = true;
			clearInterval(heartbeat);
			clearDroppedActive();
			for (const wake of connectionWaiters) wake();
			connectionWaiters.clear();
			for (const connection of connections.values()) {
				try {
					connection.socket.close(1001, "sidecar shutting down");
				} catch {
					connection.socket.terminate();
				}
			}
			await new Promise<void>((resolve) => wss.close(() => resolve()));
			for (const connection of connections.values())
				connection.socket.terminate();
		},
	};
}

function cancelledError(method: RpcMethod): BridgeError {
	return new BridgeError({
		code: "TIMEOUT",
		message: `The ${method} call was cancelled before the editor answered.`,
	});
}

function isAllowedHost(host: string | undefined): boolean {
	if (!host) return false;
	try {
		return ALLOWED_HOSTNAMES.has(new URL(`http://${host}`).hostname);
	} catch {
		return false;
	}
}

function rawToString(data: RawData): string {
	if (typeof data === "string") return data;
	if (Buffer.isBuffer(data)) return data.toString("utf8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
	return Buffer.from(data).toString("utf8");
}
