import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import {
	FilterListStorage,
	type StoredFilterList
} from "./filter-list-storage.js";

import {
	DEFAULT_CUSTOM_LIST_MAX_BYTES,
	normalizeCustomFilterListUrl
} from "./filter-list-subscriptions.js";

let databaseSequence = 0;
const storages: FilterListStorage[] = [];

function createStorage(databaseName?: string): FilterListStorage {
	databaseSequence += 1;
	const storage = new FilterListStorage(
		databaseName ?? `block-subscriptions-test-${databaseSequence}`
	);
	storages.push(storage);
	return storage;
}

function createCachedCustomRecord(id: string): StoredFilterList {
	return {
		id,
		url: "https://filters.example/custom.txt",
		title: "Custom filters",
		version: "1",
		etag: null,
		lastModified: null,
		sha256: "a".repeat(64),
		byteLength: 11,
		content: "custom data",
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

async function seedVersionFourDatabase(
	databaseName: string,
	record: StoredFilterList
): Promise<void> {
	const request = indexedDB.open(databaseName, 4);
	request.onupgradeneeded = () => {
		const database = request.result;
		database.createObjectStore("filterLists", { keyPath: "id" });
		database.createObjectStore("activeFilterLists", { keyPath: "id" });
		database.createObjectStore("pendingActiveSnapshot", { keyPath: "id" });
		database.createObjectStore("userSettings", { keyPath: "id" });
	};

	const database = await requestToPromise(request);
	const transaction = database.transaction(
		["filterLists", "activeFilterLists"],
		"readwrite"
	);
	const done = transactionToPromise(transaction);
	transaction.objectStore("filterLists").put(record);
	transaction.objectStore("activeFilterLists").put(record);
	await done;
	database.close();
}

afterEach(() => {
	for (const storage of storages.splice(0)) {
		storage.close();
	}
});

describe("Filter list subscription storage", () => {
	it("seeds built-in lists once and preserves their enabled state", async () => {
		const storage = createStorage();
		const initial = await storage.getAllSubscriptions();

		expect(initial.map(item => item.id)).toEqual(["easylist", "easyprivacy"]);
		expect(initial.every(item => item.builtIn && item.enabled)).toBe(true);

		await storage.setSubscriptionEnabled("easyprivacy", false);
		const reopened = await storage.getAllSubscriptions();

		expect(reopened.find(item => item.id === "easyprivacy")?.enabled).toBe(false);
		expect(reopened.find(item => item.id === "easylist")?.enabled).toBe(true);
	});

	it("adds and persists normalized HTTPS custom subscriptions", async () => {
		const databaseName = `block-subscriptions-persist-${databaseSequence + 1}`;
		const first = createStorage(databaseName);
		const added = await first.addCustomSubscription({
			name: "  My filters  ",
			url: "https://filters.example/custom.txt"
		});

		expect(added.id).toMatch(/^custom-/);
		expect(added).toMatchObject({
			name: "My filters",
			url: "https://filters.example/custom.txt",
			enabled: true,
			builtIn: false,
			ruleWeight: 1,
			maxBytes: DEFAULT_CUSTOM_LIST_MAX_BYTES
		});

		first.close();
		const reopened = createStorage(databaseName);
		expect(await reopened.getAllSubscriptions()).toContainEqual(added);
	});

	it("rejects unsafe URLs and duplicate normalized subscriptions", async () => {
		expect(() => normalizeCustomFilterListUrl("http://filters.example/list.txt"))
			.toThrow("must use HTTPS");
		expect(() =>
			normalizeCustomFilterListUrl("https://user:pass@filters.example/list.txt")
		).toThrow("credentials");
		expect(() =>
			normalizeCustomFilterListUrl("https://filters.example/list.txt#section")
		).toThrow("fragments");

		const storage = createStorage();
		await storage.addCustomSubscription({ url: "https://filters.example/list.txt" });
		await expect(
			storage.addCustomSubscription({ url: "https://filters.example:443/list.txt" })
		).rejects.toThrow("already subscribed");
	});

	it("allows toggling and removes a custom subscription with its cache", async () => {
		const storage = createStorage();
		const added = await storage.addCustomSubscription({
			url: "https://filters.example/custom.txt"
		});
		await storage.putMany([createCachedCustomRecord(added.id)]);

		await expect(storage.setSubscriptionEnabled(added.id, false)).resolves.toMatchObject({
			enabled: false
		});

		await storage.deleteCustomSubscription(added.id);
		expect(await storage.getAllSubscriptions()).not.toContainEqual(added);
		await expect(storage.get(added.id)).resolves.toBeNull();
	});

	it("does not allow built-in lists to be removed", async () => {
		const storage = createStorage();
		await storage.getAllSubscriptions();
		await expect(storage.deleteCustomSubscription("easylist")).rejects.toThrow(
			"cannot be removed"
		);
	});

	it("upgrades a version four database without losing filter caches", async () => {
		const databaseName = `block-subscriptions-migration-${databaseSequence + 1}`;
		const record = createCachedCustomRecord("legacy-custom");
		await seedVersionFourDatabase(databaseName, record);

		const storage = createStorage(databaseName);
		await expect(storage.getAllSubscriptions()).resolves.toHaveLength(2);
		await expect(storage.get(record.id)).resolves.toEqual(record);
		await expect(storage.getActive(record.id)).resolves.toEqual(record);

		const database = await requestToPromise(indexedDB.open(databaseName));
		expect(database.version).toBe(5);
		expect(database.objectStoreNames.contains("filterListSubscriptions")).toBe(true);
		database.close();
	});
});
