import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	CHAT_SYSTEM_PROMPT_APPEND,
	checkEditPlan,
	EDIT_OP_NAMES,
	EDITOR_PROMPT_FR,
	EDITOR_RULES,
	EditOpSchema,
	EditPlanSchema,
	encodeHubMessage,
	encodeTabMessage,
	ERROR_CODES,
	ERROR_HINTS,
	getOpRefs,
	type HubMessage,
	INTERNAL_METHOD_PARAMS,
	INTERNAL_METHODS,
	isInternalMethod,
	isToolName,
	parseHubMessage,
	parseTabMessage,
	parseToolInput,
	RpcMethodSchema,
	type TabMessage,
	TOOL_BY_NAME,
	TOOL_NAMES,
	TOOLS,
	toMcpToolConfig,
	ALWAYS_LOAD_META_KEY,
	type ToolInput,
	type ToolName,
} from "../index";

// Built from its code point so this file never contains the character itself.
const EM_DASH = String.fromCharCode(0x2014);

const EXPECTED_TOOL_NAMES: ToolName[] = [
	"get_editor_state",
	"get_element",
	"list_capabilities",
	"list_media",
	"list_projects",
	"capture_frame",
	"capture_contact_sheet",
	"peek_media",
	"apply_edit_plan",
	"mark_ranges",
	"undo",
	"redo",
	"seek",
	"play",
	"pause",
	"select",
	"set_editor_modes",
	"create_project",
	"open_project",
	"switch_scene",
	"save_project",
	"list_disk_media",
	"import_media",
	"remove_media",
	"start_export",
	"job_status",
	"cancel_job",
];

// ---------------------------------------------------------------------------
// Type-level checks (verified by tsc, trivially true at runtime)
// ---------------------------------------------------------------------------

const typedOpName: ToolInput<"apply_edit_plan">["ops"][number]["op"] = "insert_media";
const typedMaxEdge: ToolInput<"capture_frame">["maxEdge"] = 1280;
// @ts-expect-error unknown tool names are rejected
type UnknownToolInput = ToolInput<"not_a_tool">;
const typedName: ToolName = "apply_edit_plan";

