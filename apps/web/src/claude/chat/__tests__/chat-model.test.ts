import { describe, expect, test } from "bun:test";
import { ChatEventSchema, type ChatEvent } from "@opencut/claude-tools";
import {
	appendUserMessage,
	applyChatEvent,
	createConversation,
	DISCONNECTED_NOTICE,
	forceStop,
	fromPersistedConversation,
	markDisconnected,
	markStopRequested,
	PERSISTED_ITEM_LIMIT,
	resolvePermission,
	toPersistedConversation,
	type ChatItem,
	type ChatItemKind,
	type ChatItemOf,
	type Conversation,
} from "@/claude/chat/chat-model";

/** Folds events (validated against the contract schema, like the hub would send them) into a conversation. */
function fold({
	events,
	from = createConversation(),
}: {
	events: ChatEvent[];
	from?: Conversation;
}): Conversation {
	return events.reduce(
		(conversation, event) =>
			applyChatEvent({ conversation, event: ChatEventSchema.parse(event) }),
		from,
	);
}

function kinds(conversation: Conversation): ChatItemKind[] {
	return conversation.items.map((item) => item.kind);
}

function only<K extends ChatItemKind>({
	conversation,
	kind,
}: {
	conversation: Conversation;
	kind: K;
}): ChatItemOf<K>[] {
	return conversation.items.filter(
		(item): item is ChatItemOf<K> => item.kind === kind,
	);
}

function asked(text: string): Conversation {
	return appendUserMessage({
		conversation: createConversation(),
		text,
		now: 1_000,
	});
}

const JPEG = { data: "/9j/4AAQSkZJRg==", mimeType: "image/jpeg" as const };

describe("streaming text", () => {
	test("text deltas accumulate into one streaming item until assistant_done", () => {
		const streaming = fold({
			from: asked("Montre-moi la timeline"),
			events: [
				{ type: "text_delta", text: "Je " },
				{ type: "text_delta", text: "regarde " },
				{ type: "text_delta", text: "la timeline." },
			],
		});
		expect(kinds(streaming)).toEqual(["user", "text"]);
		expect(only({ conversation: streaming, kind: "text" })[0]).toMatchObject({
			text: "Je regarde la timeline.",
			streaming: true,
		});
		expect(streaming.running).toBe(true);

		const done = fold({
			from: streaming,
			events: [{ type: "assistant_done" }],
		});
		expect(only({ conversation: done, kind: "text" })[0]?.streaming).toBe(
			false,
		);
		// assistant_done ends a message, not the turn: tools may follow.
		expect(done.running).toBe(true);
	});

	test("text after assistant_done starts a new item", () => {
		const conversation = fold({
			from: asked("Salut"),
			events: [
				{ type: "text_delta", text: "Un." },
				{ type: "assistant_done" },
				{ type: "text_delta", text: "Deux." },
			],
		});
		expect(
			only({ conversation, kind: "text" }).map((item) => item.text),
		).toEqual(["Un.", "Deux."]);
	});

	test("thinking streams into its own item, closed when the answer starts", () => {
		const conversation = fold({
			from: asked("Coupe les silences"),
			events: [
				{ type: "thinking_delta", text: "Il faut " },
				{ type: "thinking_delta", text: "lire la timeline." },
				{ type: "text_delta", text: "D'accord." },
			],
		});
		expect(kinds(conversation)).toEqual(["user", "thinking", "text"]);
		expect(only({ conversation, kind: "thinking" })[0]).toMatchObject({
			text: "Il faut lire la timeline.",
			streaming: false,
		});
		expect(only({ conversation, kind: "text" })[0]?.streaming).toBe(true);
	});

	test("unchanged items keep their identity while the last one streams", () => {
		const before = fold({
			from: asked("Salut"),
			events: [{ type: "text_delta", text: "A" }],
		});
		const after = fold({
			from: before,
			events: [{ type: "text_delta", text: "B" }],
		});
		expect(after.items[0]).toBe(before.items[0]);
		expect(after.items[1]).not.toBe(before.items[1]);
	});

	test("item ids are unique and increasing", () => {
		const conversation = fold({
			from: asked("Salut"),
			events: [
				{ type: "text_delta", text: "Un." },
				{
					type: "tool_start",
					toolUseId: "t1",
					name: "get_editor_state",
					input: {},
				},
				{ type: "tool_end", toolUseId: "t1", ok: true },
				{ type: "text_delta", text: "Deux." },
			],
		});
		const ids = conversation.items.map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual(["i1", "i2", "i3", "i4"]);
	});
});

