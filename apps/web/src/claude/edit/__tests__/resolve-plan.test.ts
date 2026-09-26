import { describe, expect, test } from "bun:test";
import { getElementKeyframes } from "@/animation";
import { isBridgeError, type BridgeError } from "@/claude/types";
import { mediaTime } from "@/wasm";
import {
	audioEl,
	audioTrack,
	element,
	FPS_2997,
	imageEl,
	MEDIA,
	resolve,
	settings,
	state,
	t,
	textEl,
	textTrack,
	trackOf,
	tracks,
	videoEl,
} from "./plan-fixtures";

function expectPlanError({
	run,
	code = "INVALID_EDIT",
	opIndex,
	contains,
}: {
	run: () => unknown;
	code?: BridgeError["code"];
	opIndex: number;
	contains?: string;
}): BridgeError {
	try {
		run();
	} catch (error) {
		if (!isBridgeError(error)) throw error;
		expect(error.code).toBe(code);
		expect(error.message.startsWith(`op ${opIndex} (`)).toBe(true);
		expect(error.message).toContain("Nothing was applied");
		expect(error.details).toMatchObject({ opIndex });
		if (contains) expect(error.message).toContain(contains);
		return error;
	}
	throw new Error("expected the plan to fail");
}

const basic = () =>
	state({
		sceneTracks: tracks({
			main: [
				videoEl({ id: "v1", start: 0, duration: 4, sourceDuration: 20 }),
				videoEl({ id: "v2", start: 4, duration: 4, sourceDuration: 20 }),
			],
			overlay: [
				textTrack({
					id: "tt",
					elements: [textEl({ id: "cap", start: 1, duration: 2 })],
				}),
			],
			audio: [
				audioTrack({
					id: "at",
					elements: [audioEl({ id: "music", start: 0, duration: 8 })],
				}),
			],
		}),
	});

describe("references", () => {
	test("new_track + add_text on @track + keyframes on @element resolve to the created ids", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{ op: "new_track", type: "text", as: "titles" },
				{
					op: "add_text",
					text: "3 erreurs en pub",
					start: 0,
					duration: 2.5,
					track: "@titles",
					style: { fontFamily: "Figtree", fontSize: 9, fontWeight: "bold" },
					position: { y: -730 },
					as: "hook",
				},
				{
					op: "keyframe",
					elementId: "@hook",
					property: "opacity",
					time: 0,
					value: 0,
				},
				{
					op: "keyframe",
					elementId: "@hook",
					property: "opacity",
					time: 0.3,
					value: 1,
				},
			],
		});
		expect(plan.refs).toEqual({ titles: "id-1", hook: "id-2" });
		expect(plan.created).toEqual([
			{ op: 0, kind: "track", id: "id-1", as: "titles" },
			{ op: 1, kind: "element", id: "id-2", trackId: "id-1", as: "hook" },
		]);
		const hook = element({ plan, id: "id-2" });
		expect(hook.params).toMatchObject({
			content: "3 erreurs en pub",
			fontFamily: "Figtree",
			fontSize: 9,
			fontWeight: "bold",
			"transform.positionY": -730,
		});
		expect(
			getElementKeyframes({ animations: hook.animations }).map((key) => [
				key.time,
				key.value,
			]),
		).toEqual([
			[0, 0],
			[t(0.3), 1],
		]);
		// The new track is on top of the other layers.
		expect(plan.state.tracks.overlay[0]?.id).toBe("id-1");
	});

	test("split as names the right piece; later ops can delete it", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{ op: "split", elementIds: ["v1"], at: 2, as: "tail" },
				{ op: "delete", elementIds: ["@tail"] },
			],
		});
		expect(plan.state.tracks.main.elements.map((item) => item.id)).toEqual([
			"v1",
			"v2",
		]);
		expect(element({ plan, id: "v1" }).duration).toBe(t(2));
		// The piece was created then deleted by the same plan: not reported as created.
		expect(plan.created).toEqual([]);
		expect(plan.refs).toEqual({});
		expect(plan.changedElementIds).toEqual(["v1"]);
	});

	test("an id deleted by an earlier op fails with NOT_FOUND on the op that uses it", () => {
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [
						{ op: "delete", elementIds: ["cap"] },
						{
							op: "update_element",
							elementId: "cap",
							params: { opacity: 0.5 },
						},
					],
				}),
			code: "NOT_FOUND",
			opIndex: 1,
			contains: '"cap"',
		});
	});

	test("unknown ids and tracks fail with NOT_FOUND and the op index", () => {
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [{ op: "move", elementId: "nope", start: 1 }],
				}),
			code: "NOT_FOUND",
			opIndex: 0,
		});
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [
						{ op: "add_text", text: "x", start: 0, duration: 1 },
						{
							op: "add_text",
							text: "y",
							start: 0,
							duration: 1,
							track: "missing-track",
						},
					],
				}),
			code: "NOT_FOUND",
			opIndex: 1,
			contains: "missing-track",
		});
	});

	test("a failing op leaves the input state untouched (pure resolution)", () => {
		const initial = basic();
		const before = JSON.stringify(initial);
		expectPlanError({
			run: () =>
				resolve({
					initial,
					ops: [
						{ op: "delete", elementIds: ["v2"] },
						{ op: "split", elementIds: ["v1"], at: 9 },
					],
				}),
			opIndex: 1,
			contains: "not strictly inside",
		});
		expect(JSON.stringify(initial)).toBe(before);
	});
});

