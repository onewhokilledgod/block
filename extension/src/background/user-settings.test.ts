import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import { FilterListStorage, type StoredFilterList } from "./filter-list-storage.js";
import {
	DEFAULT_USER_SETTINGS,
	decodeStoredUserSettingsRecord,
	mergeUserSettings,
	normalizeUserSettings
} from "./user-settings.js";

let databaseSequence = 0;
const openStorages: FilterListStorage[] = [];

function createStorage(databaseName?: string): FilterListStorage {
	databaseSequence += 1;
	const storage = new FilterListStorage(
		databaseName ?? `block-user-settings-test-${databaseSequence}`
	);
	openStorages.push(storage);
	return storage;
}

function createFilterListRecord(): StoredFilterList {
	return {
		id: "easylist",
		url: "https://easylist.to/easylist/easylist.txt",
		title: "EasyList",
		version: "test-version",
		etag: null,
		lastModified: null,
		sha256: "test-hash",
		byteLength: 30,
		content: "[Adblock Plus 2.0]\n||ads.example^\n",
		fetchedAt: 1_000,
		checkedAt: 1_000
	};
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed."));
	});
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed."));
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
	});
}

async function seedVersionThreeDatabase(
	databaseName: string,
	record: StoredFilterList
): Promise<void> {
	const request = indexedDB.open(databaseName, 3);
	request.onupgradeneeded = () => {
		const database = request.result;
		database.createObjectStore("filterLists", { keyPath: "id" });
		database.createObjectStore("activeFilterLists", { keyPath: "id" });
		database.createObjectStore("pendingActiveSnapshot", { keyPath: "id" });
	};

	const database = await requestToPromise(request);
	const transaction = database.transaction(
		["filterLists", "activeFilterLists", "pendingActiveSnapshot"],
		"readwrite"
	);
	const done = transactionToPromise(transaction);
	transaction.objectStore("filterLists").put(record);
	transaction.objectStore("activeFilterLists").put(record);
	transaction.objectStore("pendingActiveSnapshot").put({
		id: "pending",
		records: [record],
		stagedAt: 2_000
	});
	await done;
	database.close();
}

async function writeRawSettingsRecord(
	databaseName: string,
	value: unknown
): Promise<void> {
	const database = await requestToPromise(indexedDB.open(databaseName));
	const transaction = database.transaction("userSettings", "readwrite");
	const done = transactionToPromise(transaction);
	transaction.objectStore("userSettings").put(value);
	await done;
	database.close();
}

afterEach(() => {
	for (const storage of openStorages.splice(0)) {
		storage.close();
	}
});

describe("UserSettings model", () => {
	it("provides defaults that preserve the current extension behavior", () => {
		expect(DEFAULT_USER_SETTINGS).toEqual({
			networkFilteringEnabled: true,
			cosmeticFilteringEnabled: true,
			automaticFilterListUpdatesEnabled: true,
			filterListUpdateIntervalMinutes: 1_440,
			theme: "system"
		});
	});

	it("normalizes missing or invalid persisted values field by field", () => {
		expect(
			normalizeUserSettings({
				networkFilteringEnabled: false,
				cosmeticFilteringEnabled: "false",
				filterListUpdateIntervalMinutes: 5,
				theme: "automatic"
			})
		).toEqual({
			...DEFAULT_USER_SETTINGS,
			networkFilteringEnabled: false
		});
	});

	it("merges valid partial updates without changing other fields", () => {
		expect(
			mergeUserSettings(DEFAULT_USER_SETTINGS, {
				cosmeticFilteringEnabled: false,
				filterListUpdateIntervalMinutes: 720,
				theme: "dark"
			})
		).toEqual({
			...DEFAULT_USER_SETTINGS,
			cosmeticFilteringEnabled: false,
			filterListUpdateIntervalMinutes: 720,
			theme: "dark"
		});
	});

	it("rejects unknown keys and invalid values", () => {
		expect(() =>
			mergeUserSettings(DEFAULT_USER_SETTINGS, { unknownPreference: true } as never)
		).toThrow("Unknown user setting");
		expect(() =>
			mergeUserSettings(DEFAULT_USER_SETTINGS, { filterListUpdateIntervalMinutes: 5 })
		).toThrow("Update interval");
		expect(() =>
			mergeUserSettings(DEFAULT_USER_SETTINGS, { theme: "automatic" } as never)
		).toThrow("Theme must");
	});

	it("migrates version zero records and rejects records from newer versions", () => {
		const migrated = decodeStoredUserSettingsRecord({
			id: "current",
			schemaVersion: 0,
			networkFilteringEnabled: false,
			cosmeticFilteringEnabled: false,
			automaticFilterListUpdatesEnabled: false,
			filterListUpdateIntervalMinutes: 720,
			theme: "dark",
			updatedAt: 1_000
		});

		expect(migrated.needsRewrite).toBe(true);
		expect(migrated.settings).toEqual({
			networkFilteringEnabled: false,
			cosmeticFilteringEnabled: false,
			automaticFilterListUpdatesEnabled: false,
			filterListUpdateIntervalMinutes: 720,
			theme: "dark"
		});

		expect(() =>
			decodeStoredUserSettingsRecord({ id: "current", schemaVersion: 2 })
		).toThrow("newer version");
	});
});

