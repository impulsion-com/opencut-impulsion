# @opencut/claude-tools

The single source of truth for how Claude drives the editor. It holds definitions only, never handlers:

| File | Contents |
| --- | --- |
| `src/define.ts` | `defineTool()`, `ToolDefinition`, `toMcpToolConfig()`, `ToolResult` (`{json?, text?, images?}`) and its zod schema |
| `src/common.ts` | Shared primitives (seconds, hex colours, params), canvas presets, `TOOL_DEFAULTS` |
| `src/edit-plan.ts` | The `apply_edit_plan` op union (`EditOpSchema`, `EditPlanSchema`), `@name` reference checks (`checkEditPlan`, `getOpRefs`), `EditPlanResult` |
| `src/tools.ts` | The v1 catalogue (`TOOLS`, `TOOL_BY_NAME`, `ToolName`, `ToolInput<N>`, `parseToolInput`) |
| `src/protocol.ts` | Tab/hub WebSocket messages (`TabMessageSchema`, `HubMessageSchema`, `ChatEvent`), error codes and hints, internal RPC methods |
| `src/instructions.ts` | `EDITOR_RULES` (MCP `instructions`), `EDITOR_PROMPT_FR` and `CHAT_SYSTEM_PROMPT_APPEND` (chat panel) |

Consumers:

- **Sidecar (`apps/bridge`)** registers every tool twice with the same call, `server.registerTool(tool.name, toMcpToolConfig(tool), handler)`:
  - on the Streamable HTTP MCP server for Claude Code, `new McpServer(info, {instructions: EDITOR_RULES})`;
  - on the chat panel's in-process server, `createSdkMcpServer({name: "opencut", instructions: EDITOR_RULES, tools: [], timeout})`, calling `registerTool` on its `.instance` (an `McpServer`). Do not use the Agent SDK's `tool()` helper: it only accepts `input.shape`. Set `timeout` (ms) high enough for `import_media` of big rushes.

  `toMcpToolConfig` passes the full strict `tool.input` as `inputSchema`. Never pass `tool.input.shape`: the MCP SDK then rebuilds a plain `z.object` that silently strips unknown keys, so a misspelled `dry_run` would apply the plan instead of dry-running it (verified with SDK 1.30.1 and Agent SDK 0.3.282). The chat's `systemPrompt.append` is `CHAT_SYSTEM_PROMPT_APPEND` (the French persona only; the rules come from `instructions`).

  `runsIn` says who handles the call: `tab` tools are forwarded unchanged with `hub.call`; `sidecar` tools run in Node; `hybrid` tools are handled by the sidecar, which does the disk or job part in Node and calls the tab through `INTERNAL_METHOD_PARAMS` or tab tools (`list_disk_media` calls `list_media` for mediaIds). The sidecar also adds `path` to `list_media` results from its import index.

  The hub must reject WebSocket upgrades whose `Origin` is not `EDITOR_ORIGIN`, and `/mcp` must check `Host`/`Origin` (the MCP SDK's DNS-rebinding protection is off by default; `createMcpExpressApp({host: "127.0.0.1"})` turns it on). The tab only fetches `/files` (preferably the opaque `/files/<id>` form minted by the sidecar, so disk paths never travel in URLs; `/files?path=` also passes) and POSTs `/exports` on `BRIDGE_ORIGIN` (the protocol schemas refuse any other URL).
- **Editor tab (`apps/web`)** parses every hub frame with `parseHubMessage`, validates params with `parseToolInput(name, params)` and dispatches to a handler typed `(input: ToolInput<N>) => Promise<ToolResult>`.

Conventions baked into the schemas:

- Every time is in **seconds**. Keyframe times are relative to the element start; everything else is timeline time.
- Elements are referenced by `elementId` only; the tab resolves the track.
- In a plan, an op that creates something accepts `as: "name"`, and later ops may pass `"@name"` wherever an element, track or effect id is expected. `EditPlanSchema` rejects forward, unknown, duplicate or wrongly-typed references at parse time.
- Tool inputs are strict objects (unknown keys are errors) and never use `.default()`: defaults are documented in `.describe()` and exported in `TOOL_DEFAULTS`, so `z.toJSONSchema(tool.input, { io: "input" })` and `io: "output"` agree and every JSON Schema converter shows optional fields as optional.
- No em dash anywhere (the tests enforce it for descriptions and prompts).

## Adding a tool

1. Add a `defineTool({...})` in `src/tools.ts` with a snake_case `name`, a `group`, `runsIn`, a strict zod `input` (no `.default()`, no transforms), MCP `annotations`, and a description that says what it does, when to use it, what it returns (the JSON shape) and the units and gotchas. Set `longRunning: true` for tools that return a `jobId`, and `alwaysLoad: true` only for core tools.
2. Append it to `TOOLS`. `ToolName`, `ToolInput<N>`, `TOOL_BY_NAME` and the protocol's `RpcMethodSchema` pick it up automatically.
3. Update `EXPECTED_TOOL_NAMES` in `src/__tests__/contract.test.ts`, then implement the handler where `runsIn` says (tab and/or sidecar).

A new edit op goes into `EditOpSchema` in `src/edit-plan.ts`, plus a case in `getOpRefs` (the `switch` is exhaustive, so TypeScript flags a missing one), cross-field rules in `checkOpFields` if any, and an example plan in the tests.

## Checks

```sh
cd packages/claude-tools && bunx tsc --noEmit -p tsconfig.json
cd ../.. && bun test packages/claude-tools
```

Framework-free: no React, no Node or DOM APIs, only `zod`.
