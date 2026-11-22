import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	FilterListStorage,
	type StoredFilterList
} from "./filter-list-storage.js";

let storage: FilterListStorage;
let databaseSequence = 0;

function createRecord(id: StoredFilterList["id"]): StoredFilterList {
	return {
		id,
		url: `https://easylist.to/${id}.txt`,
		title: id === "easylist" ? "EasyList" : "EasyPrivacy",
		version: "202611220954",
		etag: '"test-etag"',
		lastModified: "Sun, 22 Nov 2026 09:54:00 GMT",
		sha256: "test-hash",
		byteLength: 100,
		content: "[Adblock Plus 2.0]\n||ads.example^\n",
		fetchedAt: 1000,
		checkedAt: 1000
	};
}

beforeEach(() => {
	databaseSequence += 1;

	storage = new FilterListStorage(
		`block-filter-lists-test-${databaseSequence}`
	);
});

afterEach(() => {
	storage.close();
});

describe("FilterListStorage", () => {
	it("keeps downloaded cache separate from active snapshots", async () => {
		const active = createRecord("easylist");

		const candidate = {
			...active,
			version: "new-version",
			content: "new downloaded content"
		};

		await storage.putActiveMany([active]);
		await storage.putMany([candidate]);

		await expect(storage.get("easylist")).resolves.toEqual(candidate);

		await expect(storage.getActive("easylist")).resolves.toEqual(active);
	});

	it("saves multiple active snapshots together", async () => {
		const records = [createRecord("easylist"), createRecord("easyprivacy")];

		await storage.putActiveMany(records);

		const stored = await storage.getAllActive();

		expect(stored).toHaveLength(2);

		expect(stored.map(record => record.id)).toEqual([
			"easylist",
			"easyprivacy"
		]);
	});

	it("returns null for a missing list", async () => {
		await expect(storage.get("easylist")).resolves.toBeNull();
	});

	it("stores and retrieves a filter list", async () => {
		const record = createRecord("easylist");

		await storage.putMany([record]);

		await expect(storage.get("easylist")).resolves.toEqual(record);
	});

	it("stores multiple lists in one operation", async () => {
		const records = [createRecord("easylist"), createRecord("easyprivacy")];

		await storage.putMany(records);

		const stored = await storage.getAll();

		expect(stored).toHaveLength(2);
		expect(stored.map(item => item.id)).toEqual(["easylist", "easyprivacy"]);
	});

	it("replaces an existing record", async () => {
		const original = createRecord("easylist");

		await storage.putMany([original]);

		const updated = {
			...original,
			version: "202611231200",
			content: "updated content"
		};

		await storage.putMany([updated]);

		await expect(storage.get("easylist")).resolves.toEqual(updated);

		await expect(storage.getAll()).resolves.toHaveLength(1);
	});

	it("deletes only the requested list", async () => {
		await storage.putMany([
			createRecord("easylist"),
			createRecord("easyprivacy")
		]);

		await storage.delete("easylist");

		await expect(storage.get("easylist")).resolves.toBeNull();

		await expect(storage.get("easyprivacy")).resolves.toEqual(
			createRecord("easyprivacy")
		);
	});
});
