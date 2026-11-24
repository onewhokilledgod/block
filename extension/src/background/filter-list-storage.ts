import type { FilterListId } from "./filter-lists.js";
import { FILTER_LISTS } from "./filter-lists.js";
import {
	createBuiltInFilterListSubscriptions,
	normalizeCustomFilterListName,
	normalizeCustomFilterListUrl,
	type AddCustomFilterListInput,
	type StoredFilterListSubscription
} from "./filter-list-subscriptions.js";
import {
	createStoredUserSettingsRecord,
	decodeStoredUserSettingsRecord,
	DEFAULT_USER_SETTINGS,
	mergeUserSettings,
	USER_SETTINGS_RECORD_ID,
	type UserSettings,
	type UserSettingsPatch
} from "./user-settings.js";

const DATABASE_NAME = "block-filter-lists";
const DATABASE_VERSION = 5;

const STORE_NAME = "filterLists";
const ACTIVE_STORE_NAME = "activeFilterLists";
const PENDING_STORE_NAME = "pendingActiveSnapshot";
const USER_SETTINGS_STORE_NAME = "userSettings";
const SUBSCRIPTIONS_STORE_NAME = "filterListSubscriptions";

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
	name?: string;
	ruleWeight?: number;
	maxBytes?: number;
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

				if (!database.objectStoreNames.contains(USER_SETTINGS_STORE_NAME)) {
					database.createObjectStore(USER_SETTINGS_STORE_NAME, {
						keyPath: "id"
					});
				}

				if (!database.objectStoreNames.contains(SUBSCRIPTIONS_STORE_NAME)) {
					database.createObjectStore(SUBSCRIPTIONS_STORE_NAME, {
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
	 * Ensures that built-in subscriptions exist without overwriting their
	 * enabled state. This also upgrades databases created before the registry
	 * was introduced.
	 */
	private async ensureBuiltInSubscriptions(): Promise<void> {
		const database = await this.openDatabase();
		const transaction = database.transaction(
			SUBSCRIPTIONS_STORE_NAME,
			"readwrite"
		);
		const done = transactionToPromise(transaction);
		const store = transaction.objectStore(SUBSCRIPTIONS_STORE_NAME);
		const request = store.getAll();

		request.onsuccess = () => {
			const existingIds = new Set(
				(request.result as StoredFilterListSubscription[]).map(item => item.id)
			);

			for (const subscription of createBuiltInFilterListSubscriptions()) {
				if (!existingIds.has(subscription.id)) {
					store.add(subscription);
				}
			}
		};

		await done;
	}

	/** Returns built-in and user-added subscriptions, seeding built-ins once. */
	async getAllSubscriptions(): Promise<StoredFilterListSubscription[]> {
		await this.ensureBuiltInSubscriptions();

		const database = await this.openDatabase();
		const transaction = database.transaction(
			SUBSCRIPTIONS_STORE_NAME,
			"readonly"
		);
		const done = transactionToPromise(transaction);
		const result = await requestToPromise(
			transaction.objectStore(SUBSCRIPTIONS_STORE_NAME).getAll()
		);
		await done;

		return (result as StoredFilterListSubscription[]).sort((first, second) => {
			if (first.builtIn !== second.builtIn) {
				return first.builtIn ? -1 : 1;
			}
			return first.name.localeCompare(second.name);
		});
	}

	/** Adds an HTTPS-only custom list and rejects duplicate normalized URLs. */
	async addCustomSubscription(
		input: AddCustomFilterListInput
	): Promise<StoredFilterListSubscription> {
		const url = normalizeCustomFilterListUrl(input.url);
		const name = normalizeCustomFilterListName(input.name, url);
		await this.getAllSubscriptions();

		const database = await this.openDatabase();
		const transaction = database.transaction(
			SUBSCRIPTIONS_STORE_NAME,
			"readwrite"
		);
		const done = transactionToPromise(transaction);
		const store = transaction.objectStore(SUBSCRIPTIONS_STORE_NAME);
		const request = store.getAll();
		const id = `custom-${crypto.randomUUID()}`;
		const subscription: StoredFilterListSubscription = {
			id,
			name,
			url,
			enabled: true,
			builtIn: false,
			ruleWeight: 1,
			maxBytes: 8 * 1024 * 1024,
			addedAt: Date.now()
		};
		let operationError: unknown;

		request.onsuccess = () => {
			const subscriptions = request.result as StoredFilterListSubscription[];
			if (subscriptions.some(item => item.url === url)) {
				operationError = new Error(
					"A filter list with this URL is already subscribed."
				);
				transaction.abort();
				return;
			}

			store.add(subscription);
		};

		try {
			await done;
		} catch (error: unknown) {
			throw operationError ?? error;
		}

		return subscription;
	}

	/** Enables or disables a subscription without deleting its cached copy. */
	async setSubscriptionEnabled(
		id: FilterListId,
		enabled: boolean
	): Promise<StoredFilterListSubscription> {
		if (typeof enabled !== "boolean") {
			throw new TypeError("Subscription enabled state must be a boolean.");
		}

		await this.getAllSubscriptions();
		const database = await this.openDatabase();
		const transaction = database.transaction(
			SUBSCRIPTIONS_STORE_NAME,
			"readwrite"
		);
		const done = transactionToPromise(transaction);
		const store = transaction.objectStore(SUBSCRIPTIONS_STORE_NAME);
		const request = store.get(id);
		let updated: StoredFilterListSubscription | undefined;
		let operationError: unknown;

		request.onsuccess = () => {
			const current = request.result as StoredFilterListSubscription | undefined;
			if (!current) {
				operationError = new Error(`Unknown filter list subscription '${id}'.`);
				transaction.abort();
				return;
			}

			updated = { ...current, enabled };
			store.put(updated);
		};

		try {
			await done;
		} catch (error: unknown) {
			throw operationError ?? error;
		}

		if (!updated) {
			throw new Error("Could not update filter list subscription.");
		}

		return updated;
	}

	/**
	 * Removes only custom subscriptions and their downloaded cache. Built-in
	 * lists remain available and can only be disabled.
	 */
	async deleteCustomSubscription(id: FilterListId): Promise<void> {
		await this.getAllSubscriptions();
		const database = await this.openDatabase();
		const transaction = database.transaction(
			[SUBSCRIPTIONS_STORE_NAME, STORE_NAME],
			"readwrite"
		);
		const done = transactionToPromise(transaction);
		const subscriptions = transaction.objectStore(SUBSCRIPTIONS_STORE_NAME);
		const request = subscriptions.get(id);
		let operationError: unknown;

		request.onsuccess = () => {
			const current = request.result as StoredFilterListSubscription | undefined;
			if (!current) {
				operationError = new Error(`Unknown filter list subscription '${id}'.`);
				transaction.abort();
				return;
			}

			if (current.builtIn || FILTER_LISTS.some(item => item.id === id)) {
				operationError = new Error("Built-in filter lists cannot be removed.");
				transaction.abort();
				return;
			}

			subscriptions.delete(id);
			transaction.objectStore(STORE_NAME).delete(id);
		};

		try {
			await done;
		} catch (error: unknown) {
			throw operationError ?? error;
		}
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

	/** Loads the persisted preferences, creating the default record on first run. */
	async getUserSettings(): Promise<UserSettings> {
		const database = await this.openDatabase();
		const transaction = database.transaction(USER_SETTINGS_STORE_NAME, "readwrite");
		const done = transactionToPromise(transaction);
		const store = transaction.objectStore(USER_SETTINGS_STORE_NAME);
		const request = store.get(USER_SETTINGS_RECORD_ID);

		let settings: UserSettings | undefined;
		let operationError: unknown;

		request.onsuccess = () => {
			try {
				const decoded = decodeStoredUserSettingsRecord(request.result);
				settings = decoded.settings;

				if (decoded.needsRewrite) {
					store.put(createStoredUserSettingsRecord(decoded.settings));
				}
			} catch (error: unknown) {
				operationError = error;
				transaction.abort();
			}
		};

		try {
			await done;
		} catch (error: unknown) {
			throw operationError ?? error;
		}

		if (!settings) {
			throw new Error("Could not load user settings.");
		}

		return settings;
	}

	/**
	 * Atomically merges a partial settings update. IndexedDB serializes
	 * read-write transactions for this store, preventing concurrent updates
	 * from overwriting unrelated fields.
	 */
	async updateUserSettings(patch: UserSettingsPatch): Promise<UserSettings> {
		// Validate the complete patch before opening a write transaction.
		mergeUserSettings(DEFAULT_USER_SETTINGS as UserSettings, patch);

		const database = await this.openDatabase();
		const transaction = database.transaction(USER_SETTINGS_STORE_NAME, "readwrite");
		const done = transactionToPromise(transaction);
		const store = transaction.objectStore(USER_SETTINGS_STORE_NAME);
		const request = store.get(USER_SETTINGS_RECORD_ID);

		let settings: UserSettings | undefined;
		let operationError: unknown;

		request.onsuccess = () => {
			try {
				const decoded = decodeStoredUserSettingsRecord(request.result);
				settings = mergeUserSettings(decoded.settings, patch);
				store.put(createStoredUserSettingsRecord(settings));
			} catch (error: unknown) {
				operationError = error;
				transaction.abort();
			}
		};

		try {
			await done;
		} catch (error: unknown) {
			throw operationError ?? error;
		}

		if (!settings) {
			throw new Error("Could not update user settings.");
		}

		return settings;
	}

	/** Restores all preferences to their defaults without bypassing migrations. */
	async resetUserSettings(): Promise<UserSettings> {
		return this.updateUserSettings(DEFAULT_USER_SETTINGS);
	}

	close(): void {
		const pending = this.databasePromise;

		this.databasePromise = undefined;

		if (pending) {
			void pending.then(database => database.close()).catch(() => undefined);
		}
	}
}
