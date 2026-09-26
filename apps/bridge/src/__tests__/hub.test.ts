import http from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EDITOR_ORIGIN, type RpcMessage } from "@opencut/claude-tools";
import { BridgeError } from "../errors";
import { createEditorHub, timeoutFor, type EditorHub } from "../hub";
import { silentLogger } from "../log";
import {
	closeServer,
	connectTab,
	listen,
	sleep,
	upgradeStatus,
	type FakeTab,
} from "./helpers";

let server: http.Server;
let hub: EditorHub;
let port: number;
const tabs: FakeTab[] = [];

async function tab(
	options: Parameters<typeof connectTab>[0] extends infer T
		? Omit<T & object, "port">
		: never = {},
): Promise<FakeTab> {
	const connected = await connectTab({ port, ...options });
	tabs.push(connected);
	return connected;
}

function isRpc(message: { type: string }): message is RpcMessage {
	return message.type === "rpc";
}

beforeEach(async () => {
	server = http.createServer((_req, res) => res.end());
	hub = createEditorHub({
		logger: silentLogger,
		version: "test",
		reconnectGraceMs: 300,
	});
	hub.attach(server);
	port = await listen(server);
});

afterEach(async () => {
	for (const connected of tabs.splice(0))
		await connected.close().catch(() => {});
	await hub.close();
	await closeServer(server);
});

describe("origin check", () => {
	test("refuses a foreign Origin, a missing Origin and a look-alike", async () => {
		expect(await upgradeStatus({ port, origin: "http://evil.example" })).toBe(
			403,
		);
		expect(await upgradeStatus({ port })).toBe(403);
		expect(
			await upgradeStatus({
				port,
				origin: "http://localhost:3456.evil.example",
			}),
		).toBe(403);
		expect(await upgradeStatus({ port, origin: "http://127.0.0.1:3456" })).toBe(
			403,
		);
		expect(
			await upgradeStatus({ port, origin: "https://localhost:3456" }),
		).toBe(403);
	});

	test("refuses other paths", async () => {
		// 404 on Node; Bun resets the socket instead. Either way, no upgrade.
		expect([0, 404]).toContain(
			await upgradeStatus({ port, origin: EDITOR_ORIGIN, path: "/other" }),
		);
	});

	test("accepts the editor origin", async () => {
		const connected = await tab();
		const welcome = await connected.nextOf("welcome");
		expect(welcome.role).toBe("active");
		expect(welcome.sidecarVersion).toBe("test");
		expect(welcome.activeTab?.tabId).toBe("tab-1");
	});
});

