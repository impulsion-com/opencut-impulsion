/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- the lock never touches the editor */
import { describe, expect, test } from "bun:test";
import type { EditorCore } from "@/core";
import { RendererManager } from "@/core/managers/renderer-manager";

// The render mutex (map 4.4): exclusive renders run one at a time in call order, wait for the preview frame in
// flight, and move previewVersion when the last one releases so the preview redraws.

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const manager = () => new RendererManager({} as EditorCore);

describe("RendererManager render lock", () => {
	test("exclusive tasks run one at a time, in call order", async () => {
		const renderer = manager();
		const events: string[] = [];
		const first = deferred();
		const a = renderer.runExclusive(async () => {
			events.push("a:start");
			await first.promise;
			events.push("a:end");
			return "a";
		});
		const b = renderer.runExclusive(async () => {
			events.push("b:start");
			return "b";
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(events).toEqual(["a:start"]);
		expect(renderer.isRenderLocked()).toBe(true);
		first.resolve();
		expect(await a).toBe("a");
		expect(await b).toBe("b");
		expect(events).toEqual(["a:start", "a:end", "b:start"]);
		expect(renderer.isRenderLocked()).toBe(false);
	});

	test("a failing task releases the lock for the next one", async () => {
		const renderer = manager();
		const failing = renderer.runExclusive(async () => {
			throw new Error("boom");
		});
		const next = renderer.runExclusive(async () => 42);
		await expect(failing).rejects.toThrow("boom");
		expect(await next).toBe(42);
		expect(renderer.isRenderLocked()).toBe(false);
	});

	test("previewVersion moves once the queue drains", async () => {
		const renderer = manager();
		const before = renderer.getPreviewVersion();
		await Promise.all([
			renderer.runExclusive(async () => undefined),
			renderer.runExclusive(async () => undefined),
		]);
		expect(renderer.getPreviewVersion()).toBe(before + 1);
	});

	test("waits for the preview frame in flight before rendering", async () => {
		const renderer = manager();
		const frame = deferred();
		let frameDone = false;
		renderer.trackPreviewRender({
			render: frame.promise.then(() => {
				frameDone = true;
			}),
		});
		const exclusive = renderer.runExclusive(async () => frameDone);
		await Promise.resolve();
		frame.resolve();
		expect(await exclusive).toBe(true);
	});
});
