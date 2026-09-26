/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- hand-built fixtures stand in for editor data */
import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { TProject } from "@/project/types";
import type {
	AudioTrack,
	GraphicElement,
	SceneTracks,
	TextElement,
	TextTrack,
	TScene,
	UploadAudioElement,
	VideoElement,
	VideoTrack,
} from "@/timeline/types";
import { mediaTimeFromSeconds, type MediaTime } from "@/wasm";
import {
	describeElement,
	groupKeyframes,
	nonDefaultParams,
	serializeEditorState,
	summarizeElement,
	summarizeMedia,
	SUMMARY_TEXT_MAX_CHARS,
	tracksDuration,
} from "@/claude/state/serialize";

const t = (seconds: number): MediaTime => mediaTimeFromSeconds({ seconds });

function videoElement(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		id: "v1",
		type: "video",
		name: "rush.mp4",
		mediaId: "m-video",
		startTime: t(0),
		duration: t(4),
		trimStart: t(1),
		trimEnd: t(0.5),
		sourceDuration: t(5.5),
		isSourceAudioEnabled: true,
		hidden: false,
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
			blendMode: "normal",
			volume: 0,
			muted: false,
		},
		...overrides,
	};
}

function textElement(overrides: Partial<TextElement> = {}): TextElement {
	return {
		id: "t1",
		type: "text",
		name: "Hook",
		startTime: t(0.5),
		duration: t(2.5),
		trimStart: t(0),
		trimEnd: t(0),
		params: {
			content: "3 erreurs en pub",
			fontFamily: "Figtree",
			fontSize: 9,
			color: "#ffffff",
			textAlign: "center",
			fontWeight: "bold",
			"transform.positionY": -730,
			opacity: 1,
		},
		animations: {
			opacity: {
				keys: [
					{
						id: "k2",
						time: t(0.3),
						value: 1,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
					{
						id: "k1",
						time: t(0),
						value: 0,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
			},
		},
		...overrides,
	} as TextElement;
}

function audioElement(): UploadAudioElement {
	return {
		id: "a1",
		type: "audio",
		sourceType: "upload",
		mediaId: "m-audio",
		name: "music.mp3",
		startTime: t(0),
		duration: t(6),
		trimStart: t(0),
		trimEnd: t(0),
		retime: { rate: 1.5 },
		params: { volume: -12, muted: true },
	};
}

function buildTracks(): SceneTracks {
	const overlay: TextTrack = {
		id: "track-text",
		type: "text",
		name: "Texts",
		hidden: false,
		elements: [textElement()],
	};
	const main: VideoTrack = {
		id: "track-main",
		type: "video",
		name: "Main Track",
		muted: false,
		hidden: false,
		elements: [
			videoElement({ id: "v2", startTime: t(4), duration: t(2) }),
			videoElement(),
		],
	};
	const audio: AudioTrack = {
		id: "track-audio",
		type: "audio",
		name: "Audio",
		muted: true,
		elements: [audioElement()],
	};
	return { overlay: [overlay], main, audio: [audio] };
}

function buildScene({
	tracks,
	overrides = {},
}: {
	tracks: SceneTracks;
	overrides?: Partial<TScene>;
}): TScene {
	return {
		id: "scene-1",
		name: "Main scene",
		isMain: true,
		tracks,
		bookmarks: [
			{ time: t(3), duration: t(1.2), note: "retake", color: "#ff0000" },
			{ time: t(1) },
		],
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...overrides,
	};
}

function buildProject(scenes: TScene[]): TProject {
	return {
		metadata: {
			id: "p1",
			name: "Reel test",
			duration: t(6),
			createdAt: new Date(0),
			updatedAt: new Date(0),
		},
		scenes,
		currentSceneId: scenes[0]?.id ?? "",
		settings: {
			fps: { numerator: 30000, denominator: 1001 },
			canvasSize: { width: 1080, height: 1920 },
			background: { type: "blur", blurIntensity: 200 },
		},
		version: 31,
	};
}

describe("tracksDuration", () => {
	test("is the end of the last element over every track", () => {
		expect(tracksDuration(buildTracks())).toBe(t(6));
		const empty = buildTracks();
		empty.overlay = [];
		empty.main = { ...empty.main, elements: [] };
		empty.audio = [];
		expect(tracksDuration(empty)).toBe(t(0));
	});
});

describe("summarizeElement", () => {
	test("video: seconds, trims, no default params", () => {
		expect(summarizeElement(videoElement())).toEqual({
			id: "v1",
			type: "video",
			name: "rush.mp4",
			start: 0,
			end: 4,
			duration: 4,
			mediaId: "m-video",
			trimStart: 1,
			trimEnd: 0.5,
		});
	});

	test("text: content, non-default params only, animated properties", () => {
		const summary = summarizeElement(textElement());
		expect(summary.text).toBe("3 erreurs en pub");
		expect(summary.start).toBe(0.5);
		expect(summary.end).toBe(3);
		expect(summary.params).toEqual({
			fontFamily: "Figtree",
			fontSize: 9,
			fontWeight: "bold",
			"transform.positionY": -730,
		});
		expect(summary.animated).toEqual(["opacity"]);
		expect(summary.trimStart).toBeUndefined();
	});

	test("long text is truncated and flagged", () => {
		const content = "a".repeat(SUMMARY_TEXT_MAX_CHARS + 50);
		const summary = summarizeElement(
			textElement({ params: { content }, animations: undefined }),
		);
		expect(summary.text).toHaveLength(SUMMARY_TEXT_MAX_CHARS + 3);
		expect(summary.textTruncated).toBe(true);
	});

	test("audio: speed, muted, volume", () => {
		const summary = summarizeElement(audioElement());
		expect(summary.speed).toBe(1.5);
		expect(summary.muted).toBe(true);
		expect(summary.params).toEqual({ volume: -12, muted: true });
	});

	test("hidden, detached source audio, effects and masks are reported", () => {
		const summary = summarizeElement(
			videoElement({
				hidden: true,
				isSourceAudioEnabled: false,
				effects: [
					{ id: "fx1", type: "blur", enabled: true, params: { intensity: 30 } },
				],
				masks: [
					{
						id: "mask1",
						type: "split",
						params: {
							centerX: 0,
							centerY: 0,
							rotation: 0,
							feather: 0,
							inverted: false,
							strokeColor: "#ffffff",
							strokeWidth: 0,
							strokeAlign: "center",
						},
					},
				],
			}),
		);
		expect(summary.hidden).toBe(true);
		expect(summary.sourceAudio).toBe(false);
		expect(summary.effectCount).toBe(1);
		expect(summary.maskCount).toBe(1);
	});

	test("graphic: shape id", () => {
		const graphic = {
			id: "g1",
			type: "graphic",
			name: "Rectangle",
			definitionId: "rectangle",
			startTime: t(0),
			duration: t(5),
			trimStart: t(0),
			trimEnd: t(0),
			params: { fill: "#ff0000" },
		} as GraphicElement;
		expect(summarizeElement(graphic).shape).toBe("rectangle");
	});
});

describe("keyframes", () => {
	test("grouped per property, sorted, times in element-relative seconds", () => {
		const detail = describeElement({
			track: buildTracks().overlay[0],
			element: textElement(),
		});
		expect(detail.keyframes).toEqual([
			{
				property: "opacity",
				keys: [
					{ time: 0, value: 0, interpolation: "linear" },
					{ time: 0.3, value: 1, interpolation: "linear" },
				],
			},
		]);
	});

	test("effect channels use the edit-plan vocabulary", () => {
		const groups = groupKeyframes([
			{
				propertyPath: "effects.fx1.params.intensity",
				id: "k",
				time: t(1),
				value: 40,
				interpolation: "linear",
			},
		]);
		expect(groups).toEqual([
			{
				property: "effect.intensity",
				effectId: "fx1",
				keys: [{ time: 1, value: 40, interpolation: "linear" }],
			},
		]);
	});
});

describe("describeElement", () => {
	test("fills every registry param and keeps the source trims", () => {
		const track = buildTracks().main;
		const detail = describeElement({ track, element: videoElement() });
		expect(detail.trackId).toBe("track-main");
		expect(detail.trimStart).toBe(1);
		expect(detail.sourceDuration).toBe(5.5);
		expect(detail.params.opacity).toBe(1);
		expect(detail.params.blendMode).toBe("normal");
		expect(detail.mask).toBeNull();
		expect(detail.retime).toBeNull();
		expect(detail.isSourceAudioEnabled).toBe(true);
	});

	test("text params fall back to the registry defaults", () => {
		const detail = describeElement({
			track: buildTracks().overlay[0],
			element: textElement(),
		});
		expect(detail.params.letterSpacing).toBe(0);
		expect(detail.params.content).toBe("3 erreurs en pub");
	});

	test("nonDefaultParams ignores content", () => {
		expect(nonDefaultParams(textElement())).not.toHaveProperty("content");
	});
});

describe("serializeEditorState", () => {
	const tracks = buildTracks();
	const scene = buildScene({ tracks });
	const other = buildScene({
		tracks: {
			...tracks,
			overlay: [],
			audio: [],
			main: { ...tracks.main, elements: [] },
		},
		overrides: { id: "scene-2", name: "Alt", isMain: false },
	});
	const media = [
		{
			id: "m-video",
			name: "rush.mp4",
			type: "video",
			duration: 5.5,
			width: 1080,
			height: 1920,
			fps: 29.97003,
			hasAudio: true,
			file: {} as File,
		},
		{
			id: "m-image",
			name: "logo.png",
			type: "image",
			width: 512,
			height: 512,
			hasAudio: false,
			file: {} as File,
		},
	] as MediaAsset[];

	const state = serializeEditorState({
		project: buildProject([scene, other]),
		scenes: [scene, other],
		activeScene: scene,
		mediaAssets: media,
		playhead: t(1.25),
		isPlaying: false,
		selection: [{ trackId: "track-main", elementId: "v1" }],
		canUndo: true,
		canRedo: false,
		modes: { ripple: false, snapping: true },
		busy: { exporting: false, exportProgress: 0, userDragging: false },
		stateVersion: 7,
		detail: "summary",
	});

	test("project settings in editor-facing units", () => {
		expect(state.project).toEqual({
			id: "p1",
			name: "Reel test",
			canvas: { width: 1080, height: 1920 },
			fps: 29.97,
			background: { type: "blur", intensity: 200 },
			duration: 6,
		});
	});

	test("tracks in display order, elements sorted by start", () => {
		expect(state.tracks.map((track) => track.id)).toEqual([
			"track-text",
			"track-main",
			"track-audio",
		]);
		expect(state.tracks.map((track) => track.isMain)).toEqual([
			false,
			true,
			false,
		]);
		expect(state.tracks[1]?.elements.map((element) => element.id)).toEqual([
			"v1",
			"v2",
		]);
		expect(state.tracks[2]?.muted).toBe(true);
		expect(state.tracks[0]?.hidden).toBeUndefined();
	});

	test("scenes, media, bookmarks, playhead, selection, flags", () => {
		expect(state.scene).toEqual({
			id: "scene-1",
			name: "Main scene",
			isMain: true,
		});
		expect(state.scenes).toEqual([
			{ id: "scene-1", name: "Main scene", isMain: true, duration: 6 },
			{ id: "scene-2", name: "Alt", isMain: false, duration: 0 },
		]);
		expect(state.media[0]).toEqual({
			id: "m-video",
			name: "rush.mp4",
			type: "video",
			duration: 5.5,
			width: 1080,
			height: 1920,
			fps: 29.97,
			hasAudio: true,
		});
		expect(state.media[1]).not.toHaveProperty("hasAudio");
		expect(state.bookmarks).toEqual([
			{ time: 1 },
			{ time: 3, duration: 1.2, note: "retake", color: "#ff0000" },
		]);
		expect(state.playhead).toBe(1.25);
		expect(state.selection).toEqual(["v1"]);
		expect(state.canUndo).toBe(true);
		expect(state.busy).toEqual({ exporting: false, userDragging: false });
		expect(state.stateVersion).toBe(7);
	});

	test("is JSON-safe (no File, no Date, no AudioBuffer)", () => {
		const json = JSON.parse(JSON.stringify(state));
		expect(json).toEqual(state);
		expect(JSON.stringify(state)).not.toContain("file");
	});

	test('detail "full" adds params, keyframes, effects and masks to each element', () => {
		const full = serializeEditorState({
			project: buildProject([scene]),
			scenes: [scene],
			activeScene: scene,
			mediaAssets: [],
			playhead: t(0),
			isPlaying: true,
			selection: [],
			canUndo: false,
			canRedo: false,
			modes: { ripple: true, snapping: false },
			busy: { exporting: true, exportProgress: 0.4567, userDragging: true },
			stateVersion: 1,
			detail: "full",
		});
		const text = full.tracks[0]?.elements[0];
		expect(text).toMatchObject({
			id: "t1",
			trackId: "track-text",
			text: "3 erreurs en pub",
			keyframes: [{ property: "opacity" }],
			effects: [],
			mask: null,
		});
		expect(
			text && "params" in text ? text.params?.letterSpacing : undefined,
		).toBe(0);
		expect(full.busy).toEqual({
			exporting: true,
			exportProgress: 0.457,
			userDragging: true,
		});
	});
});

describe("summarizeMedia", () => {
	test("rounds duration and fps, omits unknown fields", () => {
		expect(
			summarizeMedia({
				id: "m",
				name: "voice.wav",
				type: "audio",
				duration: 12.34567,
				file: {} as File,
			} as MediaAsset),
		).toEqual({ id: "m", name: "voice.wav", type: "audio", duration: 12.346 });
	});
});
