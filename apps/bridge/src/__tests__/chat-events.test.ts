import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ChatEventSchema } from "@opencut/claude-tools";
import {
	apiKeyWarningFr,
	bareToolName,
	createChatMapperState,
	mapSdkMessage,
	summarizeJsonResult,
	summarizeToolError,
	summarizeToolText,
} from "../chat-events";

// Fixtures shaped like the Agent SDK 0.3.282 stream (captured from a real chat turn, trimmed).
const SESSION = "dbd54641-e1cb-4a39-848e-14aa714f16c9";
const base = {
	uuid: "00000000-0000-0000-0000-000000000000",
	session_id: SESSION,
	parent_tool_use_id: null,
};

function fixture(message: Record<string, unknown>): SDKMessage {
	return { ...base, ...message } as unknown as SDKMessage;
}

function run(messages: Record<string, unknown>[]) {
	const state = createChatMapperState();
	const events = messages.flatMap((message) =>
		mapSdkMessage(fixture(message), state),
	);
	for (const event of events)
		expect(ChatEventSchema.safeParse(event).success).toBe(true);
	return { events, state };
}

describe("mapSdkMessage", () => {
	test("system/init gives the session, and no warning on the subscription", () => {
		const { events, state } = run([
			{
				type: "system",
				subtype: "init",
				apiKeySource: "none",
				model: "claude-opus-5-5",
				tools: [],
				mcp_servers: [],
				cwd: "/x",
			},
		]);
		expect(events).toEqual([
			{
				type: "session",
				sessionId: SESSION,
				model: "claude-opus-5-5",
				apiKeySource: "none",
			},
		]);
		expect(state.sessionId).toBe(SESSION);
	});

	test("an API key source adds a French warning", () => {
		const { events } = run([
			{
				type: "system",
				subtype: "init",
				apiKeySource: "ANTHROPIC_API_KEY",
				model: "claude-sonnet-5",
			},
		]);
		expect(events[1]).toEqual({
			type: "error",
			message: apiKeyWarningFr("ANTHROPIC_API_KEY"),
		});
		expect(events[1]?.type === "error" && events[1].message).toContain(
			"facturés",
		);
	});

	test("stream deltas become text and thinking deltas; message_stop ends the assistant message", () => {
		const { events } = run([
			{ type: "stream_event", event: { type: "message_start", message: {} } },
			{
				type: "stream_event",
				event: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "thinking", thinking: "" },
				},
			},
			{
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "thinking_delta", thinking: "Je regarde" },
				},
			},
			{
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "signature_delta", signature: "sig" },
				},
			},
			{
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 1,
					delta: { type: "text_delta", text: "Rouge." },
				},
			},
			{
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 1,
					delta: { type: "text_delta", text: "" },
				},
			},
			{
				type: "stream_event",
				event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
			},
			{ type: "stream_event", event: { type: "message_stop" } },
		]);
		expect(events).toEqual([
			{ type: "thinking_delta", text: "Je regarde" },
			{ type: "text_delta", text: "Rouge." },
			{ type: "assistant_done" },
		]);
	});

	test("tool_start at stream start (input null), then with the complete input, tool_end with the image", () => {
		const image = "iVBORw0KGgo=";
		const { events } = run([
			{
				type: "stream_event",
				event: {
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "tool_use",
						id: "toolu_1",
						name: "mcp__opencut__capture_frame",
						input: {},
					},
				},
			},
			{
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 1,
					delta: { type: "input_json_delta", partial_json: '{"time":1}' },
				},
			},
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "toolu_1",
							name: "mcp__opencut__capture_frame",
							input: { time: 1 },
						},
					],
				},
			},
			{
				type: "user",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_1",
							content: [
								{
									type: "image",
									source: {
										type: "base64",
										media_type: "image/png",
										data: image,
									},
								},
								{ type: "text", text: "frame @1.000s 800x600" },
								{ type: "text", text: '{"time":1,"width":800,"height":600}' },
							],
						},
					],
				},
			},
			// The same assistant message may be delivered again (one block per message): no duplicate tool_start.
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "toolu_1",
							name: "mcp__opencut__capture_frame",
							input: { time: 1 },
						},
					],
				},
			},
		]);
		expect(events).toEqual([
			{
				type: "tool_start",
				toolUseId: "toolu_1",
				name: "capture_frame",
				input: null,
			},
			{
				type: "tool_start",
				toolUseId: "toolu_1",
				name: "capture_frame",
				input: { time: 1 },
			},
			{
				type: "tool_end",
				toolUseId: "toolu_1",
				ok: true,
				summary: "Image à 1 s",
				image: { data: image, mimeType: "image/png" },
			},
		]);
	});

	test("an error tool_result gives ok false and a French summary of its code", () => {
		const { events } = run([
			{
				type: "user",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_2",
							is_error: true,
							content: [
								{
									type: "text",
									text: "NOT_FOUND: Media m1 does not exist.\nAn id does not exist...",
								},
							],
						},
					],
				},
			},
			{
				type: "user",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_3",
							content: "plain string result",
						},
					],
				},
			},
		]);
		expect(events).toEqual([
			{
				type: "tool_end",
				toolUseId: "toolu_2",
				ok: false,
				summary: "Introuvable",
			},
			{
				type: "tool_end",
				toolUseId: "toolu_3",
				ok: true,
				summary: "plain string result",
			},
		]);
	});

	test("a JSON tool result gets a French gist, never raw JSON, in the chip summary", () => {
		const state = {
			project: { id: "p1", name: "E2E", duration: 30 },
			tracks: [
				{ id: "t1", elements: [{ id: "a" }, { id: "b" }] },
				{ id: "t2", elements: [{ id: "c" }] },
			],
			stateVersion: 3,
		};
		const { events } = run([
			{
				type: "user",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_4",
							content: [{ type: "text", text: JSON.stringify(state) }],
						},
						{
							type: "tool_result",
							tool_use_id: "toolu_5",
							content: [
								{ type: "text", text: JSON.stringify({ some: "shape" }) },
							],
						},
					],
				},
			},
		]);
		expect(events).toEqual([
			{
				type: "tool_end",
				toolUseId: "toolu_4",
				ok: true,
				summary: "E2E · 30 s · 2 pistes · 3 éléments",
			},
			{ type: "tool_end", toolUseId: "toolu_5", ok: true },
		]);
		expect(
			summarizeJsonResult({ applied: true, dryRun: false, opCount: 1 }),
		).toBe("1 opération appliquée");
		expect(
			summarizeJsonResult({ applied: false, dryRun: true, opCount: 3 }),
		).toBe("Essai sans modification : 3 opérations valides");
		expect(summarizeJsonResult({ marked: 2, removed: 0 })).toBe(
			"2 plages marquées",
		);
		expect(
			summarizeJsonResult({ jobId: "j", status: "running", progress: 0.42 }),
		).toBe("Tâche en cours (42 %)");
		expect(summarizeJsonResult([{ id: 1 }, { id: 2 }])).toBe("2 résultats");
		expect(summarizeToolText("frame @1.000s 800x600\nmore")).toBe(
			"Image à 1 s",
		);
	});

	test("chips stay French: vision captions, error codes and save outcomes", () => {
		expect(
			summarizeToolText(
				"frame @2.250s 1080x1920 (empty timeline: background only)",
			),
		).toBe("Image à 2,3 s (timeline vide)");
		expect(
			summarizeToolText(
				'contact sheet: 9 frames 0.000s to 8.000s, 3x3 grid, labels "cell · m:ss.cc"',
			),
		).toBe("Planche de 9 images, de 0 s à 8 s");
		expect(
			summarizeToolText(
				'source frames of "rush 01.mp4": 6 frames, 3x2 grid, labels are SOURCE times',
			),
		).toBe("6 images de « rush 01.mp4 »");
		expect(summarizeToolText('image "logo.png" 512x512')).toBe(
			"Image « logo.png »",
		);
		expect(summarizeToolText("ok")).toBe("Fait");
		expect(
			summarizeToolError(
				"STALE_STATE: The timeline changed since stateVersion 12.\nRead get_editor_state...",
			),
		).toBe("Timeline modifiée entre-temps");
		expect(
			summarizeToolError("INVALID_EDIT: op 1 (move): ... Nothing was applied."),
		).toBe("Modification refusée");
		expect(
			summarizeToolError("L'utilisateur a refusé cette action depuis le panneau."),
		).toBe("Non exécuté");
		expect(summarizeJsonResult({ saved: true, wasDirty: true })).toBe(
			"Projet enregistré",
		);
		expect(summarizeJsonResult({ saved: true, wasDirty: false })).toBe(
			"Déjà enregistré",
		);
		expect(summarizeJsonResult({ saved: false, wasDirty: true })).toBe(
			"Enregistrement non confirmé",
		);
	});

	test("result gives turn_end with usage and cost; an error result adds a French error first", () => {
		const usage = {
			input_tokens: 34,
			output_tokens: 565,
			cache_read_input_tokens: 77217,
			cache_creation_input_tokens: 26408,
		};
		const ok = run([
			{
				type: "result",
				subtype: "success",
				is_error: false,
				duration_ms: 7721,
				result: "Rouge.",
				total_cost_usd: 0.064,
				usage,
			},
		]);
		expect(ok.events).toEqual([
			{
				type: "turn_end",
				sessionId: SESSION,
				durationMs: 7721,
				usage: {
					inputTokens: 34,
					outputTokens: 565,
					cacheReadTokens: 77217,
					cacheCreationTokens: 26408,
				},
				costUsd: 0.064,
			},
		]);
		const failed = run([
			{
				type: "result",
				subtype: "error_max_turns",
				is_error: true,
				duration_ms: 10,
				errors: ["Reached max turns"],
				total_cost_usd: 0,
				usage,
			},
		]);
		expect(failed.events[0]).toEqual({
			type: "error",
			message: "Le tour s'est terminé sur une erreur : Reached max turns",
		});
		expect(failed.events[1]?.type).toBe("turn_end");
	});

	test("rate limit events pass their info through", () => {
		const info = {
			status: "allowed_warning",
			resetsAt: 1790352000,
			rateLimitType: "five_hour",
			utilization: 0.9,
			isUsingOverage: false,
		};
		expect(
			run([{ type: "rate_limit_event", rate_limit_info: info }]).events,
		).toEqual([{ type: "rate_limit", info }]);
	});

	test("assistant API errors become French errors", () => {
		const { events } = run([
			{
				type: "assistant",
				error: "rate_limit",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "API Error" }],
				},
			},
		]);
		expect(events).toEqual([
			{
				type: "error",
				message:
					"Limite d'utilisation atteinte. Réessaie plus tard ou change de profil.",
			},
		]);
	});

	test("subagent frames, replays and unrelated messages are ignored", () => {
		const { events } = run([
			{
				type: "stream_event",
				parent_tool_use_id: "toolu_9",
				event: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "x" },
				},
			},
			{
				type: "user",
				isReplay: true,
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "t", content: "x" }],
				},
			},
			{ type: "system", subtype: "api_retry", attempt: 1 },
			{ type: "system", subtype: "status", status: "compacting" },
		]);
		expect(events).toEqual([]);
	});

	test("bareToolName strips only the opencut prefix", () => {
		expect(bareToolName("mcp__opencut__apply_edit_plan")).toBe(
			"apply_edit_plan",
		);
		expect(bareToolName("mcp__other__x")).toBe("mcp__other__x");
	});
});
