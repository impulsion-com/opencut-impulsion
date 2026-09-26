import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import { StorageService } from "../service";
import {
	installFakeIndexedDB,
	installFakeOPFS,
	type FakeOPFS,
} from "./fake-browser-storage";

const PROJECT_ID = "project-1";

function buildAsset({ id }: { id: string }): MediaAsset {
	return {
		id,
		name: `${id}.wav`,
		type: "audio",
		file: new File([`bytes of ${id}`], `${id}.wav`, { type: "audio/wav" }),
		duration: 5,
	};
}

describe("StorageService media removal (detach, restore, prune)", () => {
	let fakeOPFS: FakeOPFS;
	let restoreIndexedDB: () => void;
	let restoreOPFS: () => void;

	const files = () =>
		[
			...(fakeOPFS.directories.get(`media-files-${PROJECT_ID}`)?.files.keys() ??
				[]),
		].sort();

	beforeEach(() => {
		({ restore: restoreIndexedDB } = installFakeIndexedDB());
		({ opfs: fakeOPFS, restore: restoreOPFS } = installFakeOPFS());
	});

	afterEach(() => {
		restoreOPFS();
		restoreIndexedDB();
	});

	test("detach hides the media but keeps its file; restore brings it back without rewriting the file", async () => {
		const service = new StorageService();
		await service.saveMediaAsset({
			projectId: PROJECT_ID,
			mediaAsset: buildAsset({ id: "a" }),
		});
		const directory = fakeOPFS.directories.get(`media-files-${PROJECT_ID}`);
		const storedFile = directory?.files.get("a");

		await service.detachMediaAsset({ projectId: PROJECT_ID, id: "a" });
		expect(await service.loadAllMediaAssets({ projectId: PROJECT_ID })).toEqual(
			[],
		);
		expect(files()).toEqual(["a"]);

		const loadedFile = storedFile ?? new File([], "missing");
		await service.restoreMediaAsset({
			projectId: PROJECT_ID,
			mediaAsset: { ...buildAsset({ id: "a" }), file: loadedFile },
		});
		const restored = await service.loadMediaAsset({
			projectId: PROJECT_ID,
			id: "a",
		});
		expect(restored?.name).toBe("a.wav");
		expect(restored?.duration).toBe(5);
		// Same stored File object: only the metadata was written.
		expect(directory?.files.get("a")).toBe(storedFile);
	});

	test("restore saves the file too when it is no longer stored", async () => {
		const service = new StorageService();
		await service.restoreMediaAsset({
			projectId: PROJECT_ID,
			mediaAsset: buildAsset({ id: "b" }),
		});
		const restored = await service.loadMediaAsset({
			projectId: PROJECT_ID,
			id: "b",
		});
		expect(await restored?.file.text()).toBe("bytes of b");
	});

	test("prune deletes old orphaned files only", async () => {
		const service = new StorageService();
		for (const id of ["kept", "orphan"]) {
			await service.saveMediaAsset({
				projectId: PROJECT_ID,
				mediaAsset: buildAsset({ id }),
			});
		}
		await service.detachMediaAsset({ projectId: PROJECT_ID, id: "orphan" });

		expect(
			await service.pruneOrphanedMediaFiles({ projectId: PROJECT_ID }),
		).toBe(0);
		expect(files()).toEqual(["kept", "orphan"]);

		const deleted = await service.pruneOrphanedMediaFiles({
			projectId: PROJECT_ID,
			now: Date.now() + 61_000,
		});
		expect(deleted).toBe(1);
		expect(files()).toEqual(["kept"]);
		expect(
			(await service.loadAllMediaAssets({ projectId: PROJECT_ID })).map(
				(media) => media.id,
			),
		).toEqual(["kept"]);
	});
});
