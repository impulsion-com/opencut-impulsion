import { beforeEach, describe, expect, test } from "bun:test";
import {
	DEFAULT_CHAT_MODEL,
	parseTabMessage,
	type ChatEvent,
	type ChatEventMessage,
	type TabMessage,
} from "@opencut/claude-tools";
import type { BridgeStatus } from "@/claude/bridge/client";
import type { BridgeTimers } from "@/claude/bridge/environment";
import {
	conversationStorageKey,
	createChatStore,
	PREFERENCES_STORAGE_KEY,
	resolvePanelKey,
	STOP_FALLBACK_MS,
	STOP_TIMEOUT_NOTICE,
	STOP_UNREACHABLE_NOTICE,
	type ChatBridge,
	type ChatStorage,
	type ChatStore,
} from "@/claude/chat/chat-store";
import { DISCONNECTED_NOTICE } from "@/claude/chat/chat-model";
import { getConnectionView } from "@/claude/chat/format";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeBridge implements ChatBridge {
	readonly sent: TabMessage[] = [];
	open = true;
	status: BridgeStatus = { connection: "open", role: "active" };
	private readonly statusListeners = new Set<(status: BridgeStatus) => void>();
	private readonly chatListeners = new Set<
		(message: ChatEventMessage) => void
	>();

	getStatus(): BridgeStatus {
		return this.status;
	}

	subscribeStatus(callback: (status: BridgeStatus) => void): () => void {
		this.statusListeners.add(callback);
		return () => this.statusListeners.delete(callback);
	}

	send(message: TabMessage): boolean {
		// Same validation as the real client: a malformed message would be refused there too.
		const parsed = parseTabMessage(JSON.parse(JSON.stringify(message)));
		if (!parsed.ok) throw new Error(`invalid message: ${parsed.error}`);
		if (!this.open) return false;
		this.sent.push(parsed.message);
		return true;
	}

	onChatEvent(callback: (message: ChatEventMessage) => void): () => void {
		this.chatListeners.add(callback);
		return () => this.chatListeners.delete(callback);
	}

	/** bridge.emit(key)(event, event...) delivers chat events as the hub would. */
	emit(sessionKey: string): (...events: ChatEvent[]) => void {
		return (...events) => {
			for (const event of events) {
				for (const listener of this.chatListeners) {
					listener({ type: "chat.event", sessionKey, event });
				}
			}
		};
	}

	setStatus(status: BridgeStatus): void {
		this.status = status;
		this.open = status.connection === "open";
		for (const listener of this.statusListeners) listener(status);
	}

	listenerCount(): number {
		return this.chatListeners.size + this.statusListeners.size;
	}

	ofType<T extends TabMessage["type"]>(
		type: T,
	): Extract<TabMessage, { type: T }>[] {
		return this.sent.filter(
			(message): message is Extract<TabMessage, { type: T }> =>
				message.type === type,
		);
	}
}

class MemoryStorage implements ChatStorage {
	readonly data = new Map<string, string>();
	writes = 0;

	read(key: string): string | null {
		return this.data.get(key) ?? null;
	}

	write({ key, value }: { key: string; value: string }): void {
		this.writes += 1;
		this.data.set(key, value);
	}

	remove(key: string): void {
		this.data.delete(key);
	}
}

class FakeTimers implements BridgeTimers {
	private readonly pending = new Map<
		number,
		{ callback: () => void; at: number }
	>();
	private nextHandle = 1;
	now = 0;

	schedule({
		callback,
		delayMs,
	}: {
		callback: () => void;
		delayMs: number;
	}): unknown {
		const handle = this.nextHandle++;
		this.pending.set(handle, { callback, at: this.now + delayMs });
		return handle;
	}

	cancel(handle: unknown): void {
		if (typeof handle === "number") this.pending.delete(handle);
	}

	advance(ms: number): void {
		this.now += ms;
		for (const [handle, entry] of [...this.pending]) {
			if (entry.at <= this.now) {
				this.pending.delete(handle);
				entry.callback();
			}
		}
	}

	size(): number {
		return this.pending.size;
	}
}

let bridge: FakeBridge;
let storage: MemoryStorage;
let timers: FakeTimers;
let store: ChatStore;

function makeStore(): ChatStore {
	const created = createChatStore({ bridge, storage, timers, now: () => 42 });
	created.getState().attachBridge();
	return created;
}

