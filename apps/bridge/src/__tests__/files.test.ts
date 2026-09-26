import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EDITOR_ORIGIN } from "@opencut/claude-tools";
import { resolveAllowedPath } from "../allowlist";
import {
	createFileRegistry,
	FileAccessError,
	parseRange,
	type FileRegistry,
} from "../files";
import { silentLogger } from "../log";
import { closeServer, listen } from "./helpers";

let base: string;
let root: string;
let outside: string;
let registry: FileRegistry;
let server: http.Server;
let origin: string;
let clock = Date.now();
const CONTENT = Buffer.from(
	Array.from({ length: 1000 }, (_, index) => index % 251),
);

beforeAll(async () => {
	base = await realpath(await mkdtemp(path.join(tmpdir(), "opencut-files-")));
	root = path.join(base, "root");
	outside = path.join(base, "outside");
	await mkdir(path.join(root, ".secret"), { recursive: true });
	await mkdir(path.join(root, "rushes"), { recursive: true });
	await mkdir(outside, { recursive: true });
	await writeFile(path.join(root, "clip.mp4"), CONTENT);
	await writeFile(
		path.join(root, "rushes", "take 1.mov"),
		CONTENT.subarray(0, 10),
	);
	await writeFile(path.join(root, ".hidden.mp4"), "x");
	await writeFile(path.join(root, ".secret", "inside.mp4"), "x");
	await writeFile(path.join(outside, "secret.mp4"), "top secret");
	await symlink(
		path.join(outside, "secret.mp4"),
		path.join(root, "link-out.mp4"),
	);
	await symlink(outside, path.join(root, "linked-folder"));
	await symlink(path.join(root, "clip.mp4"), path.join(root, "link-in.mp4"));

	registry = createFileRegistry({
		getRoots: () => [root],
		ttlMs: 60_000,
		now: () => clock,
		logger: silentLogger,
		baseUrl: "http://placeholder",
	});
	server = http.createServer((req, res) => {
		const match = /^\/files\/([^/?]+)/.exec(req.url ?? "");
		if (!match?.[1]) {
			res.statusCode = 404;
			res.end();
			return;
		}
		void registry.handle({ req, res, id: match[1] });
	});
	origin = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
	await closeServer(server);
	await rm(base, { recursive: true, force: true });
});

function urlFor(id: string): string {
	return `${origin}/files/${id}`;
}

async function refused(input: string): Promise<string> {
	try {
		await registry.registerFile(input);
	} catch (error) {
		expect(error).toBeInstanceOf(FileAccessError);
		return (error as Error).message;
	}
	throw new Error(`${input} was accepted`);
}

describe("parseRange", () => {
	test("single ranges", () => {
		expect(parseRange({ header: undefined, size: 100 })).toBeNull();
		expect(parseRange({ header: "bytes=0-9", size: 100 })).toEqual({
			start: 0,
			end: 9,
		});
		expect(parseRange({ header: "bytes=90-", size: 100 })).toEqual({
			start: 90,
			end: 99,
		});
		expect(parseRange({ header: "bytes=-10", size: 100 })).toEqual({
			start: 90,
			end: 99,
		});
		expect(parseRange({ header: "bytes=50-500", size: 100 })).toEqual({
			start: 50,
			end: 99,
		});
		expect(parseRange({ header: "bytes=100-", size: 100 })).toBe(
			"unsatisfiable",
		);
		expect(parseRange({ header: "bytes=20-10", size: 100 })).toBe(
			"unsatisfiable",
		);
		expect(parseRange({ header: "bytes=0-1,5-6", size: 100 })).toBeNull();
		expect(parseRange({ header: "items=0-1", size: 100 })).toBeNull();
	});
});

describe("allow-list", () => {
	test("accepts files inside a root, with a URL on the files route", async () => {
		const file = await registry.registerFile(path.join(root, "clip.mp4"));
		expect(file.path).toBe(path.join(root, "clip.mp4"));
		expect(file.url).toBe(`http://placeholder/files/${file.id}`);
		expect(file).toMatchObject({
			name: "clip.mp4",
			size: 1000,
			mimeType: "video/mp4",
		});
		const spaced = await registry.registerFile(
			path.join(root, "rushes", "take 1.mov"),
		);
		expect(spaced.mimeType).toBe("video/quicktime");
	});

	test("refuses paths outside the roots, even through .. or a symlink", async () => {
		expect(await refused(path.join(outside, "secret.mp4"))).toContain(
			"outside",
		);
		expect(
			await refused(path.join(root, "..", "outside", "secret.mp4")),
		).toContain("outside");
		expect(await refused(path.join(root, "link-out.mp4"))).toContain("outside");
		expect(
			await refused(path.join(root, "linked-folder", "secret.mp4")),
		).toContain("outside");
	});

	test("refuses dotfiles, folders, relative and missing paths", async () => {
		expect(await refused(path.join(root, ".hidden.mp4"))).toContain("hidden");
		expect(await refused(path.join(root, ".secret", "inside.mp4"))).toContain(
			"hidden",
		);
		expect(await refused(path.join(root, "rushes"))).toContain(
			"not a regular file",
		);
		expect(await refused("rushes/take 1.mov")).toContain("absolute");
		expect(await refused(path.join(root, "nope.mp4"))).toContain(
			"does not exist",
		);
	});

	test("follows a symlink that stays inside the roots", async () => {
		const file = await registry.registerFile(path.join(root, "link-in.mp4"));
		expect(file.path).toBe(path.join(root, "clip.mp4"));
	});

	test("folders: the root itself is allowed, a symlinked escape is not", async () => {
		expect(
			(await resolveAllowedPath({ input: root, roots: [root], kind: "folder" }))
				.ok,
		).toBe(true);
		const escaped = await resolveAllowedPath({
			input: path.join(root, "linked-folder"),
			roots: [root],
			kind: "folder",
		});
		expect(escaped.ok).toBe(false);
	});
});

