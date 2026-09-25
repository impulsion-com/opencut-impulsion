import { z } from "zod";

/**
 * Where a tool's handler runs.
 * - "tab": in the editor tab, against EditorCore (the sidecar forwards the call over the hub).
 * - "sidecar": in the Node sidecar (apps/bridge) only; the tab is not involved.
 * - "hybrid": the sidecar handles the call: it does the disk or job part in Node and calls the tab through
 *   internal methods (INTERNAL_METHOD_PARAMS) or tab tools (e.g. list_media). The tab never receives the
 *   hybrid tool name itself.
 */
export const TOOL_RUNS_IN = ["tab", "sidecar", "hybrid"] as const;
export type ToolRunsIn = (typeof TOOL_RUNS_IN)[number];

/** Catalogue sections, used for docs and for ordering tools in UIs. */
export const TOOL_GROUPS = [
	"read",
	"vision",
	"edit",
	"playback",
	"project",
	"media",
	"export",
] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** MCP tool annotations (hints only, never a security boundary). */
export interface ToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

/**
 * Every tool input is a zod object. Keep schemas JSON Schema friendly:
 * no transforms, no .default() (defaults are documented in .describe() and applied by handlers),
 * so z.toJSONSchema gives the same result with io "input" and "output".
 */
export type ToolInputSchema = z.ZodObject<z.ZodRawShape>;

export interface ToolDefinition<
	N extends string = string,
	I extends ToolInputSchema = ToolInputSchema,
> {
	readonly name: N;
	/** Short human title (MCP "title"). */
	readonly title: string;
	/** Written for the model: what, when, returns, units, gotchas. */
	readonly description: string;
	readonly group: ToolGroup;
	readonly runsIn: ToolRunsIn;
	readonly input: I;
	readonly annotations: Readonly<ToolAnnotations>;
	/** True when the tool starts a background job and returns a jobId instead of waiting. */
	readonly longRunning: boolean;
	/** Hint for the bridge: register with alwaysLoad so Claude Code never defers the tool behind tool search. */
	readonly alwaysLoad: boolean;
}

export interface DefineToolInput<N extends string, I extends ToolInputSchema> {
	name: N;
	title: string;
	description: string;
	group: ToolGroup;
	runsIn: ToolRunsIn;
	input: I;
	annotations: ToolAnnotations;
	longRunning?: boolean;
	alwaysLoad?: boolean;
}

/** Declares a tool. Pure data: handlers live in apps/bridge (sidecar) and apps/web (tab). */
export function defineTool<const N extends string, I extends ToolInputSchema>(
	def: DefineToolInput<N, I>,
): ToolDefinition<N, I> {
	return Object.freeze({
		name: def.name,
		title: def.title,
		description: def.description,
		group: def.group,
		runsIn: def.runsIn,
		input: def.input,
		annotations: Object.freeze({ ...def.annotations }),
		longRunning: def.longRunning ?? false,
		alwaysLoad: def.alwaysLoad ?? false,
	});
}

/** `_meta` key that keeps a tool out of Claude Code's tool-search deferral. */
export const ALWAYS_LOAD_META_KEY = "anthropic/alwaysLoad";

/**
 * The config both MCP registrations must use: `McpServer.registerTool(tool.name, toMcpToolConfig(tool), handler)`
 * on the Streamable HTTP server, and the same call on `createSdkMcpServer({...}).instance` for the chat panel.
 *
 * `inputSchema` is the FULL strict zod object on purpose. Passing `tool.input.shape` (or using the Agent SDK's
 * `tool()` helper, which only accepts a shape) makes the MCP SDK rebuild a plain `z.object`, which silently
 * strips unknown top-level keys: a misspelled `dry_run` would reach the handler as nothing and the plan would be
 * APPLIED instead of dry-run. With the strict object the call fails with -32602 "Unrecognized key".
 */
export function toMcpToolConfig<T extends ToolDefinition>(tool: T): {
	title: string;
	description: string;
	inputSchema: T["input"];
	annotations: Readonly<ToolAnnotations>;
	_meta?: Record<string, unknown>;
} {
	return {
		title: tool.title,
		description: tool.description,
		inputSchema: tool.input,
		annotations: tool.annotations,
		...(tool.alwaysLoad ? { _meta: { [ALWAYS_LOAD_META_KEY]: true } } : {}),
	};
}

/** Parsed params a handler receives (after zod parsing). */
export type InputOf<T extends ToolDefinition> = z.output<T["input"]>;
/** Params as a caller may send them (before parsing). */
export type RawInputOf<T extends ToolDefinition> = z.input<T["input"]>;

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

export const TOOL_IMAGE_MIME_TYPES = ["image/jpeg", "image/png"] as const;
export type ToolImageMimeType = (typeof TOOL_IMAGE_MIME_TYPES)[number];

export const ToolImageSchema = z.object({
	/** Base64 without the data: prefix. */
	data: z.string().min(1),
	mimeType: z.enum(TOOL_IMAGE_MIME_TYPES),
	caption: z.string().optional(),
});
export type ToolImage = z.infer<typeof ToolImageSchema>;

/**
 * What every handler returns. The bridge maps it to MCP content:
 * each image becomes an image block (followed by its caption as text), `text` becomes a text block,
 * and `json` becomes a text block with compact JSON (and structuredContent when useful).
 */
export const ToolResultSchema = z.object({
	json: z.unknown().optional(),
	text: z.string().optional(),
	images: z.array(ToolImageSchema).optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;