beforeEach(() => {
	bridge = new FakeBridge();
	storage = new MemoryStorage();
	timers = new FakeTimers();
	store = makeStore();
});

const KEY = "project-1";

function conversation(key = KEY) {
	const found = store.getState().conversations[key];
	if (!found) throw new Error(`no conversation for ${key}`);
	return found;
}

// ---------------------------------------------------------------------------

describe("sending", () => {
	test("a message goes out with the model and profile, and shows as a user bubble", () => {
		store.getState().setModel("claude-sonnet-5");
		expect(
			store
				.getState()
				.send({ sessionKey: KEY, text: "  Montre-moi la timeline \n" }),
		).toBe(true);
		expect(bridge.ofType("chat.send")).toEqual([
			{
				type: "chat.send",
				sessionKey: KEY,
				text: "Montre-moi la timeline",
				model: "claude-sonnet-5",
				profile: "A",
			},
		]);
		expect(conversation().items).toEqual([
			{ kind: "user", id: "i1", text: "Montre-moi la timeline", createdAt: 42 },
		]);
		expect(conversation().running).toBe(true);
	});

	test("nothing is recorded when the sidecar is unreachable, and blank text is ignored", () => {
		expect(store.getState().send({ sessionKey: KEY, text: "   " })).toBe(false);
		bridge.open = false;
		expect(store.getState().send({ sessionKey: KEY, text: "Salut" })).toBe(
			false,
		);
		expect(store.getState().conversations[KEY]?.items ?? []).toHaveLength(0);
	});

	test("a second message waits for the end of the turn", () => {
		store.getState().send({ sessionKey: KEY, text: "Un" });
		expect(store.getState().send({ sessionKey: KEY, text: "Deux" })).toBe(
			false,
		);
		bridge.emit(KEY)({ type: "turn_end", sessionId: "s1", durationMs: 5 });
		expect(store.getState().send({ sessionKey: KEY, text: "Deux" })).toBe(true);
	});

	test("events are routed by sessionKey", () => {
		store.getState().send({ sessionKey: KEY, text: "Un" });
		bridge.emit("other")({ type: "text_delta", text: "ailleurs" });
		bridge.emit(KEY)({ type: "text_delta", text: "ici" });
		expect(conversation().items.map((item) => item.kind)).toEqual([
			"user",
			"text",
		]);
		expect(conversation("other").items.map((item) => item.kind)).toEqual([
			"text",
		]);
	});
});

describe("resume after a reload", () => {
	test("the stored session id is sent once, on the first message after a reload", () => {
		store.getState().send({ sessionKey: KEY, text: "Un" });
		bridge.emit(KEY)(
			{
				type: "session",
				sessionId: "sdk-1",
				model: DEFAULT_CHAT_MODEL,
				apiKeySource: "none",
			},
			{ type: "text_delta", text: "Bonjour" },
			{ type: "turn_end", sessionId: "sdk-1", durationMs: 10 },
		);
		// The live session: no resume id.
		store.getState().send({ sessionKey: KEY, text: "Deux" });
		expect(
			bridge.ofType("chat.send").map((message) => message.resumeSessionId),
		).toEqual([undefined, undefined]);

		// Reload: a new store over the same storage.
		bridge.emit(KEY)({ type: "turn_end", sessionId: "sdk-1", durationMs: 10 });
		store.getState().detachBridge();
		bridge = new FakeBridge();
		store = makeStore();
		store.getState().ensureConversation(KEY);
		expect(conversation().items.map((item) => item.kind)).toEqual([
			"user",
			"text",
			"turn_end",
			"user",
			"turn_end",
		]);
		store.getState().send({ sessionKey: KEY, text: "Trois" });
		store.getState().receive({
			type: "chat.event",
			sessionKey: KEY,
			event: { type: "turn_end", sessionId: "sdk-1", durationMs: 1 },
		});
		store.getState().send({ sessionKey: KEY, text: "Quatre" });
		expect(
			bridge.ofType("chat.send").map((message) => message.resumeSessionId),
		).toEqual(["sdk-1", undefined]);
	});

	test("a session created under another profile is not offered for resume", () => {
		store.getState().send({ sessionKey: KEY, text: "Un" });
		bridge.emit(KEY)({ type: "turn_end", sessionId: "sdk-a", durationMs: 1 });
		store.getState().detachBridge();
		store = makeStore();
		store.getState().setProfile("B");
		store.getState().send({ sessionKey: KEY, text: "Deux" });
		const last = bridge.ofType("chat.send").at(-1);
		expect(last?.profile).toBe("B");
		expect(last?.resumeSessionId).toBeUndefined();
	});

	test("a dropped connection interrupts the turn and offers the session again", () => {
		store.getState().send({ sessionKey: KEY, text: "Un" });
		bridge.emit(KEY)(
			{ type: "session", sessionId: "sdk-1", model: "m", apiKeySource: "none" },
			{ type: "text_delta", text: "Je" },
		);
		bridge.setStatus({ connection: "closed", role: null });
		expect(conversation().running).toBe(false);
		expect(conversation().items.at(-1)).toMatchObject({
			kind: "notice",
			text: DISCONNECTED_NOTICE,
		});

		bridge.setStatus({ connection: "open", role: "active" });
		store.getState().send({ sessionKey: KEY, text: "Deux" });
		expect(bridge.ofType("chat.send").at(-1)?.resumeSessionId).toBe("sdk-1");
	});
});

