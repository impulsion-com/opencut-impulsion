/**
 * `bun test` preload (wired in the root and `apps/web` `bunfig.toml`).
 *
 * `opencut-wasm` is built by wasm-pack with `--target bundler`: its entry does
 * `import * as wasm from "./opencut_wasm_bg.wasm"` and relies on the bundler's
 * WebAssembly ESM integration (Next/Turbopack provide it). Bun's runtime does
 * not, so every test that reaches `@/wasm` crashed with
 * `wasm.__wbindgen_start is not a function`, followed by TDZ errors in the
 * modules that read `TICKS_PER_SECOND` at load time.
 *
 * This plugin rewrites that single import into a synchronous instantiation of
 * the real binary, so tests run against the same Rust code as the app.
 */
import { plugin } from "bun";
import { readFileSync } from "node:fs";

const WASM_ESM_IMPORT = 'import * as wasm from "./opencut_wasm_bg.wasm";';

plugin({
	name: "opencut-wasm bundler-target loader",
	setup(build) {
		build.onLoad({ filter: /opencut-wasm[\\/]opencut_wasm\.js$/ }, ({ path }) => {
			const source = readFileSync(path, "utf8");
			if (!source.includes(WASM_ESM_IMPORT)) {
				throw new Error(
					`[test-preload] Unexpected opencut-wasm entry layout in ${path}; update apps/web/src/wasm/test-preload.ts`,
				);
			}

			const wasmPath = path.replace(/opencut_wasm\.js$/, "opencut_wasm_bg.wasm");
			const instantiation = [
				'import * as __wasmImports from "./opencut_wasm_bg.js";',
				'import { readFileSync as __readWasmFile } from "node:fs";',
				"const wasm = new WebAssembly.Instance(",
				`\tnew WebAssembly.Module(__readWasmFile(${JSON.stringify(wasmPath)})),`,
				'\t{ "./opencut_wasm_bg.js": __wasmImports },',
				").exports;",
			].join("\n");

			return {
				loader: "js",
				contents: source.replace(WASM_ESM_IMPORT, instantiation),
			};
		});
	},
});
