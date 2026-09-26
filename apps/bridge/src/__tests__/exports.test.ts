import {
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EDITOR_ORIGIN } from "@opencut/claude-tools";
import {
	candidateName,
	createExportUploads,
	type ExportUploads,
} from "../exports";
import { createJobTable, type JobTable } from "../jobs";
import { silentLogger } from "../log";
import { closeServer, listen } from "./helpers";

let dir: string;
let jobs: JobTable;
let uploads: ExportUploads;
let server: http.Server;
let origin: string;

beforeAll(async () => {
	dir = await realpath(await mkdtemp(path.join(tmpdir(), "opencut-exports-")));
	jobs = createJobTable({ logger: silentLogger, doneGraceMs: 50 });
	uploads = createExportUploads({
		jobs,
		getExportsDir: () => dir,
		maxBytes: 1000,
		logger: silentLogger,
		probeDuration: async () => 12.5,
	});
	server = http.createServer((req, res) => {
		const match = /^\/exports\/([^/?]+)/.exec(req.url ?? "");
		if (!match?.[1]) {
			res.statusCode = 404;
			res.end();
			return;
		}
		void uploads.handle({ req, res, jobId: match[1] });
	});
	origin = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
	jobs.dispose();
	await closeServer(server);
	await rm(dir, { recursive: true, force: true });
});

function exportJob(fileName: string) {
	return jobs.create({
		kind: "export",
		origin: { kind: "mcp" },
		projectId: "p1",
		status: "running",
		export: {
			fileName,
			format: "mp4",
			outputPath: path.join(dir, fileName),
			upload: "none",
		},
	});
}

function post(
	jobId: string,
	body: Uint8Array,
	headers: Record<string, string> = {},
): Promise<Response> {
	return fetch(`${origin}/exports/${jobId}`, {
		method: "POST",
		body,
		headers: { "Content-Type": "video/mp4", ...headers },
	});
}

describe("POST /exports/<jobId>", () => {
	test("refuses a job the sidecar did not create", async () => {
		const response = await post(
			"00000000-0000-0000-0000-000000000000",
			new Uint8Array(10),
		);
		expect(response.status).toBe(404);
		const importJob = jobs.create({
			kind: "import",
			origin: { kind: "mcp" },
			projectId: "p1",
		});
		expect((await post(importJob.id, new Uint8Array(10))).status).toBe(404);
	});

	test("writes the upload, finishes the job and refuses a second upload", async () => {
		const job = exportJob("Mon export.mp4");
		const body = new Uint8Array(
			Array.from({ length: 300 }, (_, index) => index % 256),
		);
		const response = await post(job.id, body, { Origin: EDITOR_ORIGIN });
		expect(response.status).toBe(201);
		expect(response.headers.get("access-control-allow-origin")).toBe(
			EDITOR_ORIGIN,
		);
		const answer = (await response.json()) as {
			path: string;
			sizeBytes: number;
		};
		expect(answer).toEqual({
			path: path.join(dir, "Mon export.mp4"),
			sizeBytes: 300,
		});
		expect(
			Buffer.from(await readFile(answer.path)).equals(Buffer.from(body)),
		).toBe(true);
		const finished = jobs.get(job.id);
		expect(finished?.status).toBe("done");
		expect(finished?.result).toEqual({
			path: answer.path,
			sizeBytes: 300,
			durationSeconds: 12.5,
		});
		expect((await post(job.id, body)).status).toBe(409);
	});

	test("adds a suffix when the file name is taken", async () => {
		await writeFile(path.join(dir, "Reel.mp4"), "old");
		const job = exportJob("Reel.mp4");
		const response = await post(job.id, new Uint8Array(20));
		const answer = (await response.json()) as { path: string };
		expect(answer.path).toBe(path.join(dir, "Reel (2).mp4"));
		expect(await readFile(path.join(dir, "Reel.mp4"), "utf8")).toBe("old");
		expect(candidateName("a.b.mp4", 3)).toBe("a.b (3).mp4");
	});

	test("enforces the size limit and the editor origin", async () => {
		const tooBig = exportJob("big.mp4");
		expect((await post(tooBig.id, new Uint8Array(1001))).status).toBe(413);
		expect(jobs.get(tooBig.id)?.export?.upload).toBe("none");
		const foreign = exportJob("foreign.mp4");
		expect(
			(
				await post(foreign.id, new Uint8Array(10), {
					Origin: "http://evil.example",
				})
			).status,
		).toBe(403);
		const empty = exportJob("empty.mp4");
		expect((await post(empty.id, new Uint8Array(0))).status).toBe(400);
	});

	test("refuses uploads for a cancelled job and leaves no partial file", async () => {
		const job = exportJob("cancelled.mp4");
		jobs.finish(job.id, { status: "cancelled" });
		expect((await post(job.id, new Uint8Array(10))).status).toBe(409);
		const leftovers = (await readdir(dir)).filter((name) =>
			name.endsWith(".part"),
		);
		expect(leftovers).toEqual([]);
	});

	test("preflight allows the upload headers", async () => {
		const job = exportJob("preflight.mp4");
		const response = await fetch(`${origin}/exports/${job.id}`, {
			method: "OPTIONS",
			headers: {
				Origin: EDITOR_ORIGIN,
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "content-type",
			},
		});
		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-methods")).toContain(
			"POST",
		);
	});
});

