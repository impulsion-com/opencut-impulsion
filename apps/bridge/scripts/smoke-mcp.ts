// Smoke test of a running sidecar through the real MCP client: initialize, tools/list, a few calls.
// Usage: node --import tsx scripts/smoke-mcp.ts [http://127.0.0.1:3457]
// Without an editor tab, tab tools must fail cleanly with EDITOR_NOT_CONNECTED (isError result, no crash).

import { BRIDGE_ORIGIN, TOOL_NAMES } from "@opencut/claude-tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.argv[2] ?? BRIDGE_ORIGIN;
let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
	if (!ok) failures += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

function firstText(result: unknown): string {
	const content: unknown =
		typeof result === "object" && result !== null
			? Reflect.get(result, "content")
			: undefined;
	if (!Array.isArray(content)) return "";
	const block: unknown = content.find(
		(item) =>
			typeof item === "object" &&
			item !== null &&
			Reflect.get(item, "type") === "text",
	);
	const text: unknown =
		typeof block === "object" && block !== null
			? Reflect.get(block, "text")
			: undefined;
	return typeof text === "string" ? text : "";
}

const health = (await (await fetch(`${base}/health`)).json()) as Record<
	string,
	unknown
>;
check("GET /health", health.ok === true, JSON.stringify(health));

const client = new Client({ name: "opencut-smoke", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
check(
	"initialize",
	client.getServerVersion()?.name === "opencut",
	JSON.stringify(client.getServerVersion()),
);
check(
	"server instructions",
	(client.getInstructions() ?? "").includes("You drive OpenCut"),
);

const { tools } = await client.listTools();
const names = tools.map((tool) => tool.name).sort();
check(
	"tools/list has every contract tool",
	JSON.stringify(names) === JSON.stringify([...TOOL_NAMES].sort()),
	`${names.length} tools`,
);
const alwaysLoaded = tools
	.filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === true)
	.map((tool) => tool.name);
check(
	"alwaysLoad meta on core tools",
	alwaysLoaded.includes("apply_edit_plan"),
	alwaysLoaded.join(","),
);
const planTool = tools.find((tool) => tool.name === "apply_edit_plan");
check(
	"apply_edit_plan schema is strict",
	planTool?.inputSchema.additionalProperties === false,
);

const state = await client.callTool({
	name: "get_editor_state",
	arguments: {},
});
const stateText = firstText(state);
const tabConnected =
	health.tab && (health.tab as Record<string, unknown>).connected === true;
if (tabConnected) {
	check(
		"get_editor_state (tab connected)",
		state.isError !== true,
		stateText.slice(0, 160),
	);
} else {
	check(
		"get_editor_state without a tab -> EDITOR_NOT_CONNECTED",
		state.isError === true && stateText.startsWith("EDITOR_NOT_CONNECTED"),
		stateText.split("\n")[0],
	);
}

const misspelled = await client
	.callTool({
		name: "apply_edit_plan",
		arguments: {
			ops: [{ op: "bookmark", time: 1, action: "add" }],
			dry_run: true,
		},
	})
	.catch((error: unknown) => error);
const misspelledText =
	misspelled instanceof Error ? misspelled.message : firstText(misspelled);
check(
	"misspelled key is refused, not stripped",
	/dry_run/.test(misspelledText) && /nrecognized/.test(misspelledText),
	misspelledText.split("\n")[0],
);

const roots = await client.callTool({ name: "list_disk_media", arguments: {} });
check(
	"list_disk_media (roots)",
	roots.isError !== true,
	firstText(roots).slice(0, 200),
);

const outside = await client.callTool({
	name: "list_disk_media",
	arguments: { folder: "/etc" },
});
check(
	"list_disk_media outside the roots -> INVALID_PARAMS",
	outside.isError === true && firstText(outside).startsWith("INVALID_PARAMS"),
	firstText(outside).split("\n")[0],
);

const job = await client.callTool({
	name: "job_status",
	arguments: { jobId: "nope" },
});
check(
	"job_status unknown -> NOT_FOUND",
	job.isError === true && firstText(job).startsWith("NOT_FOUND"),
	firstText(job).split("\n")[0],
);

if (!tabConnected) {
	const exportCall = await client.callTool({
		name: "start_export",
		arguments: {},
	});
	check(
		"start_export without a tab -> EDITOR_NOT_CONNECTED",
		exportCall.isError === true &&
			firstText(exportCall).startsWith("EDITOR_NOT_CONNECTED"),
		firstText(exportCall).split("\n")[0],
	);
}

await client.close();
console.log(
	failures === 0 ? "\nsmoke test passed" : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
