import { homedir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import type {
	Options,
	Query,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	CHAT_SYSTEM_PROMPT_APPEND,
	type ChatEvent,
} from "@opencut/claude-tools";
import {
	accountOverrideVariables,
	buildChatEnv,
	buildUserMessage,
	createChatManager,
	permissionReasonFr,
	type ChatManager,
} from "../chat";
import type { EditorHub } from "../hub";
import { createJobTable, type JobTable } from "../jobs";
import { silentLogger } from "../log";
import { createFileRegistry } from "../files";
import { createMediaIndex } from "../media-index";
import { createToolRegistry } from "../tools";
import { sleep } from "./helpers";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const home = homedir();

interface FakeRun {
	options: Options;
	prompts: string[];
	models: string[];
	closed: boolean;
}

/** A fake query(): answers each prompt with init + result, and runs canUseTool for prompts starting with "tool:". */
function createFakeQuery({
	failResume = false,
}: { failResume?: boolean } = {}) {
	const runs: FakeRun[] = [];
	const queryFn = ({
		prompt,
		options,
	}: {
		prompt: AsyncIterable<SDKUserMessage>;
		options?: Options;
	}): Query => {
		const run: FakeRun = {
			options: options ?? {},
			prompts: [],
			models: [],
			closed: false,
		};
		runs.push(run);
		const sessionId = options?.resume ?? SESSION_A;
		const meta = {
			uuid: "00000000-0000-0000-0000-000000000000",
			session_id: sessionId,
			parent_tool_use_id: null,
		};
		async function* generate(): AsyncGenerator<SDKMessage, void> {
			for await (const user of prompt) {
				const content = user.message.content;
				const text = Array.isArray(content)
					? content.map((block) => ("text" in block ? block.text : "")).join("")
					: String(content);
				run.prompts.push(text);
				if (failResume && options?.resume) {
					yield {
						...meta,
						type: "result",
						subtype: "error_during_execution",
						is_error: true,
						duration_ms: 0,
						errors: [
							`No conversation found with session ID: ${options.resume}`,
						],
						usage: {},
						total_cost_usd: 0,
					} as unknown as SDKMessage;
					continue;
				}
				yield {
					...meta,
					type: "system",
					subtype: "init",
					apiKeySource: "none",
					model: options?.model ?? "?",
					tools: [],
					mcp_servers: [],
				} as unknown as SDKMessage;
				if (text.startsWith("tool:")) {
					const tool = text.slice(5);
					// Like the CLI: the assistant's tool_use block comes before the permission check.
					yield {
						...meta,
						type: "assistant",
						message: {
							role: "assistant",
							content: [
								{
									type: "tool_use",
									id: "t1",
									name: `mcp__opencut__${tool}`,
									input: { mediaIds: ["m1"] },
								},
							],
						},
					} as unknown as SDKMessage;
					const decision = await options!.canUseTool!(
						`mcp__opencut__${tool}`,
						{ mediaIds: ["m1"] },
						{ signal: new AbortController().signal, toolUseID: "t1" } as never,
					);
					yield {
						...meta,
						type: "user",
						message: {
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: "t1",
									content: [
										{ type: "text", text: decision?.behavior ?? "none" },
									],
								},
							],
						},
					} as unknown as SDKMessage;
				}
				yield {
					...meta,
					type: "result",
					subtype: "success",
					is_error: false,
					duration_ms: 5,
					result: "ok",
					usage: { input_tokens: 1, output_tokens: 2 },
					total_cost_usd: 0,
				} as unknown as SDKMessage;
			}
		}
		const generator = generate();
		return Object.assign(generator, {
			interrupt: async () => undefined,
			setModel: async (model?: string) => {
				if (model) run.models.push(model);
			},
			close: () => {
				run.closed = true;
			},
		}) as unknown as Query;
	};
	return { runs, queryFn };
}

let jobs: JobTable;
let events: Array<{ key: string; event: ChatEvent }>;

