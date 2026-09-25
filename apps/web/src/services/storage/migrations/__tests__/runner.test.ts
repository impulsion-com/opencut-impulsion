import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	installFakeIndexedDB,
	type FakeIndexedDB,
} from "../../__tests__/fake-browser-storage";
import { StorageMigration, type StorageMigrationRunArgs } from "../base";
import { runStorageMigrations } from "../runner";
import type { MigrationResult, ProjectRecord } from "../transformers/types";
import { V1toV2Migration } from "../v1-to-v2";
import { v1Project } from "./fixtures";
import { asRecord, asRecordArray } from "./helpers";

const PROJECTS_DB = "video-editor-projects";
const PROJECTS_STORE = "projects";

class MarkerMigration extends StorageMigration {
	from: number;
	to: number;

	constructor({ from, to }: { from: number; to: number }) {
		super();
		this.from = from;
		this.to = to;
	}

	async run({
		project,
	}: StorageMigrationRunArgs): Promise<MigrationResult<ProjectRecord>> {
		const steps = Array.isArray(project.steps) ? project.steps : [];
		return {
			project: {
				...project,
				version: this.to,
				steps: [...steps, `${this.from}->${this.to}`],
			},
			skipped: false,
		};
	}
}

describe("runStorageMigrations", () => {
	let fakeIndexedDB: FakeIndexedDB;
	let restore: () => void;

	beforeEach(() => {
		({ indexedDB: fakeIndexedDB, restore } = installFakeIndexedDB());
	});

	afterEach(() => {
		restore();
	});

	test("migrates stored projects in the projects database and writes them back", async () => {
		fakeIndexedDB.seed({
			dbName: PROJECTS_DB,
			storeName: PROJECTS_STORE,
			records: [
				{ id: "old", version: 29, metadata: { id: "old", name: "Old" } },
				{ id: "current", version: 31, metadata: { id: "current", name: "Now" } },
			],
		});

		const result = await runStorageMigrations({
			// Deliberately unordered: the runner sorts by `from`.
			migrations: [
				new MarkerMigration({ from: 30, to: 31 }),
				new MarkerMigration({ from: 29, to: 30 }),
			],
		});

		expect(result.migratedCount).toBe(2);
		expect(
			fakeIndexedDB.getRecords({ dbName: PROJECTS_DB, storeName: PROJECTS_STORE }),
		).toEqual([
			{ id: "current", version: 31, metadata: { id: "current", name: "Now" } },
			{
				id: "old",
				version: 31,
				metadata: { id: "old", name: "Old" },
				steps: ["29->30", "30->31"],
			},
		]);
		// The positional-constructor bug opened a database literally named "undefined".
		expect(fakeIndexedDB.databases.has("undefined")).toBe(false);
	});

	test("leaves up-to-date projects untouched", async () => {
		fakeIndexedDB.seed({
			dbName: PROJECTS_DB,
			storeName: PROJECTS_STORE,
			records: [{ id: "current", version: 31, metadata: { id: "current" } }],
		});

		const result = await runStorageMigrations({
			migrations: [new MarkerMigration({ from: 30, to: 31 })],
		});

		expect(result.migratedCount).toBe(0);
	});
});

describe("V1toV2Migration", () => {
	let fakeIndexedDB: FakeIndexedDB;
	let restore: () => void;

	beforeEach(() => {
		({ indexedDB: fakeIndexedDB, restore } = installFakeIndexedDB());
	});

	afterEach(() => {
		restore();
	});

	test("reads legacy timeline and media databases, then deletes the timeline ones", async () => {
		const projectId = v1Project.id;
		const timelineDb = `video-editor-timelines-${projectId}-scene-main`;
		fakeIndexedDB.seed({
			dbName: timelineDb,
			storeName: "timeline",
			records: [
				{
					id: "timeline",
					lastModified: "2024-01-15T12:00:00.000Z",
					tracks: [
						{
							id: "legacy-track-1",
							type: "media",
							name: "Legacy media track",
							elements: [
								{
									id: "media-element-1",
									name: "Clip",
									type: "media",
									mediaId: "media-1",
									duration: 120,
									startTime: 0,
									trimStart: 0,
									trimEnd: 0,
								},
							],
						},
					],
				},
			],
		});
		fakeIndexedDB.seed({
			dbName: `video-editor-media-${projectId}`,
			storeName: "media-metadata",
			records: [
				{
					id: "media-1",
					name: "clip.mp4",
					type: "video",
					size: 1,
					lastModified: 0,
				},
			],
		});

		const result = await new V1toV2Migration().run({
			projectId,
			project: v1Project,
		});

		expect(result.skipped).toBe(false);
		const [mainScene] = asRecordArray(result.project.scenes);
		const [track] = asRecordArray(mainScene.tracks);
		expect(track.type).toBe("video");
		const [element] = asRecordArray(track.elements);
		expect(asRecord(element).type).toBe("video");
		expect(asRecord(element).mediaId).toBe("media-1");
		expect(fakeIndexedDB.databases.has(timelineDb)).toBe(false);
		expect(fakeIndexedDB.databases.has("undefined")).toBe(false);
	});
});