describe("persistence", () => {
	test("streamed deltas are not written, the end of the turn is", () => {
		store.getState().send({ sessionKey: KEY, text: "Salut" });
		const afterSend = storage.writes;
		bridge.emit(KEY)(
			{ type: "text_delta", text: "a" },
			{ type: "text_delta", text: "b" },
			{ type: "thinking_delta", text: "c" },
			{
				type: "job",
				jobId: "j",
				kind: "export",
				status: "running",
				progress: 0.5,
			},
		);
		expect(storage.writes).toBe(afterSend);
		bridge.emit(KEY)({ type: "turn_end", sessionId: "s", durationMs: 1 });
		expect(storage.writes).toBe(afterSend + 1);
		const stored = storage.read(conversationStorageKey(KEY));
		expect(stored).toContain('"sessionId":"s"');
	});

	test("only the active tab writes what the sidecar streams; a tab becoming active reloads the stored copy", () => {
		// Tab 2 shares localStorage and receives the same events, but is passive: it never sent the message.
		const passiveBridge = new FakeBridge();
		passiveBridge.status = { connection: "open", role: "passive" };
		const passive = createChatStore({
			bridge: passiveBridge,
			storage,
			timers,
			now: () => 42,
		});
		passive.getState().attachBridge();
		passive.getState().ensureConversation(KEY);

		store.getState().send({ sessionKey: KEY, text: "Coupe les silences" });
		const events: ChatEvent[] = [
			{ type: "session", sessionId: "sdk-1", model: "m", apiKeySource: "none" },
			{ type: "text_delta", text: "Fait." },
			{ type: "turn_end", sessionId: "sdk-1", durationMs: 5 },
		];
		// The passive tab gets each event last, so a write of its copy would win.
		for (const event of events) {
			bridge.emit(KEY)(event);
			passiveBridge.emit(KEY)(event);
		}
		const kinds = (): unknown[] => {
			const stored: unknown = JSON.parse(
				storage.read(conversationStorageKey(KEY)) ?? "{}",
			);
			const items =
				typeof stored === "object" && stored !== null
					? Reflect.get(stored, "items")
					: null;
			return Array.isArray(items)
				? items.map((item: unknown) =>
						typeof item === "object" && item !== null
							? Reflect.get(item, "kind")
							: null,
					)
				: [];
		};
		expect(kinds()).toContain("user");
		// A disconnect does not make the passive tab write either.
		passiveBridge.setStatus({ connection: "closed", role: null });
		expect(kinds()).toContain("user");

		// Taking control: the passive tab swaps its copy (no user message) for the stored one before writing.
		expect(
			passive.getState().conversations[KEY]?.items.some((item) => item.kind === "user"),
		).toBe(false);
		passiveBridge.setStatus({ connection: "open", role: "active" });
		expect(
			passive.getState().conversations[KEY]?.items.map((item) => item.kind),
		).toContain("user");
	});

	test("a corrupted copy starts a fresh conversation", () => {
		storage.write({ key: conversationStorageKey(KEY), value: "{not json" });
		store.getState().ensureConversation(KEY);
		expect(conversation().items).toHaveLength(0);
	});

	test("model and profile preferences survive a reload; unknown models are ignored", () => {
		store.getState().setModel("claude-haiku-4-5");
		store.getState().setProfile("B");
		const reloaded = createChatStore({ bridge, storage, timers, now: () => 0 });
		reloaded.getState().loadPreferences();
		expect(reloaded.getState().model).toBe("claude-haiku-4-5");
		expect(reloaded.getState().profile).toBe("B");

		storage.write({
			key: PREFERENCES_STORAGE_KEY,
			value: JSON.stringify({ model: "gpt-9", profile: "A" }),
		});
		const other = createChatStore({ bridge, storage, timers, now: () => 0 });
		other.getState().loadPreferences();
		expect(other.getState().model).toBe(DEFAULT_CHAT_MODEL);
		expect(other.getState().profile).toBe("A");
	});
});