function makeManager(
	queryFn: ReturnType<typeof createFakeQuery>["queryFn"],
	permissionTimeoutMs?: number,
	idleSessionMs?: number,
): ChatManager {
	const hub = {
		isConnected: () => false,
		getActiveProjectId: () => null,
		getActiveProjectName: () => null,
		call: async () => ({}),
	} as unknown as EditorHub;
	const registry = createToolRegistry({
		hub,
		jobs,
		files: createFileRegistry({
			getRoots: () => [],
			ttlMs: 1000,
			logger: silentLogger,
		}),
		uploads: { abort: () => false },
		mediaIndex: createMediaIndex({
			dataDir: "/nonexistent-opencut-test",
			logger: silentLogger,
		}),
		prober: null,
		config: { allowedRoots: [], exportsDir: "/nonexistent-opencut-test" },
		logger: silentLogger,
	});
	return createChatManager({
		config: {
			claudePath: "/opt/claude",
			profiles: {
				A: path.join(home, ".claude"),
				B: path.join(home, ".claude-b-test-does-not-exist"),
			},
			defaultProfile: "A",
			defaultModel: "claude-opus-5-5",
			ffmpegPath: "/opt/homebrew/bin/ffmpeg",
		},
		registry,
		jobs,
		logger: silentLogger,
		cwd: "/repo",
		emit: (key, event) => events.push({ key, event }),
		queryFn,
		baseEnv: {
			PATH: "/bin",
			ANTHROPIC_API_KEY: "secret",
			ANTHROPIC_BASE_URL: "http://proxy",
			CLAUDE_CONFIG_DIR: "/somewhere",
			CLAUDECODE: "1",
		},
		permissionTimeoutMs,
		idleSessionMs,
		home,
	});
}

async function until(
	predicate: () => boolean,
	timeoutMs = 2000,
): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs)
			throw new Error("condition not met in time");
		await sleep(5);
	}
}

const typesOf = (key: string) =>
	events.filter((entry) => entry.key === key).map((entry) => entry.event.type);

beforeEach(() => {
	jobs = createJobTable({ logger: silentLogger });
	events = [];
});

describe("chat session options", () => {
	test("spawns the configured claude binary on the subscription with only the opencut tools", async () => {
		const fake = createFakeQuery();
		const manager = makeManager(fake.queryFn);
		manager.handle({ type: "chat.send", sessionKey: "k", text: "Bonjour" });
		await until(() => typesOf("k").includes("turn_end"));
		const options = fake.runs[0]!.options;
		expect(options.pathToClaudeCodeExecutable).toBe("/opt/claude");
		expect(options.cwd).toBe("/repo");
		expect(options.model).toBe("claude-opus-5-5");
		expect(options.env).toEqual({ PATH: "/bin" });
		expect(options.strictMcpConfig).toBe(true);
		expect(options.settingSources).toEqual([]);
		expect(options.tools).toEqual([]);
		expect(options.allowedTools).toBeUndefined();
		expect(options.includePartialMessages).toBe(true);
		expect(options.systemPrompt).toEqual({
			type: "preset",
			preset: "claude_code",
			append: CHAT_SYSTEM_PROMPT_APPEND,
		});
		expect(options.thinking).toEqual({
			type: "adaptive",
			display: "summarized",
		});
		expect(options.mcpServers?.opencut?.type).toBe("sdk");
		expect(options.resume).toBeUndefined();
		expect(typesOf("k")).toEqual(["session", "turn_end"]);
		expect(manager.count()).toBe(1);
		await manager.close();
	});

	test("buildChatEnv: profile A runs without CLAUDE_CONFIG_DIR, profile B with it, never with API keys", () => {
		const baseEnv = {
			ANTHROPIC_API_KEY: "k",
			ANTHROPIC_AUTH_TOKEN: "t",
			CLAUDE_CONFIG_DIR: "/x",
			HOME: home,
		};
		expect(
			buildChatEnv({ baseEnv, profileDir: path.join(home, ".claude"), home }),
		).toEqual({ HOME: home });
		expect(
			buildChatEnv({ baseEnv, profileDir: path.join(home, ".claude-b"), home }),
		).toEqual({ HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude-b") });
	});

	test("buildChatEnv keeps only an allow-list: no secrets, no parent session, no account or provider override", () => {
		const baseEnv = {
			HOME: home,
			PATH: "/usr/bin",
			LANG: "fr_FR.UTF-8",
			LC_ALL: "fr_FR.UTF-8",
			HTTPS_PROXY: "http://proxy:8080",
			OP_SERVICE_ACCOUNT_TOKEN: "op",
			OPENAI_API_KEY: "sk",
			SUPABASE_ACCESS_TOKEN: "sb",
			CLAUDE_CODE_MESSAGING_TOKEN: "m",
			CLAUDE_CODE_SESSION_ID: "s",
			CLAUDE_CODE_CHILD_SESSION: "1",
			CLAUDE_EFFORT: "xhigh",
			CLAUDE_CODE_OAUTH_TOKEN: "oauth",
			CLAUDE_CODE_USE_BEDROCK: "1",
			AWS_BEARER_TOKEN_BEDROCK: "b",
			ANTHROPIC_BEDROCK_BASE_URL: "https://x",
		};
		expect(
			buildChatEnv({ baseEnv, profileDir: path.join(home, ".claude-b"), home }),
		).toEqual({
			HOME: home,
			PATH: "/usr/bin",
			LANG: "fr_FR.UTF-8",
			LC_ALL: "fr_FR.UTF-8",
			HTTPS_PROXY: "http://proxy:8080",
			CLAUDE_CONFIG_DIR: path.join(home, ".claude-b"),
		});
		expect(accountOverrideVariables(baseEnv)).toEqual([
			"ANTHROPIC_BEDROCK_BASE_URL",
			"AWS_BEARER_TOKEN_BEDROCK",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"CLAUDE_CODE_USE_BEDROCK",
		]);
	});

	test("user messages carry attachments before the text", () => {
		const message = buildUserMessage({
			text: "Regarde",
			attachments: [
				{ type: "image", data: "AAAA", mimeType: "image/png" },
				{ type: "text", name: "notes.txt", text: "plan" },
			],
		});
		expect(message?.message.content).toEqual([
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "AAAA" },
			},
			{ type: "text", text: "Pièce jointe « notes.txt » :\n\nplan" },
			{ type: "text", text: "Regarde" },
		]);
		expect(buildUserMessage({ text: "  " })).toBeNull();
	});
});

