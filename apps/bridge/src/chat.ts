import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
	createSdkMcpServer,
	query as sdkQuery,
	type CanUseTool,
	type Options,
	type PermissionResult,
	type Query,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	CHAT_SYSTEM_PROMPT_APPEND,
	EDITOR_RULES,
	type ChatAttachment,
	type ChatEvent,
	type ChatProfile,
	type ChatSendMessage,
} from "@opencut/claude-tools";
import {
	bareToolName,
	createChatMapperState,
	mapSdkMessage,
	type ChatMapperState,
} from "./chat-events";
import type { BridgeConfig } from "./config";
import { errorMessage } from "./errors";
import type { ChatTabMessage } from "./hub";
import type { Job, JobTable } from "./jobs";
import type { Logger } from "./log";
import { downscaleImage } from "./probe";
import { registerToolsOnServer, type ToolRegistry } from "./tools";
import { BRIDGE_VERSION, MCP_SERVER_NAME } from "./version";

// Backend of the in-app chat panel. One ChatSession per sessionKey: a long-lived Agent SDK query() fed by an async
// prompt queue, spawning the user's own `claude` binary on their Claude subscription (never an API key: the child gets
// an allow-listed environment, so no key, token or provider variable reaches it). The editor tools come from the
// same registry as /mcp, registered on an in-process SDK MCP server. Every SDK message is projected to ChatEvents.

export const PERMISSION_TIMEOUT_MS = 5 * 60_000;
/**
 * A session with no turn for this long is closed (its CLI process weighs a few hundred MB); the next message of
 * that thread resumes the same conversation from lastSessions.
 */
export const IDLE_SESSION_MS = 30 * 60_000;
/** Tool calls of the chat may import big rushes (30 min in the hub): keep a margin. */
const SDK_TOOL_TIMEOUT_MS = 35 * 60_000;
/** Tool result images above this base64 length are downscaled before reaching the panel. */
const THUMBNAIL_MAX_BASE64 = 200_000;
const THUMBNAIL_MAX_EDGE = 640;
const MODEL_PATTERN = /^claude-[a-z0-9.-]+(\[1m\])?$/i;
const SESSION_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The only parent variables the spawned CLI gets (an allow-list, not a deny-list): the sidecar's environment
 * carries secrets (1Password, OpenAI, Supabase tokens), a launching Claude Code session's messaging token, and
 * variables that pick another account or provider (CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK,
 * ANTHROPIC_*), none of which the chat may inherit.
 */
const INHERITED_ENV = new Set([
	"HOME",
	"USER",
	"LOGNAME",
	"PATH",
	"SHELL",
	"TMPDIR",
	"TERM",
	"COLORTERM",
	"TZ",
	"LANG",
	"__CF_USER_TEXT_ENCODING",
	// Network plumbing, so the CLI reaches the API through the same proxy / CA as the rest of the machine.
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
]);
const INHERITED_ENV_PREFIXES = ["LC_", "XDG_"];

/** Parent variables that would change the chat's account or provider; dropped, and reported at startup. */
export function accountOverrideVariables(env: NodeJS.ProcessEnv): string[] {
	return Object.keys(env)
		.filter(
			(key) =>
				env[key] &&
				(key.startsWith("ANTHROPIC_") ||
					key.startsWith("CLAUDE_CODE_USE_") ||
					key === "CLAUDE_CODE_OAUTH_TOKEN" ||
					key === "AWS_BEARER_TOKEN_BEDROCK"),
		)
		.sort();
}

type QueryFn = (params: {
	prompt: AsyncIterable<SDKUserMessage>;
	options?: Options;
}) => Query;

export interface ChatManagerDeps {
	config: Pick<
		BridgeConfig,
		| "claudePath"
		| "profiles"
		| "defaultProfile"
		| "defaultModel"
		| "chatEffort"
		| "ffmpegPath"
	>;
	registry: ToolRegistry;
	/** Sends a chat event to the tabs. */
	emit: (sessionKey: string, event: ChatEvent) => void;
	jobs: JobTable;
	logger: Logger;
	/** Working directory of the spawned Claude Code (the opencut repo). */
	cwd: string;
	queryFn?: QueryFn;
	baseEnv?: NodeJS.ProcessEnv;
	permissionTimeoutMs?: number;
	idleSessionMs?: number;
	home?: string;
}

