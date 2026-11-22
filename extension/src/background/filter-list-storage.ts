import type { FilterListId } from "./filter-lists.js";

const DATABASE_NAME = "block-filter-lists";
const DATABASE_VERSION = 1;
const STORE_NAME = "filterLists";

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
					database.createObjectStore(STORE_NAME, { keyPath: "id" });
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

	close(): void {
		const pending = this.databasePromise;

		this.databasePromise = undefined;

		if (pending) {
			void pending.then(database => database.close()).catch(() => undefined);
		}
	}
}