describe("stop, reset and permissions", () => {
	test("Stop sends chat.interrupt and waits for the turn_end", () => {
		store.getState().send({ sessionKey: KEY, text: "Salut" });
		store.getState().interrupt(KEY);
		expect(bridge.ofType("chat.interrupt")).toEqual([
			{ type: "chat.interrupt", sessionKey: KEY },
		]);
		expect(conversation().stopRequested).toBe(true);
		bridge.emit(KEY)({ type: "turn_end", sessionId: "s", durationMs: 1 });
		expect(conversation().running).toBe(false);
		expect(timers.size()).toBe(0);
	});

	test("Stop ends the turn locally when the sidecar never confirms", () => {
		store.getState().send({ sessionKey: KEY, text: "Salut" });
		store.getState().interrupt(KEY);
		timers.advance(STOP_FALLBACK_MS);
		expect(conversation().running).toBe(false);
		expect(conversation().items.at(-1)).toMatchObject({
			kind: "notice",
			text: STOP_TIMEOUT_NOTICE,
		});
	});

	test("Stop while offline ends the turn at once", () => {
		store.getState().send({ sessionKey: KEY, text: "Salut" });
		bridge.open = false;
		store.getState().interrupt(KEY);
		expect(conversation().running).toBe(false);
		expect(conversation().items.at(-1)).toMatchObject({
			kind: "notice",
			text: STOP_UNREACHABLE_NOTICE,
		});
	});

	test("Nouvelle conversation resets the sidecar session and forgets the thread", () => {
		store.getState().send({ sessionKey: KEY, text: "Salut" });
		bridge.emit(KEY)({ type: "turn_end", sessionId: "s", durationMs: 1 });
		store.getState().reset(KEY);
		expect(bridge.ofType("chat.reset")).toEqual([
			{ type: "chat.reset", sessionKey: KEY },
		]);
		expect(conversation().items).toHaveLength(0);
		expect(conversation().sessionId).toBeNull();
		expect(storage.read(conversationStorageKey(KEY))).toBeNull();
		store.getState().send({ sessionKey: KEY, text: "Nouveau" });
		expect(bridge.ofType("chat.send").at(-1)?.resumeSessionId).toBeUndefined();
	});

	test("a reset made offline is delivered before the next message", () => {
		bridge.open = false;
		store.getState().reset(KEY);
		expect(conversation().resetPending).toBe(true);
		bridge.open = true;
		store.getState().send({ sessionKey: KEY, text: "Salut" });
		expect(bridge.sent.map((message) => message.type)).toEqual([
			"chat.reset",
			"chat.send",
		]);
		expect(conversation().resetPending).toBe(false);
	});

	test("answering a permission prompt sends chat.permission_response", () => {
		store.getState().send({ sessionKey: KEY, text: "Supprime" });
		bridge.emit(KEY)({
			type: "permission_request",
			requestId: "r1",
			toolName: "remove_media",
			input: { mediaIds: ["m"] },
		});
		expect(
			store
				.getState()
				.respondPermission({ sessionKey: KEY, requestId: "r1", allow: false }),
		).toBe(true);
		const [response] = bridge.ofType("chat.permission_response");
		expect(response).toMatchObject({
			sessionKey: KEY,
			requestId: "r1",
			allow: false,
		});
		expect(response?.message).toBeString();
		expect(conversation().items.at(-1)).toMatchObject({
			kind: "permission",
			status: "denied",
		});
	});

	test("an answer that cannot be sent leaves the prompt pending", () => {
		store.getState().send({ sessionKey: KEY, text: "Supprime" });
		bridge.emit(KEY)({
			type: "permission_request",
			requestId: "r1",
			toolName: "remove_media",
			input: {},
		});
		bridge.open = false;
		expect(
			store
				.getState()
				.respondPermission({ sessionKey: KEY, requestId: "r1", allow: true }),
		).toBe(false);
		expect(conversation().items.at(-1)).toMatchObject({
			kind: "permission",
			status: "pending",
		});
	});
});

