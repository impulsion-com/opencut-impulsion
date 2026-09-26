import {
	BRIDGE_HOST,
	BRIDGE_PORT,
	EDITOR_WS_PATH,
	encodeTabMessage,
	parseHubMessage,
	PROTOCOL_VERSION,
	type ChatEventMessage,
	type TabMessage,
	type WelcomeMessage,
} from "@opencut/claude-tools";
import { EditorCore } from "@/core";
import { getTabHandler } from "@/claude/handlers/registry";
import type { UntypedTabHandler } from "@/claude/types";
import {
	browserTimers,
	createBrowserSocket,
	getBrowserPath,
	getSessionTabId,
	isBrowserEnvironment,
	isDocumentVisible,
	sessionRoleMemory,
	type BridgeRoleMemory,
	type BridgeSocket,
	type BridgeTimers,
	type CreateBridgeSocket,
} from "./environment";
import {
	createRpcDispatcher,
	outcomeForMalformedRpc,
	type RpcOutcome,
} from "./rpc-dispatcher";
import { createStateTracker } from "./state-tracker";

export type {
	BridgeSocket,
	BridgeSocketEvents,
	BridgeTimers,
	CreateBridgeSocket,
} from "./environment";
export type { RpcOutcome } from "./rpc-dispatcher";

// The tab side of the bridge: one WebSocket to the sidecar hub (ws://127.0.0.1:3457/editor). It says hello,
// learns its role, serves "rpc" calls (rpc-dispatcher.ts), forwards chat events to the panel and reports state
// changes (state-tracker.ts). Framework-free and SSR-safe: nothing touches the browser before start().

export const EDITOR_WS_URL = `ws://${BRIDGE_HOST}:${BRIDGE_PORT}${EDITOR_WS_PATH}`;
/** Sent in hello (keep in step with apps/web/package.json). */
export const TAB_APP_VERSION = "0.1.0";

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

export type BridgeConnectionState = "connecting" | "open" | "closed";
export type BridgeRole = "active" | "passive";

export interface BridgeStatus {
	connection: BridgeConnectionState;
	/** null until the hub's welcome, and while disconnected. */
	role: BridgeRole | null;
	sidecarVersion?: string;
	/** The tab that drives the editor tools, from the last welcome (lets a passive tab say which). */
	activeTab?: WelcomeMessage["activeTab"];
}

export interface ClaudeBridgeDeps {
	url?: string;
	createSocket?: CreateBridgeSocket;
	/** The editor to serve and watch; resolved again on every call (HMR). */
	getEditor?: () => EditorCore | null;
	getHandler?: (method: string) => UntypedTabHandler | undefined;
	/** Loads and registers the handler modules; RPCs wait for it. */
	loadHandlers?: () => Promise<unknown>;
	getPath?: () => string;
	getTabId?: () => string;
	appVersion?: string;
	timers?: BridgeTimers;
	now?: () => number;
	isBrowser?: () => boolean;
	/** Where the tab keeps its last role (sessionStorage in the browser). */
	roleMemory?: BridgeRoleMemory;
	isVisible?: () => boolean;
}

export interface ClaudeBridgeClient {
	/** Connects (browser only). Idempotent. */
	start(): void;
	/** True between start() and stop(), including while waiting to reconnect. */
	isStarted(): boolean;
	/** Disconnects, aborts running calls and stops reconnecting. */
	stop(): void;
	/** Ref-counted start for React effects; the returned release stops on the next tick once nobody holds it. */
	retain(): () => void;
	/** Drops the current socket and reconnects now, resetting the backoff (e.g. a "Reconnecter" button). */
	reconnect(): void;
	getStatus(): BridgeStatus;
	subscribeStatus(callback: (status: BridgeStatus) => void): () => void;
	/** Validates and sends; false when the socket is not open or the message is malformed. */
	send(message: TabMessage): boolean;
	onChatEvent(callback: (message: ChatEventMessage) => void): () => void;
	/** Asks the hub to make this tab the active one ("take control"). */
	claimActive(): boolean;
	/** Monotonic per tab load; bumped synchronously on every project, scene, track, bookmark or media change. */
	getStateVersion(): number;
	/**
	 * Call after a client-side navigation: re-sends project-changed with the new path if it moved (the project can
	 * open before the router reaches /editor/<id>, e.g. create_project, so the hub would keep "/projects").
	 */
	notifyNavigation(): void;
}

