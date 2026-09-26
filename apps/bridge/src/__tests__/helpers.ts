import http from "node:http";
import type { AddressInfo } from "node:net";
import {
	EDITOR_ORIGIN,
	PROTOCOL_VERSION,
	type HubMessage,
} from "@opencut/claude-tools";
import WebSocket from "ws";

// Shared test helpers: a fake editor tab over a real WebSocket, and a raw upgrade request to read the refusal status.

export async function listen(server: http.Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

export async function closeServer(server: http.Server): Promise<void> {
	server.closeAllConnections?.();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Sends a WebSocket upgrade by hand and resolves with the HTTP status the server answered (0 for a reset). */
export function upgradeStatus({
	port,
	origin,
	path = "/editor",
}: {
	port: number;
	origin?: string;
	path?: string;
}): Promise<number> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = {
			Connection: "Upgrade",
			Upgrade: "websocket",
			"Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
			"Sec-WebSocket-Version": "13",
		};
		if (origin !== undefined) headers.Origin = origin;
		const req = http.request({ host: "127.0.0.1", port, path, headers });
		req.on("response", (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("upgrade", (res, socket) => {
			socket.destroy();
			resolve(res.statusCode ?? 101);
		});
		// Bun's http server cannot write a raw answer on an upgrade it does not accept: it resets the socket (0).
		req.on("error", (error: NodeJS.ErrnoException) =>
			error.code === "ECONNRESET" ? resolve(0) : reject(error),
		);
		req.end();
	});
}

export interface FakeTab {
	socket: WebSocket;
	messages: HubMessage[];
	/** Resolves with the next hub message matching the predicate (already received ones included). */
	next<T extends HubMessage>(
		predicate: (message: HubMessage) => message is T,
		timeoutMs?: number,
	): Promise<T>;
	nextOf<K extends HubMessage["type"]>(
		type: K,
		timeoutMs?: number,
	): Promise<Extract<HubMessage, { type: K }>>;
	send(message: unknown): void;
	close(): Promise<void>;
}

export async function connectTab({
	port,
	tabId = "tab-1",
	projectId = "p1",
	path = "/editor/p1",
	hello = true,
}: {
	port: number;
	tabId?: string;
	projectId?: string | null;
	path?: string;
	hello?: boolean;
}): Promise<FakeTab> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/editor`, {
		headers: { Origin: EDITOR_ORIGIN },
	});
	const messages: HubMessage[] = [];
	const waiters: Array<{
		predicate: (message: HubMessage) => boolean;
		resolve: (message: HubMessage) => void;
	}> = [];
	const consumed = new Set<HubMessage>();
	socket.on("message", (raw) => {
		const message = JSON.parse(String(raw)) as HubMessage;
		messages.push(message);
		const index = waiters.findIndex((waiter) => waiter.predicate(message));
		if (index >= 0) {
			const [waiter] = waiters.splice(index, 1);
			consumed.add(message);
			waiter?.resolve(message);
		}
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("open", () => resolve());
		socket.once("error", reject);
	});
	const tab: FakeTab = {
		socket,
		messages,
		next: <T extends HubMessage>(
			predicate: (message: HubMessage) => message is T,
			timeoutMs = 2000,
		): Promise<T> => {
			const existing = messages.find(
				(message): message is T => !consumed.has(message) && predicate(message),
			);
			if (existing) {
				consumed.add(existing);
				return Promise.resolve(existing);
			}
			return new Promise<T>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("timed out waiting for a hub message")),
					timeoutMs,
				);
				waiters.push({
					predicate,
					resolve: (message) => {
						clearTimeout(timer);
						resolve(message as T);
					},
				});
			});
		},
		nextOf(type, timeoutMs) {
			return tab.next(
				(message): message is Extract<HubMessage, { type: typeof type }> =>
					message.type === type,
				timeoutMs,
			);
		},
		send(message) {
			socket.send(JSON.stringify(message));
		},
		close() {
			return new Promise((resolve) => {
				if (socket.readyState === WebSocket.CLOSED) {
					resolve();
					return;
				}
				socket.once("close", () => resolve());
				socket.close();
			});
		},
	};
	if (hello) {
		tab.send({
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			tabId,
			path,
			projectId,
			appVersion: "test",
		});
	}
	return tab;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