describe("tool calls", () => {
	test("tool_end completes the chip with the same toolUseId, not the latest one", () => {
		const conversation = fold({
			from: asked("Regarde 12 s et 20 s"),
			events: [
				{ type: "text_delta", text: "Je regarde." },
				{
					type: "tool_start",
					toolUseId: "a",
					name: "capture_frame",
					input: { time: 12 },
				},
				{
					type: "tool_start",
					toolUseId: "b",
					name: "capture_frame",
					input: { time: 20 },
				},
				{ type: "assistant_done" },
				{
					type: "tool_end",
					toolUseId: "b",
					ok: true,
					summary: "frame @20.000s",
					image: JPEG,
				},
				{ type: "tool_end", toolUseId: "a", ok: false, summary: "NOT_FOUND" },
			],
		});
		const tools = only({ conversation, kind: "tool" });
		expect(tools).toHaveLength(2);
		expect(tools[0]).toMatchObject({
			toolUseId: "a",
			status: "error",
			summary: "NOT_FOUND",
			input: { time: 12 },
		});
		expect(tools[0]?.image).toBeUndefined();
		expect(tools[1]).toMatchObject({
			toolUseId: "b",
			status: "success",
			summary: "frame @20.000s",
			image: JPEG,
		});
		// The text before the tool is closed when the tool starts.
		expect(only({ conversation, kind: "text" })[0]?.streaming).toBe(false);
	});

	test("a tool_end without its tool_start still shows a chip", () => {
		const conversation = fold({
			from: asked("Salut"),
			events: [
				{ type: "tool_end", toolUseId: "ghost", ok: true, summary: "ok" },
			],
		});
		expect(only({ conversation, kind: "tool" })[0]).toMatchObject({
			toolUseId: "ghost",
			name: null,
			status: "success",
		});
	});

	test("a repeated tool_start updates the chip instead of duplicating it", () => {
		const conversation = fold({
			from: asked("Salut"),
			events: [
				{
					type: "tool_start",
					toolUseId: "t",
					name: "apply_edit_plan",
					input: {},
				},
				{
					type: "tool_start",
					toolUseId: "t",
					name: "apply_edit_plan",
					input: { ops: [] },
				},
			],
		});
		const tools = only({ conversation, kind: "tool" });
		expect(tools).toHaveLength(1);
		expect(tools[0]?.input).toEqual({ ops: [] });
		expect(tools[0]?.status).toBe("running");
	});

	test("turn_end stops tools that never finished", () => {
		const conversation = fold({
			from: asked("Exporte"),
			events: [
				{ type: "tool_start", toolUseId: "t", name: "start_export", input: {} },
				{ type: "turn_end", sessionId: "s1", durationMs: 1200 },
			],
		});
		expect(only({ conversation, kind: "tool" })[0]?.status).toBe("stopped");
	});
});

