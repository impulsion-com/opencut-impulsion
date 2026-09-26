/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- test fakes stand in for EditorCore and friends */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import {
	parseTabMessage,
	PROTOCOL_VERSION,
	type HubMessage,
	type TabMessage,
} from "@opencut/claude-tools";
import type { EditorCore } from "@/core";
import {
	createClaudeBridgeClient,
	EDITOR_WS_URL,
	type BridgeSocket,
	type BridgeSocketEvents,
	type BridgeTimers,
	type ClaudeBridgeClient,
	type ClaudeBridgeDeps,
} from "@/claude/bridge/client";
import {
	BridgeError,
	jsonResult,
	toolResult,
	type TabHandlerContext,
	type UntypedTabHandler,
} from "@/claude/types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeSocket implements BridgeSocket {
	readonly sent: TabMessage[] = [];
	open = false;
	closed = false;

	readonly url: string;
	readonly events: BridgeSocketEvents;

	constructor({ url, events }: { url: string; events: BridgeSocketEvents }) {
		this.url = url;
		this.events = events;
	}

	send(data: string): void {
		const parsed = parseTabMessage(data);
		if (!parsed.ok)
			throw new Error(`the client sent an invalid frame: ${parsed.error}`);
		this.sent.push(parsed.message);
	}

	close(): void {
		this.closed = true;
		this.open = false;
	}

	isOpen(): boolean {
		return this.open;
	}

	acceptOpen(): void {
		this.open = true;
		this.events.onOpen();
	}

	receive(message: HubMessage | Record<string, unknown> | string): void {
		this.events.onMessage(
			typeof message === "string" ? message : JSON.stringify(message),
		);
	}

	serverClose(): void {
		this.open = false;
		this.events.onClose();
	}

	ofType<T extends TabMessage["type"]>(
		type: T,
	): Extract<TabMessage, { type: T }>[] {
		return this.sent.filter(
			(message): message is Extract<TabMessage, { type: T }> =>
				message.type === type,
		);
	}

	rpcResult(id: string) {
		return this.ofType("rpc-result").find((message) => message.id === id);
	}

	events_(name: string) {
		return this.ofType("event").filter((message) => message.name === name);
	}
}

class ManualTimers implements BridgeTimers {
	now = 0;
	private nextId = 1;
	private queue: { id: number; at: number; callback: () => void }[] = [];

	schedule({
		callback,
		delayMs,
	}: {
		callback: () => void;
		delayMs: number;
	}): unknown {
		const id = this.nextId++;
		this.queue.push({ id, at: this.now + delayMs, callback });
		return id;
	}

	cancel(handle: unknown): void {
		this.queue = this.queue.filter((entry) => entry.id !== handle);
	}

	delays(): number[] {
		return this.queue.map((entry) => entry.at - this.now);
	}

	advance(ms: number): void {
		const target = this.now + ms;
		for (;;) {
			const due = this.queue
				.filter((entry) => entry.at <= target)
				.sort((a, b) => a.at - b.at || a.id - b.id)[0];
			if (!due) break;
			this.queue = this.queue.filter((entry) => entry !== due);
			this.now = due.at;
			due.callback();
		}
		this.now = target;
	}
}

interface FakeProject {
	metadata: { id: string; name: string };
	settings: { fps: { numerator: number; denominator: number } };
}