describe("export job events", () => {
	test("tab progress moves the job, failed and cancelled finish it", () => {
		const job = exportJob("events.mp4");
		jobs.applyTabEvent({
			type: "event",
			name: "export-progress",
			payload: { jobId: job.id, phase: "rendering", progress: 0.4 },
		});
		expect(jobs.get(job.id)).toMatchObject({
			status: "running",
			progress: 0.4,
			phase: "rendering",
		});
		jobs.applyTabEvent({
			type: "event",
			name: "export-progress",
			payload: {
				jobId: job.id,
				phase: "failed",
				progress: 0.4,
				error: "encoder crashed",
			},
		});
		expect(jobs.get(job.id)).toMatchObject({
			status: "failed",
			error: "encoder crashed",
		});
		const snapshot = jobs.snapshot(jobs.get(job.id)!);
		expect(snapshot).toMatchObject({
			jobId: job.id,
			kind: "export",
			status: "failed",
			error: "encoder crashed",
		});
		expect(typeof snapshot.startedAt).toBe("string");
	});

	test("done without an upload fails after the grace period", async () => {
		const job = exportJob("ghost.mp4");
		jobs.applyTabEvent({
			type: "event",
			name: "export-progress",
			payload: { jobId: job.id, phase: "done", progress: 1 },
		});
		expect(jobs.get(job.id)?.status).toBe("running");
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(jobs.get(job.id)?.status).toBe("failed");
	});

	test("a closed tab connection fails the exports it was rendering", () => {
		const job = exportJob("closed.mp4");
		jobs.update(job.id, { export: { connectionId: "c1" } });
		jobs.failJobsOfConnection("c2");
		expect(jobs.get(job.id)?.status).toBe("running");
		jobs.failJobsOfConnection("c1");
		expect(jobs.get(job.id)?.status).toBe("failed");
	});

	test("waitFor resolves when the job finishes", async () => {
		const job = exportJob("wait.mp4");
		setTimeout(
			() => jobs.finish(job.id, { status: "done", result: { path: "x" } }),
			30,
		);
		const finished = await jobs.waitFor(job.id, { timeoutMs: 2000 });
		expect(finished?.status).toBe("done");
		const quick = exportJob("quick.mp4");
		const startedAt = Date.now();
		expect((await jobs.waitFor(quick.id, { timeoutMs: 50 }))?.status).toBe(
			"running",
		);
		expect(Date.now() - startedAt).toBeLessThan(1000);
	});
});