describe("permission flow", () => {
	const request: ChatEvent = {
		type: "permission_request",
		requestId: "r1",
		toolName: "remove_media",
		input: { mediaIds: ["m1"] },
		reason: "Supprime le média m1 et ses éléments.",
	};

	test("a request shows a pending prompt once", () => {
		const conversation = fold({
			from: asked("Supprime la vidéo"),
			events: [
				{
					type: "tool_start",
					toolUseId: "t",
					name: "remove_media",
					input: { mediaIds: ["m1"] },
				},
				request,
				request,
			],
		});
		const prompts = only({ conversation, kind: "permission" });
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toMatchObject({
			requestId: "r1",
			toolName: "remove_media",
			status: "pending",
			reason: "Supprime le média m1 et ses éléments.",
		});
		expect(conversation.running).toBe(true);
	});

	test("a prompt expired by a reload or a disconnect comes back when the sidecar sends it again", () => {
		const pending = fold({ from: asked("Supprime"), events: [request] });
		// Reload: the stored copy settles the prompt as expired and the turn as over.
		const reloaded = fromPersistedConversation(
			JSON.parse(JSON.stringify(toPersistedConversation(pending))),
		);
		if (!reloaded) throw new Error("no conversation");
		expect(only({ conversation: reloaded, kind: "permission" })[0]?.status).toBe(
			"expired",
		);
		expect(reloaded.running).toBe(false);
		const revived = fold({ from: reloaded, events: [request] });
		const prompts = only({ conversation: revived, kind: "permission" });
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toMatchObject({ status: "pending", input: request.input });
		expect(revived.running).toBe(true);
		// A disconnect expires it the same way; an answered prompt is never reopened.
		const dropped = markDisconnected(pending);
		expect(
			only({ conversation: fold({ from: dropped, events: [request] }), kind: "permission" })[0]
				?.status,
		).toBe("pending");
		const denied = resolvePermission({
			conversation: pending,
			requestId: "r1",
			allow: false,
		});
		expect(fold({ from: denied, events: [request] })).toBe(denied);
	});

	test("answering resolves only the matching pending prompt", () => {
		const pending = fold({
			from: asked("Supprime"),
			events: [request, { ...request, requestId: "r2" }],
		});
		const answered = resolvePermission({
			conversation: pending,
			requestId: "r2",
			allow: false,
		});
		expect(
			only({ conversation: answered, kind: "permission" }).map(
				(item) => item.status,
			),
		).toEqual(["pending", "denied"]);
		// A second answer to the same prompt changes nothing.
		const again = resolvePermission({
			conversation: answered,
			requestId: "r2",
			allow: true,
		});
		expect(again).toBe(answered);
	});

	test("allow then the tool result", () => {
		const conversation = fold({
			from: resolvePermission({
				conversation: fold({
					from: asked("Supprime"),
					events: [
						{
							type: "tool_start",
							toolUseId: "t",
							name: "remove_media",
							input: {},
						},
						request,
					],
				}),
				requestId: "r1",
				allow: true,
			}),
			events: [
				{
					type: "tool_end",
					toolUseId: "t",
					ok: true,
					summary: "1 média retiré",
				},
				{ type: "text_delta", text: "C'est fait." },
				{ type: "assistant_done" },
				{ type: "turn_end", sessionId: "s1", durationMs: 3000 },
			],
		});
		expect(kinds(conversation)).toEqual([
			"user",
			"tool",
			"permission",
			"text",
			"turn_end",
		]);
		expect(only({ conversation, kind: "permission" })[0]?.status).toBe(
			"allowed",
		);
		expect(only({ conversation, kind: "tool" })[0]?.status).toBe("success");
	});

	test("an unanswered prompt expires at the end of the turn", () => {
		const conversation = fold({
			from: asked("Supprime"),
			events: [request, { type: "turn_end", sessionId: "s1", durationMs: 10 }],
		});
		expect(only({ conversation, kind: "permission" })[0]?.status).toBe(
			"expired",
		);
	});
});