describe("roles", () => {
	test("a hello never takes the role from the active tab; claim-active does", async () => {
		const first = await tab({ tabId: "a" });
		expect((await first.nextOf("welcome")).role).toBe("active");
		const second = await tab({ tabId: "b", projectId: "p2" });
		const joined = await second.nextOf("welcome");
		expect(joined.role).toBe("passive");
		expect(joined.activeTab?.tabId).toBe("a");
		expect(hub.getActiveProjectId()).toBe("p1");

		second.send({ type: "claim-active" });
		expect((await second.nextOf("welcome")).role).toBe("active");
		const demoted = await first.nextOf("welcome");
		expect(demoted.role).toBe("passive");
		expect(demoted.activeTab?.tabId).toBe("b");
		expect(hub.getActiveProjectId()).toBe("p2");

		first.send({ type: "claim-active" });
		expect((await first.nextOf("welcome")).role).toBe("active");
		expect((await second.nextOf("welcome")).role).toBe("passive");
		expect(hub.getStatus().activeTab?.tabId).toBe("a");
	});

	test("a reloading active tab keeps the role: calls wait for it instead of going to a background tab", async () => {
		const background = await tab({ tabId: "bg", projectId: "p-old" });
		await background.nextOf("welcome");
		const working = await tab({ tabId: "work", projectId: "p-work" });
		await working.nextOf("welcome");
		working.send({ type: "claim-active" });
		await working.next(
			(message): message is Extract<typeof message, { type: "welcome" }> =>
				message.type === "welcome" && message.role === "active",
		);

		await working.close();
		await sleep(20);
		const pending = hub.call("get_editor_state", {});
		const reloaded = await tab({ tabId: "work", projectId: "p-work" });
		expect((await reloaded.nextOf("welcome")).role).toBe("active");
		const rpc = await reloaded.next(isRpc);
		reloaded.send({
			type: "rpc-result",
			id: rpc.id,
			ok: true,
			result: { json: { project: "p-work" } },
		});
		expect(await pending).toEqual({ json: { project: "p-work" } });
		expect(background.messages.some((message) => message.type === "rpc")).toBe(
			false,
		);
	});

	test("when the active tab does not come back within the grace, a remaining one takes over", async () => {
		const first = await tab({ tabId: "a" });
		await first.nextOf("welcome");
		const second = await tab({ tabId: "b" });
		await second.nextOf("welcome");
		second.send({ type: "claim-active" });
		await second.next(
			(message): message is Extract<typeof message, { type: "welcome" }> =>
				message.type === "welcome" && message.role === "active",
		);
		await second.close();
		// A new tab saying hello during the grace stays passive: the dropped one may still come back.
		const third = await tab({ tabId: "c" });
		expect((await third.nextOf("welcome")).role).toBe("passive");
		await sleep(400);
		expect(hub.getStatus().activeTab?.tabId).toBe("a");
	});

	test("every hello is reported, active or passive (the chat re-sends its pending prompts)", async () => {
		const hellos: string[] = [];
		hub.onTabHello((connectionId) => hellos.push(connectionId));
		const first = await tab({ tabId: "a" });
		await first.nextOf("welcome");
		const second = await tab({ tabId: "b" });
		await second.nextOf("welcome");
		expect(hellos).toHaveLength(2);
		expect(new Set(hellos).size).toBe(2);
	});

	test("tracks project and stateVersion from the active tab only", async () => {
		const passive = await tab({ tabId: "a" });
		await passive.nextOf("welcome");
		const active = await tab({ tabId: "b", projectId: "p2" });
		await active.nextOf("welcome");
		active.send({ type: "claim-active" });
		await sleep(20);
		active.send({
			type: "event",
			name: "project-changed",
			payload: { projectId: "p2", name: "Reel", path: "/editor/p2" },
		});
		active.send({
			type: "event",
			name: "state-changed",
			payload: { version: 7, projectId: "p2" },
		});
		passive.send({
			type: "event",
			name: "state-changed",
			payload: { version: 99, projectId: "p1" },
		});
		await sleep(50);
		expect(hub.getStateVersion()).toBe(7);
		expect(hub.getActiveProjectName()).toBe("Reel");
		expect(hub.getStatus()).toMatchObject({
			connected: true,
			projectId: "p2",
			tabs: 2,
		});
	});
});