describe("GET /files/<id>", () => {
	test("serves the whole file with type, length and range support", async () => {
		const file = await registry.registerFile(path.join(root, "clip.mp4"));
		const response = await fetch(urlFor(file.id), {
			headers: { Origin: EDITOR_ORIGIN },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("video/mp4");
		expect(response.headers.get("content-length")).toBe("1000");
		expect(response.headers.get("accept-ranges")).toBe("bytes");
		expect(response.headers.get("access-control-allow-origin")).toBe(
			EDITOR_ORIGIN,
		);
		expect(Buffer.from(await response.arrayBuffer()).equals(CONTENT)).toBe(
			true,
		);
	});

	test("serves byte ranges", async () => {
		const file = await registry.registerFile(path.join(root, "clip.mp4"));
		const middle = await fetch(urlFor(file.id), {
			headers: { Range: "bytes=10-19" },
		});
		expect(middle.status).toBe(206);
		expect(middle.headers.get("content-range")).toBe("bytes 10-19/1000");
		expect(middle.headers.get("content-length")).toBe("10");
		expect(
			Buffer.from(await middle.arrayBuffer()).equals(CONTENT.subarray(10, 20)),
		).toBe(true);

		const tail = await fetch(urlFor(file.id), {
			headers: { Range: "bytes=-5" },
		});
		expect(tail.status).toBe(206);
		expect(
			Buffer.from(await tail.arrayBuffer()).equals(CONTENT.subarray(995)),
		).toBe(true);

		const beyond = await fetch(urlFor(file.id), {
			headers: { Range: "bytes=5000-" },
		});
		expect(beyond.status).toBe(416);
		expect(beyond.headers.get("content-range")).toBe("bytes */1000");
		await beyond.arrayBuffer();
	});

	test("HEAD answers headers only", async () => {
		const file = await registry.registerFile(path.join(root, "clip.mp4"));
		const response = await fetch(urlFor(file.id), { method: "HEAD" });
		expect(response.status).toBe(200);
		expect(response.headers.get("content-length")).toBe("1000");
	});

	test("CORS: only the editor origin, preflight allows Range", async () => {
		const file = await registry.registerFile(path.join(root, "clip.mp4"));
		const foreign = await fetch(urlFor(file.id), {
			headers: { Origin: "http://evil.example" },
		});
		expect(foreign.status).toBe(403);
		expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
		await foreign.arrayBuffer();
		const preflight = await fetch(urlFor(file.id), {
			method: "OPTIONS",
			headers: {
				Origin: EDITOR_ORIGIN,
				"Access-Control-Request-Method": "GET",
				"Access-Control-Request-Headers": "range",
			},
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe(
			EDITOR_ORIGIN,
		);
		expect(preflight.headers.get("access-control-allow-headers")).toContain(
			"Range",
		);
	});

	test("unknown, malformed and expired ids are 404", async () => {
		expect((await fetch(urlFor("AAAAAAAAAAAAAAAAAAAAAAAA"))).status).toBe(404);
		expect((await fetch(urlFor("..%2F..%2Fetc%2Fpasswd"))).status).toBe(404);
		const file = await registry.registerFile(path.join(root, "clip.mp4"));
		clock += 120_000;
		expect((await fetch(urlFor(file.id))).status).toBe(404);
		clock -= 120_000;
	});

	test("a file swapped for a symlink after registration is refused", async () => {
		const swap = path.join(root, "swap.mp4");
		await writeFile(swap, "fine");
		const file = await registry.registerFile(swap);
		await unlink(swap);
		await symlink(path.join(outside, "secret.mp4"), swap);
		const response = await fetch(urlFor(file.id));
		expect(response.status).toBe(403);
		expect(await response.text()).not.toContain("top secret");
	});
});