export interface ChatManager {
	handle(message: ChatTabMessage): void;
	/** Re-sends the permission requests still waiting (call when a tab says hello). Returns how many. */
	resendPendingPermissions(): number;
	count(): number;
	close(): Promise<void>;
}

/** Environment of the spawned CLI: the allow-listed parent variables, plus CLAUDE_CONFIG_DIR for profile B. */
export function buildChatEnv({
	baseEnv,
	profileDir,
	home = homedir(),
}: {
	baseEnv: NodeJS.ProcessEnv;
	profileDir: string;
	home?: string;
}): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(baseEnv)) {
		if (value === undefined) continue;
		if (
			INHERITED_ENV.has(key) ||
			INHERITED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
		)
			env[key] = value;
	}
	// The default profile must run WITHOUT CLAUDE_CONFIG_DIR: setting it, even to ~/.claude, makes Claude Code look
	// for its login under another keychain entry.
	if (path.resolve(profileDir) !== path.join(home, ".claude"))
		env.CLAUDE_CONFIG_DIR = profileDir;
	return env;
}

export function buildUserMessage({
	text,
	attachments,
}: {
	text: string;
	attachments?: readonly ChatAttachment[];
}): SDKUserMessage | null {
	const content: Array<
		| { type: "text"; text: string }
		| {
				type: "image";
				source: {
					type: "base64";
					media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
					data: string;
				};
		  }
	> = [];
	for (const attachment of attachments ?? []) {
		if (attachment.type === "image") {
			content.push({
				type: "image",
				source: {
					type: "base64",
					media_type: attachment.mimeType,
					data: attachment.data,
				},
			});
		} else {
			content.push({
				type: "text",
				text: `Pièce jointe « ${attachment.name} » :\n\n${attachment.text}`,
			});
		}
	}
	if (text.trim() !== "") content.push({ type: "text", text });
	if (content.length === 0) return null;
	return {
		type: "user",
		message: { role: "user", content },
		parent_tool_use_id: null,
	};
}

/** Why a destructive tool needs the user's go-ahead (French, shown in the permission prompt). */
export function permissionReasonFr(toolName: string, input: unknown): string {
	if (toolName === "remove_media") {
		const ids: unknown =
			typeof input === "object" && input !== null
				? Reflect.get(input, "mediaIds")
				: undefined;
		const count = Array.isArray(ids) ? ids.length : 0;
		const what = count > 1 ? `${count} médias` : "un média";
		const using = count > 1 ? "les utilisent" : "l'utilisent";
		return `Claude veut retirer ${what} de la bibliothèque du projet, ainsi que tous les éléments de la timeline qui ${using}. Les fichiers sur le disque ne sont pas touchés.`;
	}
	return `Claude veut utiliser l'outil « ${toolName} », qui peut supprimer du contenu du projet.`;
}

class PromptQueue implements AsyncIterable<SDKUserMessage> {
	private readonly items: SDKUserMessage[] = [];
	private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null =
		null;
	private closed = false;

	push(message: SDKUserMessage): boolean {
		if (this.closed) return false;
		if (this.waiting) {
			const resolve = this.waiting;
			this.waiting = null;
			resolve({ done: false, value: message });
		} else {
			this.items.push(message);
		}
		return true;
	}

	close(): void {
		this.closed = true;
		const resolve = this.waiting;
		this.waiting = null;
		resolve?.({ done: true, value: undefined });
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return {
			next: () => {
				const item = this.items.shift();
				if (item) return Promise.resolve({ done: false, value: item });
				if (this.closed)
					return Promise.resolve({ done: true, value: undefined });
				return new Promise((resolve) => {
					this.waiting = resolve;
				});
			},
			return: () => {
				this.close();
				return Promise.resolve({ done: true, value: undefined });
			},
		};
	}
}

