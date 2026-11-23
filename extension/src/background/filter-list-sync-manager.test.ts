import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	FILTER_LISTS,
	MIN_FILTER_LINES,
	getFilterListDefinition,
	type FilterListId
} from "./filter-lists.js";

import {
	FilterListStorage,
	type StoredFilterList
} from "./filter-list-storage.js";

import type { FilterListRefreshReport } from "./filter-list-manager.js";

import type {
	CompileReport,
	FilterListInput,
	FilterListsApplyResult
} from "./engine-manager.js";

import {
	ActiveSnapshotCommitError,
	FilterListSyncManager
} from "./filter-list-sync-manager.js";

let storage: FilterListStorage;
let databaseCounter = 0;

async function createRecord(
	id: FilterListId,
	version: string
): Promise<StoredFilterList> {
	const definition = getFilterListDefinition(id);

	const header =
		id === "easyprivacy" ? "[Adblock Plus 1.1]" : "[Adblock Plus 2.0]";

	const content = [
		header,
		`! Title: ${definition.expectedTitle}`,
		`! Version: ${version}`,
		...Array.from(
			{ length: MIN_FILTER_LINES + 5 },
			(_, index) => `||tracker-${index}.${id}.example^`
		)
	].join("\n");

	const bytes = new TextEncoder().encode(content);

	const digest = await crypto.subtle.digest("SHA-256", bytes);

	const sha256 = Array.from(new Uint8Array(digest))
		.map(byte => byte.toString(16).padStart(2, "0"))
		.join("");

	return {
		id,
		url: definition.url,
		title: definition.expectedTitle,
		version,
		etag: `"${id}-${version}"`,
		lastModified: null,
		sha256,
		byteLength: bytes.byteLength,
		content,
		fetchedAt: 1000,
		checkedAt: 1000
	};
}

async function createRecords(version: string): Promise<StoredFilterList[]> {
	return Promise.all(
		FILTER_LISTS.filter(item => item.enabledByDefault).map(item =>
			createRecord(item.id, version)
		)
	);
}

function createRefreshReport(
	records: readonly StoredFilterList[]
): FilterListRefreshReport {
	return {
		lists: records.map(record => ({
			id: record.id,
			name: getFilterListDefinition(record.id).name,
			status: "updated",
			version: record.version,
			sha256: record.sha256,
			byteLength: record.byteLength
		})),
		updatedCount: records.length,
		notModifiedCount: 0,
		cachedCount: 0
	};
}

function createApplicationResult(
	inputs: readonly FilterListInput[]
): FilterListsApplyResult {
	const report: CompileReport = {
		rules: [],
		parserDiagnostics: [],
		compilerDiagnostics: [],
		parserStats: {
			totalFilters: 0,
			networkFilters: 0,
			cosmeticFilters: 0,
			errors: 0,
			warnings: 0
		},
		compilerStats: {
			networkFiltersSeen: 0,
			compiledRules: 0,
			skippedNetworkFilters: 0,
			cosmeticFiltersDeferred: 0,
			regexRules: 0
		}
	};

	return {
		lists: inputs.map(input => ({
			id: input.id,
			name: getFilterListDefinition(input.id).name,
			report
		})),
		report,
		update: {
			previousManagedCount: 0,
			installedCount: inputs.length,
			preservedDynamicRuleCount: 0
		}
	};
}

function createDownloader(records: readonly StoredFilterList[]) {
	return {
		refreshAll: vi.fn(async () => {
			await storage.putMany(records);
			return createRefreshReport(records);
		})
	};
}

function createApplier() {
	const applyFilterLists = vi.fn(async (inputs: readonly FilterListInput[]) =>
		createApplicationResult(inputs)
	);

	return { applyFilterLists };
}

beforeEach(() => {
	databaseCounter += 1;

	storage = new FilterListStorage(`block-sync-manager-test-${databaseCounter}`);
});

afterEach(() => {
	storage.close();
});