function createFakeEditor() {
	const listeners = {
		project: new Set<() => void>(),
		scenes: new Set<() => void>(),
		timeline: new Set<() => void>(),
		media: new Set<() => void>(),
	};
	type Manager = keyof typeof listeners;
	const subscribe = (manager: Manager) => (listener: () => void) => {
		listeners[manager].add(listener);
		return () => {
			listeners[manager].delete(listener);
		};
	};
	const scene = {
		id: "s1",
		name: "Scène principale",
		tracks: { overlay: [], main: { id: "main", elements: [] }, audio: [] },
		bookmarks: [],
	};
	const state = {
		project: {
			metadata: { id: "p1", name: "Reel" },
			settings: { fps: { numerator: 30, denominator: 1 } },
		} as FakeProject | null,
		scene: scene as typeof scene | null,
		scenes: [scene] as unknown[],
		assets: [] as unknown[],
	};
	const editor = {
		project: {
			getActiveOrNull: () => state.project,
			subscribe: subscribe("project"),
		},
		scenes: {
			getActiveSceneOrNull: () => state.scene,
			getScenes: () => state.scenes,
			subscribe: subscribe("scenes"),
		},
		timeline: { subscribe: subscribe("timeline") },
		media: { getAssets: () => state.assets, subscribe: subscribe("media") },
	};
	return {
		editor: editor as unknown as EditorCore,
		state,
		notify: (manager: Manager) => {
			for (const listener of listeners[manager]) listener();
		},
		listenerCount: () =>
			Object.values(listeners).reduce((total, set) => total + set.size, 0),
		/** An edit: new tracks object (structural sharing gives every change a new reference). */
		editTracks: () => {
			if (!state.scene) return;
			state.scene = { ...state.scene, tracks: { ...state.scene.tracks } };
			state.scenes = [state.scene];
		},
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function memoryRoleStore(initial: "active" | "passive" | null = null) {
	let role = initial;
	return {
		read: () => role,
		write: (next: "active" | "passive") => {
			role = next;
		},
	};
}

function setup(
	overrides: Partial<ClaudeBridgeDeps> & {
		handlers?: Record<string, UntypedTabHandler>;
	} = {},
) {
	const sockets: FakeSocket[] = [];
	const timers = new ManualTimers();
	const fake = createFakeEditor();
	const handlers: Record<string, UntypedTabHandler> = overrides.handlers ?? {};
	const client: ClaudeBridgeClient = createClaudeBridgeClient({
		createSocket: ({ url, events }) => {
			const socket = new FakeSocket({ url, events });
			sockets.push(socket);
			return socket;
		},
		getEditor: () => fake.editor,
		getHandler: (method) => handlers[method],
		loadHandlers: async () => undefined,
		getPath: () => "/editor/p1",
		getTabId: () => "tab-test",
		appVersion: "9.9.9",
		timers,
		now: () => timers.now,
		isBrowser: () => true,
		roleMemory: memoryRoleStore(),
		isVisible: () => false,
		...overrides,
	});
	const last = () => {
		const socket = sockets[sockets.length - 1];
		if (!socket) throw new Error("no socket was created");
		return socket;
	};
	/** Starts, opens the socket and completes the handshake as the active tab. */
	const connectActive = () => {
		client.start();
		last().acceptOpen();
		last().receive({
			type: "welcome",
			protocolVersion: PROTOCOL_VERSION,
			role: "active",
			sidecarVersion: "0.1.0",
			activeTab: {
				tabId: "tab-test",
				projectId: "p1",
				projectName: "Reel",
				path: "/editor/p1",
			},
		});
		return last();
	};
	return { client, sockets, timers, fake, handlers, last, connectActive };
}

let restoreConsole: () => void = () => {};

beforeEach(() => {
	const { warn, error } = console;
	console.warn = mock(() => {});
	console.error = mock(() => {});
	restoreConsole = () => {
		console.warn = warn;
		console.error = error;
	};
});

afterEach(() => restoreConsole());

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

describe("claude bridge client: connection", () => {
	test("does nothing outside the browser", () => {
		const { client, sockets } = setup({ isBrowser: () => false });
		client.start();
		expect(sockets.length).toBe(0);
		expect(client.getStatus()).toEqual({ connection: "closed", role: null });
		expect(client.isStarted()).toBe(false);
	});

	test("connects to the hub and says hello once the socket opens", () => {
		const { client, sockets, last } = setup();
		client.start();
		client.start();
		expect(sockets.length).toBe(1);
		expect(last().url).toBe(EDITOR_WS_URL);
		expect(EDITOR_WS_URL).toBe("ws://127.0.0.1:3457/editor");
		expect(client.getStatus().connection).toBe("connecting");

		last().acceptOpen();
		expect(client.getStatus()).toEqual({ connection: "open", role: null });
		expect(last().sent).toEqual([
			{
				type: "hello",
				protocolVersion: PROTOCOL_VERSION,
				tabId: "tab-test",
				path: "/editor/p1",
				projectId: "p1",
				appVersion: "9.9.9",
			},
		]);
	});

	test("welcome sets the role; becoming active re-sends project and state", () => {
		const { client, connectActive } = setup();
		const statuses: string[] = [];
		client.subscribeStatus((status) =>
			statuses.push(`${status.connection}/${status.role}`),
		);
		const socket = connectActive();

		expect(client.getStatus()).toMatchObject({
			connection: "open",
			role: "active",
			sidecarVersion: "0.1.0",
			activeTab: { tabId: "tab-test" },
		});
		expect(statuses).toEqual(["connecting/null", "open/null", "open/active"]);
		expect(socket.events_("project-changed")).toEqual([
			{
				type: "event",
				name: "project-changed",
				payload: { projectId: "p1", name: "Reel", path: "/editor/p1" },
			},
		]);
		expect(socket.events_("state-changed")).toEqual([
			{
				type: "event",
				name: "state-changed",
				payload: { version: 0, projectId: "p1" },
			},
		]);

		socket.receive({
			type: "welcome",
			protocolVersion: PROTOCOL_VERSION,
			role: "passive",
			sidecarVersion: "0.1.0",
			activeTab: null,
		});
		expect(client.getStatus().role).toBe("passive");
		expect(socket.events_("state-changed").length).toBe(1);
	});

	test("a tab that was active claims the role back when its first welcome says passive; a passive one does not", () => {
		const passiveWelcome = {
			type: "welcome",
			protocolVersion: PROTOCOL_VERSION,
			role: "passive",
			sidecarVersion: "0.1.0",
			activeTab: {
				tabId: "other",
				projectId: "p9",
				projectName: "Ancien",
				path: "/editor/p9",
			},
		} as const;
		const claims = (socket: FakeSocket) =>
			socket.sent.filter((message) => message.type === "claim-active").length;

		// Sidecar restarted and a background tab said hello first: the working tab takes the role back.
		const memory = memoryRoleStore("active");
		const working = setup({ roleMemory: memory });
		working.client.start();
		working.last().acceptOpen();
		working.last().receive(passiveWelcome);
		expect(claims(working.last())).toBe(1);
		expect(working.client.getStatus().role).toBeNull();
		working.last().receive({ ...passiveWelcome, role: "active" });
		expect(working.client.getStatus().role).toBe("active");
		expect(memory.read()).toBe("active");
		// Demoted later by another tab: remembered, so its next reconnection stays passive.
		working.last().receive(passiveWelcome);
		expect(claims(working.last())).toBe(1);
		expect(memory.read()).toBe("passive");

		const background = setup({ roleMemory: memoryRoleStore("passive") });
		background.client.start();
		background.last().acceptOpen();
		background.last().receive(passiveWelcome);
		expect(claims(background.last())).toBe(0);
		expect(background.client.getStatus().role).toBe("passive");

		// A tab opened in the foreground takes over; one opened in the background does not.
		const opened = setup({ isVisible: () => true });
		opened.client.start();
		opened.last().acceptOpen();
		opened.last().receive(passiveWelcome);
		expect(claims(opened.last())).toBe(1);
		const hidden = setup({ isVisible: () => false });
		hidden.client.start();
		hidden.last().acceptOpen();
		hidden.last().receive(passiveWelcome);
		expect(claims(hidden.last())).toBe(0);
	});

	test("reconnects with exponential backoff capped at 15 s, reset by a welcome", () => {
		const { client, sockets, timers, last } = setup();
		client.start();
		const waits: number[] = [];
		for (let attempt = 0; attempt < 6; attempt += 1) {
			last().serverClose();
			expect(client.getStatus()).toEqual({ connection: "closed", role: null });
			const [delay] = timers.delays();
			waits.push(delay ?? -1);
			timers.advance(delay ?? 0);
		}
		expect(waits).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
		expect(sockets.length).toBe(7);

		// A completed handshake resets the backoff.
		last().acceptOpen();
		last().receive({
			type: "welcome",
			protocolVersion: PROTOCOL_VERSION,
			role: "active",
			sidecarVersion: "0.1.0",
			activeTab: null,
		});
		last().serverClose();
		expect(timers.delays()).toEqual([1000]);
		client.stop();
		expect(timers.delays()).toEqual([]);
	});

	test("events of a replaced socket are ignored", () => {
		const { client, sockets, last } = setup();
		client.start();
		const first = last();
		client.reconnect();
		expect(sockets.length).toBe(2);
		expect(first.closed).toBe(true);
		first.events.onOpen();
		first.events.onClose();
		expect(client.getStatus().connection).toBe("connecting");
		expect(first.sent).toEqual([]);
	});

	test("retain survives a StrictMode remount and stops once released", () => {
		const { client, sockets, timers, fake } = setup();
		const releaseFirst = client.retain();
		releaseFirst();
		const releaseSecond = client.retain();
		timers.advance(10);
		expect(sockets.length).toBe(1);
		expect(sockets[0]?.closed).toBe(false);
		expect(client.isStarted()).toBe(true);

		releaseSecond();
		releaseSecond();
		timers.advance(1);
		expect(sockets[0]?.closed).toBe(true);
		expect(client.isStarted()).toBe(false);
		expect(fake.listenerCount()).toBe(0);
	});

	test("send refuses while disconnected and validates messages", () => {
		const { client, last } = setup();
		expect(client.claimActive()).toBe(false);
		client.start();
		last().acceptOpen();
		expect(client.claimActive()).toBe(true);
		expect(last().ofType("claim-active")).toEqual([{ type: "claim-active" }]);
		expect(
			client.send({
				type: "chat.send",
				sessionKey: "",
				text: "x",
			} as TabMessage),
		).toBe(false);
		expect(
			client.send({
				type: "chat.send",
				sessionKey: "p1",
				text: "Coupe le début",
			}),
		).toBe(true);
	});

	test("chat events reach subscribers until they unsubscribe", () => {
		const { client, connectActive } = setup();
		const socket = connectActive();
		const received: string[] = [];
		const unsubscribe = client.onChatEvent((message) => {
			if (message.event.type === "text_delta")
				received.push(message.event.text);
		});
		socket.receive({
			type: "chat.event",
			sessionKey: "p1",
			event: { type: "text_delta", text: "Je coupe" },
		});
		unsubscribe();
		socket.receive({
			type: "chat.event",
			sessionKey: "p1",
			event: { type: "text_delta", text: " ignoré" },
		});
		expect(received).toEqual(["Je coupe"]);
	});
});

// ---------------------------------------------------------------------------
// RPC dispatch
// ---------------------------------------------------------------------------

describe("claude bridge client: rpc dispatch", () => {
	test("runs the handler with parsed params and a fresh editor, then replies ok", async () => {
		const calls: { input: unknown; ctx: TabHandlerContext }[] = [];
		const { connectActive, fake } = setup({
			handlers: {
				capture_frame: async (input, ctx) => {
					calls.push({ input, ctx });
					return toolResult({
						json: { time: 12.4, width: 1080, height: 1920 },
						text: "frame @12.400s 1080x1920",
					});
				},
			},
		});
		const socket = connectActive();
		socket.receive({
			type: "rpc",
			id: "r1",
			method: "capture_frame",
			params: { time: 12.4 },
			projectId: "p1",
		});
		await flush();

		expect(calls.length).toBe(1);
		expect(calls[0]?.input).toEqual({ time: 12.4 });
		expect(calls[0]?.ctx.editor).toBe(fake.editor);
		expect(calls[0]?.ctx.method).toBe("capture_frame");
		expect(calls[0]?.ctx.signal?.aborted).toBe(false);
		expect(socket.rpcResult("r1")).toEqual({
			type: "rpc-result",
			id: "r1",
			ok: true,
			result: {
				json: { time: 12.4, width: 1080, height: 1920 },
				text: "frame @12.400s 1080x1920",
			},
		});
	});

	test("invalid params answer INVALID_PARAMS with issues and never reach the handler", async () => {
		const handler = mock(async () => jsonResult({}));
		const { connectActive } = setup({ handlers: { capture_frame: handler } });
		const socket = connectActive();
		socket.receive({
			type: "rpc",
			id: "r2",
			method: "capture_frame",
			params: { time: -1, extra: true },
		});
		await flush();

		const result = socket.rpcResult("r2");
		expect(handler).not.toHaveBeenCalled();
		expect(result?.ok).toBe(false);
		if (result?.ok === false) {
			expect(result.error.code).toBe("INVALID_PARAMS");
			expect(result.error.message).toContain("time");
			expect(
				(result.error.details as { issues: unknown[] }).issues.length,
			).toBeGreaterThanOrEqual(2);
		}
	});

	test("internal methods are validated with INTERNAL_METHOD_PARAMS", async () => {
		const handler = mock(async () => jsonResult({ imported: [], skipped: [] }));
		const { connectActive } = setup({
			handlers: { "internal.import_files": handler },
		});
		const socket = connectActive();
		const file = {
			path: "/Users/me/videos/a.mp4",
			name: "a.mp4",
			size: 10,
			mimeType: "video/mp4",
		};
		socket.receive({
			type: "rpc",
			id: "bad",
			method: "internal.import_files",
			params: { files: [{ ...file, url: "https://evil.example/files/a" }] },
		});
		socket.receive({
			type: "rpc",
			id: "good",
			method: "internal.import_files",
			params: { files: [{ ...file, url: "http://127.0.0.1:3457/files/f1" }] },
		});
		await flush();

		expect(socket.rpcResult("bad")).toMatchObject({
			ok: false,
			error: { code: "INVALID_PARAMS" },
		});
		expect(socket.rpcResult("good")).toMatchObject({
			ok: true,
			result: { json: { imported: [], skipped: [] } },
		});
		expect(handler).toHaveBeenCalledTimes(1);
	});

	test("maps handler errors: BridgeError keeps its code, zod becomes INVALID_PARAMS, anything else INTERNAL", async () => {
		const { connectActive } = setup({
			handlers: {
				get_element: async () => {
					throw new BridgeError({
						code: "NOT_FOUND",
						message: 'Element "e9" does not exist.',
						details: { elementId: "e9" },
					});
				},
				seek: async () => {
					z.number().parse("douze");
					return jsonResult({});
				},
				play: async () => {
					throw new Error("renderer exploded");
				},
			},
		});
		const socket = connectActive();
		socket.receive({
			type: "rpc",
			id: "a",
			method: "get_element",
			params: { elementId: "e9" },
		});
		socket.receive({
			type: "rpc",
			id: "b",
			method: "seek",
			params: { time: 1 },
		});
		socket.receive({ type: "rpc", id: "c", method: "play", params: {} });
		await flush();

		expect(socket.rpcResult("a")).toEqual({
			type: "rpc-result",
			id: "a",
			ok: false,
			error: {
				code: "NOT_FOUND",
				message: 'Element "e9" does not exist.',
				details: { elementId: "e9" },
			},
		});
		expect(socket.rpcResult("b")).toMatchObject({
			ok: false,
			error: { code: "INVALID_PARAMS" },
		});
		expect(socket.rpcResult("c")).toMatchObject({
			ok: false,
			error: { code: "INTERNAL", message: "renderer exploded" },
		});
	});

	test("a method without a handler answers INTERNAL", async () => {
		const { connectActive } = setup();
		const socket = connectActive();
		socket.receive({
			type: "rpc",
			id: "r3",
			method: "list_capabilities",
			params: {},
		});
		await flush();
		const result = socket.rpcResult("r3");
		expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
		if (result?.ok === false)
			expect(result.error.message).toContain("list_capabilities");
	});

	test("answers PROJECT_MISMATCH when another project is open", async () => {
		const handler = mock(async () => jsonResult({ ok: true }));
		const { connectActive, fake } = setup({
			handlers: { save_project: handler },
		});
		const socket = connectActive();
		socket.receive({
			type: "rpc",
			id: "m1",
			method: "save_project",
			params: {},
			projectId: "p2",
		});
		socket.receive({
			type: "rpc",
			id: "m2",
			method: "save_project",
			params: {},
			projectId: null,
		});
		socket.receive({
			type: "rpc",
			id: "m3",
			method: "save_project",
			params: {},
			projectId: "p1",
		});
		await flush();
		fake.state.project = null;
		socket.receive({
			type: "rpc",
			id: "m4",
			method: "save_project",
			params: {},
			projectId: "p1",
		});
		await flush();

		expect(socket.rpcResult("m1")).toMatchObject({
			ok: false,
			error: {
				code: "PROJECT_MISMATCH",
				details: { expected: "p2", open: "p1" },
			},
		});
		expect(socket.rpcResult("m2")?.ok).toBe(true);
		expect(socket.rpcResult("m3")?.ok).toBe(true);
		expect(socket.rpcResult("m4")).toMatchObject({
			ok: false,
			error: { code: "PROJECT_MISMATCH", details: { open: null } },
		});
		expect(handler).toHaveBeenCalledTimes(2);
	});

	test("an invalid handler result answers INTERNAL", async () => {
		const { connectActive } = setup({
			handlers: {
				pause: async () =>
					({ images: [{ data: "", mimeType: "image/gif" }] }) as never,
			},
		});
		const socket = connectActive();
		socket.receive({ type: "rpc", id: "r4", method: "pause", params: {} });
		await flush();
		expect(socket.rpcResult("r4")).toMatchObject({
			ok: false,
			error: { code: "INTERNAL" },
		});
	});

	test("a result that cannot be serialised still gets an answer", async () => {
		const { connectActive } = setup({
			handlers: { pause: async () => jsonResult({ big: BigInt(1) }) },
		});
		const socket = connectActive();
		socket.receive({ type: "rpc", id: "r5", method: "pause", params: {} });
		await flush();
		expect(socket.rpcResult("r5")).toMatchObject({
			ok: false,
			error: { code: "INTERNAL" },
		});
	});

	test("a repeated idempotencyKey runs once and answers both deliveries with the first result", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handler = mock(async () => {
			await gate;
			return jsonResult({ applied: true });
		});
		const { connectActive, sockets, client, last } = setup({
			handlers: { apply_edit_plan: handler },
		});
		const first = connectActive();
		const params = { ops: [{ op: "delete", elementIds: ["e1"] }] };
		first.receive({
			type: "rpc",
			id: "r6",
			method: "apply_edit_plan",
			params,
			idempotencyKey: "call-1",
		});

		// The socket drops while the edit runs; the hub re-delivers the call on the new socket.
		first.serverClose();
		client.reconnect();
		const second = last();
		second.acceptOpen();
		second.receive({
			type: "rpc",
			id: "r7",
			method: "apply_edit_plan",
			params,
			idempotencyKey: "call-1",
		});
		release();
		await flush();

		expect(sockets.length).toBe(2);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(first.rpcResult("r6")).toBeUndefined();
		expect(second.rpcResult("r7")).toMatchObject({
			ok: true,
			result: { json: { applied: true } },
		});

		// Later repeats (within the TTL) are answered from the cache too.
		second.receive({
			type: "rpc",
			id: "r8",
			method: "apply_edit_plan",
			params,
			idempotencyKey: "call-1",
		});
		await flush();
		expect(handler).toHaveBeenCalledTimes(1);
		expect(second.rpcResult("r8")).toMatchObject({ ok: true });
	});

	test("read-only calls are never cached, even with a repeated idempotencyKey (their frames are heavy)", async () => {
		const handler = mock(async () =>
			jsonResult({ stateVersion: 1 }),
		);
		const { connectActive } = setup({
			handlers: { get_editor_state: handler },
		});
		const socket = connectActive();
		for (const id of ["q1", "q2"]) {
			socket.receive({
				type: "rpc",
				id,
				method: "get_editor_state",
				params: {},
				idempotencyKey: "same-key",
			});
			await flush();
		}
		expect(handler).toHaveBeenCalledTimes(2);
		expect(socket.rpcResult("q2")).toMatchObject({ ok: true });
	});

	test("rpc frames with an unknown method or bad fields still get an answer", async () => {
		const { connectActive } = setup();
		const socket = connectActive();
		socket.receive({ type: "rpc", id: "u1", method: "rm_rf", params: {} });
		socket.receive({
			type: "rpc",
			id: "u2",
			method: "play",
			params: {},
			timeoutMs: -5,
		});
		socket.receive("{not json");
		await flush();
		expect(socket.rpcResult("u1")).toMatchObject({
			ok: false,
			error: { code: "INTERNAL" },
		});
		expect(socket.rpcResult("u2")).toMatchObject({
			ok: false,
			error: { code: "INVALID_PARAMS" },
		});
		expect(socket.ofType("rpc-result").length).toBe(2);
	});

	test("timeoutMs aborts the handler's signal; stop aborts running calls", async () => {
		const signals: AbortSignal[] = [];
		const { connectActive, timers, client } = setup({
			handlers: {
				capture_contact_sheet: (_input, ctx) =>
					new Promise(() => {
						if (ctx.signal) signals.push(ctx.signal);
					}),
			},
		});
		const socket = connectActive();
		socket.receive({
			type: "rpc",
			id: "t1",
			method: "capture_contact_sheet",
			params: {},
			timeoutMs: 500,
		});
		socket.receive({
			type: "rpc",
			id: "t2",
			method: "capture_contact_sheet",
			params: {},
		});
		await flush();
		expect(signals.length).toBe(2);
		timers.advance(499);
		expect(signals[0]?.aborted).toBe(false);
		timers.advance(1);
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
		client.stop();
		expect(signals[1]?.aborted).toBe(true);
	});

	test("reportProgress sends throttled job-progress events with a default kind", async () => {
		const { connectActive, timers } = setup({
			handlers: {
				"internal.import_files": async (_input, ctx) => {
					ctx.reportProgress({
						jobId: "job-1",
						progress: 0.1,
						phase: "copying",
					});
					ctx.reportProgress({
						jobId: "job-1",
						progress: 0.2,
						phase: "copying",
					});
					timers.now += 150;
					ctx.reportProgress({
						jobId: "job-1",
						progress: 0.5,
						phase: "copying",
						message: "a.mp4",
					});
					ctx.reportProgress({
						jobId: "job-1",
						progress: 0.6,
						phase: "probing",
					});
					ctx.reportProgress({
						jobId: "job-1",
						progress: 1.4,
						phase: "probing",
					});
					return jsonResult({ imported: [], skipped: [] });
				},
			},
		});
		const socket = connectActive();
		socket.receive({
			type: "rpc",
			id: "p1",
			method: "internal.import_files",
			params: {
				jobId: "job-1",
				files: [
					{
						path: "/a.mp4",
						url: "http://127.0.0.1:3457/files/f1",
						name: "a.mp4",
						size: 1,
						mimeType: "video/mp4",
					},
				],
			},
		});
		await flush();
		const progress = socket
			.events_("job-progress")
			.map((event) => event.payload);
		expect(progress).toEqual([
			{ jobId: "job-1", kind: "import", phase: "copying", progress: 0.1 },
			{
				jobId: "job-1",
				kind: "import",
				phase: "copying",
				progress: 0.5,
				message: "a.mp4",
			},
			{ jobId: "job-1", kind: "import", phase: "probing", progress: 0.6 },
			{ jobId: "job-1", kind: "import", phase: "probing", progress: 1 },
		]);
	});
});

// ---------------------------------------------------------------------------
// State version
// ---------------------------------------------------------------------------

describe("claude bridge client: stateVersion", () => {
	test("bumps synchronously on real changes only, and debounces state-changed by 150 ms", () => {
		const { client, connectActive, fake, timers } = setup();
		const socket = connectActive();
		const initial = socket.events_("state-changed").length;
		expect(client.getStateVersion()).toBe(0);

		// A notification without a new reference (playback, selection, zoom...) is not a change.
		fake.notify("timeline");
		expect(client.getStateVersion()).toBe(0);

		fake.editTracks();
		fake.notify("timeline");
		expect(client.getStateVersion()).toBe(1);
		fake.editTracks();
		fake.notify("scenes");
		expect(client.getStateVersion()).toBe(2);

		timers.advance(149);
		expect(socket.events_("state-changed").length).toBe(initial);
		timers.advance(1);
		expect(socket.events_("state-changed").slice(initial)).toEqual([
			{
				type: "event",
				name: "state-changed",
				payload: { version: 2, projectId: "p1" },
			},
		]);
	});

	test("a steady stream of edits still reports within 1 s", () => {
		const { connectActive, fake, timers } = setup();
		const socket = connectActive();
		const initial = socket.events_("state-changed").length;
		for (let i = 0; i < 12; i += 1) {
			fake.editTracks();
			fake.notify("timeline");
			timers.advance(100);
		}
		expect(socket.events_("state-changed").length).toBeGreaterThan(initial);
	});

	test("media, settings and bookmarks count; getStateVersion catches changes made before any notification", () => {
		const { client, connectActive, fake } = setup();
		connectActive();
		fake.state.assets = [{ id: "m1" }];
		fake.notify("media");
		expect(client.getStateVersion()).toBe(1);
		if (fake.state.project)
			fake.state.project = {
				...fake.state.project,
				settings: { fps: { numerator: 25, denominator: 1 } },
			};
		expect(client.getStateVersion()).toBe(2);
	});

	test("project-changed is sent when another project opens, only while active", () => {
		const { connectActive, fake } = setup();
		const socket = connectActive();
		const before = socket.events_("project-changed").length;
		fake.state.project = {
			metadata: { id: "p2", name: "Podcast" },
			settings: { fps: { numerator: 25, denominator: 1 } },
		};
		fake.notify("project");
		expect(socket.events_("project-changed").slice(before)).toEqual([
			{
				type: "event",
				name: "project-changed",
				payload: { projectId: "p2", name: "Podcast", path: "/editor/p1" },
			},
		]);

		socket.receive({
			type: "welcome",
			protocolVersion: PROTOCOL_VERSION,
			role: "passive",
			sidecarVersion: "0.1.0",
			activeTab: null,
		});
		fake.state.project = null;
		fake.notify("project");
		expect(socket.events_("project-changed").length).toBe(before + 1);
	});

	test("stateVersion starts at the load time, so a reloaded tab never reuses an earlier version", () => {
		const first = setup({ now: () => 1_000 });
		first.connectActive();
		first.fake.editTracks();
		first.fake.notify("timeline");
		const firstVersions = first.client.getStateVersion();
		expect(firstVersions).toBe(1_001);
		const reloaded = setup({ now: () => 2_000 });
		reloaded.connectActive();
		expect(reloaded.client.getStateVersion()).toBeGreaterThan(firstVersions);
		expect(reloaded.client.getStateVersion()).toBe(2_000);
	});

	test("notifyNavigation re-sends project-changed once the path moved", () => {
		let path = "/projects";
		const { client, connectActive } = setup({ getPath: () => path });
		const socket = connectActive();
		const sent = () => socket.events_("project-changed");
		const before = sent().length;
		expect(sent().at(-1)).toMatchObject({ payload: { path: "/projects" } });

		client.notifyNavigation();
		expect(sent().length).toBe(before);

		path = "/editor/p1";
		client.notifyNavigation();
		expect(sent().length).toBe(before + 1);
		expect(sent().at(-1)).toMatchObject({
			payload: { projectId: "p1", path: "/editor/p1" },
		});
		client.notifyNavigation();
		expect(sent().length).toBe(before + 1);
	});

	test("handlers read the same version through ctx", async () => {
		const versions: number[] = [];
		const { connectActive, fake } = setup({
			handlers: {
				get_editor_state: async (_input, ctx) => {
					versions.push(ctx.getStateVersion());
					fake.editTracks();
					fake.notify("timeline");
					versions.push(ctx.getStateVersion());
					return jsonResult({ stateVersion: ctx.getStateVersion() });
				},
			},
		});
		const socket = connectActive();
		socket.receive({
			type: "rpc",
			id: "v1",
			method: "get_editor_state",
			params: {},
		});
		await flush();
		expect(versions).toEqual([0, 1]);
		expect(socket.rpcResult("v1")).toMatchObject({
			ok: true,
			result: { json: { stateVersion: 1 } },
		});
	});
});