/** Finds <configDir>/projects/<project>/<sessionId>.jsonl in any profile and copies it into `targetDir`. */
export async function ensureTranscriptInProfile({
	sessionId,
	targetDir,
	profileDirs,
}: {
	sessionId: string;
	targetDir: string;
	profileDirs: readonly string[];
}): Promise<boolean> {
	if (!SESSION_ID_PATTERN.test(sessionId)) return false;
	const fileName = `${sessionId}.jsonl`;
	const locate = async (configDir: string): Promise<string | null> => {
		const projectsDir = path.join(configDir, "projects");
		let projects: string[];
		try {
			projects = await readdir(projectsDir);
		} catch {
			return null;
		}
		for (const project of projects) {
			const candidate = path.join(projectsDir, project, fileName);
			try {
				if ((await stat(candidate)).isFile()) return candidate;
			} catch {
				// Not in this project folder.
			}
		}
		return null;
	};
	if (await locate(targetDir)) return true;
	for (const dir of profileDirs) {
		if (path.resolve(dir) === path.resolve(targetDir)) continue;
		const source = await locate(dir);
		if (!source) continue;
		const destination = path.join(
			targetDir,
			"projects",
			path.basename(path.dirname(source)),
			fileName,
		);
		await mkdir(path.dirname(destination), { recursive: true });
		await copyFile(source, destination);
		return true;
	}
	return false;
}

interface SessionOutcome {
	initialised: boolean;
	error: unknown;
	/** Messages the failed process never answered (re-sent to the fresh session after a failed resume). */
	unsent: SDKUserMessage[];
	closedByUs: boolean;
	/** Startup failure text or the tail of the CLI's stderr. */
	detail: string | null;
	/** Turns still running when the process ended. */
	turnsPending: number;
}

interface SessionSettings {
	key: string;
	profile: ChatProfile;
	model: string;
	resume?: string;
}

class ChatSession {
	readonly key: string;
	readonly profile: ChatProfile;
	model: string;
	readonly resume?: string;
	sessionId: string | null = null;
	ended = false;
	/** Set by chat.reset: the conversation was thrown away, so its end must not be remembered for a resume. */
	forgotten = false;
	private readonly queue = new PromptQueue();
	private readonly mapper: ChatMapperState = createChatMapperState();
	private readonly pendingPermissions = new Map<
		string,
		(decision: { allow: boolean; message?: string }) => void
	>();
	/** The permission_request events still waiting, re-sent to a tab that (re)connects. */
	private readonly pendingPermissionEvents = new Map<string, ChatEvent>();
	/** tool_start events whose tool_end has not come yet, re-sent too so a reloaded panel keeps the tool's name. */
	private readonly openToolStarts = new Map<string, ChatEvent>();
	/** Messages sent before system/init: re-sent if the resume fails and a fresh session takes over. */
	private readonly sentBeforeInit: SDKUserMessage[] = [];
	private initialised = false;
	private closedByUs = false;
	/** Messages sent whose turn has not ended yet (a crash mid-turn still owes the panel a turn_end). */
	private turnsPending = 0;
	/** Last message sent or received (epoch ms), for the idle sweep. */
	private lastActivityAt = Date.now();
	/** Set when the CLI answered with a result before system/init (unknown resume id, not logged in...). */
	private startupFailure: string | null = null;
	private emitChain: Promise<void> = Promise.resolve();
	private readonly stderrTail: string[] = [];
	private query: Query | null = null;

	constructor(
		settings: SessionSettings,
		private readonly deps: ChatManagerDeps,
		private readonly onEnded: (
			session: ChatSession,
			outcome: SessionOutcome,
		) => void,
	) {
		this.key = settings.key;
		this.profile = settings.profile;
		this.model = settings.model;
		this.resume = settings.resume;
	}