describe("rpc", () => {
	test("forwards a call and resolves with the tab's result", async () => {
		const connected = await tab();
		await connected.nextOf("welcome");
		const pending = hub.call(
			"get_editor_state",
			{ detail: "summary" },
			{ projectId: "p1" },
		);
		const rpc = await connected.next(isRpc);
		expect(rpc.method).toBe("get_editor_state");
		expect(rpc.params).toEqual({ detail: "summary" });
		expect(rpc.projectId).toBe("p1");
		expect(rpc.timeoutMs).toBe(timeoutFor("get_editor_state"));
		expect(typeof rpc.idempotencyKey).toBe("string");
		connected.send({
			type: "rpc-result",
			id: rpc.id,
			ok: true,
			result: { json: { stateVersion: 3 } },
		});
		expect(await pending).toEqual({ json: { stateVersion: 3 } });
	});

	test("rejects with the tab's error code", async () => {
		const connected = await tab();
		await connected.nextOf("welcome");
		const pending = hub.call("undo", {});
		const rpc = await connected.next(isRpc);
		connected.send({
			type: "rpc-result",
			id: rpc.id,
			ok: false,
			error: { code: "USER_INTERACTING", message: "dragging" },
		});
		const error = await pending.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(BridgeError);
		expect((error as BridgeError).code).toBe("USER_INTERACTING");
	});

	test("times out with TIMEOUT when the tab never answers", async () => {
		const connected = await tab();
		await connected.nextOf("welcome");
		const startedAt = Date.now();
		const error = await hub
			.call("get_editor_state", {}, { timeoutMs: 120 })
			.catch((caught: unknown) => caught);
		expect((error as BridgeError).code).toBe("TIMEOUT");
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
		// A late answer is ignored.
		const rpc = await connected.next(isRpc);
		connected.send({ type: "rpc-result", id: rpc.id, ok: true, result: {} });
		await sleep(20);
	});

	test("fails with CONNECTION_LOST when the tab disconnects mid-call", async () => {
		const connected = await tab();
		await connected.nextOf("welcome");
		const pending = hub.call("apply_edit_plan", { ops: [] });
		await connected.next(isRpc);
		await connected.close();
		const error = await pending.catch((caught: unknown) => caught);
		expect((error as BridgeError).code).toBe("CONNECTION_LOST");
	});

	test("fails with EDITOR_NOT_CONNECTED without a tab", async () => {
		const error = await hub
			.call("get_editor_state", {})
			.catch((caught: unknown) => caught);
		expect((error as BridgeError).code).toBe("EDITOR_NOT_CONNECTED");
	});

	test("waits briefly for a tab that just reloaded", async () => {
		const first = await tab();
		await first.nextOf("welcome");
		await first.close();
		await sleep(20);
		const pending = hub.call("list_projects", {}, { waitForTabMs: 1000 });
		const second = await tab({ tabId: "reloaded" });
		const rpc = await second.next(isRpc);
		second.send({
			type: "rpc-result",
			id: rpc.id,
			ok: true,
			result: { json: [] },
		});
		expect(await pending).toEqual({ json: [] });
	});

	test("a malformed result fails its call at once", async () => {
		const connected = await tab();
		await connected.nextOf("welcome");
		const pending = hub.call("capture_frame", {});
		const rpc = await connected.next(isRpc);
		connected.send({
			type: "rpc-result",
			id: rpc.id,
			ok: true,
			result: { images: [{ data: "", mimeType: "image/gif" }] },
		});
		const error = await pending.catch((caught: unknown) => caught);
		expect((error as BridgeError).code).toBe("INTERNAL");
	});

	test("an aborted signal rejects the call", async () => {
		const connected = await tab();
		await connected.nextOf("welcome");
		const controller = new AbortController();
		const pending = hub.call(
			"get_editor_state",
			{},
			{ signal: controller.signal },
		);
		await connected.next(isRpc);
		controller.abort();
		const error = await pending.catch((caught: unknown) => caught);
		expect((error as BridgeError).code).toBe("TIMEOUT");
	});

	test("per-method default timeouts", () => {
		expect(timeoutFor("capture_frame")).toBe(30_000);
		expect(timeoutFor("internal.import_files")).toBe(30 * 60_000);
		expect(timeoutFor("apply_edit_plan")).toBe(60_000);
		expect(timeoutFor("get_editor_state")).toBe(15_000);
	});
});

describe("events and chat", () => {
	test("forwards job progress from any tab and chat messages to listeners", async () => {
		const events: string[] = [];
		const chats: string[] = [];
		hub.onTabEvent((event) => events.push(event.name));
		hub.onChatMessage((message) => chats.push(message.type));
		const connected = await tab();
		await connected.nextOf("welcome");
		connected.send({
			type: "event",
			name: "job-progress",
			payload: { jobId: "j", kind: "import", phase: "copying", progress: 0.5 },
		});
		connected.send({ type: "chat.send", sessionKey: "k", text: "Bonjour" });
		connected.send({ type: "not-a-message" });
		await sleep(50);
		expect(events).toEqual(["job-progress"]);
		expect(chats).toEqual(["chat.send"]);
	});

	test("broadcasts chat events to every tab", async () => {
		const first = await tab({ tabId: "a" });
		const second = await tab({ tabId: "b" });
		await first.nextOf("welcome");
		await second.nextOf("welcome");
		expect(
			hub.broadcastChatEvent("k", { type: "text_delta", text: "Salut" }),
		).toBe(2);
		const received = await second.nextOf("chat.event");
		expect(received).toEqual({
			type: "chat.event",
			sessionKey: "k",
			event: { type: "text_delta", text: "Salut" },
		});
		await first.nextOf("chat.event");
	});
});
