import { ERROR_HINTS, type ToolResult } from "@opencut/claude-tools";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toBridgeError } from "./errors";

// ToolResult (the contract's {json?, text?, images?}) to MCP content. Images first, each followed by its caption,
// then the text, then the JSON as one compact text block. Errors become isError results that end with the
// contract's remedy hint, so the model knows what to do next.

const MAX_DETAILS_CHARS = 1500;

export function compactJson(value: unknown): string {
	try {
		const text = JSON.stringify(value, (_key, inner: unknown) =>
			typeof inner === "bigint" ? inner.toString() : inner,
		);
		return text ?? "null";
	} catch {
		return String(value);
	}
}

export function toCallToolResult(result: ToolResult): CallToolResult {
	const content: CallToolResult["content"] = [];
	for (const image of result.images ?? []) {
		content.push({ type: "image", data: image.data, mimeType: image.mimeType });
		if (image.caption) content.push({ type: "text", text: image.caption });
	}
	if (result.text) content.push({ type: "text", text: result.text });
	if (result.json !== undefined)
		content.push({ type: "text", text: compactJson(result.json) });
	if (content.length === 0) content.push({ type: "text", text: "ok" });
	return { content };
}

export function toErrorCallToolResult(error: unknown): CallToolResult {
	const bridgeError = toBridgeError(error);
	const lines = [
		`${bridgeError.code}: ${bridgeError.message}`,
		ERROR_HINTS[bridgeError.code],
	];
	if (bridgeError.details !== undefined) {
		const details = compactJson(bridgeError.details);
		lines.push(
			`Details: ${details.length > MAX_DETAILS_CHARS ? `${details.slice(0, MAX_DETAILS_CHARS)}...` : details}`,
		);
	}
	return { isError: true, content: [{ type: "text", text: lines.join("\n") }] };
}