describe("tool catalogue", () => {
	test("type-level helpers resolve", () => {
		expect([typedOpName, typedMaxEdge, typedName]).toEqual([
			"insert_media",
			1280,
			"apply_edit_plan",
		]);
		const unused: UnknownToolInput | undefined = undefined;
		expect(unused).toBeUndefined();
	});

	test("contains exactly the v1 tools", () => {
		expect([...TOOL_NAMES]).toEqual(EXPECTED_TOOL_NAMES);
	});

	test("names are unique snake_case and indexed", () => {
		const seen = new Set<string>();
		for (const tool of TOOLS) {
			expect(tool.name).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
			expect(seen.has(tool.name)).toBe(false);
			seen.add(tool.name);
			expect(TOOL_BY_NAME[tool.name]).toBe(tool as never);
			expect(isToolName(tool.name)).toBe(true);
		}
		expect(Object.keys(TOOL_BY_NAME).length).toBe(TOOLS.length);
		expect(isToolName("toString")).toBe(false);
		expect(isToolName("delete_everything")).toBe(false);
	});

	test("every tool has a useful title and description", () => {
		for (const tool of TOOLS) {
			expect(tool.title.length).toBeGreaterThan(2);
			expect(tool.description.length).toBeGreaterThanOrEqual(40);
			expect(tool.description).toMatch(/Returns/);
		}
	});

	test("annotations are consistent", () => {
		for (const tool of TOOLS) {
			const a = tool.annotations;
			if (a.readOnlyHint) expect(a.destructiveHint).not.toBe(true);
			expect(a.openWorldHint).toBe(false);
		}
		expect(TOOL_BY_NAME.remove_media.annotations.destructiveHint).toBe(true);
		expect(TOOL_BY_NAME.start_export.longRunning).toBe(true);
		expect(TOOL_BY_NAME.start_export.runsIn).toBe("hybrid");
		expect(TOOL_BY_NAME.import_media.runsIn).toBe("hybrid");
		expect(TOOL_BY_NAME.list_disk_media.runsIn).toBe("hybrid");
		expect(TOOL_BY_NAME.list_media.runsIn).toBe("tab");
		expect(TOOL_BY_NAME.job_status.runsIn).toBe("sidecar");
		expect(TOOL_BY_NAME.cancel_job.runsIn).toBe("sidecar");
	});

	test("every input schema converts to JSON Schema (MCP needs it)", () => {
		for (const tool of TOOLS) {
			const asInput = z.toJSONSchema(tool.input, { io: "input" });
			const asOutput = z.toJSONSchema(tool.input, { io: "output" });
			expect(asInput.type).toBe("object");
			// No .default() or transform anywhere: both views must be identical, so every converter agrees.
			expect(asOutput).toEqual(asInput);
			const text = JSON.stringify(asInput);
			expect(text.includes(EM_DASH)).toBe(false);
		}
	});

	test("MCP registration keeps unknown top-level keys an error", () => {
		// Registering `input.shape` would make the MCP SDK strip a misspelled `dry_run` and APPLY the plan.
		for (const tool of TOOLS) {
			const config = toMcpToolConfig(tool);
			expect(config.inputSchema).toBe(tool.input as never);
			expect(z.toJSONSchema(config.inputSchema, { io: "input" }).additionalProperties).toBe(false);
			const result = config.inputSchema.safeParse({ dry_run: true });
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
			}
			expect(config._meta?.[ALWAYS_LOAD_META_KEY] === true).toBe(tool.alwaysLoad);
		}
		const typo = parseToolInput("apply_edit_plan", {
			ops: [{ op: "delete", elementIds: ["a"] }],
			dry_run: true,
		});
		expect(typo.ok).toBe(false);
		if (!typo.ok) expect(typo.message).toContain("dry_run");
	});

	test("the apply_edit_plan schema lists every op", () => {
		const schema = JSON.stringify(z.toJSONSchema(TOOL_BY_NAME.apply_edit_plan.input, { io: "input" }));
		for (const op of EDIT_OP_NAMES) {
			expect(schema).toContain(`"const":"${op}"`);
		}
		// Keep the biggest schema within a sane token budget.
		expect(schema.length).toBeLessThan(40_000);
	});

	test("parseToolInput validates and reports compact messages", () => {
		const ok = parseToolInput("capture_frame", { time: 12.4 });
		expect(ok.ok).toBe(true);
		if (ok.ok) expect(ok.data.time).toBe(12.4);

		expect(parseToolInput("play", undefined).ok).toBe(true);

		const bad = parseToolInput("capture_frame", { time: -1, extra: true });
		expect(bad.ok).toBe(false);
		if (!bad.ok) {
			expect(bad.message).toContain("time");
			expect(bad.issues.length).toBeGreaterThanOrEqual(2);
		}

		const badPlan = parseToolInput("apply_edit_plan", {
			ops: [{ op: "trim", elementId: "el-1" }],
		});
		expect(badPlan.ok).toBe(false);
		if (!badPlan.ok) expect(badPlan.message).toContain("ops.0: trim needs start and/or end");
	});
});

// ---------------------------------------------------------------------------
// Edit plans
// ---------------------------------------------------------------------------