	start(): void {
		const { config, registry, logger } = this.deps;
		const sdkServer = createSdkMcpServer({
			name: MCP_SERVER_NAME,
			version: BRIDGE_VERSION,
			instructions: EDITOR_RULES,
			tools: [],
			timeout: SDK_TOOL_TIMEOUT_MS,
		});
		registerToolsOnServer({
			server: sdkServer.instance,
			registry,
			getOrigin: () => ({ kind: "chat", sessionKey: this.key }),
			logger: logger.child("chat-tools"),
		});
		const options: Options = {
			pathToClaudeCodeExecutable: config.claudePath,
			cwd: this.deps.cwd,
			env: buildChatEnv({
				baseEnv: this.deps.baseEnv ?? process.env,
				profileDir: config.profiles[this.profile],
				home: this.deps.home,
			}),
			model: this.model,
			mcpServers: { [MCP_SERVER_NAME]: sdkServer },
			strictMcpConfig: true,
			settingSources: [],
			tools: [],
			// No allowedTools on purpose: an allow rule would auto-approve the tool before canUseTool runs. canUseTool
			// approves every opencut tool at once, except destructive ones, which wait for the panel's answer.
			permissionMode: "default",
			canUseTool: this.canUseTool,
			includePartialMessages: true,
			systemPrompt: {
				type: "preset",
				preset: "claude_code",
				append: CHAT_SYSTEM_PROMPT_APPEND,
			},
			...(supportsAdaptiveThinking(this.model)
				? { thinking: { type: "adaptive", display: "summarized" } }
				: {}),
			...(config.chatEffort ? { effort: config.chatEffort } : {}),
			...(this.resume ? { resume: this.resume } : {}),
			stderr: (data: string) => {
				for (const line of data.split("\n")) {
					if (line.trim() === "") continue;
					this.stderrTail.push(line.trim().slice(0, 300));
					if (this.stderrTail.length > 5) this.stderrTail.shift();
				}
			},
		};
		logger.info("chat session starting", {
			sessionKey: this.key,
			profile: this.profile,
			model: this.model,
			resume: this.resume,
		});
		const queryFn = this.deps.queryFn ?? sdkQuery;
		this.query = queryFn({ prompt: this.queue, options });
		void this.consume(this.query);
	}

	send(message: SDKUserMessage): void {
		this.lastActivityAt = Date.now();
		if (!this.initialised) this.sentBeforeInit.push(message);
		if (this.queue.push(message)) this.turnsPending += 1;
	}

	/** No turn running, no prompt waiting, and nothing sent or received for `idleMs`. */
	isIdle({ now, idleMs }: { now: number; idleMs: number }): boolean {
		return (
			!this.ended &&
			this.turnsPending === 0 &&
			this.pendingPermissions.size === 0 &&
			now - this.lastActivityAt >= idleMs
		);
	}

	async setModel(model: string): Promise<void> {
		if (!this.query) throw new Error("session not started");
		await this.query.setModel(model);
		this.model = model;
	}

	async interrupt(): Promise<void> {
		this.denyAllPermissions("The user stopped the turn.");
		await this.query?.interrupt();
	}

	close(): void {
		this.closedByUs = true;
		this.denyAllPermissions("The chat session was closed.");
		this.queue.close();
		try {
			this.query?.close();
		} catch {
			// Already gone.
		}
	}

	answerPermission({
		requestId,
		allow,
		message,
	}: {
		requestId: string;
		allow: boolean;
		message?: string;
	}): boolean {
		const resolve = this.pendingPermissions.get(requestId);
		if (!resolve) return false;
		this.pendingPermissions.delete(requestId);
		this.pendingPermissionEvents.delete(requestId);
		resolve({ allow, ...(message ? { message } : {}) });
		return true;
	}

	/**
	 * Emits the tool calls still running, then the permission requests still waiting, again (a tab reloaded and
	 * lost them). Returns the number of permission requests.
	 */
	resendPendingPermissions(): number {
		for (const event of this.openToolStarts.values()) this.emit(event);
		for (const event of this.pendingPermissionEvents.values()) this.emit(event);
		return this.pendingPermissionEvents.size;
	}

	emit(event: ChatEvent): void {
		if (event.type === "tool_start")
			this.openToolStarts.set(event.toolUseId, event);
		else if (event.type === "tool_end")
			this.openToolStarts.delete(event.toolUseId);
		else if (event.type === "turn_end") this.openToolStarts.clear();
		// Chained so an async thumbnail step never reorders events.
		this.emitChain = this.emitChain
			.then(async () => {
				this.deps.emit(this.key, await this.shrinkImage(event));
			})
			.catch((error: unknown) => {
				this.deps.logger.warn("chat event dropped", {
					type: event.type,
					error: errorMessage(error),
				});
			});
	}

	private async shrinkImage(event: ChatEvent): Promise<ChatEvent> {
		if (
			event.type !== "tool_end" ||
			!event.image ||
			event.image.data.length <= THUMBNAIL_MAX_BASE64
		)
			return event;
		const scaled = await downscaleImage({
			ffmpegPath: this.deps.config.ffmpegPath,
			data: Buffer.from(event.image.data, "base64"),
			maxEdge: THUMBNAIL_MAX_EDGE,
		});
		if (scaled)
			return { ...event, image: { data: scaled, mimeType: "image/jpeg" } };
		const { image: _image, ...rest } = event;
		return rest;
	}

