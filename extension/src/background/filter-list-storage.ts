import type { FilterListId } from "./filter-lists.js";

const DATABASE_NAME = "block-filter-lists";
const DATABASE_VERSION = 3;

const STORE_NAME = "filterLists";
const ACTIVE_STORE_NAME = "activeFilterLists";
const PENDING_STORE_NAME = "pendingActiveSnapshot";

const PENDING_SNAPSHOT_KEY = "pending";

export interface StoredFilterList {
	id: FilterListId;
	url: string;
	title: string;
	version: string | null;
	etag: string | null;
	lastModified: string | null;
	sha256: string;
	byteLength: number;
	content: string;
	fetchedAt: number;
	checkedAt: number;
}

export interface PendingActiveSnapshot {
	id: typeof PENDING_SNAPSHOT_KEY;
	records: StoredFilterList[];
	stagedAt: number;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);

		request.onerror = () => {
			reject(request.error ?? new Error("IndexedDB request failed."));
		};
	});
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();

		transaction.onerror = () => {
			reject(transaction.error ?? new Error("IndexedDB transaction failed."));
		};

		transaction.onabort = () => {
			reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
		};
	});
}

export class FilterListStorage {
	async getActive(id: FilterListId): Promise<StoredFilterList | null> {
		const database = await this.openDatabase();

		const transaction = database.transaction(ACTIVE_STORE_NAME, "readonly");

		const done = transactionToPromise(transaction);

		const result = await requestToPromise(
			transaction.objectStore(ACTIVE_STORE_NAME).get(id)
		);

		await done;

		return result ?? null;
	}

	async getAllActive(): Promise<StoredFilterList[]> {
		const database = await this.openDatabase();

		const transaction = database.transaction(ACTIVE_STORE_NAME, "readonly");

		const done = transactionToPromise(transaction);

		const result = await requestToPromise(
			transaction.objectStore(ACTIVE_STORE_NAME).getAll()
		);

		await done;

		return result.sort((a, b) => a.id.localeCompare(b.id));
	}

	async putActiveMany(records: readonly StoredFilterList[]): Promise<void> {
		if (records.length === 0) {
			return;
		}

		const database = await this.openDatabase();

		const transaction = database.transaction(ACTIVE_STORE_NAME, "readwrite");

		const done = transactionToPromise(transaction);

		const store = transaction.objectStore(ACTIVE_STORE_NAME);

		for (const record of records) {
			store.put(record);
		}

		await done;
	}
	private databasePromise?: Promise<IDBDatabase>;

	constructor(private readonly databaseName = DATABASE_NAME) {}

	private openDatabase(): Promise<IDBDatabase> {
		if (this.databasePromise) {
			return this.databasePromise;
		}

		const opening = new Promise<IDBDatabase>((resolve, reject) => {
			if (typeof indexedDB === "undefined") {
				reject(new Error("IndexedDB is unavailable."));
				return;
			}

			const request = indexedDB.open(this.databaseName, DATABASE_VERSION);

			request.onupgradeneeded = () => {
				const database = request.result;

				if (!database.objectStoreNames.contains(STORE_NAME)) {
					database.createObjectStore(STORE_NAME, {
						keyPath: "id"
					});
				}

				if (!database.objectStoreNames.contains(ACTIVE_STORE_NAME)) {
					database.createObjectStore(ACTIVE_STORE_NAME, {
						keyPath: "id"
					});
				}

				if (!database.objectStoreNames.contains(PENDING_STORE_NAME)) {
					database.createObjectStore(PENDING_STORE_NAME, {
						keyPath: "id"
					});
				}
			};

			request.onsuccess = () => {
				const database = request.result;

				database.onversionchange = () => {
					database.close();
				};

				resolve(database);
			};

			request.onerror = () => {
				reject(request.error ?? new Error("Failed to open IndexedDB."));
			};
		});

		this.databasePromise = opening;

		void opening.catch(() => {
			if (this.databasePromise === opening) {
				this.databasePromise = undefined;
			}
		});

		return opening;
	}

	async get(id: FilterListId): Promise<StoredFilterList | null> {
		const database = await this.openDatabase();

		const transaction = database.transaction(STORE_NAME, "readonly");

		const done = transactionToPromise(transaction);

		const result = await requestToPromise(
			transaction.objectStore(STORE_NAME).get(id)
		);

		await done;

		return result ?? null;
	}