describe("turn end, session and errors", () => {
	test("turn_end closes the turn, records the session and adds a footer", () => {
		const start = {
			...asked("Salut"),
			lastProfile: "B" as const,
		};
		const conversation = fold({
			from: start,
			events: [
				{
					type: "session",
					sessionId: "s1",
					model: "claude-opus-5-5",
					apiKeySource: "none",
				},
				{ type: "text_delta", text: "Bonjour" },
				{
					type: "turn_end",
					sessionId: "s1",
					durationMs: 4200,
					costUsd: 0.042,
					usage: { inputTokens: 1200, outputTokens: 80 },
				},
			],
		});
		expect(conversation.running).toBe(false);
		expect(conversation.sessionId).toBe("s1");
		expect(conversation.sessionProfile).toBe("B");
		expect(conversation.session).toEqual({
			sessionId: "s1",
			model: "claude-opus-5-5",
			apiKeySource: "none",
		});
		expect(only({ conversation, kind: "text" })[0]?.streaming).toBe(false);
		expect(conversation.items.at(-1)).toMatchObject({
			kind: "turn_end",
			durationMs: 4200,
			costUsd: 0.042,
			usage: { inputTokens: 1200, outputTokens: 80 },
		});
	});

	test("turn_end shows each turn's own cost although the SDK reports a running total", () => {
		const turn = ({
			costUsd,
			sessionId = "s1",
		}: {
			costUsd: number;
			sessionId?: string;
		}) => ({
			type: "turn_end" as const,
			sessionId,
			durationMs: 1000,
			costUsd,
		});
		const conversation = fold({
			from: asked("Un"),
			events: [
				turn({ costUsd: 0.067 }),
				turn({ costUsd: 0.0778 }),
				turn({ costUsd: 0.02, sessionId: "s2" }),
			],
		});
		const footers = only({ conversation, kind: "turn_end" });
		expect(footers[0]?.costUsd).toBe(0.067);
		expect(footers[1]?.costUsd).toBeCloseTo(0.0108, 6);
		expect(footers[1]?.sessionCostUsd).toBe(0.0778);
		// Another session (reset, profile switch without resume): its first total is that turn's cost.
		expect(footers[2]?.costUsd).toBe(0.02);
	});

	test("the session event keeps apiKeySource for the billing warning", () => {
		const conversation = fold({
			events: [
				{
					type: "session",
					sessionId: "s1",
					model: "claude-opus-5-5",
					apiKeySource: "ANTHROPIC_API_KEY",
				},
			],
		});
		expect(conversation.session?.apiKeySource).toBe("ANTHROPIC_API_KEY");
		expect(conversation.items).toHaveLength(0);
	});

	test("error ends the turn and shows the message", () => {
		const conversation = fold({
			from: asked("Salut"),
			events: [
				{ type: "text_delta", text: "Je" },
				{ type: "error", message: "Profil B non connecté" },
			],
		});
		expect(conversation.running).toBe(false);
		expect(conversation.items.at(-1)).toMatchObject({
			kind: "error",
			message: "Profil B non connecté",
		});
		expect(only({ conversation, kind: "text" })[0]?.streaming).toBe(false);
	});

	test("rate_limit leaves the conversation untouched (the store keeps it)", () => {
		const conversation = asked("Salut");
		const next = applyChatEvent({
			conversation,
			event: {
				type: "rate_limit",
				info: { status: "allowed_warning", utilization: 0.9 },
			},
		});
		expect(next).toBe(conversation);
	});

	test("job events update one progress item in place", () => {
		const conversation = fold({
			from: asked("Exporte en MP4"),
			events: [
				{
					type: "job",
					jobId: "j1",
					kind: "export",
					status: "queued",
					progress: 0,
				},
				{ type: "text_delta", text: "Export lancé." },
				{
					type: "job",
					jobId: "j1",
					kind: "export",
					status: "running",
					progress: 0.4,
					phase: "rendering",
				},
				{ type: "turn_end", sessionId: "s1", durationMs: 900 },
				{
					type: "job",
					jobId: "j1",
					kind: "export",
					status: "done",
					progress: 1,
					message: "export.mp4",
				},
			],
		});
		const jobs = only({ conversation, kind: "job" });
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			status: "done",
			progress: 1,
			message: "export.mp4",
		});
		// A job that outlives the turn does not reopen it.
		expect(conversation.running).toBe(false);
		expect(kinds(conversation)).toEqual(["user", "job", "text", "turn_end"]);
	});
});

describe("local transitions", () => {
	test("stop request, then the sidecar's turn_end", () => {
		const running = fold({
			from: asked("Salut"),
			events: [{ type: "text_delta", text: "Je" }],
		});
		const stopping = markStopRequested(running);
		expect(stopping.stopRequested).toBe(true);
		expect(markStopRequested(stopping)).toBe(stopping);
		const ended = fold({
			from: stopping,
			events: [{ type: "turn_end", sessionId: "s1", durationMs: 10 }],
		});
		expect(ended.running).toBe(false);
		expect(ended.stopRequested).toBe(false);
	});

	test("forceStop settles everything and leaves a note", () => {
		const conversation = forceStop({
			conversation: fold({
				from: asked("Salut"),
				events: [
					{
						type: "tool_start",
						toolUseId: "t",
						name: "capture_frame",
						input: {},
					},
				],
			}),
			notice: "Arrêt local",
		});
		expect(conversation.running).toBe(false);
		expect(only({ conversation, kind: "tool" })[0]?.status).toBe("stopped");
		expect(conversation.items.at(-1)).toMatchObject({
			kind: "notice",
			text: "Arrêt local",
		});
	});

	test("a disconnect interrupts a running turn and asks for resume", () => {
		const idle = { ...createConversation(), needsResume: false };
		expect(markDisconnected(idle)).toEqual({ ...idle, needsResume: true });

		const running = { ...asked("Salut"), needsResume: false };
		const dropped = markDisconnected(running);
		expect(dropped.running).toBe(false);
		expect(dropped.needsResume).toBe(true);
		expect(dropped.items.at(-1)).toMatchObject({
			kind: "notice",
			text: DISCONNECTED_NOTICE,
		});
	});
});

