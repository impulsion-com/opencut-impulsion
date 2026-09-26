import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	ChatEventSchema,
	type ChatEvent,
	type ChatUsage,
} from "@opencut/claude-tools";
import { MCP_SERVER_NAME } from "./version";

// Pure projection of the Agent SDK stream (SDKMessage) onto the contract's ChatEvent union, so the web app never
// depends on SDK types. Stateful only to pair streamed tool_use blocks with their ids.
//
// tool_start comes at most twice per toolUseId: once when the block starts streaming (input null, so the panel can
// show "Claude prépare ..." early) and once when the input is complete. The panel should upsert by toolUseId.

export interface ChatMapperState {
	sessionId: string | null;
	/** Streaming content block index -> tool_use id. */
	streamingTools: Map<number, string>;
	/** Tool uses already announced with their complete input. */
	completedTools: Set<string>;
}

export function createChatMapperState(): ChatMapperState {
	return {
		sessionId: null,
		streamingTools: new Map(),
		completedTools: new Set(),
	};
}

const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
const SUMMARY_MAX = 160;

/** "mcp__opencut__apply_edit_plan" -> "apply_edit_plan" (other names are returned unchanged). */
export function bareToolName(name: string): string {
	return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

const ASSISTANT_ERRORS_FR: Record<string, string> = {
	authentication_failed:
		"Claude Code n'est pas connecté pour ce profil. Lance `claude` puis /login dans un terminal.",
	oauth_org_not_allowed:
		"Ce compte n'est pas autorisé pour cette organisation.",
	account_on_hold: "Le compte Claude est suspendu.",
	verification_required: "Le compte Claude demande une vérification.",
	billing_error: "Problème de facturation sur le compte Claude.",
	rate_limit:
		"Limite d'utilisation atteinte. Réessaie plus tard ou change de profil.",
	overloaded:
		"Les serveurs de Claude sont surchargés. Réessaie dans un instant.",
	invalid_request: "La requête a été refusée par l'API.",
	model_not_found: "Ce modèle n'est pas disponible pour ce compte.",
	server_error: "Erreur côté serveur de Claude.",
	max_output_tokens: "La réponse a atteint la longueur maximale.",
	cloud_credential_error: "Identifiants cloud invalides.",
	unknown: "Erreur inconnue de Claude.",
};

export function apiKeyWarningFr(apiKeySource: string): string {
	return `Attention : Claude n'utilise pas la connexion de l'abonnement (source de la clé : ${apiKeySource}). Ces échanges pourraient être facturés à l'API. Retire la clé d'API de l'environnement du sidecar puis relance-le.`;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function nonNegativeInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.round(value))
		: undefined;
}

function usageFrom(value: unknown): ChatUsage | undefined {
	const usage = record(value);
	if (!usage) return undefined;
	const inputTokens = nonNegativeInt(usage.input_tokens);
	const outputTokens = nonNegativeInt(usage.output_tokens);
	if (inputTokens === undefined || outputTokens === undefined) return undefined;
	const cacheReadTokens = nonNegativeInt(usage.cache_read_input_tokens);
	const cacheCreationTokens = nonNegativeInt(usage.cache_creation_input_tokens);
	return {
		inputTokens,
		outputTokens,
		...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
		...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
	};
}