	async getAll(): Promise<StoredFilterList[]> {
		const database = await this.openDatabase();

		const transaction = database.transaction(STORE_NAME, "readonly");

		const done = transactionToPromise(transaction);

		const result = await requestToPromise(
			transaction.objectStore(STORE_NAME).getAll()
		);

		await done;

		return result.sort((a, b) => a.id.localeCompare(b.id));
	}

	/**
	 * Saves multiple lists in one IndexedDB transaction.
	 */
	async putMany(records: readonly StoredFilterList[]): Promise<void> {
		if (records.length === 0) {
			return;
		}

		const database = await this.openDatabase();

		const transaction = database.transaction(STORE_NAME, "readwrite");

		const done = transactionToPromise(transaction);
		const store = transaction.objectStore(STORE_NAME);

		for (const record of records) {
			store.put(record);
		}

		await done;
	}

	async delete(id: FilterListId): Promise<void> {
		const database = await this.openDatabase();

		const transaction = database.transaction(STORE_NAME, "readwrite");

		const done = transactionToPromise(transaction);

		transaction.objectStore(STORE_NAME).delete(id);

		await done;
	}

	/**
	 * Stores a candidate snapshot before changing browser DNR rules.
	 */
	async stageActiveSnapshot(
		records: readonly StoredFilterList[],
		stagedAt = Date.now()
	): Promise<void> {
		if (records.length === 0) {
			throw new TypeError("Cannot stage an empty active snapshot.");
		}

		const ids = new Set<string>();

		for (const record of records) {
			if (ids.has(record.id)) {
				throw new Error(`Duplicate snapshot record: ${record.id}.`);
			}

			ids.add(record.id);
		}

		const database = await this.openDatabase();

		const transaction = database.transaction(PENDING_STORE_NAME, "readwrite");

		const done = transactionToPromise(transaction);

		const snapshot: PendingActiveSnapshot = {
			id: PENDING_SNAPSHOT_KEY,
			records: Array.from(records),
			stagedAt
		};

		transaction.objectStore(PENDING_STORE_NAME).put(snapshot);

		await done;
	}

	/**
	 * Returns an interrupted activation, if one exists.
	 */
	async getPendingActiveSnapshot(): Promise<PendingActiveSnapshot | null> {
		const database = await this.openDatabase();

		const transaction = database.transaction(PENDING_STORE_NAME, "readonly");

		const done = transactionToPromise(transaction);

		const result = await requestToPromise(
			transaction.objectStore(PENDING_STORE_NAME).get(PENDING_SNAPSHOT_KEY)
		);

		await done;

		return result ?? null;
	}

	/**
	 * Commits the staged snapshot and removes its journal entry
	 * in one IndexedDB transaction.
	 */
	async commitPendingActiveSnapshot(): Promise<boolean> {
		const database = await this.openDatabase();

		const transaction = database.transaction(
			[ACTIVE_STORE_NAME, PENDING_STORE_NAME],
			"readwrite"
		);

		const done = transactionToPromise(transaction);

		let committed = false;

		const pendingStore = transaction.objectStore(PENDING_STORE_NAME);

		const request = pendingStore.get(PENDING_SNAPSHOT_KEY);

		request.onsuccess = () => {
			const snapshot = request.result as PendingActiveSnapshot | undefined;

			if (!snapshot) {
				return;
			}

			const activeStore = transaction.objectStore(ACTIVE_STORE_NAME);

			activeStore.clear();

			for (const record of snapshot.records) {
				activeStore.put(record);
			}

			pendingStore.delete(PENDING_SNAPSHOT_KEY);

			committed = true;
		};

		await done;

		return committed;
	}

	/**
	 * Discards a staged snapshot after a failed DNR update.
	 */
	async discardPendingActiveSnapshot(): Promise<void> {
		const database = await this.openDatabase();

		const transaction = database.transaction(PENDING_STORE_NAME, "readwrite");

		const done = transactionToPromise(transaction);

		transaction.objectStore(PENDING_STORE_NAME).delete(PENDING_SNAPSHOT_KEY);

		await done;
	}

	close(): void {
		const pending = this.databasePromise;

		this.databasePromise = undefined;

		if (pending) {
			void pending.then(database => database.close()).catch(() => undefined);
		}
	}
}