describe("units and frame snapping", () => {
	test("30 fps: times snap to 4000-tick frames, ends are start + duration", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{
					op: "add_text",
					text: "a",
					start: 5.01,
					duration: 1.02,
					track: "overlay",
				},
			],
		});
		const text = element({ plan, id: "id-1" });
		expect(text.startTime).toBe(t(5));
		expect(text.startTime % 4000).toBe(0);
		expect(text.duration).toBe(mediaTime({ ticks: 31 * 4000 }));
	});

	test("29.97 fps: 4004-tick frames", () => {
		const initial = { ...basic(), settings: settings({ fps: FPS_2997 }) };
		const plan = resolve({
			initial,
			ops: [
				{ op: "add_text", text: "a", start: 1, duration: 1, track: "overlay" },
			],
		});
		const text = element({ plan, id: "id-1" });
		expect(text.startTime).toBe(mediaTime({ ticks: 30 * 4004 }));
		expect(text.duration).toBe(mediaTime({ ticks: 30 * 4004 }));
	});

	test("a duration shorter than a frame becomes one frame", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{
					op: "add_text",
					text: "a",
					start: 0,
					duration: 0.001,
					track: "overlay",
				},
			],
		});
		expect(element({ plan, id: "id-1" }).duration).toBe(
			mediaTime({ ticks: 4000 }),
		);
	});
});