describe("permissions", () => {
	test("a destructive tool waits for the panel; the answer is passed to Claude", async () => {
		const fake = createFakeQuery();
		const manager = makeManager(fake.queryFn);
		manager.handle({
			type: "chat.send",
			sessionKey: "k",
			text: "tool:remove_media",
		});
		await until(() => typesOf("k").includes("permission_request"));
		const request = events.find(
			(entry) => entry.event.type === "permission_request",
		)?.event;
		if (request?.type !== "permission_request")
			throw new Error("no permission request");
		expect(request.toolName).toBe("remove_media");
		expect(request.reason).toBe(
			permissionReasonFr("remove_media", { mediaIds: ["m1"] }),
		);
		expect(request.reason).toContain("un média");
		expect(request.reason).toContain("qui l'utilisent");
		expect(
			permissionReasonFr("remove_media", { mediaIds: ["m1", "m2"] }),
		).toContain(
			"2 médias de la bibliothèque du projet, ainsi que tous les éléments de la timeline qui les utilisent",
		);
		manager.handle({
			type: "chat.permission_response",
			sessionKey: "k",
			requestId: request.requestId,
			allow: false,
		});
		await until(() => typesOf("k").includes("turn_end"));
		const toolEnd = events.find(
			(entry) => entry.event.type === "tool_end",
		)?.event;
		expect(toolEnd).toMatchObject({ type: "tool_end", summary: "deny" });
		await manager.close();
	});

	test("a request still waiting is sent again when a tab reconnects, and no longer once answered", async () => {
		const fake = createFakeQuery();
		const manager = makeManager(fake.queryFn);
		manager.handle({
			type: "chat.send",
			sessionKey: "k",
			text: "tool:remove_media",
		});
		await until(() => typesOf("k").includes("permission_request"));
		const requests = () =>
			events.filter((entry) => entry.event.type === "permission_request");
		const countBefore = events.length;
		expect(manager.resendPendingPermissions()).toBe(1);
		await until(() => requests().length === 2);
		const [first, again] = requests();
		expect(again?.key).toBe("k");
		expect(again?.event).toEqual(first?.event);
		// The running tool call is sent again first, so a reloaded panel keeps the tool's name on its chip.
		expect(events.slice(countBefore).map((entry) => entry.event)).toEqual([
			{
				type: "tool_start",
				toolUseId: "t1",
				name: "remove_media",
				input: { mediaIds: ["m1"] },
			},
			first!.event,
		]);
		const requestId =
			first?.event.type === "permission_request" ? first.event.requestId : "";
		manager.handle({
			type: "chat.permission_response",
			sessionKey: "k",
			requestId,
			allow: false,
		});
		await until(() => typesOf("k").includes("turn_end"));
		const countAfter = events.length;
		expect(manager.resendPendingPermissions()).toBe(0);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(events.length).toBe(countAfter);
		await manager.close();
	});

	test("non-destructive opencut tools are approved at once, foreign tools refused", async () => {
		const fake = createFakeQuery();
		const manager = makeManager(fake.queryFn);
		manager.handle({
			type: "chat.send",
			sessionKey: "k",
			text: "tool:apply_edit_plan",
		});
		await until(() => typesOf("k").includes("turn_end"));
		expect(
			events.find((entry) => entry.event.type === "tool_end")?.event,
		).toMatchObject({ summary: "allow" });
		expect(typesOf("k")).not.toContain("permission_request");
		const canUseTool = fake.runs[0]!.options.canUseTool!;
		const foreign = await canUseTool("Bash", {}, {
			signal: new AbortController().signal,
			toolUseID: "x",
		} as never);
		expect(foreign?.behavior).toBe("deny");
		await manager.close();
	});

	test("an unanswered request is denied after the timeout, with a French notice", async () => {
		const fake = createFakeQuery();
		const manager = makeManager(fake.queryFn, 40);
		manager.handle({
			type: "chat.send",
			sessionKey: "k",
			text: "tool:remove_media",
		});
		await until(() => typesOf("k").includes("turn_end"));
		expect(
			events.find((entry) => entry.event.type === "tool_end")?.event,
		).toMatchObject({ summary: "deny" });
		const notice = events.find((entry) => entry.event.type === "error")?.event;
		expect(notice?.type === "error" && notice.message).toContain("5 minutes");
		await manager.close();
	});
});

