/**
 * Minimal in-memory IndexedDB and OPFS for `bun test` (no browser storage, and
 * fake-indexeddb is not a dependency). They cover exactly what
 * `IndexedDBAdapter` and `OPFSAdapter` call, with the same async request and
 * error shapes, so the real adapters, `StorageService` and the migration
 * runner can be exercised end to end.
 */

type RequestCallback = (event: { target: FakeRequest<unknown> }) => void;

interface FakeRequest<T> {
	result: T | undefined;
	error: unknown;
	onsuccess: RequestCallback | null;
	onerror: RequestCallback | null;
	onupgradeneeded?: RequestCallback | null;
}

interface FakeObjectStore {
	keyPath: string;
	records: Map<string, unknown>;
}

interface FakeDatabase {
	version: number;
	stores: Map<string, FakeObjectStore>;
}

function createRequest<T>(): FakeRequest<T> {
	return { result: undefined, error: null, onsuccess: null, onerror: null };
}

/** Settles after the caller attached its handlers, like a real IDB request. */
function settle<T>({
	request,
	compute,
}: {
	request: FakeRequest<T>;
	compute: () => T;
}): void {
	queueMicrotask(() => {
		try {
			request.result = compute();
			request.onsuccess?.({ target: request });
		} catch (error) {
			request.error = error;
			request.onerror?.({ target: request });
		}
	});
}

function notFound(message: string): DOMException {
	return new DOMException(message, "NotFoundError");
}

function readKey({ value, keyPath }: { value: unknown; keyPath: string }): string {
	if (typeof value !== "object" || value === null) {
		throw new DOMException("Value is not an object", "DataError");
	}
	const key: unknown = Reflect.get(value, keyPath);
	if (typeof key !== "string") {
		throw new DOMException(`Missing string key "${keyPath}"`, "DataError");
	}
	return key;
}

function sortedKeys(store: FakeObjectStore): string[] {
	return [...store.records.keys()].sort();
}

export class FakeIndexedDB {
	readonly databases = new Map<string, FakeDatabase>();

	/** Seed a record as if it had been written by an older build. */
	seed({
		dbName,
		storeName,
		version = 1,
		records,
	}: {
		dbName: string;
		storeName: string;
		version?: number;
		records: Array<Record<string, unknown>>;
	}): void {
		const database = this.databases.get(dbName) ?? {
			version,
			stores: new Map<string, FakeObjectStore>(),
		};
		const store = database.stores.get(storeName) ?? {
			keyPath: "id",
			records: new Map<string, unknown>(),
		};
		for (const record of records) {
			store.records.set(
				readKey({ value: record, keyPath: store.keyPath }),
				structuredClone(record),
			);
		}
		database.stores.set(storeName, store);
		this.databases.set(dbName, database);
	}

	getRecords({
		dbName,
		storeName,
	}: {
		dbName: string;
		storeName: string;
	}): unknown[] {
		const store = this.databases.get(dbName)?.stores.get(storeName);
		if (!store) return [];
		return sortedKeys(store).map((key) => store.records.get(key));
	}

	// Positional like `IDBFactory.open`, which the real adapter calls.
	// eslint-disable-next-line opencut/prefer-object-params
	open(name: string, version = 1): FakeRequest<unknown> {
		const request = createRequest<unknown>();
		request.onupgradeneeded = null;

		queueMicrotask(() => {
			const existing = this.databases.get(name);
			if (existing && version < existing.version) {
				request.error = new DOMException(
					`Requested version ${version} is lower than ${existing.version}`,
					"VersionError",
				);
				request.onerror?.({ target: request });
				return;
			}

			const database = existing ?? {
				version: 0,
				stores: new Map<string, FakeObjectStore>(),
			};
			this.databases.set(name, database);
			request.result = this.connect(database);

			if (version > database.version) {
				database.version = version;
				request.onupgradeneeded?.({ target: request });
			}
			request.onsuccess?.({ target: request });
		});

		return request;
	}

	deleteDatabase(name: string): FakeRequest<undefined> {
		const request = createRequest<undefined>();
		settle({
			request,
			compute: () => {
				this.databases.delete(name);
				return undefined;
			},
		});
		return request;
	}