describe("insert_media and placement", () => {
	test("video on main after the last clip, default duration = rest of the media after trimStart", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{
					op: "insert_media",
					mediaId: "m-video",
					start: 8,
					track: "main",
					trimStart: 5,
					as: "clip",
				},
			],
		});
		const clip = element({ plan, id: "id-1" });
		expect(trackOf({ plan, id: "id-1" })).toBe("main");
		expect(clip.startTime).toBe(t(8));
		expect(clip.trimStart).toBe(t(5));
		expect(clip.duration).toBe(t(15));
		expect(clip.trimEnd).toBe(t(0));
		expect(clip.type === "video" ? clip.sourceDuration : null).toBe(t(20));
	});

	test("a duration past the end of the media is refused", () => {
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [
						{
							op: "insert_media",
							mediaId: "m-video",
							start: 8,
							track: "main",
							trimStart: 15,
							duration: 6,
						},
					],
				}),
			opIndex: 0,
			contains: "exceeds",
		});
	});

	test("explicit track overlap is refused with the clashing element", () => {
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [
						{
							op: "insert_media",
							mediaId: "m-video",
							start: 3,
							track: "main",
							duration: 2,
						},
					],
				}),
			opIndex: 0,
			contains: "overlap element v1",
		});
	});

	test("incompatible kinds are refused (audio on main, video on an audio track)", () => {
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [
						{ op: "insert_media", mediaId: "m-audio", start: 0, track: "main" },
					],
				}),
			opIndex: 0,
			contains: "main track only takes",
		});
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [
						{ op: "insert_media", mediaId: "m-video", start: 20, track: "at" },
					],
				}),
			opIndex: 0,
			contains: "cannot go on track at",
		});
	});

	test("unknown media fails with NOT_FOUND", () => {
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [
						{ op: "insert_media", mediaId: "ghost", start: 0, track: "auto" },
					],
				}),
			code: "NOT_FOUND",
			opIndex: 0,
		});
	});

	test("auto places audio on the first audio track with room, else a new one; overlay makes a new top track", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{
					op: "insert_media",
					mediaId: "m-audio",
					start: 8,
					track: "audio",
					duration: 2,
					as: "sfx",
				},
				{
					op: "insert_media",
					mediaId: "m-audio",
					start: 1,
					track: "audio",
					duration: 2,
					as: "sfx2",
				},
				{
					op: "insert_media",
					mediaId: "m-image",
					start: 1,
					track: "overlay",
					as: "broll",
				},
			],
		});
		expect(trackOf({ plan, id: plan.refs.sfx ?? "" })).toBe("at");
		expect(trackOf({ plan, id: plan.refs.sfx2 ?? "" })).not.toBe("at");
		expect(plan.state.tracks.audio).toHaveLength(2);
		expect(plan.state.tracks.overlay[0]?.elements[0]?.id).toBe(plan.refs.broll);
		// Images default to 5 s.
		expect(element({ plan, id: plan.refs.broll ?? "" }).duration).toBe(t(5));
	});

	test("the first visual clip on an empty timeline sets canvas and fps (non-undoable step); project_settings after it wins", () => {
		const empty = state({
			sceneTracks: tracks({}),
			projectSettings: settings({ width: 1920, height: 1080 }),
		});
		const plan = resolve({
			initial: empty,
			ops: [
				{ op: "insert_media", mediaId: "m-silent", start: 0, track: "main" },
				{ op: "project_settings", canvas: "9:16" },
			],
		});
		expect(plan.settingsSteps).toEqual([
			{
				opIndex: 0,
				patch: {
					canvasSize: { width: 1080, height: 1920 },
					originalCanvasSize: { width: 1080, height: 1920 },
					fps: { numerator: 25, denominator: 1 },
				},
				undoable: false,
			},
		]);
		// 9:16 equals the canvas the clip set, so the settings op only warns.
		expect(
			plan.warnings.some((warning) =>
				warning.startsWith("op 1 (project_settings)"),
			),
		).toBe(true);
		expect(plan.state.settings.fps).toEqual({ numerator: 25, denominator: 1 });
	});
});