	private readonly canUseTool: CanUseTool = async (
		toolName,
		input,
		{ signal },
	): Promise<PermissionResult> => {
		const bare = bareToolName(toolName);
		const entry = toolName.startsWith(`mcp__${MCP_SERVER_NAME}__`)
			? this.deps.registry.get(bare)
			: undefined;
		if (!entry)
			return {
				behavior: "deny",
				message: "Only the opencut editor tools are available in this chat.",
			};
		if (!entry.tool.annotations.destructiveHint)
			return { behavior: "allow", updatedInput: input };
		const requestId = randomUUID();
		const decision = await new Promise<{
			allow: boolean;
			message?: string;
			timedOut?: boolean;
		}>((resolve) => {
			const timeoutMs = this.deps.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS;
			const finish = (value: {
				allow: boolean;
				message?: string;
				timedOut?: boolean;
			}) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				this.pendingPermissions.delete(requestId);
				this.pendingPermissionEvents.delete(requestId);
				resolve(value);
			};
			const timer = setTimeout(
				() => finish({ allow: false, timedOut: true }),
				timeoutMs,
			);
			const onAbort = () =>
				finish({ allow: false, message: "The turn was interrupted." });
			signal.addEventListener("abort", onAbort, { once: true });
			this.pendingPermissions.set(requestId, finish);
			const request: ChatEvent = {
				type: "permission_request",
				requestId,
				toolName: bare,
				input,
				reason: permissionReasonFr(bare, input),
			};
			this.pendingPermissionEvents.set(requestId, request);
			this.emit(request);
		});
		this.deps.logger.info("chat permission", {
			sessionKey: this.key,
			tool: bare,
			allow: decision.allow,
			timedOut: decision.timedOut,
		});
		if (decision.allow) return { behavior: "allow", updatedInput: input };
		if (decision.timedOut) {
			this.emit({
				type: "error",
				message: `La demande d'autorisation pour « ${bare} » est restée sans réponse pendant 5 minutes : action refusée.`,
			});
			return {
				behavior: "deny",
				message:
					"The user did not answer the permission request within 5 minutes; the action was not run.",
			};
		}
		return {
			behavior: "deny",
			message:
				decision.message ?? "The user declined this action in the chat panel.",
		};
	};

	private denyAllPermissions(message: string): void {
		for (const resolve of [...this.pendingPermissions.values()])
			resolve({ allow: false, message });
		this.pendingPermissions.clear();
		this.pendingPermissionEvents.clear();
	}

	private async consume(query: Query): Promise<void> {
		let failure: unknown = null;
		try {
			for await (const message of query) this.handleMessage(message);
		} catch (error) {
			failure = error;
		}
		this.ended = true;
		this.denyAllPermissions("The chat session ended.");
		await this.emitChain;
		this.onEnded(this, {
			initialised: this.initialised,
			error: failure,
			unsent: this.initialised ? [] : [...this.sentBeforeInit],
			closedByUs: this.closedByUs,
			detail: this.startupFailure ?? (this.stderrTail.join(" | ") || null),
			turnsPending: this.turnsPending,
		});
	}

	private handleMessage(message: SDKMessage): void {
		this.lastActivityAt = Date.now();
		if (!this.initialised && message.type === "result") {
			// The CLI failed before starting the conversation and waits for more input: end this process; the manager
			// restarts without resume, or reports the failure.
			this.startupFailure =
				message.subtype === "success"
					? message.result
					: message.errors?.length
						? message.errors.join(" ; ")
						: message.subtype;
			this.deps.logger.warn("chat session failed to start", {
				sessionKey: this.key,
				resume: this.resume,
				detail: this.startupFailure,
			});
			this.queue.close();
			try {
				this.query?.close();
			} catch {
				// Already gone.
			}
			return;
		}
		if (message.type === "system" && message.subtype === "init") {
			this.initialised = true;
			this.sentBeforeInit.length = 0;
			this.sessionId = message.session_id;
			this.deps.logger.info("chat session ready", {
				sessionKey: this.key,
				sessionId: message.session_id,
				model: message.model,
				apiKeySource: message.apiKeySource,
			});
			if (message.apiKeySource !== "none") {
				this.deps.logger.warn("chat is not using the subscription login", {
					apiKeySource: message.apiKeySource,
				});
			}
		}
		if (message.type === "result") {
			this.sessionId = message.session_id;
			this.turnsPending = Math.max(0, this.turnsPending - 1);
		}
		for (const event of mapSdkMessage(message, this.mapper)) this.emit(event);
	}
}