describe("persistence", () => {
	function longConversation(count: number): Conversation {
		let conversation = createConversation();
		for (let index = 0; index < count; index += 1) {
			conversation = appendUserMessage({
				conversation,
				text: `m${index}`,
				now: index,
			});
			conversation = fold({
				from: conversation,
				events: [{ type: "turn_end", sessionId: "s1", durationMs: 1 }],
			});
		}
		return conversation;
	}

	test("keeps the last items, without images or tool inputs, and round-trips", () => {
		const conversation = fold({
			from: longConversation(60),
			events: [
				{
					type: "tool_start",
					toolUseId: "t",
					name: "capture_frame",
					input: { time: 1 },
				},
				{
					type: "tool_end",
					toolUseId: "t",
					ok: true,
					summary: "frame",
					image: JPEG,
				},
				{ type: "turn_end", sessionId: "s2", durationMs: 5 },
			],
		});
		const persisted = toPersistedConversation(conversation);
		expect(persisted.items).toHaveLength(PERSISTED_ITEM_LIMIT);
		const serialized = JSON.stringify(persisted);
		expect(serialized).not.toContain(JPEG.data);
		expect(serialized).not.toContain('"input"');

		const restored = fromPersistedConversation(JSON.parse(serialized));
		expect(restored).not.toBeNull();
		if (!restored) return;
		expect(restored.items).toHaveLength(PERSISTED_ITEM_LIMIT);
		expect(restored.sessionId).toBe("s2");
		expect(restored.needsResume).toBe(true);
		expect(restored.running).toBe(false);
		const tool = only({ conversation: restored, kind: "tool" })[0];
		expect(tool).toMatchObject({
			status: "success",
			summary: "frame",
			imageDropped: true,
		});
		expect(tool?.image).toBeUndefined();
		// New items never reuse an id of the restored ones.
		const next = appendUserMessage({
			conversation: restored,
			text: "encore",
			now: 0,
		});
		const ids = next.items.map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("a copy saved mid-turn comes back settled", () => {
		const midTurn = fold({
			from: asked("Salut"),
			events: [
				{ type: "session", sessionId: "s1", model: "m", apiKeySource: "none" },
				{ type: "thinking_delta", text: "hmm" },
				{
					type: "tool_start",
					toolUseId: "t",
					name: "apply_edit_plan",
					input: {},
				},
				{
					type: "permission_request",
					requestId: "r",
					toolName: "remove_media",
					input: {},
				},
			],
		});
		const restored = fromPersistedConversation(
			JSON.parse(JSON.stringify(toPersistedConversation(midTurn))),
		);
		expect(restored?.running).toBe(false);
		const states = restored?.items.map((item: ChatItem) =>
			item.kind === "tool" || item.kind === "permission"
				? item.status
				: item.kind === "thinking"
					? item.streaming
					: item.kind,
		);
		expect(states).toEqual(["user", false, "stopped", "expired"]);
	});

	test("unusable copies are refused and bad items skipped", () => {
		expect(fromPersistedConversation(null)).toBeNull();
		expect(fromPersistedConversation({ version: 2 })).toBeNull();
		const restored = fromPersistedConversation({
			version: 1,
			items: [
				{ kind: "user", id: "i1", text: "ok", createdAt: 1 },
				{ kind: "martian", id: "i2" },
				{ kind: "text", id: "i3", text: 42, streaming: false },
			],
			seq: 4,
			session: null,
			sessionId: null,
			sessionProfile: null,
			resetPending: false,
		});
		expect(restored?.items.map((item) => item.id)).toEqual(["i1"]);
		expect(restored?.seq).toBe(4);
	});
});