describe("timing ops", () => {
	test("trim keeps content anchored and refuses to extend past the source", () => {
		const plan = resolve({
			initial: basic(),
			ops: [{ op: "trim", elementId: "v2", start: 5, end: 7 }],
		});
		const clip = element({ plan, id: "v2" });
		expect(clip.startTime).toBe(t(5));
		expect(clip.duration).toBe(t(2));
		expect(clip.trimStart).toBe(t(1));
		expect(clip.trimEnd).toBe(t(17));
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [{ op: "trim", elementId: "v2", start: 3 }],
				}),
			opIndex: 0,
			contains: "cannot start before",
		});
	});

	test("trim of the first main clip keeps it at 0 s (with a warning)", () => {
		const plan = resolve({
			initial: basic(),
			ops: [{ op: "trim", elementId: "v1", start: 1 }],
		});
		expect(element({ plan, id: "v1" }).startTime).toBe(t(0));
		expect(element({ plan, id: "v1" }).trimStart).toBe(t(1));
		expect(plan.warnings[0]).toContain("first clip of the main track");
	});

	test("move to another time and track, refusing overlaps", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{ op: "move", elementId: "cap", start: 6 },
				{ op: "move", elementId: "music", track: "overlay" },
			],
		});
		expect(element({ plan, id: "cap" }).startTime).toBe(t(6));
		// The audio moved to a NEW audio track; the old one became empty and was pruned like the editor does.
		expect(plan.state.tracks.audio.map((track) => track.id)).toEqual(["id-1"]);
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [{ op: "move", elementId: "v2", start: 2 }],
				}),
			opIndex: 0,
			contains: "overlap element v1",
		});
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [{ op: "move", elementId: "cap", track: "main" }],
				}),
			opIndex: 0,
			contains: "cannot go on track main",
		});
	});

	test("remove_range through the plan: every track, bookmarks, new ids reported", () => {
		const initial = { ...basic(), bookmarks: [{ time: t(6) }] };
		const plan = resolve({
			initial,
			ops: [{ op: "remove_range", start: 2, end: 3 }],
		});
		expect(plan.durationTicks).toBe(t(7));
		expect(plan.state.bookmarks).toEqual([{ time: t(5) }]);
		// v1 and the music both span the range: each is cut in two.
		expect(plan.created.map((entry) => entry.kind)).toEqual([
			"element",
			"element",
		]);
		expect(element({ plan, id: "v2" }).startTime).toBe(t(3));
		expect(plan.warnings.join(" ")).toContain("cut in two");
	});

	test("remove_range past the end of the timeline changes nothing (no empty undo step)", () => {
		const initial = { ...basic(), bookmarks: [{ time: t(1) }] };
		const plan = resolve({
			initial,
			ops: [{ op: "remove_range", start: 50, end: 60 }],
		});
		expect(plan.warnings.join(" ")).toContain("nothing to cut");
		expect(plan.tracksChanged).toBe(false);
		expect(plan.bookmarksChanged).toBe(false);
		expect(plan.changedElementIds).toEqual([]);
	});

	test("remove_range restricted to some tracks leaves the others alone", () => {
		const initial = basic();
		const plan = resolve({
			initial,
			ops: [{ op: "remove_range", start: 2, end: 3, tracks: ["main", "tt"] }],
		});
		expect(plan.state.tracks.audio[0]).toBe(initial.tracks.audio[0]);
		expect(element({ plan, id: "v2" }).startTime).toBe(t(3));
	});

	test("set_speed changes the duration and refuses an overlap", () => {
		const plan = resolve({
			initial: basic(),
			ops: [{ op: "set_speed", elementId: "v2", rate: 2 }],
		});
		expect(element({ plan, id: "v2" }).duration).toBe(t(2));
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [{ op: "set_speed", elementId: "v1", rate: 0.5 }],
				}),
			opIndex: 0,
			contains: "overlap element v2",
		});
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [{ op: "set_speed", elementId: "cap", rate: 2 }],
				}),
			opIndex: 0,
			contains: "video and audio only",
		});
	});

	test("duplicate puts the copy on a new track of the same kind", () => {
		const plan = resolve({
			initial: basic(),
			ops: [{ op: "duplicate", elementIds: ["cap"], as: "copy" }],
		});
		const copyId = plan.refs.copy ?? "";
		expect(element({ plan, id: copyId }).startTime).toBe(t(1));
		expect(element({ plan, id: copyId }).name).toBe("cap (copy)");
		expect(plan.state.tracks.overlay).toHaveLength(2);
		expect(trackOf({ plan, id: copyId })).toBe(
			plan.state.tracks.overlay[0]?.id ?? "",
		);
	});
});