function supportsAdaptiveThinking(model: string): boolean {
	return !/haiku/i.test(model);
}

export function createChatManager(deps: ChatManagerDeps): ChatManager {
	const { config, logger } = deps;
	const sessions = new Map<string, ChatSession>();
	/** Last Agent SDK session per key, to resume after a crash or a profile switch. */
	const lastSessions = new Map<
		string,
		{ sessionId: string; profile: ChatProfile; model: string }
	>();
	/** chat.send handling is async (transcript copy, setModel): serialised per key so sends never race. */
	const sendChains = new Map<string, Promise<void>>();

	const idleMs = deps.idleSessionMs ?? IDLE_SESSION_MS;
	const idleSweep = setInterval(
		() => {
			const now = Date.now();
			for (const session of [...sessions.values()]) {
				if (sendChains.has(session.key) || !session.isIdle({ now, idleMs }))
					continue;
				logger.info("closing an idle chat session", {
					sessionKey: session.key,
					sessionId: session.sessionId ?? undefined,
				});
				// onSessionEnded keeps its id in lastSessions: the next message resumes it.
				session.close();
			}
		},
		Math.min(60_000, Math.max(10, Math.floor(idleMs / 2))),
	);
	idleSweep.unref?.();

	const unsubscribeJobs = deps.jobs.subscribe((job: Job) => {
		if (job.origin.kind !== "chat") return;
		deps.emit(job.origin.sessionKey, {
			type: "job",
			jobId: job.id,
			kind: job.kind,
			status: job.status,
			progress: Math.min(1, Math.max(0, job.progress)),
			...(job.phase === undefined ? {} : { phase: job.phase }),
			...(job.message === undefined ? {} : { message: job.message }),
		});
	});

	function emitError(sessionKey: string, message: string): void {
		deps.emit(sessionKey, { type: "error", message });
	}

	function startSession(settings: SessionSettings): ChatSession {
		const session = new ChatSession(settings, deps, (ended, outcome) =>
			onSessionEnded(ended, outcome),
		);
		sessions.set(settings.key, session);
		session.start();
		return session;
	}

	function onSessionEnded(session: ChatSession, outcome: SessionOutcome): void {
		// A reset session ends asynchronously after close(): remembering it here would make the next message
		// resume the conversation the user just discarded.
		if (session.sessionId && !session.forgotten) {
			lastSessions.set(session.key, {
				sessionId: session.sessionId,
				profile: session.profile,
				model: session.model,
			});
		}
		const current = sessions.get(session.key) === session;
		if (current) sessions.delete(session.key);
		logger.info("chat session ended", {
			sessionKey: session.key,
			sessionId: session.sessionId ?? undefined,
			byUs: outcome.closedByUs,
			error: outcome.error ? errorMessage(outcome.error) : undefined,
		});
		if (outcome.closedByUs || !current) return;
		const detail =
			outcome.detail ??
			(outcome.error ? errorMessage(outcome.error) : "sans message");
		if (!outcome.initialised && session.resume) {
			// The conversation to resume was not found (other profile, deleted transcript...): start fresh.
			lastSessions.delete(session.key);
			emitError(
				session.key,
				"Impossible de reprendre la conversation précédente : une nouvelle conversation commence.",
			);
			const fresh = startSession({
				key: session.key,
				profile: session.profile,
				model: session.model,
			});
			for (const message of outcome.unsent) fresh.send(message);
			return;
		}
		if (!outcome.initialised) {
			emitError(
				session.key,
				`Claude Code n'a pas pu démarrer (${detail}). Vérifie que le profil ${session.profile} est connecté (claude puis /login).`,
			);
			return;
		}
		emitError(
			session.key,
			`La session Claude s'est arrêtée (${detail}). Le prochain message la relancera.`,
		);
		// Unblock the panel: the interrupted turn will never get its own turn_end.
		if (outcome.turnsPending > 0 && session.sessionId) {
			deps.emit(session.key, {
				type: "turn_end",
				sessionId: session.sessionId,
				durationMs: 0,
			});
		}
	}

	async function prepareResume({
		sessionId,
		profile,
	}: {
		sessionId: string;
		profile: ChatProfile;
	}): Promise<void> {
		try {
			await ensureTranscriptInProfile({
				sessionId,
				targetDir: config.profiles[profile],
				profileDirs: Object.values(config.profiles),
			});
		} catch (error) {
			logger.warn("could not copy the transcript between profiles", {
				error: errorMessage(error),
			});
		}
	}

	async function handleSend(message: ChatSendMessage): Promise<void> {
		const key = message.sessionKey;
		if (message.model !== undefined && !MODEL_PATTERN.test(message.model)) {
			emitError(key, `Modèle inconnu : « ${message.model} ».`);
			return;
		}
		const user = buildUserMessage({
			text: message.text,
			attachments: message.attachments,
		});
		if (!user) {
			emitError(key, "Message vide : rien à envoyer.");
			return;
		}
		let session = sessions.get(key);
		const profile =
			message.profile ?? session?.profile ?? config.defaultProfile;
		const model = message.model ?? session?.model ?? config.defaultModel;

		if (session && !session.ended && session.profile !== profile) {
			// Another profile is another login and another process: resume the same conversation there.
			const resume = session.sessionId ?? undefined;
			session.close();
			sessions.delete(key);
			if (resume) await prepareResume({ sessionId: resume, profile });
			session = startSession({
				key,
				profile,
				model,
				...(resume ? { resume } : {}),
			});
		} else if (session && !session.ended && session.model !== model) {
			try {
				await session.setModel(model);
				logger.info("chat model changed", { sessionKey: key, model });
			} catch (error) {
				logger.warn("setModel failed, restarting the session", {
					error: errorMessage(error),
				});
				const resume = session.sessionId ?? undefined;
				session.close();
				sessions.delete(key);
				session = startSession({
					key,
					profile,
					model,
					...(resume ? { resume } : {}),
				});
			}
		}
		if (!session || session.ended) {
			const last = lastSessions.get(key);
			const resume = last?.sessionId ?? message.resumeSessionId;
			if (resume) await prepareResume({ sessionId: resume, profile });
			session = startSession({
				key,
				profile,
				model,
				...(resume ? { resume } : {}),
			});
		}
		session.send(user);
	}

	return {
		resendPendingPermissions() {
			let count = 0;
			for (const session of sessions.values()) {
				if (!session.ended) count += session.resendPendingPermissions();
			}
			return count;
		},
		handle(message) {
			switch (message.type) {
				case "chat.send": {
					const key = message.sessionKey;
					const next = (sendChains.get(key) ?? Promise.resolve())
						.then(() => handleSend(message))
						.catch((error: unknown) => {
							logger.error("chat send failed", { error: errorMessage(error) });
							emitError(
								key,
								`Le message n'a pas pu être envoyé : ${errorMessage(error)}`,
							);
						});
					sendChains.set(key, next);
					void next.finally(() => {
						if (sendChains.get(key) === next) sendChains.delete(key);
					});
					return;
				}
				case "chat.interrupt": {
					const session = sessions.get(message.sessionKey);
					session
						?.interrupt()
						.catch((error: unknown) =>
							logger.warn("interrupt failed", { error: errorMessage(error) }),
						);
					return;
				}
				case "chat.reset": {
					const session = sessions.get(message.sessionKey);
					if (session) session.forgotten = true;
					session?.close();
					sessions.delete(message.sessionKey);
					lastSessions.delete(message.sessionKey);
					logger.info("chat session reset", { sessionKey: message.sessionKey });
					return;
				}
				case "chat.permission_response": {
					const session = sessions.get(message.sessionKey);
					const answered = session?.answerPermission({
						requestId: message.requestId,
						allow: message.allow,
						...(message.message ? { message: message.message } : {}),
					});
					if (!answered)
						logger.warn("permission answer for an unknown request", {
							requestId: message.requestId,
						});
					return;
				}
			}
		},
		count: () => sessions.size,
		async close() {
			clearInterval(idleSweep);
			unsubscribeJobs();
			for (const session of sessions.values()) session.close();
			sessions.clear();
		},
	};
}