const EXAMPLE_PLANS: Record<string, unknown[]> = {
	"reel hook on a vertical canvas": [
		// On an empty timeline the first clip resets canvas and fps, so project_settings comes after it.
		{ op: "insert_media", mediaId: "media-rush-01", start: 0, track: "main", trimStart: 1.25, duration: 42.5, as: "rush" },
		{ op: "project_settings", canvas: "9:16", fps: 30, background: { type: "blur", intensity: 200 } },
		{ op: "new_track", type: "text", position: "top", as: "titles" },
		{
			op: "add_text",
			text: "3 erreurs qui ruinent tes pubs",
			start: 0,
			duration: 2.8,
			track: "@titles",
			style: { fontFamily: "Figtree", fontSize: 8.5, color: "#ffffff", fontWeight: "bold", textAlign: "center" },
			position: { y: -730 },
			as: "hook",
		},
		{ op: "keyframe", elementId: "@hook", property: "opacity", time: 0, value: 0 },
		{ op: "keyframe", elementId: "@hook", property: "opacity", time: 0.25, value: 1, interpolation: "bezier" },
		{ op: "keyframe", elementId: "@rush", property: "transform.scale", time: 0, value: 1 },
		{ op: "keyframe", elementId: "@rush", property: "transform.scale", time: 2.8, value: 1.08 },
	],
	"remove two retakes across every track": [
		// Last range first, so the earlier times stay valid.
		{ op: "remove_range", start: 31.2, end: 33.05 },
		{ op: "remove_range", start: 12.4, end: 18.933 },
		{ op: "bookmark", time: 12.4, action: "add", note: "retake retiree", color: "#ff5a5a" },
	],
	"split an overlay clip, drop the middle and shift the tail on its own track": [
		{ op: "split", elementIds: ["c0ffee00-overlay-clip"], at: 12.4, as: "afterCut" },
		{ op: "split", elementIds: ["@afterCut"], at: 14, as: "tail" },
		{ op: "delete", elementIds: ["@afterCut"] },
		{ op: "move", elementId: "@tail", start: 12.4 },
		{ op: "remove_range", start: 20, end: 21.5, tracks: ["main", "@tail"] },
	],
	"b-roll insert with clip blur and punch-in": [
		{ op: "insert_media", mediaId: "media-broll-07", start: 8.2, track: "overlay", trimStart: 3.2, duration: 2.6, as: "broll" },
		{ op: "update_element", elementId: "@broll", params: { "transform.scale": 1.1, opacity: 0.95 }, name: "B-roll bureau" },
		{ op: "clip_effect", elementId: "@broll", action: "add", effect: "blur", params: { intensity: 25 }, as: "soft" },
		{ op: "clip_effect", elementId: "@broll", action: "update", effectId: "@soft", params: { intensity: 12 } },
		// Trim first: keyframes past a new end are dropped.
		{ op: "trim", elementId: "@broll", end: 10.5 },
		{ op: "keyframe", elementId: "@broll", property: "transform.scale", time: 0, value: 1.1 },
		{ op: "keyframe", elementId: "@broll", property: "transform.scale", time: 2.3, value: 1.18, interpolation: "linear" },
		{ op: "keyframe", elementId: "@broll", property: "effect.intensity", effectId: "@soft", time: 0, value: 40 },
		{ op: "keyframe", elementId: "@broll", property: "effect.intensity", effectId: "@soft", time: 0.4, value: 0 },
	],
	"podcast two-shot with split masks": [
		{ op: "new_track", type: "video", position: "bottom", as: "camB" },
		{ op: "insert_media", mediaId: "media-cam-b", start: 0, track: "@camB", as: "guest" },
		// Split rotation points at the kept side: 180 keeps the left half, inverting it keeps the right half.
		{ op: "mask", elementId: "main-cam-a", action: "set", type: "split", params: { centerX: 0, rotation: 180, feather: 0 } },
		{ op: "mask", elementId: "@guest", action: "set", type: "split", params: { centerX: 0, rotation: 180 } },
		{ op: "mask", elementId: "@guest", action: "invert" },
		{ op: "update_element", elementId: "@guest", params: { "transform.positionX": 270 } },
		{ op: "toggle_track", trackId: "@camB", mute: true },
		{ op: "source_audio", elementId: "main-cam-a", separate: true, as: "hostVoice" },
		{ op: "update_element", elementId: "@hostVoice", params: { volume: -3 } },
		{ op: "source_audio", elementId: "main-cam-b", separate: false },
		{ op: "delete", elementIds: ["audio-cam-b-detached"] },
	],
	"captions, graphics, effect layer and speed": [
		{ op: "add_text", text: "le media buying", start: 3, duration: 1.4, track: "auto", style: { fontFamily: "Figtree", fontSize: 5, fontWeight: "bold" }, position: { y: 520 }, maxWidth: 0.8, as: "cap1" },
		{ op: "add_text", text: "s'apprend en agence", start: 4.4, duration: 1.6, track: "@cap1", style: { fontFamily: "Figtree", fontSize: 5 }, position: { y: 520 } },
		{ op: "add_graphic", shape: "rectangle", start: 0, duration: 6, size: { width: 1080, height: 200 }, params: { fill: "#000000", opacity: 0.3, cornerRadius: 10 }, as: "bar" },
		{ op: "keyframe", elementId: "@bar", property: "params.fill", time: 0, value: "#000000" },
		{ op: "keyframe", elementId: "@bar", property: "params.cornerRadius", time: 1, value: 25 },
		{ op: "duplicate", elementIds: ["@bar"], as: "bar2" },
		{ op: "move", elementId: "@bar2", start: 6 },
		{ op: "add_effect_layer", effect: "blur", start: 6, duration: 1.5, intensity: 30 },
		{ op: "set_speed", elementId: "clip-intro", rate: 1.25, maintainPitch: true },
		{ op: "update_element", elementId: "@bar", hidden: true },
		{ op: "move", elementId: "@bar", track: "overlay" },
		{ op: "bookmark", time: 3, action: "add", duration: 3, note: "verifier le visage" },
		{ op: "bookmark", time: 3, action: "update", color: "#00c853" },
		{ op: "project_settings", background: { type: "color", color: "linear-gradient(180deg, #111111, #333333)" } },
	],
};