describe("User settings persistence", () => {
	it("creates defaults on first use and preserves updates across storage instances", async () => {
		const databaseName = `block-user-settings-persist-${databaseSequence + 1}`;
		const first = createStorage(databaseName);
		const initial = await first.getUserSettings();
		expect(initial).toEqual(DEFAULT_USER_SETTINGS);

		const updated = await first.updateUserSettings({
			theme: "dark",
			filterListUpdateIntervalMinutes: 720
		});
		expect(updated).toEqual({
			...DEFAULT_USER_SETTINGS,
			theme: "dark",
			filterListUpdateIntervalMinutes: 720
		});

		first.close();
		const reopened = createStorage(databaseName);
		expect(await reopened.getUserSettings()).toEqual(updated);
	});

	it("applies concurrent partial updates without losing unrelated fields", async () => {
		const storage = createStorage();

		await storage.getUserSettings();
		await Promise.all([
			storage.updateUserSettings({ theme: "dark" }),
			storage.updateUserSettings({ cosmeticFilteringEnabled: false })
		]);

		expect(await storage.getUserSettings()).toEqual({
			...DEFAULT_USER_SETTINGS,
			theme: "dark",
			cosmeticFilteringEnabled: false
		});
	});

	it("rejects invalid updates without modifying the stored settings", async () => {
		const storage = createStorage();
		await storage.getUserSettings();

		await expect(
			storage.updateUserSettings({ filterListUpdateIntervalMinutes: 5 })
		).rejects.toThrow("Update interval");

		expect(await storage.getUserSettings()).toEqual(DEFAULT_USER_SETTINGS);
	});

	it("resets all preferences to defaults", async () => {
		const storage = createStorage();
		await storage.updateUserSettings({
			networkFilteringEnabled: false,
			cosmeticFilteringEnabled: false,
			automaticFilterListUpdatesEnabled: false,
			theme: "light"
		});

		await expect(storage.resetUserSettings()).resolves.toEqual(
			DEFAULT_USER_SETTINGS
		);
	});

	it("migrates a version zero settings record on read", async () => {
		const storage = createStorage();
		await storage.getUserSettings();
		const databaseName = `block-user-settings-test-${databaseSequence}`;
		storage.close();

		await writeRawSettingsRecord(databaseName, {
			id: "current",
			schemaVersion: 0,
			networkFilteringEnabled: false,
			theme: "light"
		});

		const reopened = createStorage(databaseName);
		expect(await reopened.getUserSettings()).toEqual({
			...DEFAULT_USER_SETTINGS,
			networkFilteringEnabled: false,
			theme: "light"
		});

		const database = await requestToPromise(indexedDB.open(databaseName));
		const record = await requestToPromise(
			database
				.transaction("userSettings", "readonly")
				.objectStore("userSettings")
				.get("current")
		);
		database.close();
		expect(record.schemaVersion).toBe(1);
		expect(record.settings.networkFilteringEnabled).toBe(false);
	});

	it("upgrades a version three database without deleting existing filter data", async () => {
		const databaseName = `block-user-settings-migration-${databaseSequence + 1}`;
		const record = createFilterListRecord();
		await seedVersionThreeDatabase(databaseName, record);

		const storage = createStorage(databaseName);
		expect(await storage.getUserSettings()).toEqual(DEFAULT_USER_SETTINGS);
		expect(await storage.get("easylist")).toEqual(record);
		expect(await storage.getActive("easylist")).toEqual(record);
		expect(await storage.getPendingActiveSnapshot()).toEqual({
			id: "pending",
			records: [record],
			stagedAt: 2_000
		});

		const database = await requestToPromise(indexedDB.open(databaseName));
		expect(database.version).toBe(5);
		expect(database.objectStoreNames.contains("userSettings")).toBe(true);
		expect(database.objectStoreNames.contains("filterLists")).toBe(true);
		expect(database.objectStoreNames.contains("activeFilterLists")).toBe(true);
		expect(database.objectStoreNames.contains("pendingActiveSnapshot")).toBe(true);
		database.close();
	});
});