describe("FilterListSyncManager", () => {
	it("applies both lists before committing active snapshots", async () => {
		const previous = await createRecords("old");
		const candidates = await createRecords("new");

		await storage.putActiveMany(previous);

		const downloader = createDownloader(candidates);
		const applier = createApplier();

		applier.applyFilterLists.mockImplementationOnce(async inputs => {
			// The previous active snapshot is still visible
			// while DNR application is running.
			await expect(storage.getAllActive()).resolves.toEqual(previous);

			return createApplicationResult(inputs);
		});

		const manager = new FilterListSyncManager(
			downloader,
			storage,
			applier,
			() => 2000
		);

		const result = await manager.sync();

		expect(result.skippedApplication).toBe(false);
		expect(result.recoveredPendingSnapshot).toBe(false);

		expect(applier.applyFilterLists).toHaveBeenCalledTimes(1);
		expect(applier.applyFilterLists).toHaveBeenCalledWith([
			{
				id: "easylist",
				content: candidates.find(item => item.id === "easylist")!.content
			},
			{
				id: "easyprivacy",
				content: candidates.find(item => item.id === "easyprivacy")!.content
			}
		]);

		await expect(storage.getAllActive()).resolves.toEqual(candidates);

		await expect(storage.getPendingActiveSnapshot()).resolves.toBeNull();

		expect(result.activeLists).toHaveLength(2);
	});

	it("preserves active snapshots when downloading fails", async () => {
		const previous = await createRecords("old");

		await storage.putActiveMany(previous);

		const downloader = {
			refreshAll: vi.fn().mockRejectedValue(new Error("Network unavailable"))
		};

		const applier = createApplier();

		const manager = new FilterListSyncManager(downloader, storage, applier);

		await expect(manager.sync()).rejects.toThrow("Network unavailable");

		expect(applier.applyFilterLists).not.toHaveBeenCalled();

		await expect(storage.getAllActive()).resolves.toEqual(previous);
	});

	it("preserves active snapshots when DNR application fails", async () => {
		const previous = await createRecords("old");
		const candidates = await createRecords("new");

		await storage.putActiveMany(previous);

		const downloader = createDownloader(candidates);

		const applier = {
			applyFilterLists: vi
				.fn()
				.mockRejectedValue(new Error("DNR update failed"))
		};

		const manager = new FilterListSyncManager(downloader, storage, applier);

		await expect(manager.sync()).rejects.toThrow("DNR update failed");

		await expect(storage.getAllActive()).resolves.toEqual(previous);

		await expect(storage.getPendingActiveSnapshot()).resolves.toBeNull();
	});

	it("recovers an interrupted activation without applying it twice", async () => {
		const candidates = await createRecords("recovery");

		await storage.putMany(candidates);

		await storage.stageActiveSnapshot(candidates, 3000);

		const downloader = createDownloader(candidates);
		const applier = createApplier();

		const manager = new FilterListSyncManager(downloader, storage, applier);

		const result = await manager.sync({ forceApply: true });

		expect(result.recoveredPendingSnapshot).toBe(true);
		expect(result.skippedApplication).toBe(true);

		// One application for recovery, no second installation
		// because the downloaded records have the same SHA-256.
		expect(applier.applyFilterLists).toHaveBeenCalledTimes(1);

		await expect(storage.getAllActive()).resolves.toEqual(candidates);

		await expect(storage.getPendingActiveSnapshot()).resolves.toBeNull();
	});

	it("skips DNR replacement when active lists are unchanged", async () => {
		const records = await createRecords("same");

		await storage.putMany(records);
		await storage.putActiveMany(records);

		const downloader = createDownloader(records);
		const applier = createApplier();

		const manager = new FilterListSyncManager(downloader, storage, applier);

		const result = await manager.sync();

		expect(result.skippedApplication).toBe(true);
		expect(result.application).toBeNull();

		expect(applier.applyFilterLists).not.toHaveBeenCalled();
	});

	it("reapplies unchanged snapshots when forceApply is requested", async () => {
		const records = await createRecords("unchanged");
		await storage.putMany(records);
		await storage.putActiveMany(records);

		const downloader = createDownloader(records);
		const applier = createApplier();
		const manager = new FilterListSyncManager(downloader, storage, applier);

		const result = await manager.sync({ forceApply: true });

		expect(result.skippedApplication).toBe(false);
		expect(result.application).not.toBeNull();
		expect(applier.applyFilterLists).toHaveBeenCalledTimes(1);
		await expect(storage.getAllActive()).resolves.toEqual(records);
	});

	it("retries a forced reapplication after a DNR failure", async () => {
		const records = await createRecords("unchanged");
		await storage.putMany(records);
		await storage.putActiveMany(records);

		const downloader = createDownloader(records);
		const applier = createApplier();
		applier.applyFilterLists.mockRejectedValueOnce(
			new Error("DNR update failed")
		);
		const manager = new FilterListSyncManager(downloader, storage, applier);

		await expect(
			manager.sync({ forceApply: true })
		).rejects.toThrow("DNR update failed");
		await expect(storage.getPendingActiveSnapshot()).resolves.toBeNull();

		const retry = await manager.sync();

		expect(retry.skippedApplication).toBe(false);
		expect(applier.applyFilterLists).toHaveBeenCalledTimes(2);
		await expect(storage.getAllActive()).resolves.toEqual(records);
	});

	it("recovers after active snapshot commit failure", async () => {
		const previous = await createRecords("old");
		const candidates = await createRecords("new");

		await storage.putActiveMany(previous);

		const downloader = createDownloader(candidates);
		const applier = createApplier();

		const commitSpy = vi
			.spyOn(storage, "commitPendingActiveSnapshot")
			.mockRejectedValueOnce(new Error("Simulated IndexedDB commit failure"));

		const manager = new FilterListSyncManager(downloader, storage, applier);

		await expect(manager.sync()).rejects.toBeInstanceOf(
			ActiveSnapshotCommitError
		);

		expect(commitSpy).toHaveBeenCalledTimes(1);

		// The durable journal survives the failed commit.
		await expect(storage.getPendingActiveSnapshot()).resolves.not.toBeNull();

		await expect(storage.getAllActive()).resolves.toEqual(previous);

		// The next run replays DNR application and commits
		// the pending snapshot.
		const recovered = await manager.sync();

		expect(recovered.recoveredPendingSnapshot).toBe(true);
		expect(applier.applyFilterLists).toHaveBeenCalledTimes(2);

		await expect(storage.getAllActive()).resolves.toEqual(candidates);

		await expect(storage.getPendingActiveSnapshot()).resolves.toBeNull();
	});
});