describe("session lifecycle", () => {
	test("an idle session is closed, and the next message of its thread resumes the conversation", async () => {
		const fake = createFakeQuery();
		const manager = makeManager(fake.queryFn, undefined, 60);
		manager.handle({ type: "chat.send", sessionKey: "k", text: "Bonjour" });
		await until(() => typesOf("k").includes("turn_end"));
		expect(manager.count()).toBe(1);
		await until(() => manager.count() === 0, 1000);
		expect(fake.runs[0]?.closed).toBe(true);
		manager.handle({ type: "chat.send", sessionKey: "k", text: "Encore" });
		await until(() => fake.runs.length === 2);
		expect(fake.runs[1]?.options.resume).toBe(SESSION_A);
		await manager.close();
	});

	test("a session waiting on a permission prompt is not idle", async () => {
		const fake = createFakeQuery();
		const manager = makeManager(fake.queryFn, undefined, 30);
		manager.handle({
			type: "chat.send",
			sessionKey: "k",
			text: "tool:remove_media",
		});
		await until(() => typesOf("k").includes("permission_request"));
		await sleep(120);
		expect(manager.count()).toBe(1);
		await manager.close();
	});

	test("a failed resume restarts a fresh conversation and re-sends the message", async () => {
		const fake = createFakeQuery({ failResume: true });
		const manager = makeManager(fake.queryFn);
		manager.handle({
			type: "chat.send",
			sessionKey: "k",
			text: "Encore",
			resumeSessionId: "22222222-2222-4222-8222-222222222222",
		});
		await until(() => typesOf("k").includes("turn_end"));
		expect(fake.runs).toHaveLength(2);
		expect(fake.runs[0]!.options.resume).toBe(
			"22222222-2222-4222-8222-222222222222",
		);
		expect(fake.runs[1]!.options.resume).toBeUndefined();
		expect(fake.runs[1]!.prompts).toEqual(["Encore"]);
		expect(typesOf("k")).toEqual(["error", "session", "turn_end"]);
		await manager.close();
	});

	test("a model change reuses the live session; a profile change resumes it in the other profile", async () => {
		const fake = createFakeQuery();
		const manager = makeManager(fake.queryFn);
		manager.handle({ type: "chat.send", sessionKey: "k", text: "un" });
		await until(
			() => typesOf("k").filter((type) => type === "turn_end").length === 1,
		);
		manager.handle({
			type: "chat.send",
			sessionKey: "k",
			text: "deux",
			model: "claude-sonnet-5",
		});
		await until(
			() => typesOf("k").filter((type) => type === "turn_end").length === 2,
		);
		expect(fake.runs).toHaveLength(1);
		expect(fake.runs[0]!.models).toEqual(["claude-sonnet-5"]);

		manager.handle({
			type: "chat.send",
			sessionKey: "k",
			text: "trois",
			profile: "B",
		});
		await until(
			() => typesOf("k").filter((type) => type === "turn_end").length === 3,
		);
		expect(fake.runs).toHaveLength(2);
		expect(fake.runs[0]!.closed).toBe(true);
		expect(fake.runs[1]!.options.resume).toBe(SESSION_A);
		expect(fake.runs[1]!.options.model).toBe("claude-sonnet-5");
		expect(fake.runs[1]!.options.env?.CLAUDE_CONFIG_DIR).toBe(
			path.join(home, ".claude-b-test-does-not-exist"),
		);
		await manager.close();
	});

	test("reset closes the session; invalid models and empty messages are refused in French", async () => {
		const fake = createFakeQuery();
		const manager = makeManager(fake.queryFn);
		manager.handle({
			type: "chat.send",
			sessionKey: "k",
			text: "un",
			model: "claude-haiku-4-5",
		});
		await until(() => typesOf("k").includes("turn_end"));
		expect(fake.runs[0]!.options.thinking).toBeUndefined();
		manager.handle({ type: "chat.reset", sessionKey: "k" });
		expect(manager.count()).toBe(0);
		expect(fake.runs[0]!.closed).toBe(true);
		manager.handle({
			type: "chat.send",
			sessionKey: "k2",
			text: "x",
			model: "gpt-5; rm -rf",
		});
		manager.handle({ type: "chat.send", sessionKey: "k3", text: "   " });
		await until(() => typesOf("k2").length === 1 && typesOf("k3").length === 1);
		expect(events.find((entry) => entry.key === "k2")?.event).toMatchObject({
			type: "error",
		});
		expect(events.find((entry) => entry.key === "k3")?.event).toEqual({
			type: "error",
			message: "Message vide : rien à envoyer.",
		});
		await manager.close();
	});

	test("after a reset the next message starts a NEW conversation, even once the old process has ended", async () => {
		const fake = createFakeQuery();
		const manager = makeManager(fake.queryFn);
		manager.handle({ type: "chat.send", sessionKey: "k", text: "un" });
		await until(() => typesOf("k").includes("turn_end"));
		manager.handle({ type: "chat.reset", sessionKey: "k" });
		// The old query ends asynchronously after close(); its end must not bring the conversation back.
		await sleep(50);
		manager.handle({ type: "chat.send", sessionKey: "k", text: "deux" });
		await until(
			() => typesOf("k").filter((type) => type === "turn_end").length === 2,
		);
		expect(fake.runs).toHaveLength(2);
		expect(fake.runs[1]!.options.resume).toBeUndefined();
		expect(fake.runs[1]!.prompts).toEqual(["deux"]);
		await manager.close();
	});

	test("a crash mid-turn reports the error and still ends the turn", async () => {
		const crashing = ({
			prompt,
		}: {
			prompt: AsyncIterable<SDKUserMessage>;
			options?: Options;
		}): Query => {
			const meta = {
				uuid: "00000000-0000-0000-0000-000000000000",
				session_id: SESSION_A,
				parent_tool_use_id: null,
			};
			async function* generate(): AsyncGenerator<SDKMessage, void> {
				for await (const _user of prompt) {
					yield {
						...meta,
						type: "system",
						subtype: "init",
						apiKeySource: "none",
						model: "m",
					} as unknown as SDKMessage;
					throw new Error("claude exited with code 1");
				}
			}
			return Object.assign(generate(), {
				interrupt: async () => undefined,
				setModel: async () => {},
				close: () => {},
			}) as unknown as Query;
		};
		const manager = makeManager(crashing);
		manager.handle({ type: "chat.send", sessionKey: "k", text: "Bonjour" });
		await until(() => typesOf("k").includes("turn_end"));
		expect(typesOf("k")).toEqual(["session", "error", "turn_end"]);
		const error = events.find((entry) => entry.event.type === "error")?.event;
		expect(error?.type === "error" && error.message).toContain(
			"claude exited with code 1",
		);
		expect(manager.count()).toBe(0);
		await manager.close();
	});

	test("jobs started from the chat stream to its panel", async () => {
		const fake = createFakeQuery();
		const manager = makeManager(fake.queryFn);
		const job = jobs.create({
			kind: "export",
			origin: { kind: "chat", sessionKey: "k" },
			projectId: "p1",
		});
		jobs.update(job.id, {
			status: "running",
			progress: 0.5,
			phase: "rendering",
			message: "Rendu de l'export en cours",
		});
		jobs.create({ kind: "export", origin: { kind: "mcp" }, projectId: "p1" });
		const jobEvents = events.filter((entry) => entry.event.type === "job");
		expect(jobEvents.map((entry) => entry.key)).toEqual(["k", "k"]);
		expect(jobEvents[1]?.event).toEqual({
			type: "job",
			jobId: job.id,
			kind: "export",
			status: "running",
			progress: 0.5,
			phase: "rendering",
			message: "Rendu de l'export en cours",
		});
		await manager.close();
	});
});