describe("edit plan", () => {
	test("covers the full op union", () => {
		expect(EDIT_OP_NAMES.length).toBe(20);
		expect(new Set(EDIT_OP_NAMES).size).toBe(20);
	});

	for (const [name, plan] of Object.entries(EXAMPLE_PLANS)) {
		test(`example plan parses: ${name}`, () => {
			const result = EditPlanSchema.safeParse(plan);
			if (!result.success) {
				throw new Error(JSON.stringify(result.error.issues, null, 2));
			}
			expect(checkEditPlan(result.data)).toEqual([]);
			const tool = parseToolInput("apply_edit_plan", { ops: plan, label: name.slice(0, 80), dryRun: true });
			expect(tool.ok).toBe(true);
		});
	}

	test("example plans exercise every op", () => {
		const used = new Set(Object.values(EXAMPLE_PLANS).flat().map((op) => (op as { op: string }).op));
		for (const op of EDIT_OP_NAMES) expect(used.has(op)).toBe(true);
	});

	test("getOpRefs reports definitions and uses", () => {
		const op = EditOpSchema.parse({ op: "clip_effect", elementId: "@clip", action: "update", effectId: "@fx", params: { intensity: 5 } });
		const refs = getOpRefs(op);
		expect(refs.defines).toBeNull();
		expect(refs.uses.map((u) => [u.path.join("."), u.accepts.join("|")])).toEqual([
			["elementId", "element"],
			["effectId", "effect"],
		]);
		const track = getOpRefs(EditOpSchema.parse({ op: "new_track", type: "audio", as: "sfx" }));
		expect(track.defines).toEqual({ name: "sfx", kind: "track" });
	});

	const issuesOf = (plan: unknown[]) => {
		const result = EditPlanSchema.safeParse(plan);
		expect(result.success).toBe(false);
		return result.success ? [] : result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
	};

	test("rejects forward and undefined references", () => {
		const issues = issuesOf([
			{ op: "delete", elementIds: ["@later"] },
			{ op: "add_text", text: "x", start: 0, duration: 1, as: "later" },
			{ op: "move", elementId: "@ghost", start: 2 },
		]);
		expect(issues.map((i) => i.path)).toEqual(["0.elementIds.0", "2.elementId"]);
		expect(issues[0]?.message).toContain("not defined by an earlier op");
	});

	test("rejects references of the wrong kind", () => {
		const issues = issuesOf([
			{ op: "new_track", type: "text", as: "t1" },
			{ op: "add_text", text: "x", start: 0, duration: 1, track: "@t1", as: "label" },
			{ op: "split", elementIds: ["@t1"], at: 0.5 },
			{ op: "clip_effect", elementId: "@label", action: "remove", effectId: "@label" },
		]);
		expect(issues.map((i) => i.path)).toEqual(["2.elementIds.0", "3.effectId"]);
		expect(issues[0]?.message).toContain("names a track");
	});

	test("rejects duplicate names, malformed refs and bad names", () => {
		const issues = issuesOf([
			{ op: "add_text", text: "a", start: 0, duration: 1, as: "cap" },
			{ op: "add_text", text: "b", start: 1, duration: 1, as: "cap" },
			{ op: "delete", elementIds: ["@not valid"] },
		]);
		expect(issues.map((i) => i.path)).toEqual(["1.as", "2.elementIds.0"]);
		expect(EditOpSchema.safeParse({ op: "new_track", type: "text", as: "9lives" }).success).toBe(false);
	});

	test("rejects unknown keys, bad units and invalid combinations", () => {
		// Strict objects: a misspelled field is an error, not silently dropped.
		expect(EditOpSchema.safeParse({ op: "add_text", text: "x", startTime: 0, start: 0, duration: 1 }).success).toBe(false);
		expect(EditOpSchema.safeParse({ op: "add_text", text: "x", start: -1, duration: 1 }).success).toBe(false);
		expect(EditOpSchema.safeParse({ op: "add_text", text: "x", start: 0, duration: 0 }).success).toBe(false);
		expect(EditOpSchema.safeParse({ op: "set_speed", elementId: "e", rate: 8 }).success).toBe(false);
		expect(EditOpSchema.safeParse({ op: "keyframe", elementId: "e", property: "fontSize", time: 0, value: 3 }).success).toBe(false);
		expect(EditOpSchema.safeParse({ op: "wobble", elementId: "e" }).success).toBe(false);

		const issues = issuesOf([
			{ op: "trim", elementId: "e1" },
			{ op: "trim", elementId: "e1", start: 5, end: 4 },
			{ op: "split", elementIds: ["e1", "e2"], at: 3, as: "right" },
			{ op: "keyframe", elementId: "e1", property: "color", time: 0, value: 3 },
			{ op: "keyframe", elementId: "e1", property: "opacity", time: 0 },
			{ op: "clip_effect", elementId: "e1", action: "add" },
			{ op: "mask", elementId: "e1", action: "set" },
			{ op: "update_element", elementId: "e1", params: {} },
			{ op: "toggle_track", trackId: "main" },
			{ op: "project_settings" },
			{ op: "source_audio", elementId: "e1", separate: false, as: "voice" },
		]);
		expect(issues.map((i) => i.path)).toEqual([
			"0",
			"1.end",
			"2.as",
			"3.value",
			"4.value",
			"5.effect",
			"6.type",
			"7",
			"8",
			"9",
			"10.as",
		]);
	});

	test("rejects the contract traps the reviewers found", () => {
		// Freeform masks cannot be activated with scalar params; text never goes on main or audio.
		expect(EditOpSchema.safeParse({ op: "mask", elementId: "e", action: "set", type: "freeform" }).success).toBe(false);
		expect(EditOpSchema.safeParse({ op: "add_text", text: "x", start: 0, duration: 1, track: "main" }).success).toBe(false);
		expect(EditOpSchema.safeParse({ op: "add_graphic", shape: "star", start: 0, duration: 1, track: "audio" }).success).toBe(false);
		expect(EditOpSchema.safeParse({ op: "add_text", text: "x", start: 0, duration: 1, style: { fontSize: 0.5 } }).success).toBe(false);
		// The editor's blur presets go up to 500.
		expect(EditOpSchema.safeParse({ op: "project_settings", background: { type: "blur", intensity: 500 } }).success).toBe(true);
		expect(EditOpSchema.safeParse({ op: "project_settings", background: { type: "color", color: "transparent" } }).success).toBe(true);
		expect(EditOpSchema.safeParse({ op: "project_settings", background: { type: "color", color: "red; drop" } }).success).toBe(false);
		expect(EditOpSchema.safeParse({ op: "project_settings", canvas: "4:3" }).success).toBe(true);
		expect(EditOpSchema.safeParse({ op: "keyframe", elementId: "e", property: "params.", time: 0, value: 1 }).success).toBe(false);

		const issues = issuesOf([
			{ op: "remove_range", start: 5, end: 5 },
			{ op: "duplicate", elementIds: ["a", "b"], as: "copies" },
			{ op: "keyframe", elementId: "e1", property: "effect.intensity", time: 0, value: 3 },
			{ op: "keyframe", elementId: "e1", property: "opacity", effectId: "fx1", time: 0, value: 1 },
			{ op: "add_graphic", shape: "rectangle", start: 0, duration: 1, size: { width: 100, height: 10 }, params: { "transform.scaleX": 2 } },
			{ op: "keyframe", elementId: "e1", property: "params.fill", time: 0, value: "white" },
		]);
		expect(issues.map((i) => i.path)).toEqual(["0.end", "1.as", "2.effectId", "3.effectId", "4.size", "5.value"]);
	});

	test("remove_range tracks may reference earlier ops", () => {
		const issues = issuesOf([
			{ op: "remove_range", start: 1, end: 2, tracks: ["@later"] },
			{ op: "new_track", type: "audio", as: "later" },
		]);
		expect(issues.map((i) => i.path)).toEqual(["0.tracks.0"]);
	});

	test("keyframe removal needs no value", () => {
		expect(EditPlanSchema.safeParse([{ op: "keyframe", elementId: "e1", property: "volume", time: 1.5, remove: true }]).success).toBe(true);
	});

	test("empty and oversized plans are rejected", () => {
		expect(EditPlanSchema.safeParse([]).success).toBe(false);
		const big = Array.from({ length: 201 }, (_, i) => ({ op: "delete", elementIds: [`e${i}`] }));
		expect(EditPlanSchema.safeParse(big).success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

const TINY_JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

const TAB_MESSAGES: TabMessage[] = [
	{ type: "hello", protocolVersion: 1, tabId: "tab-1", path: "/editor/p1", projectId: "p1", appVersion: "0.1.0" },
	{ type: "hello", protocolVersion: 1, tabId: "tab-2", path: "/projects", projectId: null, appVersion: "0.1.0" },
	{
		type: "rpc-result",
		id: "r1",
		ok: true,
		result: { json: { applied: true, refs: { hook: "el-9" } }, text: "ok", images: [{ data: TINY_JPEG, mimeType: "image/jpeg", caption: "frame @1.000s 1080x1920" }] },
	},
	{ type: "rpc-result", id: "r2", ok: false, error: { code: "INVALID_EDIT", message: "overlap on track t3", details: { op: 2 } } },
	{ type: "event", name: "state-changed", payload: { version: 42, projectId: "p1" } },
	{ type: "event", name: "project-changed", payload: { projectId: null, name: null, path: "/projects" } },
	{ type: "event", name: "export-progress", payload: { jobId: "job-1", phase: "rendering", progress: 0.37 } },
	{
		type: "chat.send",
		sessionKey: "p1",
		text: "Coupe les silences du début",
		model: "claude-opus-5",
		profile: "B",
		attachments: [
			{ type: "image", data: TINY_JPEG, mimeType: "image/jpeg", name: "ref.jpg" },
			{ type: "text", name: "notes.txt", text: "garder la 2e prise" },
		],
	},
	{ type: "event", name: "job-progress", payload: { jobId: "job-2", kind: "import", phase: "copying", progress: 0.5 } },
	{ type: "chat.send", sessionKey: "p1", text: "On reprend ?", resumeSessionId: "s1" },
	{ type: "chat.interrupt", sessionKey: "p1" },
	{ type: "chat.reset", sessionKey: "p1" },
	{ type: "chat.permission_response", sessionKey: "p1", requestId: "perm-1", allow: false, message: "garde les rushes" },
	{ type: "claim-active" },
];

const HUB_MESSAGES: HubMessage[] = [
	{ type: "welcome", protocolVersion: 1, role: "active", sidecarVersion: "0.1.0", activeTab: { tabId: "tab-1", projectId: "p1", projectName: "Reel", path: "/editor/p1" } },
	{ type: "welcome", protocolVersion: 1, role: "passive", sidecarVersion: "0.1.0", activeTab: null },
	{ type: "rpc", id: "r1", method: "apply_edit_plan", params: { ops: EXAMPLE_PLANS["remove two retakes across every track"], expectStateVersion: 42 }, projectId: "p1", timeoutMs: 30_000, idempotencyKey: "call-7" },
	{ type: "rpc", id: "r2", method: "internal.ping", params: {} },
	{ type: "chat.event", sessionKey: "p1", event: { type: "session", sessionId: "s1", model: "claude-opus-5", apiKeySource: "none" } },
	{ type: "chat.event", sessionKey: "p1", event: { type: "text_delta", text: "Je coupe " } },
	{ type: "chat.event", sessionKey: "p1", event: { type: "thinking_delta", text: "Les silences sont..." } },
	{ type: "chat.event", sessionKey: "p1", event: { type: "tool_start", toolUseId: "tu1", name: "capture_frame", input: { time: 3 } } },
	{ type: "chat.event", sessionKey: "p1", event: { type: "tool_end", toolUseId: "tu1", ok: true, summary: "frame @3.000s", image: { data: TINY_JPEG, mimeType: "image/jpeg" } } },
	{ type: "chat.event", sessionKey: "p1", event: { type: "assistant_done" } },
	{
		type: "chat.event",
		sessionKey: "p1",
		event: { type: "turn_end", sessionId: "s1", durationMs: 8123, usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 9000 }, costUsd: 0 },
	},
	{ type: "chat.event", sessionKey: "p1", event: { type: "permission_request", requestId: "perm-1", toolName: "remove_media", input: { mediaIds: ["m1"] }, reason: "Supprimer 1 média" } },
	{ type: "chat.event", sessionKey: "p1", event: { type: "job", jobId: "job-1", kind: "export", status: "running", progress: 0.4, phase: "rendering" } },
	{ type: "chat.event", sessionKey: "p1", event: { type: "rate_limit", info: { status: "allowed_warning", resetsAt: 1790000000, utilization: 0.82, extra: "kept" } } },
	{ type: "chat.event", sessionKey: "p1", event: { type: "error", message: "Claude est indisponible" } },
];

describe("protocol", () => {
	test("tab messages round-trip", () => {
		for (const message of TAB_MESSAGES) {
			const parsed = parseTabMessage(encodeTabMessage(message));
			if (!parsed.ok) throw new Error(`${message.type}: ${parsed.error}`);
			expect(parsed.message).toEqual(message);
		}
	});

	test("hub messages round-trip", () => {
		for (const message of HUB_MESSAGES) {
			const parsed = parseHubMessage(encodeHubMessage(message));
			if (!parsed.ok) throw new Error(`${message.type}: ${parsed.error}`);
			expect(parsed.message).toEqual(message);
		}
	});

	test("every tab message type and chat event type is covered", () => {
		expect(new Set(TAB_MESSAGES.map((m) => m.type))).toEqual(
			new Set(["hello", "rpc-result", "event", "chat.send", "chat.interrupt", "chat.reset", "chat.permission_response", "claim-active"]),
		);
		const events = HUB_MESSAGES.flatMap((m) => (m.type === "chat.event" ? [m.event.type] : []));
		expect(new Set(events)).toEqual(
			new Set(["session", "text_delta", "thinking_delta", "tool_start", "tool_end", "assistant_done", "turn_end", "permission_request", "job", "rate_limit", "error"]),
		);
	});

	test("malformed frames are rejected with a readable error", () => {
		expect(parseTabMessage("{not json")).toEqual({ ok: false, error: "invalid JSON" });
		const wrongType = parseTabMessage({ type: "rpc", id: "x", method: "play", params: {} });
		expect(wrongType.ok).toBe(false);
		const missing = parseTabMessage({ type: "hello", tabId: "t" });
		expect(missing.ok).toBe(false);
		const badEvent = parseTabMessage({ type: "event", name: "export-progress", payload: { jobId: "j", phase: "rendering", progress: 3 } });
		expect(badEvent.ok).toBe(false);
		const badResult = parseTabMessage({ type: "rpc-result", id: "r", ok: false, error: { code: "NOPE", message: "x" } });
		expect(badResult.ok).toBe(false);
		const unknownMethod = parseHubMessage({ type: "rpc", id: "r", method: "rm_rf", params: {} });
		expect(unknownMethod.ok).toBe(false);
		expect(() => encodeHubMessage({ type: "welcome", role: "boss" } as unknown as HubMessage)).toThrow();
	});

	test("rpc methods cover every tool and internal method", () => {
		for (const name of TOOL_NAMES) expect(RpcMethodSchema.safeParse(name).success).toBe(true);
		for (const method of INTERNAL_METHODS) {
			expect(RpcMethodSchema.safeParse(method).success).toBe(true);
			expect(isInternalMethod(method)).toBe(true);
		}
		expect(isInternalMethod("apply_edit_plan")).toBe(false);
	});

	test("internal method params parse", () => {
		expect(
			INTERNAL_METHOD_PARAMS["internal.import_files"].safeParse({
				files: [{ path: "/Users/me/videos/a.mp4", url: "http://127.0.0.1:3457/files?id=1", name: "a.mp4", size: 1024, mimeType: "video/mp4" }],
				place: { start: 0, track: "main" },
			}).success,
		).toBe(true);
		expect(
			INTERNAL_METHOD_PARAMS["internal.export_start"].safeParse({
				jobId: "job-1",
				format: "mp4",
				quality: "high",
				includeAudio: true,
				fileName: "reel-v3",
				uploadUrl: "http://127.0.0.1:3457/exports?job=job-1",
			}).success,
		).toBe(true);
		// The tab only talks to the sidecar's own routes.
		const importWith = (url: string) =>
			INTERNAL_METHOD_PARAMS["internal.import_files"].safeParse({
				files: [{ path: "/a.mp4", url, name: "a.mp4", size: 1, mimeType: "video/mp4" }],
			}).success;
		expect(importWith("http://127.0.0.1:3457/files?id=1")).toBe(true);
		expect(importWith("http://127.0.0.1:3457/exports?id=1")).toBe(false);
		expect(importWith("https://evil.example/files?id=1")).toBe(false);
		expect(importWith("http://127.0.0.1:3457@evil.example/files")).toBe(false);
		expect(importWith("/files?id=1")).toBe(false);
		const exportTo = (uploadUrl: string) =>
			INTERNAL_METHOD_PARAMS["internal.export_start"].safeParse({
				jobId: "j",
				format: "mp4",
				quality: "low",
				includeAudio: false,
				fileName: "x",
				uploadUrl,
			}).success;
		expect(exportTo("http://127.0.0.1:3457/exports/job-1")).toBe(true);
		expect(exportTo("http://localhost:3457/exports")).toBe(false);
		expect(exportTo("http://127.0.0.1:3457/exportsx")).toBe(false);
	});

	test("every error code has a hint", () => {
		for (const code of ERROR_CODES) expect(ERROR_HINTS[code].length).toBeGreaterThan(10);
	});
});

describe("instructions", () => {
	test("never contain the em dash and stay compact", () => {
		for (const text of [EDITOR_RULES, EDITOR_PROMPT_FR, CHAT_SYSTEM_PROMPT_APPEND]) {
			expect(text.includes(EM_DASH)).toBe(false);
		}
		expect(EDITOR_RULES.length).toBeLessThan(4_000);
		expect(EDITOR_PROMPT_FR.length).toBeLessThan(800);
		expect(CHAT_SYSTEM_PROMPT_APPEND.startsWith(EDITOR_PROMPT_FR)).toBe(true);
	});

	test("rules mention the key conventions", () => {
		for (const needle of ["SECONDS", "get_editor_state", "apply_edit_plan", "capture_frame", "mark_ranges", "Figtree", "2.2 s", "32 characters"]) {
			expect(EDITOR_RULES).toContain(needle);
		}
		for (const needle of ["français", "Cmd+Z"]) expect(EDITOR_PROMPT_FR).toContain(needle);
	});

	test("tool descriptions never contain the em dash", () => {
		for (const tool of TOOLS) {
			expect(tool.description.includes(EM_DASH)).toBe(false);
			expect(tool.title.includes(EM_DASH)).toBe(false);
		}
	});
});