	private connect(database: FakeDatabase) {
		return {
			objectStoreNames: {
				contains: (storeName: string) => database.stores.has(storeName),
			},
			// Positional like `IDBDatabase.createObjectStore`.
			// eslint-disable-next-line opencut/prefer-object-params
			createObjectStore: (
				storeName: string,
				{ keyPath }: { keyPath: string },
			) => {
				database.stores.set(storeName, { keyPath, records: new Map() });
			},
			transaction: (storeNames: string[]) => {
				for (const storeName of storeNames) {
					if (!database.stores.has(storeName)) {
						throw notFound(`No object store named "${storeName}"`);
					}
				}
				return {
					objectStore: (storeName: string) => {
						const store = database.stores.get(storeName);
						if (!store) throw notFound(`No object store named "${storeName}"`);
						return this.storeApi(store);
					},
				};
			},
		};
	}

	private storeApi(store: FakeObjectStore) {
		const run = <T>(compute: () => T): FakeRequest<T> => {
			const request = createRequest<T>();
			settle({ request, compute });
			return request;
		};

		return {
			get: (key: string) =>
				run(() => structuredClone(store.records.get(key))),
			put: (value: unknown) =>
				run(() => {
					const key = readKey({ value, keyPath: store.keyPath });
					store.records.set(key, structuredClone(value));
					return key;
				}),
			delete: (key: string) =>
				run(() => {
					store.records.delete(key);
					return undefined;
				}),
			getAllKeys: () => run(() => sortedKeys(store)),
			getAll: () =>
				run(() =>
					sortedKeys(store).map((key) => structuredClone(store.records.get(key))),
				),
			clear: () =>
				run(() => {
					store.records.clear();
					return undefined;
				}),
		};
	}
}

class FakeFileHandle {
	private readonly files: Map<string, File>;
	private readonly name: string;

	constructor({ files, name }: { files: Map<string, File>; name: string }) {
		this.files = files;
		this.name = name;
	}

	async getFile(): Promise<File> {
		const file = this.files.get(this.name);
		if (!file) throw notFound(`No file named "${this.name}"`);
		return file;
	}

	async createWritable() {
		const chunks: BlobPart[] = [];
		return {
			write: async (data: Blob) => {
				chunks.push(data);
			},
			close: async () => {
				this.files.set(this.name, new File(chunks, this.name));
			},
		};
	}
}

class FakeDirectoryHandle {
	readonly files = new Map<string, File>();

	// Positional like `FileSystemDirectoryHandle.getFileHandle`.
	// eslint-disable-next-line opencut/prefer-object-params
	async getFileHandle(
		name: string,
		options?: { create?: boolean },
	): Promise<FakeFileHandle> {
		if (!this.files.has(name)) {
			if (!options?.create) throw notFound(`No file named "${name}"`);
			this.files.set(name, new File([], name));
		}
		return new FakeFileHandle({ files: this.files, name });
	}

	async removeEntry(name: string): Promise<void> {
		if (!this.files.delete(name)) throw notFound(`No file named "${name}"`);
	}

	async *keys(): AsyncIterableIterator<string> {
		yield* [...this.files.keys()];
	}
}

export class FakeOPFS {
	readonly directories = new Map<string, FakeDirectoryHandle>();

	async getDirectory() {
		return {
			// Positional like `FileSystemDirectoryHandle.getDirectoryHandle`.
			// eslint-disable-next-line opencut/prefer-object-params
			getDirectoryHandle: async (
				name: string,
				options?: { create?: boolean },
			): Promise<FakeDirectoryHandle> => {
				const existing = this.directories.get(name);
				if (existing) return existing;
				if (!options?.create) throw notFound(`No directory named "${name}"`);
				const directory = new FakeDirectoryHandle();
				this.directories.set(name, directory);
				return directory;
			},
		};
	}
}

function defineGlobal({
	target,
	key,
	value,
}: {
	target: object;
	key: string;
	value: unknown;
}): () => void {
	const previous = Object.getOwnPropertyDescriptor(target, key);
	Object.defineProperty(target, key, {
		value,
		configurable: true,
		writable: true,
	});
	return () => {
		if (previous) {
			Object.defineProperty(target, key, previous);
		} else {
			Reflect.deleteProperty(target, key);
		}
	};
}

/** Installs `globalThis.indexedDB`; returns the fake and a restore function. */
export function installFakeIndexedDB(): {
	indexedDB: FakeIndexedDB;
	restore: () => void;
} {
	const indexedDB = new FakeIndexedDB();
	const restore = defineGlobal({
		target: globalThis,
		key: "indexedDB",
		value: indexedDB,
	});
	return { indexedDB, restore };
}

/** Installs `navigator.storage.getDirectory`; returns the fake and a restore function. */
export function installFakeOPFS(): { opfs: FakeOPFS; restore: () => void } {
	const opfs = new FakeOPFS();
	const restore = defineGlobal({
		target: navigator,
		key: "storage",
		value: { getDirectory: () => opfs.getDirectory() },
	});
	return { opfs, restore };
}