describe("property ops", () => {
	test("update_element: transform.scale sets both axes, unknown keys are errors, values are clamped with a warning", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{
					op: "update_element",
					elementId: "v1",
					params: { "transform.scale": 1.2, opacity: 3 },
					name: "Intro",
				},
			],
		});
		const clip = element({ plan, id: "v1" });
		expect(clip.params).toMatchObject({
			"transform.scaleX": 1.2,
			"transform.scaleY": 1.2,
			opacity: 1,
		});
		expect(clip.name).toBe("Intro");
		expect(plan.warnings[0]).toContain("clamped");
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [
						{ op: "update_element", elementId: "v1", params: { fontSize: 20 } },
					],
				}),
			opIndex: 0,
			contains: 'unknown param "fontSize"',
		});
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [{ op: "update_element", elementId: "cap", muted: true }],
				}),
			opIndex: 0,
			contains: "muted applies",
		});
	});

	test("update_element refuses a param whose keyframes would hide the new value", () => {
		const zoom = [
			{
				op: "keyframe",
				elementId: "v1",
				property: "transform.scale",
				time: 0,
				value: 1,
			},
			{
				op: "keyframe",
				elementId: "v1",
				property: "transform.scale",
				time: 2,
				value: 1.12,
			},
		];
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [
						...zoom,
						{
							op: "update_element",
							elementId: "v1",
							params: { "transform.scale": 1.5 },
						},
					],
				}),
			opIndex: 2,
			contains: '"transform.scale" is animated (2 keyframes)',
		});
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [
						{
							op: "keyframe",
							elementId: "cap",
							property: "opacity",
							time: 0,
							value: 0,
						},
						{ op: "update_element", elementId: "cap", params: { opacity: 0.2 } },
					],
				}),
			opIndex: 1,
			contains: '"opacity" is animated (1 keyframe)',
		});
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [
						{
							op: "clip_effect",
							elementId: "v1",
							action: "add",
							effect: "blur",
							as: "blurIn",
						},
						{
							op: "keyframe",
							elementId: "v1",
							property: "effect.intensity",
							effectId: "@blurIn",
							time: 0,
							value: 40,
						},
						{
							op: "clip_effect",
							elementId: "v1",
							action: "update",
							effectId: "@blurIn",
							params: { intensity: 10 },
						},
					],
				}),
			opIndex: 2,
			contains: '"effect.intensity" is animated',
		});
		// A param without keyframes on the same element is still set.
		const plan = resolve({
			initial: basic(),
			ops: [
				...zoom,
				{ op: "update_element", elementId: "v1", params: { opacity: 0.5 } },
			],
		});
		expect(element({ plan, id: "v1" }).params.opacity).toBe(0.5);
	});

	test("keyframe transform.scale expands to scaleX and scaleY; remove deletes both", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{
					op: "keyframe",
					elementId: "v1",
					property: "transform.scale",
					time: 0,
					value: 1,
				},
				{
					op: "keyframe",
					elementId: "v1",
					property: "transform.scale",
					time: 2,
					value: 1.2,
					interpolation: "bezier",
				},
				{
					op: "keyframe",
					elementId: "v1",
					property: "transform.scale",
					time: 2,
					remove: true,
				},
			],
		});
		const paths = getElementKeyframes({
			animations: element({ plan, id: "v1" }).animations,
		}).map((key) => `${key.propertyPath}@${key.time}`);
		expect(paths.sort()).toEqual(["transform.scaleX@0", "transform.scaleY@0"]);
	});

	test("keyframe past the element end is clamped; a property the element lacks is refused", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{
					op: "keyframe",
					elementId: "cap",
					property: "opacity",
					time: 10,
					value: 0.5,
				},
			],
		});
		expect(
			getElementKeyframes({
				animations: element({ plan, id: "cap" }).animations,
			})[0]?.time,
		).toBe(t(2));
		expect(plan.warnings[0]).toContain("clamped");
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [
						{
							op: "keyframe",
							elementId: "v1",
							property: "color",
							time: 0,
							value: "#ff0000",
						},
					],
				}),
			opIndex: 0,
			contains: "cannot be keyframed",
		});
	});

	test("clip_effect add with as, then an effect keyframe and an update on @name", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{
					op: "clip_effect",
					elementId: "v1",
					action: "add",
					effect: "blur",
					params: { intensity: 40 },
					as: "blurIn",
				},
				{
					op: "keyframe",
					elementId: "v1",
					property: "effect.intensity",
					effectId: "@blurIn",
					time: 0,
					value: 60,
				},
				{
					op: "clip_effect",
					elementId: "v1",
					action: "toggle",
					effectId: "@blurIn",
				},
			],
		});
		const clip = element({ plan, id: "v1" });
		const effect = clip.type === "video" ? clip.effects?.[0] : undefined;
		expect(effect).toMatchObject({
			id: "id-1",
			type: "blur",
			enabled: false,
			params: { intensity: 40 },
		});
		expect(
			getElementKeyframes({ animations: clip.animations })[0]?.propertyPath,
		).toBe("effects.id-1.params.intensity");
		expect(plan.created).toEqual([
			{
				op: 0,
				kind: "effect",
				id: "id-1",
				trackId: "main",
				elementId: "v1",
				as: "blurIn",
			},
		]);

		const removed = resolve({
			initial: plan.state,
			ops: [
				{
					op: "clip_effect",
					elementId: "v1",
					action: "remove",
					effectId: "id-1",
				},
			],
		});
		const cleaned = element({ plan: removed, id: "v1" });
		expect(cleaned.type === "video" ? cleaned.effects : null).toEqual([]);
		expect(cleaned.animations).toBeUndefined();
	});

	test("mask set with params, invert, remove; refused on text", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{
					op: "mask",
					elementId: "v1",
					action: "set",
					type: "split",
					params: { centerX: 0.25, rotation: 90 },
				},
				{ op: "mask", elementId: "v1", action: "invert" },
			],
		});
		const clip = element({ plan, id: "v1" });
		const mask = clip.type === "video" ? clip.masks?.[0] : undefined;
		expect(mask?.type).toBe("split");
		expect(mask?.params).toMatchObject({
			centerX: 0.25,
			rotation: 90,
			inverted: true,
		});
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [
						{ op: "mask", elementId: "cap", action: "set", type: "rectangle" },
					],
				}),
			opIndex: 0,
			contains: "masks apply to",
		});
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [
						{
							op: "mask",
							elementId: "v1",
							action: "set",
							type: "rectangle",
							params: { radius: 3 },
						},
					],
				}),
			opIndex: 0,
			contains: 'unknown param "radius"',
		});
	});

	test("toggle_track sets states and refuses what a track kind cannot do", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{ op: "toggle_track", trackId: "main", mute: true, hide: true },
				{ op: "toggle_track", trackId: "at", mute: true },
			],
		});
		expect(plan.state.tracks.main).toMatchObject({ muted: true, hidden: true });
		expect(plan.state.tracks.audio[0]).toMatchObject({ muted: true });
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [{ op: "toggle_track", trackId: "at", hide: true }],
				}),
			opIndex: 0,
			contains: "cannot be hidden",
		});
	});

	test("source_audio detaches the sound onto an audio track, refuses silent media", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{ op: "source_audio", elementId: "v2", separate: true, as: "voice" },
			],
		});
		const voice = element({ plan, id: plan.refs.voice ?? "" });
		expect(voice.type).toBe("audio");
		expect(voice.startTime).toBe(t(4));
		const video = element({ plan, id: "v2" });
		expect(video.type === "video" ? video.isSourceAudioEnabled : null).toBe(
			false,
		);

		const silent = state({
			sceneTracks: tracks({
				main: [
					videoEl({ id: "s", start: 0, duration: 4, mediaId: "m-silent" }),
				],
			}),
		});
		expectPlanError({
			run: () =>
				resolve({
					initial: silent,
					ops: [{ op: "source_audio", elementId: "s", separate: true }],
				}),
			opIndex: 0,
			contains: "no audio",
		});
	});
});