describe("the panel's conversation when the open project changes", () => {
	test("a running turn stays on screen after Claude opens another project, until the user switches", () => {
		const shown = (projectKey: string) =>
			resolvePanelKey({ projectKey, state: store.getState() });
		store.getState().notePanelShown({ shownKey: "P1", projectKey: "P1" });
		store.getState().send({ sessionKey: "P1", text: "Crée un projet vertical" });
		bridge.emit("P1")({
			type: "tool_start",
			toolUseId: "t1",
			name: "create_project",
			input: {},
		});
		// The tab navigates to P2 (the panel even remounts while it loads): P1's running thread stays.
		expect(shown("P2")).toBe("P1");
		store.getState().notePanelShown({ shownKey: "P1", projectKey: "P2" });
		expect(store.getState().pinnedKey).toBe("P1");
		bridge.emit("P1")({ type: "turn_end", sessionId: "sdk-1", durationMs: 1 });
		// The answer stays visible once the turn is over, and a follow-up goes to the same session.
		expect(shown("P2")).toBe("P1");
		store.getState().send({ sessionKey: shown("P2"), text: "Et le logo ?" });
		expect(bridge.ofType("chat.send").at(-1)?.sessionKey).toBe("P1");
		bridge.emit("P1")({ type: "turn_end", sessionId: "sdk-1", durationMs: 1 });

		store.getState().unpinPanel("P2");
		expect(shown("P2")).toBe("P2");
		store.getState().notePanelShown({ shownKey: "P2", projectKey: "P2" });
		// An idle conversation does not follow a project switch.
		expect(shown("P3")).toBe("P3");
	});

	test("coming back to the pinned project unpins it", () => {
		store.getState().notePanelShown({ shownKey: "P1", projectKey: "P1" });
		store.getState().send({ sessionKey: "P1", text: "Un" });
		store.getState().notePanelShown({ shownKey: "P1", projectKey: "P2" });
		expect(resolvePanelKey({ projectKey: "P1", state: store.getState() })).toBe(
			"P1",
		);
		store.getState().notePanelShown({ shownKey: "P1", projectKey: "P1" });
		expect(store.getState().pinnedKey).toBeNull();
	});
});

describe("bridge status and quota", () => {
	test("offline only after a failure, not before the first attempt", () => {
		bridge = new FakeBridge();
		bridge.status = { connection: "closed", role: null };
		store = makeStore();
		const view = () =>
			getConnectionView({
				status: store.getState().bridgeStatus,
				failed: store.getState().bridgeFailed,
			});
		expect(view()).toBe("connecting");
		bridge.setStatus({ connection: "connecting", role: null });
		expect(view()).toBe("connecting");
		bridge.setStatus({ connection: "closed", role: null });
		expect(view()).toBe("offline");
		// Retries flip to "connecting" for a moment: still offline.
		bridge.setStatus({ connection: "connecting", role: null });
		expect(view()).toBe("offline");
		bridge.setStatus({ connection: "open", role: null });
		expect(view()).toBe("connecting");
		bridge.setStatus({ connection: "open", role: "passive" });
		expect(view()).toBe("passive");
		bridge.setStatus({ connection: "open", role: "active" });
		expect(view()).toBe("active");
	});

	test("rate_limit is kept at the store level", () => {
		bridge.emit(KEY)({
			type: "rate_limit",
			info: { status: "allowed_warning", utilization: 0.85 },
		});
		expect(store.getState().rateLimit).toEqual({
			status: "allowed_warning",
			utilization: 0.85,
		});
		expect(store.getState().rateLimitAt).toBe(42);
		expect(store.getState().conversations[KEY]).toBeUndefined();
	});

	test("attach is idempotent and detach removes every listener", () => {
		const count = bridge.listenerCount();
		store.getState().attachBridge();
		expect(bridge.listenerCount()).toBe(count);
		expect(store.getState().detachBridge()).toBe(true);
		expect(bridge.listenerCount()).toBe(0);
		expect(store.getState().detachBridge()).toBe(false);
	});
});