export function createClaudeBridgeClient(
	deps: ClaudeBridgeDeps = {},
): ClaudeBridgeClient {
	const url = deps.url ?? EDITOR_WS_URL;
	const createSocket = deps.createSocket ?? createBrowserSocket;
	const isBrowser = deps.isBrowser ?? isBrowserEnvironment;
	const getEditor =
		deps.getEditor ??
		(() => (typeof window === "undefined" ? null : EditorCore.getInstance()));
	const getHandler =
		deps.getHandler ?? ((method: string) => getTabHandler(method));
	const loadHandlers = deps.loadHandlers ?? (() => import("@/claude/handlers"));
	const getPath = deps.getPath ?? getBrowserPath;
	const getTabId = deps.getTabId ?? getSessionTabId;
	const appVersion = deps.appVersion ?? TAB_APP_VERSION;
	const timers = deps.timers ?? browserTimers;
	const now = deps.now ?? (() => Date.now());
	const roleMemory = deps.roleMemory ?? sessionRoleMemory;
	const isVisible = deps.isVisible ?? isDocumentVisible;

	let started = false;
	let socket: BridgeSocket | null = null;
	/** Bumped for every socket; events of older sockets are ignored. */
	let generation = 0;
	let reconnectDelay = RECONNECT_MIN_MS;
	let reconnectTimer: unknown = null;
	let handlersReady: Promise<unknown> = Promise.resolve();
	let tabId: string | null = null;
	let refCount = 0;
	let pendingStop: unknown = null;
	/**
	 * Decided when a socket opens: the hub only gives the role to a hello when nobody holds it, so a tab that was
	 * active before (reload after the grace, sidecar restart) or was just opened in the foreground claims it if
	 * its first welcome says passive. A background tab reconnecting stays passive.
	 */
	let claimOnWelcome = false;

	let status: BridgeStatus = { connection: "closed", role: null };
	const statusListeners = new Set<(status: BridgeStatus) => void>();
	const chatListeners = new Set<(message: ChatEventMessage) => void>();

	function setStatus(patch: Partial<BridgeStatus>): void {
		const next: BridgeStatus = { ...status, ...patch };
		if (
			next.connection === status.connection &&
			next.role === status.role &&
			next.sidecarVersion === status.sidecarVersion &&
			next.activeTab === status.activeTab
		) {
			return;
		}
		status = next;
		for (const listener of statusListeners) listener(status);
	}

	function sendTo({
		target,
		message,
	}: {
		target: BridgeSocket | null;
		message: TabMessage;
	}): boolean {
		if (!target || !target.isOpen()) return false;
		let frame: string;
		try {
			frame = encodeTabMessage(message);
		} catch (error) {
			console.error(
				"[claude] refused to send a malformed message",
				message.type,
				error,
			);
			return false;
		}
		try {
			target.send(frame);
			return true;
		} catch (error) {
			console.error("[claude] send failed", error);
			return false;
		}
	}

	function send(message: TabMessage): boolean {
		return sendTo({ target: socket, message });
	}

	// Tab-level events describe the editor the hub drives, so only the active tab sends them.
	const tracker = createStateTracker({
		getEditor,
		timers,
		now,
		onStateChanged: ({ version, projectId }) => {
			if (status.role !== "active") return;
			send({
				type: "event",
				name: "state-changed",
				payload: { version, projectId },
			});
		},
		onProjectChanged: () => sendProjectChanged(),
	});

	/** Path of the last project-changed sent on the current socket (null: none yet). */
	let lastSentPath: string | null = null;

	function sendProjectChanged(): void {
		if (status.role !== "active") return;
		const project = tracker.getProject();
		const path = getPath();
		if (
			send({
				type: "event",
				name: "project-changed",
				payload: { projectId: project.id, name: project.name, path },
			})
		) {
			lastSentPath = path;
		}
	}

	function notifyNavigation(): void {
		if (lastSentPath !== null && getPath() !== lastSentPath)
			sendProjectChanged();
	}

	const dispatcher = createRpcDispatcher({
		getHandler,
		whenHandlersReady: () => handlersReady,
		bindEditor: () => tracker.bind(),
		getStateVersion: () => tracker.getVersion(),
		sendEvent: (event) => {
			send(event);
		},
		timers,
		now,
	});

	/** Answers on the socket that delivered the call; a re-delivery after a reconnect is answered from the cache. */
	function reply({
		target,
		id,
		outcome,
	}: {
		target: BridgeSocket;
		id: string;
		outcome: RpcOutcome;
	}): void {
		const message: TabMessage = outcome.ok
			? { type: "rpc-result", id, ok: true, result: outcome.result }
			: { type: "rpc-result", id, ok: false, error: outcome.error };
		if (sendTo({ target, message }) || !target.isOpen()) return;
		// Could not be encoded (e.g. a BigInt or a cycle in json or details): answer with a plain error instead.
		sendTo({
			target,
			message: {
				type: "rpc-result",
				id,
				ok: false,
				error: outcome.ok
					? {
							code: "INTERNAL",
							message: "The tab could not serialise the result of this call.",
						}
					: { code: outcome.error.code, message: outcome.error.message },
			},
		});
	}

	function handleWelcome(message: WelcomeMessage): void {
		if (message.protocolVersion !== PROTOCOL_VERSION) {
			console.warn(
				`[claude] protocol mismatch: tab v${PROTOCOL_VERSION}, sidecar v${message.protocolVersion}. Restart the sidecar after pulling.`,
			);
		}
		reconnectDelay = RECONNECT_MIN_MS;
		if (claimOnWelcome) {
			claimOnWelcome = false;
			if (message.role === "passive" && send({ type: "claim-active" })) {
				// The hub answers with a new welcome; showing "passive" meanwhile would only flicker.
				setStatus({
					sidecarVersion: message.sidecarVersion,
					activeTab: message.activeTab,
				});
				return;
			}
		}
		roleMemory.write(message.role);
		const becameActive = message.role === "active" && status.role !== "active";
		setStatus({
			role: message.role,
			sidecarVersion: message.sidecarVersion,
			activeTab: message.activeTab,
		});
		if (becameActive) {
			// The hub's view may be stale (changes made while passive or disconnected are not sent).
			sendProjectChanged();
			tracker.flush();
		}
	}

	function handleFrame({
		data,
		target,
	}: {
		data: unknown;
		target: BridgeSocket;
	}): void {
		if (typeof data !== "string") {
			console.warn("[claude] ignored a binary frame from the hub");
			return;
		}
		const parsed = parseHubMessage(data);
		if (!parsed.ok) {
			console.warn("[claude] ignored a malformed hub frame:", parsed.error);
			let raw: unknown = null;
			try {
				raw = JSON.parse(data);
			} catch {
				// Not JSON: nothing to answer.
			}
			const answer = outcomeForMalformedRpc({ raw, error: parsed.error });
			if (answer) reply({ target, ...answer });
			return;
		}
		const message = parsed.message;
		switch (message.type) {
			case "welcome":
				handleWelcome(message);
				return;
			case "rpc":
				dispatcher.dispatch({
					message,
					respond: (outcome) => reply({ target, id: message.id, outcome }),
				});
				return;
			case "chat.event":
				for (const listener of chatListeners) {
					try {
						listener(message);
					} catch (error) {
						console.error("[claude] chat listener failed", error);
					}
				}
				return;
		}
	}

	function scheduleReconnect(): void {
		if (!started || reconnectTimer !== null) return;
		const delayMs = reconnectDelay;
		reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
		reconnectTimer = timers.schedule({
			callback: () => {
				reconnectTimer = null;
				connect();
			},
			delayMs,
		});
	}

	function connect(): void {
		if (!started) return;
		const current = ++generation;
		const isCurrent = () => current === generation;
		setStatus({ connection: "connecting", role: null });
		let created: BridgeSocket | null = null;
		try {
			created = createSocket({
				url,
				events: {
					onOpen: () => {
						if (!isCurrent() || !created) return;
						setStatus({ connection: "open" });
						const remembered = roleMemory.read();
						claimOnWelcome =
							remembered === "active" || (remembered === null && isVisible());
						tabId ??= getTabId();
						tracker.bind();
						sendTo({
							target: created,
							message: {
								type: "hello",
								protocolVersion: PROTOCOL_VERSION,
								tabId,
								path: getPath(),
								projectId: tracker.getProject().id,
								appVersion,
							},
						});
					},
					onMessage: (data) => {
						if (isCurrent() && created) handleFrame({ data, target: created });
					},
					onClose: () => {
						if (!isCurrent()) return;
						socket = null;
						setStatus({ connection: "closed", role: null });
						scheduleReconnect();
					},
				},
			});
		} catch (error) {
			console.warn("[claude] could not open the bridge socket", error);
			setStatus({ connection: "closed", role: null });
			scheduleReconnect();
			return;
		}
		socket = created;
	}

	function dropSocket(): void {
		generation += 1;
		const previous = socket;
		socket = null;
		try {
			previous?.close();
		} catch {
			// Already closed.
		}
	}

	function cancelPendingStop(): void {
		if (pendingStop !== null) timers.cancel(pendingStop);
		pendingStop = null;
	}

	function start(): void {
		cancelPendingStop();
		if (started || !isBrowser()) return;
		started = true;
		reconnectDelay = RECONNECT_MIN_MS;
		handlersReady = loadHandlers().catch((error: unknown) => {
			console.error("[claude] failed to load the tab handlers", error);
		});
		tracker.bind();
		connect();
	}

	function stop(): void {
		cancelPendingStop();
		if (!started) return;
		started = false;
		if (reconnectTimer !== null) timers.cancel(reconnectTimer);
		reconnectTimer = null;
		dropSocket();
		dispatcher.abortAll();
		tracker.unbind();
		setStatus({ connection: "closed", role: null });
	}

	function retain(): () => void {
		refCount += 1;
		start();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			refCount = Math.max(0, refCount - 1);
			if (refCount > 0 || pendingStop !== null) return;
			// Deferred: React StrictMode unmounts and remounts effects synchronously in dev.
			pendingStop = timers.schedule({
				callback: () => {
					pendingStop = null;
					if (refCount === 0) stop();
				},
				delayMs: 0,
			});
		};
	}

	function reconnect(): void {
		if (!started) {
			start();
			return;
		}
		if (reconnectTimer !== null) timers.cancel(reconnectTimer);
		reconnectTimer = null;
		reconnectDelay = RECONNECT_MIN_MS;
		dropSocket();
		connect();
	}

	return {
		start,
		isStarted: () => started,
		stop,
		retain,
		reconnect,
		getStatus: () => status,
		subscribeStatus(callback) {
			statusListeners.add(callback);
			return () => {
				statusListeners.delete(callback);
			};
		},
		send,
		onChatEvent(callback) {
			chatListeners.add(callback);
			return () => {
				chatListeners.delete(callback);
			};
		},
		claimActive: () => send({ type: "claim-active" }),
		getStateVersion: () => tracker.getVersion(),
		notifyNavigation,
	};
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

const GLOBAL_KEY = "__opencutClaudeBridge";

/** The tab's bridge. Start it with <ClaudeBridge/> (root layout); everything else just reads or sends. */
export const claudeBridge: ClaudeBridgeClient = createClaudeBridgeClient();

function isBridgeClient(value: unknown): value is ClaudeBridgeClient {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "stop") === "function" &&
		typeof Reflect.get(value, "isStarted") === "function"
	);
}

// HMR re-evaluates this module: close the previous instance's socket and carry its running state over, so the
// bridge keeps working even if React does not re-run <ClaudeBridge/>'s effect.
const previousBridge: unknown = Reflect.get(globalThis, GLOBAL_KEY);
Reflect.set(globalThis, GLOBAL_KEY, claudeBridge);
if (isBridgeClient(previousBridge) && previousBridge !== claudeBridge) {
	const wasStarted = previousBridge.isStarted();
	previousBridge.stop();
	if (wasStarted) claudeBridge.start();
}

/** Current stateVersion of this tab, for handlers (apply_edit_plan's expectStateVersion, results). */
export function getStateVersion(): number {
	return claudeBridge.getStateVersion();
}