function oneLine(text: string): string {
	const line =
		text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
	const trimmed = line.trim();
	return trimmed.length > SUMMARY_MAX
		? `${trimmed.slice(0, SUMMARY_MAX - 3)}...`
		: trimmed;
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count > 1 ? many : one}`;
}

function formatSeconds(value: unknown): string | null {
	return typeof value === "number" && Number.isFinite(value)
		? `${String(Math.round(value * 10) / 10).replace(".", ",")} s`
		: null;
}

const JOB_STATUS_FR: Record<string, string> = {
	queued: "en attente",
	running: "en cours",
	done: "terminée",
	failed: "échouée",
	cancelled: "annulée",
};

/**
 * French one-liner for a tool's JSON result, read from its shape (the chip only needs the gist). Unknown shapes
 * give undefined: the chip then shows the tool label alone rather than raw JSON.
 */
export function summarizeJsonResult(value: unknown): string | undefined {
	if (Array.isArray(value))
		return plural(value.length, "résultat", "résultats");
	const result = record(value);
	if (!result) return undefined;
	const project = record(result.project);
	if (project && Array.isArray(result.tracks)) {
		const elements = result.tracks.reduce<number>((total, track) => {
			const items = record(track)?.elements;
			return total + (Array.isArray(items) ? items.length : 0);
		}, 0);
		return [
			typeof project.name === "string" ? project.name : null,
			formatSeconds(project.duration),
			plural(result.tracks.length, "piste", "pistes"),
			plural(elements, "élément", "éléments"),
		]
			.filter((part): part is string => part !== null)
			.join(" · ");
	}
	if (
		typeof result.applied === "boolean" &&
		typeof result.opCount === "number"
	) {
		if (result.dryRun === true)
			return `Essai sans modification : ${plural(result.opCount, "opération valide", "opérations valides")}`;
		return result.applied
			? plural(result.opCount, "opération appliquée", "opérations appliquées")
			: "Aucun changement";
	}
	if (typeof result.marked === "number")
		return plural(result.marked, "plage marquée", "plages marquées");
	if (typeof result.undone === "number")
		return plural(result.undone, "étape annulée", "étapes annulées");
	if (typeof result.redone === "number")
		return plural(result.redone, "étape rétablie", "étapes rétablies");
	if (Array.isArray(result.imported)) {
		const skipped = Array.isArray(result.skipped) ? result.skipped.length : 0;
		const imported = plural(
			result.imported.length,
			"fichier importé",
			"fichiers importés",
		);
		return skipped > 0
			? `${imported}, ${skipped} ignoré${skipped > 1 ? "s" : ""}`
			: imported;
	}
	if (typeof result.jobId === "string" && typeof result.status === "string") {
		const status = JOB_STATUS_FR[result.status] ?? result.status;
		const progress =
			typeof result.progress === "number" && result.status === "running"
				? ` (${Math.round(result.progress * 100)} %)`
				: "";
		return `Tâche ${status}${progress}`;
	}
	if (typeof result.jobId === "string") return "Tâche lancée";
	if (Array.isArray(result.entries))
		return plural(result.entries.length, "entrée", "entrées");
	if (typeof result.projectId === "string" && typeof result.name === "string")
		return `Projet « ${result.name} »`;
	if (Array.isArray(result.removed))
		return plural(result.removed.length, "média retiré", "médias retirés");
	if (Array.isArray(result.selected))
		return plural(
			result.selected.length,
			"élément sélectionné",
			"éléments sélectionnés",
		);
	if (typeof result.saved === "boolean") {
		// saved is false when the save did not land (no project, still loading, not settled within 5 s).
		if (!result.saved) return "Enregistrement non confirmé";
		return result.wasDirty === false ? "Déjà enregistré" : "Projet enregistré";
	}
	const playhead = formatSeconds(result.playhead);
	if (playhead) return `Tête de lecture à ${playhead}`;
	return undefined;
}

const FRAME_CAPTION = /^frame @(\d+(?:\.\d+)?)s \d+x\d+/;
const SHEET_CAPTION =
	/^contact sheet: (\d+) frames (\d+(?:\.\d+)?)s to (\d+(?:\.\d+)?)s/;
const SOURCE_FRAMES_CAPTION = /^source frames of "(.*)": (\d+) frames/;
const IMAGE_CAPTION = /^image "(.*)" \d+x\d+$/;

/** French gist of the caption the vision tools put before their image (the caption is written for Claude). */
export function summarizeCaption(line: string): string | undefined {
	const frame = FRAME_CAPTION.exec(line);
	if (frame) {
		const empty = line.includes("(empty timeline") ? " (timeline vide)" : "";
		return `Image à ${formatSeconds(Number(frame[1]))}${empty}`;
	}
	const sheet = SHEET_CAPTION.exec(line);
	if (sheet)
		return `Planche de ${sheet[1]} images, de ${formatSeconds(Number(sheet[2]))} à ${formatSeconds(Number(sheet[3]))}`;
	const source = SOURCE_FRAMES_CAPTION.exec(line);
	if (source)
		return `${plural(Number(source[2]), "image", "images")} de « ${source[1]} »`;
	const image = IMAGE_CAPTION.exec(line);
	if (image) return `Image « ${image[1]} »`;
	return undefined;
}

/** Chip summary of a tool result's first text block: JSON and captions get a French gist, else its first line. */
export function summarizeToolText(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return summarizeJsonResult(JSON.parse(trimmed));
		} catch {
			// Not JSON after all: fall back to the first line.
		}
	}
	const line = oneLine(text);
	if (line === "") return undefined;
	if (line === "ok") return "Fait";
	return summarizeCaption(line) ?? line;
}

const ERROR_CODES_FR: Readonly<Record<string, string>> = {
	EDITOR_NOT_CONNECTED: "Éditeur non connecté",
	NO_PROJECT: "Aucun projet prêt",
	PROJECT_MISMATCH: "Un autre projet est ouvert",
	USER_INTERACTING: "Manipulation en cours dans l'éditeur",
	EXPORTING: "Export en cours",
	INVALID_PARAMS: "Paramètres refusés",
	INVALID_EDIT: "Modification refusée",
	NOT_FOUND: "Introuvable",
	STALE_STATE: "Timeline modifiée entre-temps",
	TIMEOUT: "Délai dépassé",
	CONNECTION_LOST: "Connexion à l'éditeur perdue",
	BUSY: "Éditeur occupé",
	INTERNAL: "Erreur interne",
};

/**
 * Chip summary of a failed tool call. Its text ("INVALID_EDIT: op 1 (move)... Nothing was applied.") is English
 * and meant for Claude: the chip gets a short French phrase for the code instead.
 */
export function summarizeToolError(text: string): string {
	const code = /^([A-Z_]+): /.exec(text.trim())?.[1];
	return (code ? ERROR_CODES_FR[code] : undefined) ?? "Non exécuté";
}

type ToolEndImage = { data: string; mimeType: "image/jpeg" | "image/png" };

/** First image of a tool_result content (Messages API image blocks, or MCP-style {data, mimeType}). */
export function firstImage(content: unknown): ToolEndImage | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		const entry = record(block);
		if (!entry || entry.type !== "image") continue;
		const source = record(entry.source);
		const data = source?.data ?? entry.data;
		const mimeType = source?.media_type ?? entry.mimeType;
		if (
			typeof data === "string" &&
			data.length > 0 &&
			(mimeType === "image/jpeg" || mimeType === "image/png")
		) {
			return { data, mimeType };
		}
	}
	return undefined;
}

function firstText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		const entry = record(block);
		if (
			entry?.type === "text" &&
			typeof entry.text === "string" &&
			entry.text.trim() !== ""
		)
			return entry.text;
	}
	return undefined;
}

function mapStreamEvent(event: unknown, state: ChatMapperState): ChatEvent[] {
	const streamEvent = record(event);
	if (!streamEvent) return [];
	switch (streamEvent.type) {
		case "content_block_start": {
			const block = record(streamEvent.content_block);
			const index =
				typeof streamEvent.index === "number" ? streamEvent.index : -1;
			if (
				block?.type === "tool_use" &&
				typeof block.id === "string" &&
				typeof block.name === "string"
			) {
				state.streamingTools.set(index, block.id);
				return [
					{
						type: "tool_start",
						toolUseId: block.id,
						name: bareToolName(block.name),
						input: null,
					},
				];
			}
			return [];
		}
		case "content_block_delta": {
			const delta = record(streamEvent.delta);
			if (
				delta?.type === "text_delta" &&
				typeof delta.text === "string" &&
				delta.text !== ""
			) {
				return [{ type: "text_delta", text: delta.text }];
			}
			if (
				delta?.type === "thinking_delta" &&
				typeof delta.thinking === "string" &&
				delta.thinking !== ""
			) {
				return [{ type: "thinking_delta", text: delta.thinking }];
			}
			return [];
		}
		case "message_stop":
			state.streamingTools.clear();
			return [{ type: "assistant_done" }];
		default:
			return [];
	}
}

/** Maps one SDK message to zero or more chat events (already valid against ChatEventSchema). */
export function mapSdkMessage(
	message: SDKMessage,
	state: ChatMapperState,
): ChatEvent[] {
	const events: ChatEvent[] = [];
	switch (message.type) {
		case "system": {
			if (message.subtype !== "init") break;
			state.sessionId = message.session_id;
			events.push({
				type: "session",
				sessionId: message.session_id,
				model: message.model,
				apiKeySource: String(message.apiKeySource),
			});
			if (message.apiKeySource !== "none") {
				events.push({
					type: "error",
					message: apiKeyWarningFr(String(message.apiKeySource)),
				});
			}
			break;
		}
		case "stream_event": {
			if (message.parent_tool_use_id !== null) break;
			events.push(...mapStreamEvent(message.event, state));
			break;
		}
		case "assistant": {
			if (message.parent_tool_use_id !== null) break;
			const content: unknown = message.message?.content;
			for (const block of Array.isArray(content) ? content : []) {
				const entry = record(block);
				if (
					entry?.type !== "tool_use" ||
					typeof entry.id !== "string" ||
					typeof entry.name !== "string"
				)
					continue;
				if (state.completedTools.has(entry.id)) continue;
				state.completedTools.add(entry.id);
				events.push({
					type: "tool_start",
					toolUseId: entry.id,
					name: bareToolName(entry.name),
					input: entry.input ?? {},
				});
			}
			if (message.error) {
				events.push({
					type: "error",
					message:
						ASSISTANT_ERRORS_FR[message.error] ??
						ASSISTANT_ERRORS_FR.unknown ??
						"Erreur.",
				});
			}
			break;
		}
		case "user": {
			if (message.parent_tool_use_id !== null || "isReplay" in message) break;
			const content: unknown = message.message?.content;
			for (const block of Array.isArray(content) ? content : []) {
				const entry = record(block);
				if (
					entry?.type !== "tool_result" ||
					typeof entry.tool_use_id !== "string"
				)
					continue;
				const text = firstText(entry.content);
				const image = firstImage(entry.content);
				const failed = entry.is_error === true;
				const summary = text
					? failed
						? summarizeToolError(text)
						: summarizeToolText(text)
					: failed
						? summarizeToolError("")
						: undefined;
				events.push({
					type: "tool_end",
					toolUseId: entry.tool_use_id,
					ok: entry.is_error !== true,
					...(summary ? { summary } : {}),
					...(image ? { image } : {}),
				});
			}
			break;
		}
		case "result": {
			const failed = message.subtype !== "success" || message.is_error;
			if (failed) {
				const detail =
					message.subtype === "success"
						? message.result
						: message.errors?.length
							? message.errors.join(" ; ")
							: message.subtype;
				events.push({
					type: "error",
					message: `Le tour s'est terminé sur une erreur : ${oneLine(detail || "erreur inconnue")}`,
				});
			}
			const usage = usageFrom(message.usage);
			const costUsd =
				typeof message.total_cost_usd === "number" &&
				message.total_cost_usd >= 0
					? message.total_cost_usd
					: undefined;
			events.push({
				type: "turn_end",
				sessionId: message.session_id,
				durationMs: Math.max(0, message.duration_ms ?? 0),
				...(usage ? { usage } : {}),
				...(costUsd === undefined ? {} : { costUsd }),
			});
			state.sessionId = message.session_id;
			break;
		}
		case "rate_limit_event": {
			events.push({ type: "rate_limit", info: { ...message.rate_limit_info } });
			break;
		}
		default:
			break;
	}
	// Belt and braces: never hand the tab an event its schema would refuse.
	return events.filter((event) => ChatEventSchema.safeParse(event).success);
}
