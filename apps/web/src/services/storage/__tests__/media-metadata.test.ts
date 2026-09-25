import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import { StorageService } from "../service";
import {
	installFakeIndexedDB,
	installFakeOPFS,
	type FakeIndexedDB,
	type FakeOPFS,
} from "./fake-browser-storage";

const PROJECT_ID = "project-1";

function buildVideoAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
	return {
		id: "clip-1",
		name: "clip.mp4",
		type: "video",
		file: new File(["video-bytes"], "clip.mp4", { type: "video/mp4" }),
		width: 1920,
		height: 1080,
		duration: 12.5,
		...overrides,
	};
}

describe("StorageService media metadata", () => {
	let fakeIndexedDB: FakeIndexedDB;
	let fakeOPFS: FakeOPFS;
	let restoreIndexedDB: () => void;
	let restoreOPFS: () => void;

	beforeEach(() => {
		({ indexedDB: fakeIndexedDB, restore: restoreIndexedDB } =
			installFakeIndexedDB());
		({ opfs: fakeOPFS, restore: restoreOPFS } = installFakeOPFS());
	});

	afterEach(() => {
		restoreOPFS();
		restoreIndexedDB();
	});

	test("persists and restores fps and hasAudio", async () => {
		const service = new StorageService();
		await service.saveMediaAsset({
			projectId: PROJECT_ID,
			mediaAsset: buildVideoAsset({ fps: 30_000 / 1_001, hasAudio: false }),
		});

		const loaded = await service.loadMediaAsset({
			projectId: PROJECT_ID,
			id: "clip-1",
		});

		expect(loaded?.fps).toBe(30_000 / 1_001);
		expect(loaded?.hasAudio).toBe(false);
		expect(loaded?.duration).toBe(12.5);
	});

	test("loads records saved before fps and hasAudio were persisted", async () => {
		fakeIndexedDB.seed({
			dbName: `video-editor-media-${PROJECT_ID}`,
			storeName: "media-metadata",
			records: [
				{
					id: "legacy",
					name: "legacy.mp4",
					type: "video",
					size: 3,
					lastModified: 0,
					duration: 4,
				},
			],
		});
		const directory = await (await fakeOPFS.getDirectory()).getDirectoryHandle(
			`media-files-${PROJECT_ID}`,
			{ create: true },
		);
		directory.files.set("legacy", new File(["abc"], "legacy"));

		const loaded = await new StorageService().loadMediaAsset({
			projectId: PROJECT_ID,
			id: "legacy",
		});

		expect(loaded).not.toBeNull();
		expect(loaded?.fps).toBeUndefined();
		// Undefined means "unknown": consumers check `hasAudio !== false`.
		expect(loaded?.hasAudio).toBeUndefined();
	});
});