describe("project ops", () => {
	test("bookmarks: add, update (nearest frame), remove; missing ones are NOT_FOUND", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{
					op: "bookmark",
					action: "add",
					time: 1.01,
					note: "hook",
					duration: 2,
				},
				{ op: "bookmark", action: "update", time: 1, color: "#ff0000" },
				{ op: "bookmark", action: "add", time: 5 },
				{ op: "bookmark", action: "remove", time: 5 },
			],
		});
		expect(plan.state.bookmarks).toEqual([
			{ time: t(1), note: "hook", duration: t(2), color: "#ff0000" },
		]);
		expect(plan.bookmarksChanged).toBe(true);
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [{ op: "bookmark", action: "remove", time: 3 }],
				}),
			code: "NOT_FOUND",
			opIndex: 0,
		});
	});

	test("bookmarks off the current frame grid (fps changed) are still found at their reported time", () => {
		// 0.1 s is frame 3 at 30 fps; at 25 fps it snaps to 0.12 s, and at 29.97 fps 8 s snaps to 8.008 s.
		const initial = () =>
			state({
				sceneTracks: tracks({
					main: [videoEl({ id: "v", start: 0, duration: 10 })],
				}),
				bookmarks: [{ time: t(0.1), note: "hook" }, { time: t(8) }],
			});
		const plan = resolve({
			initial: initial(),
			ops: [
				{ op: "project_settings", fps: 25 },
				{ op: "bookmark", action: "update", time: 0.1, note: "accroche" },
				{ op: "bookmark", action: "add", time: 0.12, color: "#ff0000" },
				{ op: "project_settings", fps: 29.97 },
				{ op: "bookmark", action: "remove", time: 8 },
			],
		});
		expect(plan.state.bookmarks).toEqual([
			{ time: t(0.1), note: "accroche", color: "#ff0000" },
		]);
		expect(plan.warnings.join(" ")).toContain("already existed at 0.1 s");
		// Adjacent frames stay distinct bookmarks.
		const adjacent = resolve({
			initial: initial(),
			ops: [{ op: "bookmark", action: "add", time: 3 / 30 + 1 / 30 }],
		});
		expect(adjacent.state.bookmarks).toHaveLength(3);
		expectPlanError({
			run: () =>
				resolve({
					initial: initial(),
					ops: [{ op: "bookmark", action: "remove", time: 0.15 }],
				}),
			code: "NOT_FOUND",
			opIndex: 0,
			contains: "there is no bookmark at 0.15 s",
		});
	});

	test("project_settings: 4:5 is a custom canvas, editor presets use preset mode, odd fps refused", () => {
		const custom = resolve({
			initial: basic(),
			ops: [
				{
					op: "project_settings",
					canvas: "4:5",
					fps: 29.97,
					background: { type: "blur", intensity: 200 },
				},
			],
		});
		expect(custom.settingsSteps[0]).toEqual({
			opIndex: 0,
			patch: {
				canvasSize: { width: 1080, height: 1350 },
				canvasSizeMode: "custom",
				lastCustomCanvasSize: { width: 1080, height: 1350 },
				fps: { numerator: 30_000, denominator: 1_001 },
				background: { type: "blur", blurIntensity: 200 },
			},
			undoable: true,
		});
		const preset = resolve({
			initial: basic(),
			ops: [{ op: "project_settings", canvas: { width: 1920, height: 1080 } }],
		});
		expect(preset.settingsSteps[0]?.patch).toEqual({
			canvasSize: { width: 1920, height: 1080 },
		});
		expectPlanError({
			run: () =>
				resolve({
					initial: basic(),
					ops: [{ op: "project_settings", fps: 23.5 }],
				}),
			opIndex: 0,
			contains: "not supported",
		});
	});

	test("settings changed by a plan apply to later ops (new fps snaps later times)", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{ op: "project_settings", fps: 25 },
				{
					op: "add_text",
					text: "x",
					start: 1.01,
					duration: 1,
					track: "overlay",
				},
			],
		});
		// 25 fps: 4800-tick frames; 1.01 s -> frame 25 = 120000 ticks.
		expect(element({ plan, id: "id-1" }).startTime).toBe(t(1));
		expect(element({ plan, id: "id-1" }).duration).toBe(t(1));
	});

	test("an empty new track is pruned with a warning and not reported", () => {
		const plan = resolve({
			initial: basic(),
			ops: [{ op: "new_track", type: "graphic", as: "unused" }],
		});
		expect(plan.created).toEqual([]);
		expect(plan.tracksChanged).toBe(false);
		expect(plan.warnings[0]).toContain("stayed empty");
	});
});

describe("text", () => {
	test("maxWidth wraps with the measurer (10 px per char here, 50% of 1080 px = 540 px = 54 chars)", () => {
		const long =
			"Voici une phrase assez longue pour depasser la moitie de la largeur du canevas";
		const plan = resolve({
			initial: basic(),
			ops: [
				{
					op: "add_text",
					text: long,
					start: 0,
					duration: 2,
					maxWidth: 0.5,
					track: "overlay",
				},
			],
		});
		const content = String(element({ plan, id: "id-1" }).params.content);
		expect(content.split("\n").every((line) => line.length * 10 <= 540)).toBe(
			true,
		);
		expect(content.replace(/\n/g, " ")).toBe(long);
	});

	test("an em dash in text is flagged", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{
					op: "add_text",
					text: "a \u2014 b",
					start: 0,
					duration: 1,
					track: "overlay",
				},
			],
		});
		expect(plan.warnings[0]).toContain("em dash");
	});

	test("graphic size converts to scale against the canvas short edge", () => {
		const plan = resolve({
			initial: basic(),
			ops: [
				{
					op: "add_graphic",
					shape: "rectangle",
					start: 0,
					duration: 1,
					size: { width: 1080, height: 200 },
					params: { fill: "#ff0000" },
				},
			],
		});
		expect(element({ plan, id: "id-1" }).params).toMatchObject({
			"transform.scaleX": 1,
			fill: "#ff0000",
		});
		expect(
			Number(element({ plan, id: "id-1" }).params["transform.scaleY"]),
		).toBeCloseTo(200 / 1080, 2);
	});

	test("image fixture sanity: MEDIA holds an image", () => {
		expect(MEDIA.some((item) => item.type === "image")).toBe(true);
		expect(imageEl({ id: "i", start: 0, duration: 1 }).type).toBe("image");
	});
});
